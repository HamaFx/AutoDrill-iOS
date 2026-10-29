#!/bin/bash
# Boots the real game under Xvfb with the committed mapdump mod (+ any content mods the save
# export has) and waits for the dump to finish. The dump is the raw material of the committed
# real-map corpus (tests/js/fixtures/corpus/); see tools/mapdata/README.md.
#
#   mkdir -p /tmp/game-data && unzip tests/game-data/2026-10-29-save-export.zip -d /tmp/game-data
#   SOURCE=/tmp/game-data OUT=/tmp/opencode/dump2 ./tools/mapdump.sh
#
# Environment:
#   SOURCE        game-data export root (saves/ and maps/ are read; mods/ is copied when present)
#   OUT           where the text dumps go (default /tmp/opencode/dump2)
#   CONTENT_MODS  mods directory for saves that reference third-party content (default SOURCE/mods)
set -euo pipefail
cd "$(dirname "$0")/.."

SOURCE="${SOURCE:-/tmp/game-data}"
OUT="${OUT:-/tmp/opencode/dump2}"
CONTENT_MODS="${CONTENT_MODS:-$SOURCE/mods}"

DATA="$HOME/.local/share/Mindustry"
MODS="$DATA/mods"
DISP=":93"
JAR="${MINDUSTRY_JAR:-/tmp/opencode/libs/Mindustry.jar}"
LOG=/tmp/opencode/mr/mapdump.log

[ -f "$JAR" ] || { echo "missing $JAR"; exit 1; }
[ -d "$SOURCE/saves" ] || { echo "missing $SOURCE/saves - extract the committed export first"; exit 1; }

mkdir -p "$(dirname "$LOG")" "$OUT"
rm -f "$DATA/settings.bin" "$DATA/settings_backup.bin" "$DATA/launchid.dat"
mkdir -p "$MODS"
rm -rf "$MODS"/*

# the dump mod is a dev tool: it lives in tests/ so tools/pack.sh never ships it
cp -r tests/ingame/autodrill-mapdump "$MODS/mapdump"

# content mods the saves may reference (the AutoDrill mods themselves are not needed here)
if [ -d "$CONTENT_MODS" ]; then
    for m in "$CONTENT_MODS"/*.zip; do
        [ -f "$m" ] || continue
        case "$(basename "$m")" in
            *autodrill*|*AutoDrill*|*auto-drill*) continue ;;
        esac
        cp "$m" "$MODS/"
    done
else
    echo "note: no content mods at $CONTENT_MODS - saves that reference them will LOAD FAILED"
fi

Xvfb "$DISP" -screen 0 1280x800x24 >/dev/null 2>&1 &
XVFB_PID=$!
sleep 2

MAPDUMP_SOURCE="$SOURCE" MAPDUMP_OUT="$OUT" DISPLAY="$DISP" java -Xmx2g -jar "$JAR" > "$LOG" 2>&1 &
GAME_PID=$!

for _ in $(seq 1 150); do
    sleep 2
    if grep -q "MAPDUMP-DONE" "$LOG" 2>/dev/null; then break; fi
done

kill "$GAME_PID" 2>/dev/null || true
sleep 1
kill "$XVFB_PID" 2>/dev/null || true

echo "== dump summary =="
grep -E "\[mapdump\]" "$LOG" | sed 's/.*\[mapdump\]/  /' | tail -60
if grep -q "MAPDUMP-DONE" "$LOG"; then echo "MAP DUMP COMPLETE"; else echo "MAP DUMP INCOMPLETE - see $LOG"; exit 1; fi
echo "dumps: $(ls "$OUT" | wc -l) files in $OUT"
