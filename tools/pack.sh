#!/bin/bash
# Builds the installable mod zip. Only runtime files end up in the archive.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(rg -o 'version: *"([^"]+)"' -r '$1' mod.hjson)"
OUT="dist/auto-drill-ios_v${VERSION}.zip"

rm -rf dist
mkdir -p dist

zip -q -r "$OUT" \
    mod.hjson \
    scripts \
    sprites \
    bundles \
    README.md \
    LICENSE

echo "built $OUT"
unzip -l "$OUT"
