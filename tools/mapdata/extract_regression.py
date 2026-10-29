#!/usr/bin/env python3
"""Extract the corpus regression fixtures into the engine-tests scenario block.

Two patches from the 2026-10-29 corpus run (docs/AUDIT-CORPUS-GAPS.md) drive the engine checks:

  * `17.msav_scrap_0`      - the deep repair left two free anchors outside its window; the final
                             gap fill takes them (123 -> 125 covered).
  * `12.msav_titanium_23`  - a drill whose convector path to the belt grid was longer than the
                             packing pass's 80-node/12-tile cap; the final repair pass now
                             searches farther (3 -> 4 wired drills).

The fake world supports one terrain rectangle, so both crops are pasted into one region with a
2-tile gutter. Re-run after regenerating the corpus:

    python3 tools/mapdata/extract_regression.py > /tmp/regression.txt
    # then paste over the terrain block in tools/engine-tests.sh (between MARKER lines)
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_corpus import load_patch  # noqa: E402

# name, dump file, corpus placement x, y (from the manifest)
PATCHES = [
    ("17.msav_scrap_0", "17.msav_scrap_0.txt"),
    ("12.msav_titanium_23", "12.msav_titanium_23.txt"),
]
# stacked in the free right strip of the test world (away from the synthetic patches and the
# power target at 112,20); the world is widened to 200 so every crop keeps >=24 tiles of blank
# ground around it, like a corpus patch keeps its 10-tile gutter. The offsets are chosen
# congruent (mod 6) to the corpus coordinates: the belt tool's pattern has period 6 and its
# phase search only covers offsets 0..2, so a different congruence would produce a different
# (still legal) layout and the fixture would not reproduce the measured patch.
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

    width = max(p[2]["w"] for p in patches)
    height = sum(p[2]["h"] for p in patches) + GUTTER * (len(patches) - 1)
    grid = [["."] * width for _ in range(height)]

    cursor = 0
    taps = []
    for name, mp, pi in patches:
        for ry, row in enumerate(pi["rows"]):
            for rx, ch in enumerate(row):
                grid[cursor + ry][rx] = ch
        taps.append((name, [mp["tap"][0] - mp["x"] + X0, mp["tap"][1] - mp["y"] + Y0 + cursor]))
        cursor += pi["h"] + GUTTER

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
