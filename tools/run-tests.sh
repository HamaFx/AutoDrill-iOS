#!/bin/bash
# Runs the in-engine test suite inside the real game.
#   tools/run-tests.sh normal   -> desktop script engine (compiled)
#   tools/run-tests.sh ios      -> patched jar: interpreted JS + Rhino's iOS interface path
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:?usage: run-tests.sh <normal|ios>}"
DATA="$HOME/.local/share/Mindustry"
MODS="$DATA/mods"
DISP=":91"
JAR="/tmp/opencode/libs/Mindustry.jar"
LOG="/tmp/opencode/mr/suite-$MODE.log"
SHOTS="dist/screenshots"

if [ "$MODE" = "ios" ]; then
    JAR="/tmp/opencode/libs/Mindustry-iossim.jar"
fi
[ -f "$JAR" ] || { echo "missing $JAR (see docs/plans for how it is built)"; exit 1; }

mkdir -p "$(dirname "$LOG")" "$SHOTS"

# a killed game makes Mindustry disable all mods on the next start - always start clean
# Mindustry writes launchid.dat on start and deletes it on a clean exit: if it is
# left behind (killed run), the next start disables ALL mods.
rm -f "$DATA/settings.bin" "$DATA/settings_backup.bin" "$DATA/launchid.dat"
mkdir -p "$MODS"
rm -rf "$MODS"/*

rsync -a --exclude dist --exclude tests --exclude tools --exclude docs --exclude .git \
    --exclude node_modules --exclude package.json --exclude eslint.config.mjs ./ "$MODS/auto-drill-ios/"
rsync -a --exclude dist --exclude tools --exclude docs --exclude .git \
    tests/ingame/autodrill-test/ "$MODS/autodrill-test/"

Xvfb "$DISP" -screen 0 1280x800x24 >/dev/null 2>&1 &
XVFB_PID=$!
sleep 2

DISPLAY="$DISP" java -jar "$JAR" > "$LOG" 2>&1 &
GAME_PID=$!

for _ in $(seq 1 60); do
    sleep 2
    if grep -q "AUTODRILL-TEST-RESULT" "$LOG" 2>/dev/null; then
        break
    fi
    if grep -q "OutOfMemoryError" "$LOG" 2>/dev/null; then
        echo "(run aborted early: OutOfMemoryError)"
        break
    fi
done

DISPLAY="$DISP" import -window root "$SHOTS/suite-$MODE.png" 2>/dev/null || true

kill "$GAME_PID" 2>/dev/null || true
sleep 2
kill "$XVFB_PID" 2>/dev/null || true

echo "== mode: $MODE =="
grep -E "\[autodrill-test\]" "$LOG" | sed 's/.*\[autodrill-test\]/  /' | tail -12

if grep -q "AUTODRILL-TEST-RESULT passed=[0-9]* failed=0" "$LOG"; then
    echo "SUITE PASSED ($MODE)"
else
    echo "SUITE FAILED ($MODE) - see $LOG"
    grep -E "FAIL|threw|failed=" "$LOG" | head -20
    exit 1
fi
