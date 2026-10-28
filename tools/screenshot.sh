#!/bin/bash
# Runs the game headless, shows one piece of the mod's UI, and saves a screenshot.
#   tools/screenshot.sh <toolbar|tutorial|settings> <outfile.png>
set -euo pipefail
cd "$(dirname "$0")/.."

MODE="${1:?usage: screenshot.sh <toolbar|tutorial|settings> <out.png>}"
OUT="${2:?usage: screenshot.sh <toolbar|tutorial|settings> <out.png>}"
JAR="${MINDUSTRY_JAR:-/tmp/opencode/libs/Mindustry-iossim.jar}"
MODS="$HOME/.local/share/Mindustry/mods"
DISP=":77"

mkdir -p "$(dirname "$OUT")"

# stage the mods under test
rm -rf "$MODS/auto-drill-ios" "$MODS/autodrill-visual"
rsync -a --exclude dist --exclude tests --exclude tools --exclude docs --exclude .git \
    --exclude node_modules --exclude package.json --exclude eslint.config.mjs ./ "$MODS/auto-drill-ios/"
rsync -a --exclude dist --exclude tools --exclude docs --exclude .git \
    tests/ingame/autodrill-visual/ "$MODS/autodrill-visual/"

sed -i "s/^var MODE = .*/var MODE = \"$MODE\"; \/\/ toolbar | tutorial | settings/" "$MODS/autodrill-visual/scripts/main.js"

Xvfb "$DISP" -screen 0 1280x800x24 >/dev/null 2>&1 &
XVFB_PID=$!
sleep 2

DISPLAY="$DISP" java -jar "$JAR" >"/tmp/opencode/mr/screenshot-$MODE.log" 2>&1 &
GAME_PID=$!

# wait for the driver to report, then let it render a few frames
for _ in $(seq 1 60); do
    sleep 1
    if grep -q "\[autodrill-visual\] mode:" "/tmp/opencode/mr/screenshot-$MODE.log" 2>/dev/null; then
        break
    fi
done
sleep 6

DISPLAY="$DISP" import -window root "$OUT" 2>/dev/null || DISPLAY="$DISP" xwd -root | convert xwd:- "$OUT"

kill "$GAME_PID" 2>/dev/null || true
sleep 1
kill "$XVFB_PID" 2>/dev/null || true

grep -E "\[autodrill-visual\]|\[auto-drill-ios\]" "/tmp/opencode/mr/screenshot-$MODE.log" | head -5
echo "saved $OUT"
