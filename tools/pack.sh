#!/bin/bash
# Builds the installable mod zip. Only runtime files end up in the archive.
#
#   tools/pack.sh            # the standard build  -> dist/auto-drill-ios_v<version>.zip
#   tools/pack.sh --classic  # the classic build   -> dist/auto-drill-ios_v<version>-classic.zip
#
# The classic build (scripts/classic-defaults.js, flipped on here) ships the original Java
# mod's drill defaults and settings page. The repo copy always stays off.
set -euo pipefail
cd "$(dirname "$0")/.."

CLASSIC=false
if [ "${1:-}" = "--classic" ]; then
    CLASSIC=true
elif [ $# -gt 0 ]; then
    echo "unknown argument: $1 (see the header of tools/pack.sh)" >&2
    exit 1
fi

VERSION="$(rg -o 'version: *"([^"]+)"' -r '$1' mod.hjson)"

rm -rf dist
mkdir -p dist

FILES=(mod.hjson scripts sprites bundles README.md LICENSE)

if $CLASSIC; then
    OUT="dist/auto-drill-ios_v${VERSION}-classic.zip"
    OUT_ABS="$(pwd)/$OUT"
    STAGE=/tmp/opencode/autodrill-classic-pack
    rm -rf "$STAGE"
    mkdir -p "$STAGE"
    trap 'rm -rf "$STAGE"' EXIT
    cp -r "${FILES[@]}" "$STAGE/"

    python3 - "$STAGE" <<'PY'
import pathlib, sys
stage = pathlib.Path(sys.argv[1])

def sub_once(path, old, new):
    text = path.read_text()
    if old not in text:
        sys.exit("classic pack: pattern not found in %s: %r" % (path, old))
    path.write_text(text.replace(old, new, 1))

# the build switch: the classic package ships the original mod's drill defaults
sub_once(stage / "scripts/classic-defaults.js", "exports.on = false;", "exports.on = true;")

# the mod list should say which of the two builds is installed
sub_once(stage / "mod.hjson",
         'displayName: "AutoDrill (iOS)"',
         'displayName: "AutoDrill (iOS) Classic"')
sub_once(stage / "mod.hjson",
         'description: "Adds tools',
         "description: \"Classic build: ships the original mod's drill defaults. Adds tools")
PY

    (cd "$STAGE" && zip -q -r "$OUT_ABS" "${FILES[@]}")
else
    if grep -q 'exports\.on = true' scripts/classic-defaults.js; then
        echo "scripts/classic-defaults.js is on - refusing to build the standard zip" >&2
        exit 1
    fi
    OUT="dist/auto-drill-ios_v${VERSION}.zip"
    zip -q -r "$OUT" "${FILES[@]}"
fi

echo "built $OUT"
unzip -l "$OUT"
