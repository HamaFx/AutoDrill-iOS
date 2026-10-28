#!/bin/bash
# Runs the optimiser against a configurable fake world and reports how much of the patch it
# actually mines. Fast (seconds, no game) - use it to tune or debug the fill.
#
#   tools/coverage-probe.sh                                  # defaults: laser, 21x21 square patch
#   WORLD=120 ORE=20,20,100,100 MAXTILES=2000 ./tools/coverage-probe.sh
#   DRILL=mechanicalDrill ROUND=1 ORE=30,30,90,90 ./tools/coverage-probe.sh
#   ORE=30,30,90,90 MINORES=1 ./tools/coverage-probe.sh
set -euo pipefail
cd "$(dirname "$0")/.."

WORLD="${WORLD:-64}"
ORE="${ORE:-20,20,40,40}"
ROUND="${ROUND:-0}"
DRILL="${DRILL:-laserDrill}"
MAXTILES="${MAXTILES:-}"
MINORES="${MINORES:-}"
QUALITY="${QUALITY:-}"

WORLD="$WORLD" ORE="$ORE" ROUND="$ROUND" DRILL="$DRILL" MAXTILES="$MAXTILES" MINORES="$MINORES" \
QUALITY="$QUALITY" python3 - <<'PYEOF'
import os

def s(name):
    return os.environ.get(name, "")

x0, y0, x1, y1 = [int(v) for v in s("ORE").split(",")]
drill = s("DRILL")
# same mapping as OptimizationDrill.getDrillSettingsPrefix
prefix = {"mechanicalDrill": "mechanical", "pneumaticDrill": "pneumatic",
          "laserDrill": "laser", "blastDrill": "airblast",
          "impactDrill": "airblast", "eruptionDrill": "airblast"}[drill]

settings = []
if s("MAXTILES"):
    settings.append('"%s-drill-max-tiles": %s' % (prefix, s("MAXTILES")))
if s("MINORES"):
    settings.append('"%s-drill-min-ores": %s' % (prefix, s("MINORES")))
if s("QUALITY"):
    settings.append('"auto-drill-ios-optimization-quality": %s' % s("QUALITY"))

body = """
AUTODRILL_FAKE_SCENARIO = {
    world: %s,
    ore: {oreX0: %d, oreY0: %d, x1: %d, y1: %d},
    round: %s,
    drill: "%s",
    settings: {%s}
};
""" % (s("WORLD"), x0, y0, x1, y1, "true" if s("ROUND") == "1" else "false", drill,
       ", ".join(settings))

open("tests/js/scenario.js", "w").write(body)
PYEOF

MINDUSTRY_JAR="${MINDUSTRY_JAR:-/tmp/opencode/libs/Mindustry.jar}"
RHINO_JAR="${RHINO_JAR:-/tmp/opencode/rhino.jar}"
STAGE=/tmp/opencode/autodrill-coverage-probe

rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -r scripts "$STAGE/scripts"
cp tests/js/coverage-probe.js "$STAGE/scripts/main.js"

java -Xmx512m -cp "$MINDUSTRY_JAR:$RHINO_JAR:tests/build" ScriptHarness "$STAGE" tests/js/prescript.js tests/harness/global.js
