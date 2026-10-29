# tools/mapdata — the real-map corpus pipeline

Offline tooling only (Python 3). Nothing here ships with the mod and nothing here runs on iOS:
the engine reads the *output* (`tests/js/fixtures/corpus/`), never these scripts.

## Scoreboard, teacher, gap miner

Three levels of measurement on the same corpus (see the phase 4 plan for the full story):

1. **Scoreboard** — `./tools/corpus-probe.sh` (or `--quick` for the 12-patch gate). Every patch
   gets the belt tool (all four directions), the optimizer (support ON/OFF) and the output
   routing; the output is one fixed-format line per patch, a summary, and an FNV-1a hash.
   `tests/js/fixtures/corpus/baseline.txt` is the committed result - regenerate it in the same
   commit as any engine change that moves it.
2. **Teacher** — labels what a slow solver proves achievable per patch:

   ```bash
   ./tools/corpus-probe.sh --dump-candidates > /tmp/corpus-cands.txt
   uv run --with 'pulp==2.9.0' tools/vein-solve.py /tmp/corpus-cands.txt > /tmp/corpus-opt.txt
   ./tools/corpus-probe.sh --teacher > /tmp/corpus-beltref.txt
   python3 tools/mapdata/teacher_merge.py /tmp/corpus-opt.txt \
       tests/js/fixtures/corpus/teacher.json --classes /tmp/corpus-cands.txt --belt /tmp/corpus-beltref.txt
   ```

   Patches over the ILP candidate cap (300) get an upper-bound `reference` label from the
   shared restarts packer instead of an exact optimum. `teacher.json` records, per patch, the
   solver, status, optimum/reference, the engine at label time, and the honest gap.
3. **Gap miner** — classifies every left tile by cause, inside the probe (it needs the
   engine's own rules), and aggregates them:

   ```bash
   ./tools/corpus-probe.sh --json /tmp/corpus.json
   python3 tools/mapdata/corpus_gaps.py /tmp/corpus.json \
       tests/js/fixtures/corpus/teacher.json > docs/AUDIT-CORPUS-GAPS.md
   ```

   `freeAnchor > 0` is an engine bug by definition and makes the tool exit non-zero.

## What the pipeline does

```
tests/game-data/2026-10-29-save-export.zip
        │  unzip to /tmp/game-data
        ▼
tools/mapdump.sh          boots the real game (Xvfb) with the mapdump dev mod:
                          SaveIO.load every save/map, dump every ore patch ±24 tiles as text
        │  /tmp/opencode/dump2/*.txt
        ▼
tools/mapdata/build_corpus.py
        │  crop each patch to bbox±6, pack into one 512×512 fake world with 10-tile gutters
        ▼
tests/js/fixtures/corpus/world.js       (scenario: AUTODRILL_FAKE_SCENARIO + CORPUS)
tests/js/fixtures/corpus/manifest.json  (same metadata, Python-readable)
```

`make_fixture.py` is the single-patch variant: it turns one dump into a fixture the
`tools/realmap-probe.sh` rig can load (the belting audit's tool, kept for spot checks).

## Commands

```bash
# rebuild the raw dumps from the committed export (needs the real game jars + Xvfb; minutes)
mkdir -p /tmp/game-data && unzip -o tests/game-data/2026-10-29-save-export.zip -d /tmp/game-data
SOURCE=/tmp/game-data OUT=/tmp/opencode/dump2 ./tools/mapdump.sh

# rebuild the committed corpus from the dumps (seconds)
python3 tools/mapdata/build_corpus.py /tmp/opencode/dump2 tests/js/fixtures/corpus

# one dump → one single-patch fixture for realmap-probe.sh
python3 tools/mapdata/make_fixture.py /tmp/opencode/dump2/0.msav_lead_0.txt --out tests/js/fixtures/realmap-x.js
```

The ASTHOSUS / third-party-mod saves in the export fail to load without their mods (`LOAD
FAILED … Error reading region "meta"`); the dumper logs and skips them. Everything the corpus
needs is in the archive itself.

## Corpus rules (why the numbers are comparable)

- **Patches.** Only the six Serpulo drill ores (lead, copper, coal, titanium, thorium, scrap).
  A patch is the 8-connected run of *buildable* ore tiles from its tap, with the dumper's
  12-tile floor applied to that run: wall-ore pockets (ore under a wall) and their slivers are
  not patches the engine could ever fill. Walls, foreign ore and existing buildings inside a
  kept patch are taken exactly as the save had them.
- **Crop.** The patch bbox ±6 tiles. The dumper's ±24 is source context only; ±6 is enough for
  walls, foreign-ore borders and the belt ring, and keeps the world small.
- **Packing.** Patches are packed into one fake world, ≥10 tiles of free ground between any two
  crop boxes. The 10 tiles are what keeps one patch's scan (and the belt tool's ring) out of its
  neighbour's tiles; with gutters of 1–2 tiles the numbers become noise.
- **Selection.** At most 512×512; patches are picked round-robin over saves, alternating large
  and small within each save, under a 245 000-tile area budget. Dumps beyond that are listed in
  the builder output but not in the corpus.
- **Determinism.** Inputs are processed in file-name order, no timestamps are written, and the
  builder never reads the clock. Rebuilding from the same dumps produces byte-identical files.

## Terrain alphabet (matches tests/js/fake-api.js)

| char | meaning |
|---|---|
| `l c k t h s` | lead, copper, coal, titanium, thorium, scrap ore |
| `#` | solid: any non-air block (cliff, wall, boulder, wall ore) |
| `B` | a built block (conveyor, core, anything already standing) |
| `.` | free ground |

Ore of other planets/modded ores (beryllium, tungsten, …) is not representable and is written as
free ground in the corpus; the dumper still records it in the dumps for other tools.

## Outputs

- `world.js` — `AUTODRILL_FAKE_SCENARIO` (world, terrain rows) + `var CORPUS = [...]` with
  `{name, save, map, ore, tiles, tap, built, x, y}` per patch. Coordinates are corpus-world
  coordinates; `tiles` is the patch size the engine will see (the connected buildable ore run).
- `manifest.json` — the same records plus `bbox` and `dumpTap` (original world coordinates, for
  tracing a patch back to its save) and `source` (dump file name).

Never hand-edit the corpus: regenerate it and commit the diff.
