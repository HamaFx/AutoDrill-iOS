#!/usr/bin/env python3
"""Convert one mapdump region into a single-file fake-world fixture.

The fixture sets AUTODRILL_FAKE_SCENARIO.terrain (the real tile grid: ores, walls, built
blocks) and REALMAP (tap, save/map name, and the save's existing transport for the "meets the
base" check). This is the per-patch tool the belting audit used and the corpus pipeline keeps
for the single-patch probes (tools/realmap-probe.sh).

    python3 tools/mapdata/make_fixture.py /tmp/opencode/dump2/0.msav_lead_0.txt \
        --out tests/js/fixtures/<name>.js

Terrain alphabet (tests/js/fake-api.js): 'l' lead, 'c' copper, 'k' coal, 't' titanium,
'h' thorium, 's' scrap, '#' solid (any wall block), 'B' a built block, '.' free ground.
"""
import argparse
import json
import re
import sys

ORE = {"ore-lead": "l", "ore-copper": "c", "ore-coal": "k", "ore-titanium": "t",
       "ore-thorium": "h", "ore-scrap": "s"}
ORE_NAMES = {"l": "lead", "c": "copper", "k": "coal", "t": "titanium", "h": "thorium", "s": "scrap"}

HEADER_KEYS = ("save", "mapname", "wave", "world", "region", "component", "tap", "ore")


def parse_dump(path):
    """Parse a mapdump text file into (header dict, grid {(x, y): (floor, overlay, block, build)})."""
    hdr = {}
    grid = {}
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if not line or line.startswith("-- col"):
                continue
            key = line.split("=", 1)[0] if "=" in line else ""
            if key in HEADER_KEYS and "," not in line.split("=", 1)[0]:
                k, _, v = line.partition("=")
                hdr[k] = v
                continue
            parts = line.split(" ")
            if len(parts) < 4:
                continue
            xy = parts[0].split(",")
            try:
                x, y = int(xy[0]), int(xy[1])
            except (ValueError, IndexError):
                continue
            if len(parts) <= 2:
                continue
            floor, overlay, block = parts[1], parts[2], parts[3]
            build = parts[4][1:] if len(parts) > 4 and parts[4].startswith("#") else ""
            grid[(x, y)] = (floor, overlay, block, build)
    if "region" not in hdr or "tap" not in hdr:
        raise SystemExit(f"{path}: missing region/tap header - not a mapdump file?")
    return hdr, grid


def region_of(hdr):
    x0, y0, w, h = [int(v) for v in hdr["region"].split(",")]
    return x0, y0, w, h


def char_of(floor, overlay, block, build):
    if build:
        return "B"
    if block != "air":
        return "#"
    return ORE.get(overlay, ".")


def rows_from_grid(grid, hdr, pad=0, crop=None):
    """Terrain rows for the (optionally cropped) region. `crop` is (x0, y0, x1, y1)."""
    rx0, ry0, rw, rh = region_of(hdr)
    if crop is None:
        x0, y0, x1, y1 = rx0 - pad, ry0 - pad, rx0 + rw - 1 + pad, ry0 + rh - 1 + pad
    else:
        x0, y0, x1, y1 = crop
    # never leave the dump: its edge is the data boundary
    x0, y0 = max(x0, rx0), max(y0, ry0)
    x1, y1 = min(x1, rx0 + rw - 1), min(y1, ry0 + rh - 1)
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
    return x0, y0, x1 - x0 + 1, y1 - y0 + 1, rows, built


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("dump", help="mapdump region .txt")
    ap.add_argument("--out", default="tests/js/fixtures/realmap-fixture.js",
                    help="where to write the fixture (default tests/js/fixtures/realmap-fixture.js)")
    ap.add_argument("--pad", type=int, default=0, help="extra ground around the dump region")
    args = ap.parse_args()

    hdr, grid = parse_dump(args.dump)
    x0, y0, w, h, rows, built = rows_from_grid(grid, hdr, pad=args.pad)
    ww, wh = [int(v) for v in hdr.get("world", "256x256").split("x")]
    tap = [int(v) for v in hdr["tap"].split(",")]

    scenario = {
        "world": ww, "worldH": wh,
        "patches": [],
        "terrain": {
            "x0": x0, "y0": y0,
            "chars": {"l": "lead", "c": "copper", "k": "coal", "t": "titanium",
                      "h": "thorium", "s": "scrap"},
            "rows": rows,
        },
    }
    realmap = {
        "save": hdr.get("save", "?"), "mapname": hdr.get("mapname", "?"),
        "x0": x0, "y0": y0, "w": w, "h": h,
        "tap": tap,
        "component": int(hdr["component"].split(" ")[0]),
        "built": built,
    }

    name = re.sub(r"[^A-Za-z0-9._-]", "_", hdr.get("save", "?"))
    text = ("// Real-map fixture: %s (%s), region %d,%d %dx%d, tap %s.\n"
            "// Generated from a save export by tools/mapdata/make_fixture.py.\n"
            "AUTODRILL_FAKE_SCENARIO = %s;\n"
            "var REALMAP = %s;\n" % (
                realmap["save"], realmap["mapname"], x0, y0, w, h, tap,
                json.dumps(scenario, separators=(",", ":")),
                json.dumps(realmap, separators=(",", ":"))))
    with open(args.out, "w", encoding="utf-8") as fh:
        fh.write(text)
    print("wrote", args.out, "from", name, "tap", tap, "component", realmap["component"])
    return 0


if __name__ == "__main__":
    sys.exit(main())
