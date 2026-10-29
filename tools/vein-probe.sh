#!/bin/bash
# Shape battery for the fill engine: runs a library of awkward ore shapes (thin veins, steps,
# branches, tendrils, rings, combs, walk veins) through the optimiser against the fake world and
# reports coverage plus a per-tile diagnosis, with a randomized-restart reference per shape.
#
#   tools/vein-probe.sh            # the whole battery
#   tools/vein-probe.sh blob7      # only shapes whose name contains "blob7"
set -euo pipefail
cd "$(dirname "$0")/.."

MINDUSTRY_JAR="${MINDUSTRY_JAR:-/tmp/opencode/libs/Mindustry.jar}"
RHINO_JAR="${RHINO_JAR:-/tmp/opencode/rhino.jar}"
STAGE=/tmp/opencode/autodrill-vein-probe
FILTER="${1:-}"

cp tests/js/vein-scenarios.js tests/js/scenario.js

rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -r scripts "$STAGE/scripts"
cp tests/js/vein-probe.js "$STAGE/scripts/main.js"

AUTODRILL_VEIN_FILTER="$FILTER" \
    java -Xmx1g -cp "$MINDUSTRY_JAR:$RHINO_JAR:tests/build" ScriptHarness "$STAGE" tests/js/prescript.js tests/harness/global.js
