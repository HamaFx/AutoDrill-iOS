#!/bin/bash
# Verifies the classic package (tools/pack.sh --classic): the packed zip carries the build
# switch and behaves like the original mod - the original drill defaults are shipped and the
# port's extra settings (layout variation, belt lanes, output routing) are not read.
#
#   tools/classic-check.sh          # packs the classic zip, then checks it
#   tools/classic-check.sh <zip>    # checks an already built classic zip
set -euo pipefail
cd "$(dirname "$0")/.."

MINDUSTRY_JAR="${MINDUSTRY_JAR:-/tmp/opencode/libs/Mindustry.jar}"
RHINO_JAR="${RHINO_JAR:-/tmp/opencode/rhino.jar}"
STAGE=/tmp/opencode/autodrill-classic-check
HARNESS="$STAGE/harness"
LOG=/tmp/opencode/classic-check.log

ZIP="${1:-}"
if [ -z "$ZIP" ]; then
    ./tools/pack.sh --classic >/dev/null
    VERSION="$(rg -o 'version: *"([^"]+)"' -r '$1' mod.hjson)"
    ZIP="dist/auto-drill-ios_v${VERSION}-classic.zip"
fi
[ -f "$ZIP" ] || { echo "missing $ZIP"; exit 1; }
[ -f "$MINDUSTRY_JAR" ] || { echo "missing $MINDUSTRY_JAR (run tools/fetch-deps.sh)"; exit 1; }
[ -f "$RHINO_JAR" ] || curl -sL -o "$RHINO_JAR" "https://jitpack.io/com/github/Anuken/rhino/32395f942976a6d1d21ec9877664554cd5762306/rhino-32395f942976a6d1d21ec9877664554cd5762306.jar"

rm -rf "$STAGE"
mkdir -p "$STAGE"
unzip -q "$ZIP" -d "$STAGE"

# 1. the packed zip really carries the switch
grep -q 'exports\.on = true;' "$STAGE/scripts/classic-defaults.js" \
    || { echo "CLASSIC CHECK FAILED: the build switch is not on in $ZIP"; exit 1; }

# 2. behaviour, in the iOS script mode the phone uses
cat > tests/js/scenario.js <<'EOF'
AUTODRILL_FAKE_SCENARIO = {
    world: 120,
    patches: [
        {oreX0: 30, oreY0: 30, x1: 80, y1: 80, round: true}
    ],
    powerTarget: {x: 95, y: 35}
};
EOF

mkdir -p "$HARNESS"
cp -r "$STAGE/scripts" "$HARNESS/scripts"
cp tests/js/classic-tests.js "$HARNESS/scripts/main.js"

[ -f tests/build/ScriptHarness.class ] || javac -cp "$MINDUSTRY_JAR:$RHINO_JAR" -d tests/build tests/harness/ScriptHarness.java

mkdir -p "$(dirname "$LOG")"
java -Xmx1g -cp "$MINDUSTRY_JAR:$RHINO_JAR:tests/build" \
    ScriptHarness "$HARNESS" tests/js/prescript.js tests/harness/global.js | tee "$LOG"

if grep -Eq "CLASSIC-TESTS-RESULT passed=[0-9]+ failed=0$" "$LOG"; then
    echo
    echo "CLASSIC CHECK PASSED - the classic package ships the original mod's defaults"
else
    echo
    echo "CLASSIC CHECK FAILED - see the CHECK FAIL lines above"
    exit 1
fi

# 3. the packed scripts must also load in the iOS script mode (real global.js, ui.js included)
echo "== classic: iOS-mode load =="
java -cp "$MINDUSTRY_JAR:$RHINO_JAR:tests/build" \
    ScriptHarness "$STAGE" - tests/harness/global.js 2>&1 | grep -E "\[harness\] (done|FAILED)" || {
    echo "CLASSIC CHECK FAILED: the packed scripts do not load in iOS mode"
    exit 1
}
echo "classic iOS-mode load passed"
