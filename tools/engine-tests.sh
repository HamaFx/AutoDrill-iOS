#!/bin/bash
# Runs the engine checks (tests/js/engine-tests.js) against a fake world: the fill's promises
# about coverage, overlap and determinism. Seconds per run, no game needed.
set -euo pipefail
cd "$(dirname "$0")/.."

MINDUSTRY_JAR="${MINDUSTRY_JAR:-/tmp/opencode/libs/Mindustry.jar}"
RHINO_JAR="${RHINO_JAR:-/tmp/opencode/rhino.jar}"
STAGE=/tmp/opencode/autodrill-engine-tests

# One world with four ore shapes: a dense square, two round blobs (one squashed) and a small
# patch. Several shapes per run keeps the checks fast and lets them cross-check each other.
cat > tests/js/scenario.js <<'EOF'
AUTODRILL_FAKE_SCENARIO = {
    world: 140,
    patches: [
        {oreX0: 10, oreY0: 10, x1: 33, y1: 33},
        {oreX0: 60, oreY0: 10, x1: 104, y1: 54, round: true},
        {oreX0: 10, oreY0: 60, x1: 59, y1: 85, round: true},
        {oreX0: 70, oreY0: 70, x1: 79, y1: 79},
        {oreX0: 70, oreY0: 100, x1: 109, y1: 100}
    ]
};
EOF

[ -f tests/build/ScriptHarness.class ] || javac -cp "$MINDUSTRY_JAR:$RHINO_JAR" -d tests/build tests/harness/ScriptHarness.java

rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -r scripts "$STAGE/scripts"
cp tests/js/engine-tests.js "$STAGE/scripts/main.js"

java -Xmx512m -cp "$MINDUSTRY_JAR:$RHINO_JAR:tests/build" ScriptHarness "$STAGE" tests/js/prescript.js tests/harness/global.js
