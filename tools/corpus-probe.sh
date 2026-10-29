#!/bin/bash
# Runs the corpus scoreboard (tests/js/corpus-probe.js) over the committed real-map corpus.
#
#   ./tools/corpus-probe.sh                  # every patch (offline; minutes)
#   ./tools/corpus-probe.sh --quick          # the first 12 patches - the committed gate
#   ./tools/corpus-probe.sh --list           # one line per patch, no fills
#   ./tools/corpus-probe.sh --dump-candidates > cands.txt   # VEIN dump for tools/vein-solve.py
#   ./tools/corpus-probe.sh --teacher        # BELT-REF reference-pack labels for the teacher
#   ./tools/corpus-probe.sh --json out.json  # per-patch plans + left tiles + classes
#
# The corpus world is staged as tests/js/scenario.js (the probes' scenario slot). The script
# exits non-zero when the probe reports any CORPUS-FAIL line or the harness crashes.
set -euo pipefail
cd "$(dirname "$0")/.."

MINDUSTRY_JAR="${MINDUSTRY_JAR:-/tmp/opencode/libs/Mindustry.jar}"
RHINO_JAR="${RHINO_JAR:-/tmp/opencode/rhino.jar}"
STAGE=/tmp/opencode/autodrill-corpus-probe

MODE=full
JSON_PATH=""
while [ $# -gt 0 ]; do
    case "$1" in
        --quick) MODE=quick ;;
        --list) MODE=list ;;
        --dump-candidates) MODE=dump ;;
        --teacher) MODE=teacher ;;
        --json) MODE=json; JSON_PATH="${2:?--json needs an output path}"; shift ;;
        *) echo "unknown argument: $1 (see the header of tools/corpus-probe.sh)"; exit 1 ;;
    esac
    shift
done

[ -f tests/js/fixtures/corpus/world.js ] || { echo "missing corpus - run tools/mapdata/build_corpus.py first"; exit 1; }
[ -f tests/build/ScriptHarness.class ] || javac -cp "$MINDUSTRY_JAR:$RHINO_JAR" -d tests/build tests/harness/ScriptHarness.java

cp tests/js/fixtures/corpus/world.js tests/js/scenario.js

rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -r scripts "$STAGE/scripts"
cp tests/js/corpus-probe.js "$STAGE/scripts/main.js"

LOG=$(mktemp)
set +e
AUTODRILL_CORPUS_MODE="$MODE" AUTODRILL_CORPUS_JSON="$JSON_PATH" \
AUTODRILL_CORPUS_LIMIT="${AUTODRILL_CORPUS_LIMIT:-0}" \
    java -Xmx2g -cp "$MINDUSTRY_JAR:$RHINO_JAR:tests/build" \
    ScriptHarness "$STAGE" tests/js/prescript.js tests/harness/global.js | tee "$LOG"
status=${PIPESTATUS[0]}
set -e

if grep -q "CORPUS-FAIL" "$LOG"; then
    echo "CORPUS PROBE FAILED - see the CORPUS-FAIL lines above"
    exit 1
fi
if [ "$status" -ne 0 ]; then
    echo "CORPUS PROBE CRASHED (harness exit $status)"
    exit 1
fi
