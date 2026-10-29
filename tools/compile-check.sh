#!/bin/bash
# Does the *compiled* script engine (the desktop/normal build) accept the scripts?
#
# The interpreted iOS engine and Rhino's optimizer disagree: code that runs fine interpreted can
# make the optimizer emit invalid bytecode ("Stack underflow"), and the mod then fails to load
# on desktop/Android. That error happens while the mods load, ~7 seconds in, so this check only
# waits for the load phase instead of running the whole suite.
#
#   tools/compile-check.sh          # expects a clean load
set -euo pipefail
cd "$(dirname "$0")/.."

DATA="$HOME/.local/share/Mindustry"
MODS="$DATA/mods"
DISP=":94"
JAR="${MINDUSTRY_JAR:-/tmp/opencode/libs/Mindustry.jar}"
LOG=/tmp/opencode/mr/compile-check.log
WAIT="${WAIT:-40}"

rm -f "$DATA/settings.bin" "$DATA/settings_backup.bin" "$DATA/launchid.dat"
mkdir -p "$MODS"
rm -rf "$MODS"/*
rsync -a --exclude dist --exclude tests --exclude tools --exclude docs --exclude .git \
    --exclude node_modules --exclude package.json --exclude eslint.config.mjs ./ "$MODS/auto-drill-ios/"

Xvfb "$DISP" -screen 0 1280x800x24 >/dev/null 2>&1 &
XVFB_PID=$!
sleep 2

DISPLAY="$DISP" java -jar "$JAR" > "$LOG" 2>&1 &
GAME_PID=$!

for i in $(seq 1 "$WAIT"); do
    sleep 1
    if grep -q "Total time to load" "$LOG" 2>/dev/null; then break; fi
done
sleep 2

kill "$GAME_PID" 2>/dev/null || true
sleep 1
kill "$XVFB_PID" 2>/dev/null || true

if grep -q "Stack underflow\|IllegalStateException\|EvaluatorException\|Exception while compiling" "$LOG"; then
    echo "COMPILE CHECK FAILED - the compiled engine rejected the scripts:"
    grep -E "Stack underflow|IllegalStateException|EvaluatorException|Exception while compiling" "$LOG" | head -5
    exit 1
fi

if ! grep -q "Total time to load" "$LOG"; then
    echo "COMPILE CHECK INCONCLUSIVE - the game did not reach the end of loading (see $LOG)"
    exit 1
fi

echo "COMPILE CHECK PASSED - the compiled engine loaded the mod"
