#!/bin/bash
# Runs the shape sweep (tests/js/shape-sweep.js): how much of each patch shape the engine mines,
# and what a slow multi-restart packer reaches on the same rules - the difference is the honest
# headroom left in the placement engine.
set -euo pipefail
cd "$(dirname "$0")/.."

MINDUSTRY_JAR="${MINDUSTRY_JAR:-/tmp/opencode/libs/Mindustry.jar}"
RHINO_JAR="${RHINO_JAR:-/tmp/opencode/rhino.jar}"
STAGE=/tmp/opencode/autodrill-shape-sweep

cat > tests/js/scenario.js <<'EOF'
AUTODRILL_FAKE_SCENARIO = {
    world: 150,
    patches: [
        {oreX0: 10, oreY0: 10, x1: 33, y1: 33},
        {oreX0: 45, oreY0: 10, x1: 89, y1: 54, round: true},
        {oreX0: 10, oreY0: 60, x1: 59, y1: 85, round: true},
        {oreX0: 70, oreY0: 60, x1: 79, y1: 79},
        {oreX0: 95, oreY0: 10, x1: 134, y1: 10},
        {oreX0: 95, oreY0: 70, x1: 129, y1: 104, band: true},
        {oreX0: 10, oreY0: 100, x1: 40, y1: 130, hole: true},
        {oreX0: 50, oreY0: 100, x1: 90, y1: 101},
        {oreX0: 100, oreY0: 120, x1: 111, y1: 131}
    ]
};
EOF

[ -f tests/build/ScriptHarness.class ] || javac -cp "$MINDUSTRY_JAR:$RHINO_JAR" -d tests/build tests/harness/ScriptHarness.java

rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -r scripts "$STAGE/scripts"
cp tests/js/shape-sweep.js "$STAGE/scripts/main.js"

LOG=$(mktemp)
java -Xmx1g -cp "$MINDUSTRY_JAR:$RHINO_JAR:tests/build" ScriptHarness "$STAGE" tests/js/prescript.js tests/harness/global.js | tee "$LOG"

if grep -q "SWEEP RESULT failures=0" "$LOG"; then
    echo "SHAPE SWEEP PASSED"
else
    echo "SHAPE SWEEP FAILED - see the SWEEP FAIL lines above"
    exit 1
fi
