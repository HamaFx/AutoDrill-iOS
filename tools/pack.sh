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

    # the same patch tools/classic-tag.sh applies to the release tag tree
    python3 tools/classic-patch.py "$STAGE"

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
