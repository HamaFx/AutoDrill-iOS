#!/bin/bash
# Publishes the current version: packs the mod and creates/updates the GitHub release with
# the build tag in its title (that tag is what the in-game browser matches on).
#
# This is the same thing .github/workflows/release.yml does on a tag push - kept as a local
# fallback so publishing never depends on GitHub Actions being available.
#
#   tools/publish.sh                # standard build, release v<version>
#   tools/publish.sh --classic      # classic build, prerelease v<version>-classic
#   tools/publish.sh 1.2.0 [v161]   # explicit version and build tag (standard build)
#
# The classic build is a separate, manual-import package (same mod, original mod's defaults);
# it is published as a prerelease so the standard build keeps the "Latest" badge.
set -euo pipefail
cd "$(dirname "$0")/.."

CLASSIC=false
if [ "${1:-}" = "--classic" ]; then
    CLASSIC=true
    shift
fi

VERSION="${1:-$(rg -o 'version: *"([^"]+)"' -r '$1' mod.hjson)}"
BUILD_TAG="${2:-v160}"

if $CLASSIC; then
    TAG="v$VERSION-classic"
    ZIP="dist/auto-drill-ios_v${VERSION}-classic.zip"
    TITLE="AutoDrill iOS $VERSION classic [$BUILD_TAG]"
    NOTES="The classic build of the iOS port: drill defaults and settings match the original Java mod (mechanical 200, pneumatic 150, laser 100, airblast 100 max tiles; min ores 1/2/5/9; the port's extra settings are not shown or used). Import \`$ZIP\` manually (Mods -> Import -> File); it replaces the standard build of the same mod. Requires Mindustry 8.160 or newer."
    ./tools/pack.sh --classic >/dev/null
else
    TAG="v$VERSION"
    ZIP="dist/auto-drill-ios_v${VERSION}.zip"
    TITLE="AutoDrill iOS $VERSION [$BUILD_TAG]"
    NOTES="Requires Mindustry 8.160 or newer. Install from the in-game mod browser, or import \`$ZIP\` manually (Mods -> Import -> File)."
    ./tools/pack.sh >/dev/null
fi

echo "packed $ZIP"

if gh release view "$TAG" >/dev/null 2>&1; then
    gh release upload "$TAG" "$ZIP" --clobber
    echo "updated release $TAG"
elif $CLASSIC; then
    gh release create "$TAG" "$ZIP" \
        --title "$TITLE" \
        --notes "$NOTES" \
        --prerelease
    echo "created release $TAG"
else
    gh release create "$TAG" "$ZIP" \
        --title "$TITLE" \
        --notes "$NOTES"
    echo "created release $TAG"
fi

echo
echo "Next: the in-game update prompt appears after the MindustryMods listing refreshes"
echo "(every ~2 hours). Keep 'version' in mod.hjson in sync with the tag."
