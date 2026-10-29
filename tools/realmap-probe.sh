#!/bin/bash
# Runs the real-map probe (tests/js/realmap-probe.js) against a terrain fixture exported from
# a real save - the belting/routing audit's measurement rig.
#
#   tools/realmap-probe.sh                                  # the committed Desolate Rift lead vein
#   tools/realmap-probe.sh tests/js/fixtures/other.js
#
# The fixture sets AUTODRILL_FAKE_SCENARIO.terrain (real ores/walls/buildings) and REALMAP
# (the tap of the patch to fill plus the save's existing transport, for the "meets the base"
# check). See docs/AUDIT-BELTING.md for how fixtures are produced from a save export.
set -euo pipefail
cd "$(dirname "$0")/.."

MINDUSTRY_JAR="${MINDUSTRY_JAR:-/tmp/opencode/libs/Mindustry.jar}"
RHINO_JAR="${RHINO_JAR:-/tmp/opencode/rhino.jar}"
STAGE=/tmp/opencode/autodrill-realmap
FIXTURE="${1:-tests/js/fixtures/desolate-rift-lead.js}"

[ -f "$FIXTURE" ] || { echo "missing fixture $FIXTURE"; exit 1; }
[ -f tests/build/ScriptHarness.class ] || javac -cp "$MINDUSTRY_JAR:$RHINO_JAR" -d tests/build tests/harness/ScriptHarness.java

# the fixture doubles as the fake-world scenario and the probe's metadata
cp "$FIXTURE" tests/js/scenario.js

rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -r scripts "$STAGE/scripts"
cp tests/js/realmap-probe.js "$STAGE/scripts/main.js"

java -Xmx2g -cp "$MINDUSTRY_JAR:$RHINO_JAR:tests/build" ScriptHarness "$STAGE" tests/js/prescript.js tests/harness/global.js
