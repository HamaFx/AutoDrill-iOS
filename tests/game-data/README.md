# Game-data export (maintainer)

`2026-10-29-save-export.zip` — a Mindustry **game-data directory export** from the maintainer's
device (iOS), sent in on 2026-10-29 for the belting/routing audit and the real-map corpus.

Contents (112 files):

| Path | What |
|---|---|
| `settings.bin` | Mindustry settings, including the AutoDrill settings actually used (min-ores, max-tiles, quality, routing length, lanes, support) |
| `saves/` | 40 save slots: Serpulo sectors (Desolate Rift, …), Asthosus sectors, custom maps; each `.msav` with its `-backup` |
| `maps/` | 10 custom maps |
| `schematics/` | 29 schematics |

**Not included:** the `mods/` folder of the original export (≈ 99 MB of third-party mod zips:
Asthosus, tier lists, etc.). Those are not ours to redistribute and are re-downloadable; only
the Asthosus mod is needed to load those two sectors when re-dumping, and the committed corpus
(below) already captures the patches.

## How this data is used

- `docs/AUDIT-BELTING.md` — the belting/routing audit measured on these saves (via the in-game
  map dump + fixture pipeline).
- `docs/plans/2026-10-29-phase4-real-map-corpus-and-distillation.md` — the plan that turns this
  export into the committed real-map shape corpus (`tests/js/fixtures/corpus/`).

## Rebuilding the corpus from this archive

```bash
mkdir -p /tmp/game-data && unzip tests/game-data/2026-10-29-save-export.zip -d /tmp/game-data
SOURCE=/tmp/game-data ./tools/mapdump.sh            # dumps every ore patch from every save
python3 tools/mapdata/build_corpus.py /tmp/opencode/dump2 tests/js/fixtures/corpus
```

(The dump step boots the real game headless; see the phase 4 plan for the full pipeline.)
