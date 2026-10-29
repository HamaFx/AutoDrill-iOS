#!/usr/bin/env python3
"""Build the committed real-map shape corpus from mapdump regions.

Every mapdump region (tools/mapdump.sh output) is cropped to the patch bbox +- CROP_PAD tiles,
and the patches are packed side by side into one fake world with >= GUTTER tiles between any
two patches' crop boxes. The output is a single scenario file plus a manifest:

    tests/js/fixtures/corpus/world.js       AUTODRILL_FAKE_SCENARIO + CORPUS (load as scenario.js)
    tests/js/fixtures/corpus/manifest.json  the same metadata, Python-readable

Only the six Serpulo drill ores are kept (lead, copper, coal, titanium, thorium, scrap); dumps
of other ores (Erekir, modded) are skipped - the fake world's terrain alphabet has no char for
them. The dumps come from one game-data export, so the corpus is deterministic: inputs sorted
by file name, saves picked round-robin, no timestamps in the output.

    python3 tools/mapdata/build_corpus.py /tmp/opencode/dump2 tests/js/fixtures/corpus
"""
import argparse
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_fixture import parse_dump, region_of, char_of  # noqa: E402

ORE_CHARS = {"ore-lead": "l", "ore-copper": "c", "ore-coal": "k", "ore-titanium": "t",
             "ore-thorium": "h", "ore-scrap": "s"}
ORE_SHORT = ("lead", "copper", "coal", "titanium", "thorium", "scrap")

CROP_PAD = 6        # tiles of real terrain kept around the patch bbox
GUTTER = 10         # minimum free tiles between two patches' crop boxes
MAX_SIDE = 512      # the fake world may not exceed this on either side
MAX_PATCHES = 320   # hard cap on selected patches before packing
AREA_BUDGET = 245000  # selected crop areas must stay under this (the world holds ~254k)

DUMP_RE = re.compile(r"^(.*)_([a-z-]+)_(\d+)\.txt$")
MIN_TILES = 12      # the dumper's component floor, applied to buildable (mineable) cells


def flood_cells(grid, tap, want):
    """8-connected component of buildable `want` cells containing tap.

    The fake world cannot hold ore under a wall: wall-ore tiles are '#' (solid, no drop), so
    they do not connect two pockets of a real component. This uses the same rule the engine
    will see - a patch is the connected run of buildable ore chars from the tap.
    """
    seen = {tap}
    stack = [tap]
    cells = []
    while stack:
        cur = stack.pop()
        cells.append(cur)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                nxt = (cur[0] + dx, cur[1] + dy)
                if nxt in seen:
                    continue
                cell = grid.get(nxt)
                if cell is None or char_of(*cell) != want:
                    continue
                seen.add(nxt)
                stack.append(nxt)
    return cells


def load_patch(path, fname):
    hdr, grid = parse_dump(path)
    ore_overlay = hdr.get("ore", "")
    want = ORE_CHARS.get(ore_overlay)
    if want is None:
        raise ValueError(f"{fname}: unknown ore overlay {ore_overlay!r}")
    dump_tap = tuple(int(v) for v in hdr["tap"].split(","))
    cell = grid.get(dump_tap)
    if cell is None or cell[1] != ore_overlay:
        raise ValueError(f"{fname}: tap tile {dump_tap} is not {ore_overlay}")

    # The dump's tap is the component's middle tile, which can be a wall ore (solid block,
    # never minable). The engine needs a free ore tile to start from: take the buildable cell
    # nearest the dump tap.
    tap = dump_tap
    if char_of(*grid[tap]) != want:
        best = None
        best_d = None
        for c in grid:
            if grid[c][1] != ore_overlay or char_of(*grid[c]) != want:
                continue
            d = (c[0] - dump_tap[0]) ** 2 + (c[1] - dump_tap[1]) ** 2
            if best is None or d < best_d:
                best, best_d = c, d
        if best is None:
            # every tile of the component is under a wall/building (a wall-ore pocket): there
            # is nothing the engine could ever place on it. Skip the patch, keep the dump.
            return None
        tap = best

    cells = flood_cells(grid, tap, want)
    if len(cells) < MIN_TILES:
        # a walled sliver: the engine's connected patch is below the dumper's size floor
        return None

    minx = min(c[0] for c in cells)
    maxx = max(c[0] for c in cells)
    miny = min(c[1] for c in cells)
    maxy = max(c[1] for c in cells)

    rx0, ry0, rw, rh = region_of(hdr)
    x0 = max(rx0, minx - CROP_PAD)
    y0 = max(ry0, miny - CROP_PAD)
    x1 = min(rx0 + rw - 1, maxx + CROP_PAD)
    y1 = min(ry0 + rh - 1, maxy + CROP_PAD)

    rows = []
    built = []
    for y in range(y0, y1 + 1):
        row = []
        for x in range(x0, x1 + 1):
            floor, overlay, block, build = grid.get((x, y), ("air", "air", "air", ""))
            row.append(char_of(floor, overlay, block, build))
            if build:
                built.append([x, y, build])
        rows.append("".join(row))

    return {
        "name": fname[:-4],
        "source": fname,
        "save": hdr.get("save", "?"),
        "map": hdr.get("mapname", "?"),
        "ore": hdr.get("ore", "ore-?")[4:],
        "tap": [tap[0], tap[1]],
        "tiles": len(cells),
        "bbox": [minx, miny, maxx, maxy],
        "region": [x0, y0, x1 - x0 + 1, y1 - y0 + 1],
        "w": x1 - x0 + 1,
        "h": y1 - y0 + 1,
        "rows": rows,
        "built": built,
    }


def interleave_by_size(patches):
    """Largest, smallest, second largest, second smallest, ... within one save."""
    ordered = sorted(patches, key=lambda p: (-p["tiles"], p["name"]))
    out = []
    lo, hi = 0, len(ordered) - 1
    while lo <= hi:
        out.append(ordered[lo])
        lo += 1
        if lo <= hi:
            out.append(ordered[hi])
            hi -= 1
    return out


def select(per_save):
    """Round-robin over saves, alternating large and small patches, until the area budget.

    A patch larger than the budget's remainder is skipped (it is the area hogs that would push
    the world over 512x512); skipping does not stop the round - smaller patches still get in.
    """
    queues = {save: list(interleave_by_size(patches)) for save, patches in per_save.items()}
    saves = sorted(queues)
    selected = []
    area = 0
    while len(selected) < MAX_PATCHES:
        added = 0
        for save in saves:
            queue = queues[save]
            if not queue:
                continue
            patch = queue.pop(0)
            patch_area = (patch["w"] + GUTTER) * (patch["h"] + GUTTER)
            if area + patch_area > AREA_BUDGET:
                continue
            selected.append(patch)
            area += patch_area
            added += 1
            if len(selected) >= MAX_PATCHES:
                break
        if added == 0:
            break
    return selected


def pack(patches):
    """Shelf packing, tallest first, into MAX_SIDE x MAX_SIDE with GUTTER between crops."""
    order = sorted(patches, key=lambda p: (-p["h"], -p["w"], p["name"]))
    placed = []
    row_y = 0
    row_h = 0
    row_x = 0
    for p in order:
        if row_x + p["w"] > MAX_SIDE:
            # start a new shelf
            row_y += row_h + GUTTER
            row_x = 0
            row_h = 0
        if row_y + p["h"] > MAX_SIDE:
            # no room anywhere: this patch is not in the corpus
            continue
        p["x"] = row_x
        p["y"] = row_y
        row_x += p["w"] + GUTTER
        if p["h"] > row_h:
            row_h = p["h"]
        placed.append(p)
    return placed


def build_world(placed):
    width = 0
    height = 0
    for p in placed:
        if p["x"] + p["w"] > width:
            width = p["x"] + p["w"]
        if p["y"] + p["h"] > height:
            height = p["y"] + p["h"]
    width = ((width + 7) // 8) * 8
    height = ((height + 7) // 8) * 8

    grid = [["."] * width for _ in range(height)]
    for p in placed:
        for ry, row in enumerate(p["rows"]):
            for rx, ch in enumerate(row):
                gx, gy = p["x"] + rx, p["y"] + ry
                if grid[gy][gx] != ".":
                    raise SystemExit(f"corpus overlap at {gx},{gy}: {p['name']}")
                grid[gy][gx] = ch
    return width, height, ["".join(row) for row in grid]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dumpdir", help="directory of mapdump .txt regions (tools/mapdump.sh OUT)")
    ap.add_argument("outdir", help="corpus output directory (tests/js/fixtures/corpus)")
    args = ap.parse_args()

    per_save = {}
    skipped_ores = {}
    skipped_walled = 0
    for fname in sorted(os.listdir(args.dumpdir)):
        if not fname.endswith(".txt"):
            continue
        info = DUMP_RE.match(fname)
        if info is None:
            continue
        ore = info.group(2)
        if ore not in ORE_SHORT:
            skipped_ores[ore] = skipped_ores.get(ore, 0) + 1
            continue
        patch = load_patch(os.path.join(args.dumpdir, fname), fname)
        if patch is None:
            skipped_walled += 1
            continue
        per_save.setdefault(patch["save"], []).append(patch)

    selected = select(per_save)
    placed = pack(selected)
    if len(placed) < 150:
        print(f"warning: only {len(placed)} patches fit the {MAX_SIDE}x{MAX_SIDE} world", file=sys.stderr)

    width, height, rows = build_world(placed)
    if width > MAX_SIDE or height > MAX_SIDE:
        raise SystemExit(f"world {width}x{height} exceeds {MAX_SIDE}")

    # output order: the dump order (save, ore, index) - stable and diffable
    placed.sort(key=lambda p: p["name"])
    corpus = []
    per_ore = {}
    total_tiles = 0
    for p in placed:
        # the dump's coordinates are original-world; the corpus is their crop, placed at x,y
        tx = p["x"] + (p["tap"][0] - p["region"][0])
        ty = p["y"] + (p["tap"][1] - p["region"][1])
        built = [[bx - p["region"][0] + p["x"], by - p["region"][1] + p["y"], block]
                 for (bx, by, block) in p["built"]]
        corpus.append({
            "name": p["name"],
            "source": p["source"],
            "save": p["save"],
            "map": p["map"],
            "ore": p["ore"],
            "tiles": p["tiles"],
            "tap": [tx, ty],
            "dumpTap": p["tap"],
            "bbox": p["bbox"],
            "built": built,
            "x": p["x"],
            "y": p["y"],
        })
        per_ore[p["ore"]] = per_ore.get(p["ore"], 0) + 1
        total_tiles += p["tiles"]

    scenario = {
        "world": width,
        "worldH": height,
        "patches": [],
        "terrain": {
            "x0": 0, "y0": 0,
            "chars": {"l": "lead", "c": "copper", "k": "coal", "t": "titanium",
                      "h": "thorium", "s": "scrap"},
            "rows": rows,
        },
    }

    os.makedirs(args.outdir, exist_ok=True)
    world_path = os.path.join(args.outdir, "world.js")
    manifest_path = os.path.join(args.outdir, "manifest.json")
    with open(world_path, "w", encoding="utf-8") as fh:
        fh.write("// Real-map shape corpus - generated by tools/mapdata/build_corpus.py.\n")
        fh.write("// Data: tests/game-data/2026-10-29-save-export.zip. Do not hand-edit; regenerate.\n")
        fh.write("AUTODRILL_FAKE_SCENARIO = " + json.dumps(scenario, separators=(",", ":")) + ";\n")
        fh.write("var CORPUS = " + json.dumps(corpus, separators=(",", ":")) + ";\n")
    with open(manifest_path, "w", encoding="utf-8") as fh:
        json.dump(corpus, fh, indent=1, sort_keys=False)
        fh.write("\n")

    saves = sorted(set(p["save"] for p in placed))
    print(f"corpus: {len(placed)} patches, {total_tiles} ore tiles, {width}x{height} world")
    print(f"  saves={len(saves)} ore={', '.join('%s:%d' % kv for kv in sorted(per_ore.items()))}")
    if skipped_walled:
        print(f"  skipped all-walled components: {skipped_walled}")
    if skipped_ores:
        print("  skipped non-Serpulo ore dumps: "
              + ", ".join("%s:%d" % kv for kv in sorted(skipped_ores.items())))
    print(f"  dropped by packing: {len(selected) - len(placed)} of {len(selected)} selected")
    if not saves:
        raise SystemExit("no patches selected - wrong dump directory?")
    return 0


if __name__ == "__main__":
    sys.exit(main())
