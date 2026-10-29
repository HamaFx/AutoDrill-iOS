#!/bin/bash
# Wall-ore battery: runs the wall fill (plasma bores, ducts, beam nodes) over wall bodies with
# ore on their surfaces and measures, with a faithful BeamDrill simulation, how much of that ore
# the planned bores actually mine.
set -euo pipefail
cd "$(dirname "$0")/.."

MINDUSTRY_JAR="${MINDUSTRY_JAR:-/tmp/opencode/libs/Mindustry.jar}"
RHINO_JAR="${RHINO_JAR:-/tmp/opencode/rhino.jar}"
STAGE=/tmp/opencode/autodrill-wall-probe

cp tests/js/wall-scenarios.js tests/js/scenario.js

rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -r scripts "$STAGE/scripts"
cp tests/js/wall-probe.js "$STAGE/scripts/main.js"

java -Xmx512m -cp "$MINDUSTRY_JAR:$RHINO_JAR:tests/build" ScriptHarness "$STAGE" tests/js/prescript.js tests/harness/global.js
