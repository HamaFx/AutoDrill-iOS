#!/bin/bash
# Verifies the iOS edition stands down when another mod called "auto-drill" is enabled.
set -euo pipefail
cd "$(dirname "$0")/.."

DATA="$HOME/.local/share/Mindustry"
MODS="$DATA/mods"
DISP=":92"
JAR="/tmp/opencode/libs/Mindustry-iossim.jar"
LOG="/tmp/opencode/mr/guard.log"

mkdir -p "$(dirname "$LOG")"
# Mindustry writes launchid.dat on start and deletes it on a clean exit: if it is
# left behind (killed run), the next start disables ALL mods.
rm -f "$DATA/settings.bin" "$DATA/settings_backup.bin" "$DATA/launchid.dat"
mkdir -p "$MODS"
rm -rf "$MODS"/*

rsync -a --exclude dist --exclude tests --exclude tools --exclude docs --exclude .git \
    --exclude node_modules --exclude package.json --exclude eslint.config.mjs ./ "$MODS/auto-drill-ios/"
rsync -a --exclude dist --exclude tools --exclude docs --exclude .git \
    tests/ingame/fake-java-autodrill/ "$MODS/auto-drill/"
rsync -a --exclude dist --exclude tools --exclude docs --exclude .git \
    tests/ingame/autodrill-guard/ "$MODS/autodrill-guard/"

Xvfb "$DISP" -screen 0 1280x800x24 >/dev/null 2>&1 &
XVFB_PID=$!
sleep 2

DISPLAY="$DISP" java -jar "$JAR" > "$LOG" 2>&1 &
GAME_PID=$!

for _ in $(seq 1 45); do
    sleep 2
    if grep -q "AUTODRILL-GUARD-RESULT" "$LOG" 2>/dev/null; then
        break
    fi
done

kill "$GAME_PID" 2>/dev/null || true
sleep 2
kill "$XVFB_PID" 2>/dev/null || true

grep -E "\[autodrill-guard\]|\[auto-drill-ios\]" "$LOG" | sed 's/.*\[/  [/' | tail -6

if grep -q "AUTODRILL-GUARD-RESULT passed=[0-9]* failed=0" "$LOG"; then
    echo "GUARD CHECK PASSED"
else
    echo "GUARD CHECK FAILED - see $LOG"
    exit 1
fi
