#!/bin/bash
# iOS-mode load test: runs the mod's scripts through Rhino exactly as the iOS build does
# (optimization level -1, Kit.isIos == true), using the real global.js from the game jar.
#
# Also statically rejects the patterns iOS cannot execute.
set -euo pipefail
cd "$(dirname "$0")/.."

MINDUSTRY_JAR="${MINDUSTRY_JAR:-/tmp/opencode/libs/Mindustry.jar}"
RHINO_JAR="${RHINO_JAR:-/tmp/opencode/rhino.jar}"
RHINO_COMMIT=32395f942976a6d1d21ec9877664554cd5762306

[ -f "$MINDUSTRY_JAR" ] || { echo "missing $MINDUSTRY_JAR (run tools/fetch-deps.sh)"; exit 1; }
[ -f "$RHINO_JAR" ] || curl -sL -o "$RHINO_JAR" "https://jitpack.io/com/github/Anuken/rhino/$RHINO_COMMIT/rhino-$RHINO_COMMIT.jar"

echo "== static check: names that collide with Mindustry's global.js =="
python3 tools/check-global-collisions.py tests/harness/global.js scripts tests/ingame

echo "== static check: every local var is initialised (Rhino's iOS interpreter loses uninitialised locals) =="
if rg -n '\bvar\s+[A-Za-z_$][A-Za-z0-9_$]*\s*[,;]' scripts tests/ingame; then
    echo "FAIL: declare locals with an initial value (var x = null;)"; exit 1
fi

echo "== static check: no class subclassing / bytecode generation =="
if rg -n "JavaAdapter|extend\(|new java\.lang\.Thread|org\.mozilla" scripts/ ; then
    echo "FAIL: iOS cannot execute these patterns"; exit 1
fi
# every 'new X(){...}' must be an interface from arc.func / mindustry / java.lang
if rg -n "new [A-Za-z0-9_.$]+\(\)\s*\{" scripts/ ; then
    echo "NOTE: check the lines above - only interfaces may be implemented this way"
fi

echo "== extracting global.js from the game jar =="
mkdir -p tests/harness
unzip -o -q "$MINDUSTRY_JAR" "scripts/global.js" -d tests/harness/extract
cp tests/harness/extract/scripts/global.js tests/harness/global.js

echo "== compiling harness =="
mkdir -p tests/build
javac -cp "$MINDUSTRY_JAR:$RHINO_JAR" -d tests/build tests/harness/ScriptHarness.java

echo "== running mod in iOS script mode =="
java -cp "$MINDUSTRY_JAR:$RHINO_JAR:tests/build" ScriptHarness . - tests/harness/global.js

echo
echo "iOS-mode check passed."
