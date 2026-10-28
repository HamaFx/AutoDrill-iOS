#!/bin/bash
# Builds the "iOS simulation" game jar used by tools/run-tests.sh ios:
# the real desktop release with three lines changed so scripts run the way the iOS build runs
# them (interpreted JS + Rhino's iOS interface path). Reproducible from scratch - no manual
# patching required.
#
#   tools/make-ios-sim-jar.sh [version] [release-jar]
#
# Defaults: version $MINDUSTRY_VERSION (or v160.7), jar /tmp/opencode/libs/Mindustry.jar
set -euo pipefail

VERSION="${1:-${MINDUSTRY_VERSION:-v160.7}}"
BASE_JAR="${2:-/tmp/opencode/libs/Mindustry.jar}"
OUT_JAR="${BASE_JAR%.jar}-iossim.jar"
WORK=/tmp/opencode/ios-sim-build

mkdir -p "$(dirname "$BASE_JAR")" "$WORK"

if [ ! -f "$BASE_JAR" ]; then
    echo "downloading Mindustry $VERSION release jar..."
    curl -sL -o "$BASE_JAR" "https://github.com/Anuken/Mindustry/releases/download/$VERSION/Mindustry.jar"
fi

echo "fetching $VERSION sources (only Platform.java is needed)..."
rm -rf "$WORK/src" "$WORK/patched" "$WORK/classes"
mkdir -p "$WORK/src" "$WORK/patched/mindustry/core" "$WORK/classes"
curl -sL -o "$WORK/src.zip" "https://github.com/Anuken/Mindustry/archive/refs/tags/$VERSION.zip"
unzip -q -o "$WORK/src.zip" -d "$WORK/src"
SRC=$(find "$WORK/src" -path "*/core/src/mindustry/core/Platform.java" | head -1)
[ -n "$SRC" ] || { echo "Platform.java not found in the $VERSION sources"; exit 1; }

python3 - "$SRC" "$WORK/patched/mindustry/core/Platform.java" <<'PY'
import sys
src, dest = sys.argv[1], sys.argv[2]
text = open(src).read()
old = """        Context context = Context.getCurrentContext();
        if(context == null) context = Context.enter();
        context.setOptimizationLevel(9);
        return context;"""
new = """        // PATCHED: behave like the iOS build - interpreted scripts and Rhino's iOS paths
        System.setProperty("java.vm.name", "RoboVM");
        Context context = Context.getCurrentContext();
        if(context == null) context = Context.enter();
        context.setOptimizationLevel(-1);
        return context;"""
if old not in text:
    sys.exit("could not find getScriptContext() body to patch - has Mindustry changed?")
open(dest, "w").write(text.replace(old, new, 1))
PY

javac --release 17 -nowarn -cp "$BASE_JAR" -d "$WORK/classes" "$WORK/patched/mindustry/core/Platform.java"

cp "$BASE_JAR" "$OUT_JAR"
(cd "$WORK/classes" && jar uf "$OUT_JAR" mindustry/core/Platform.class)

echo "built $OUT_JAR"
echo "run the engine suite against it with: MINDUSTRY_JAR=$OUT_JAR tools/run-tests.sh ios"
