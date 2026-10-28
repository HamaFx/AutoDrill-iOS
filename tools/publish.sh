#!/bin/bash
# Publishes the current version: packs the mod and creates/updates the GitHub release with
# the build tag in its title (that tag is what the in-game browser matches on).
#
# This is the same thing .github/workflows/release.yml does on a tag push - kept as a local
# fallback so publishing never depends on GitHub Actions being available.
#
#   tools/publish.sh            # uses the version from mod.hjson
#   tools/publish.sh 1.2.0 [v161]  # explicit version and build tag
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-$(rg -o 'version: *"([^"]+)"' -r '$1' mod.hjson)}"
BUILD_TAG="${2:-v160}"
TAG="v$VERSION"
ZIP="dist/auto-drill-ios_v${VERSION}.zip"

./tools/pack.sh >/dev/null
echo "packed $ZIP"

if gh release view "$TAG" >/dev/null 2>&1; then
    gh release upload "$TAG" "$ZIP" --clobber
    echo "updated release $TAG"
else
    gh release create "$TAG" "$ZIP" \
        --title "AutoDrill iOS $VERSION [$BUILD_TAG]" \
        --notes "Requires Mindustry 8.160 or newer. Install from the in-game mod browser, or import \`$ZIP\` manually (Mods -> Import -> File)."
    echo "created release $TAG"
fi

echo
echo "Next: the in-game update prompt appears after the MindustryMods listing refreshes"
echo "(every ~2 hours). Keep 'version' in mod.hjson in sync with the tag."
