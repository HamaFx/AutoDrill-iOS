#!/bin/bash
# Points the classic release tag at a commit whose *tree* is the classic build.
#
# Why: for script mods the in-game browser downloads the repository tree at the release's tag
# (the "zipball"), not the release's zip asset. A tag sitting on the standard main tree would
# therefore silently install the standard build. This stages the same patch
# tools/pack.sh --classic applies, commits it in a temporary worktree and points the tag at
# that commit; the main checkout and every other ref stay standard.
#
#   tools/classic-tag.sh                    # tag v<version>-classic, local only
#   tools/classic-tag.sh --push             # same, force-pushes the tag to origin
#   tools/classic-tag.sh v1.2.3-classic --push
set -euo pipefail
cd "$(dirname "$0")/.."

PUSH=false
TAG=""
for arg in "$@"; do
    case "$arg" in
        --push) PUSH=true ;;
        -*) echo "unknown option: $arg (see the header of tools/classic-tag.sh)" >&2; exit 1 ;;
        *) TAG="$arg" ;;
    esac
done
[ -n "$TAG" ] || TAG="v$(rg -o 'version: *"([^"]+)"' -r '$1' mod.hjson)-classic"

BASE="$(git rev-parse HEAD)"
TMP="$(mktemp -d /tmp/opencode/autodrill-classic-tree.XXXXXX)"
WORKTREE="$TMP/tree"

cleanup(){
    git worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
    rm -rf "$TMP"
}
trap cleanup EXIT

git worktree add -q --detach "$WORKTREE" "$BASE"
python3 tools/classic-patch.py "$WORKTREE"
git -C "$WORKTREE" add -A
git -C "$WORKTREE" commit -q -m "classic: $TAG runtime tree

The in-game mod browser installs script mods from the repository tree at the release tag, so
this commit carries the classic build's switch and package marking for $TAG. Created by
tools/classic-tag.sh; the main branch and every other ref stay standard."

COMMIT="$(git -C "$WORKTREE" rev-parse HEAD)"
git tag -a -f "$TAG" "$COMMIT" -m "AutoDrill iOS ${TAG#v} [v160]"
echo "tagged $TAG -> $COMMIT (base $BASE)"

if $PUSH; then
    git push --force origin "refs/tags/$TAG"
    echo "pushed $TAG"
else
    echo "(local only - re-run with --push to update origin)"
fi
