#!/usr/bin/env python3
"""Extract the corpus regression fixtures into the engine-tests scenario block.

Three patches from the 2026-10-29 corpus runs drive the engine checks:

  * `17.msav_scrap_0`       - the deep repair left two free anchors outside its window; the final
                              gap fill takes them (123 -> 125 covered). docs/AUDIT-CORPUS-GAPS.md.
  * `12.msav_titanium_23`   - a drill whose conveyor path to the belt grid was longer than the
                              packing pass's 80-node/12-tile cap; the final repair pass searches
                              farther (3 -> 4 wired drills).
  * `sector-serpulo-165.msav_coal_38` - the worst patch of the belt scoreboard (6/14): its
                              alignment needed a pattern phase outside the old 3x3 search; the
                              6x6 phase candidates plus the layout competition reach 11/14.

Each fixture is placed at the same pattern alignment (mod 6 in both axes) as its corpus patch,
so the engine check reproduces the corpus measurement. The fake world supports one terrain
rectangle, so the crops are stacked with a gutter. Re-run after regenerating the corpus:

    python3 tools/mapdata/extract_regression.py > /tmp/regression.txt
    # then paste over the terrain block in tools/engine-tests.sh
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_corpus import load_patch  # noqa: E402

# name, dump file
PATCHES = [
    ("17.msav_scrap_0", "17.msav_scrap_0.txt"),
    ("12.msav_titanium_23", "12.msav_titanium_23.txt"),
    ("sector-serpulo-165.msav_coal_38", "sector-serpulo-165.msav_coal_38.txt"),
]
# in the free right strip of the 200x140 test world (away from the synthetic patches and the
# power target at 112,20), with >=24 tiles of blank ground around the stack
X0, Y0 = 150, 24
GUTTER = 23


def main():
    repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    manifest = {p["name"]: p for p in json.load(open(os.path.join(repo, "tests/js/fixtures/corpus/manifest.json")))}

    patches = []
    for name, dump in PATCHES:
        mp = manifest[name]
        pi = load_patch(os.path.join("/tmp/opencode/dump2", dump), dump)
        patches.append((name, mp, pi))

    # keep each patch at the corpus pattern alignment: x mod 6 and y mod 6 must match, or the
    # belt tool's phase search sees a different alignment than the corpus run did
    placed = []
    cursor = Y0
    for name, mp, pi in patches:
        x = X0 + ((mp["x"] - X0) % 6)
        y = cursor + ((mp["y"] - cursor) % 6)
        placed.append((name, mp, pi, x, y))
        cursor = y + pi["h"] + GUTTER

    width = max(x - X0 + pi["w"] for _, _, pi, x, _ in placed)
    height = max(y - Y0 + pi["h"] for _, _, pi, _, y in placed)
    grid = [["."] * width for _ in range(height)]

    taps = []
    for name, mp, pi, x, y in placed:
        for ry, row in enumerate(pi["rows"]):
            for rx, ch in enumerate(row):
                grid[y - Y0 + ry][x - X0 + rx] = ch
        taps.append((name, [mp["tap"][0] - mp["x"] + x, mp["tap"][1] - mp["y"] + y]))

    print("    // regression fixtures from the corpus run of 2026-10-29 (see docs/AUDIT-CORPUS-GAPS.md):")
    for name, tap in taps:
        print("    //   %s - tap %s" % (name, tap))
    for i, (name, tap) in enumerate(taps):
        print("    terrainTap%d: [%d, %d]," % (i + 1, tap[0], tap[1]))
    print("    terrain: {")
    print("        x0: %d, y0: %d," % (X0, Y0))
    print("        chars: {l: \"lead\", c: \"copper\", k: \"coal\", t: \"titanium\", h: \"thorium\", s: \"scrap\"},")
    print("        rows: [")
    for row in grid:
        print("            " + json.dumps("".join(row)) + ",")
    print("        ]")
    print("    },")
    return 0


if __name__ == "__main__":
    sys.exit(main())
