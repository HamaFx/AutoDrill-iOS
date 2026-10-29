# Belting & Routing Audit

Date: 2026-10-29 · Baseline: `AutoDrill (iOS)` v1.11.0 · Data: player save export
(`/tmp/BCD3675A-…zip`: 40 saves, 10 maps, settings, both AutoDrill mods)

**Why.** Player feedback on v1.11.0: the belt tool leaves ore on real veins, and — more
importantly — *"all the drills need belts to transport rss to core"*: a fill that only stops at
the patch edge shifts the work back to the player. This audit measures the belting/routing
system on the player's **real maps** (not synthetic shapes), names the root causes, and ranks
the fixes.

---

## 1. Method (reproducible rig)

1. **Export** — the player's data dir (saves/maps/settings/mods) was parsed with a minimal MSAV
   reader; every save was loaded **in the real game** by a one-off mod (`SaveIO.load`) that dumps
   each lead-ore patch (±32 tiles: floors, overlays, blocks, buildings, team) to text.
2. **Fixture** — a dumped region is converted into a committed fixture
   (`tests/js/fixtures/desolate-rift-lead.js`) that drives the fake world's new `terrain`
   option: per-tile ore types (the real item ids), walls (`#`) and built blocks, plus the
   patch tap and the save's existing transport for the "meets the base" check.
3. **Measure** — `tools/realmap-probe.sh [fixture]` runs the belt tool (all 4 output
   directions), the optimizer (support ON/OFF) and the output routing on that terrain, and
   reports coverage plus a **directed** belt-flow simulation (`drill → conveyor/bridge →
   config target → … → config 0,0 bridge that dumps`, exactly `ItemBridgeBuild.updateTile`).

New/changed test rig files: `tests/js/fake-api.js` (terrain option + Serpulo ore items),
`tests/js/realmap-probe.js`, `tools/realmap-probe.sh`, `tests/js/fixtures/desolate-rift-lead.js`.

### Belt-tool results on the player's real lead veins

18 lead components (45–60 tiles each) across 8 saves; each row is one patch, best/worst of the
four output directions (directions differ little; where they do, both numbers are shown).

| patch | tiles | covered | drills | wired to an outlet |
|---|---|---|---|---|
| Desolate Rift (271) comp0 | 55 | 52 (95%) | 22 | 20–21/22 |
| Desolate Rift (271) comp1 | 52 | 47 (90%) | 19 | 19/19 |
| 0.msav comp0 | 58 | 53 (91%) | 18 | 18/18 |
| 0.msav comp1 | 51 | 45 (88%) | 16 | 16/16 |
| 12.msav comp0 | 50 | 44 (88%) | 17 | 17/17 |
| 12.msav comp1 | 45 | 38 (84%) | 13 | 13/13 |
| 19.msav comp3 | 57 | 37 (65%) | 12 | 9–11/12 |
| 19.msav comp4 | 54 | 49 (91%) | 16 | 16/16 |
| 23.msav comp0 | 59 | 53 (90%) | 15 | 14/15 |
| 23.msav comp1 | 58 | 47 (81%) | 14 | 13/14 |
| 23.msav comp2 | 54 | 47 (87%) | 14 | 14/14 |
| 23.msav comp3 | 51 | 42 (82%) | 13 | 11/13 |
| 7.msav comp0 | 60 | 55 (92%) | 17 | 16/17 |
| sector-serpulo-165 comp3 | 58 | 48 (83%) | 14 | 13/14 |
| sector-serpulo-165 comp4 | 52 | 39 (75%) | 12 | 11/12 |
| sector-serpulo-170 comp0 | 54 | 50 (93%) | 22 | 22/22 |
| sector-serpulo-170 comp1 | 45 | 41 (91%) | 15 | 15/15 |
| sector-serpulo-170 comp2 | 45 | 31 (69%) | 12 | 10/12 |

Median belt coverage **≈ 87%**; worst 65%. The toast about "the belt layout keeps tiles for its
bridges" is accurate but unspecific — the losses are (in order of frequency):

1. **The 1-in-9 bridge grid** (`isBridgeTile`): tiles reserved for belts are never mined.
2. **Drill packing**: every drill needs 4 free tiles + transport; greedy packing leaves holes
   among walls and other ore.
3. **Transport-limited candidates** (`skipped` in the report — e.g. `170 comp2`: "1 more drill
   fits here but has no belt room"); the candidate is free but no conveyor/bridge fits beside it.
4. **Foreign-ore dominance** (`countOre`): 2×2 footprints with more thorium/coal/copper than
   lead are rejected — correct for the game, but it costs coverage at patch borders.
5. **Terrain**: walls pinch candidates (e.g. `19 comp3`: `unreachable=3`, walls inside the
   region).

### Optimizer (laser) with the default Water & Power Support ON

8 of 18 patches at 100%. The rest lose to power reservations **and** walls:
`165 comp4` 39/52 (`blocked=8`, `unreachable=5`), `170 comp2` 35/45, `23 comp1` 51/58,
`19 comp3` 44/57 (`blocked=10`). With support OFF most of them only recover a little — pinned
patches stay pinned. (The power-reservation cost itself was fixed on *veins* in Phase 3: thin
veins are 100% now; wide patches still pay for the lattice by design.)

---

## 2. Findings

### F1 — 1–3 drills per patch get **dead belts** (concrete bug)

The directed flow simulation shows all bridges dump (`dumps == bridges`, `stuck=0`) but 1–3
drills per patch sit beside a conveyor that leads nowhere. Example, Desolate Rift fixture,
drill `(35,46)`:

```
conveyor 36,48 rot=1   ← points into the drill footprint / at a belt tile with no bridge
bridge   36,43/36,49/39,43/39,46/39,49   ← the real chain
```

**Root cause.** `connectByConveyor` / `addConveyorToGrid` (`scripts/bridge.js:61-160`) plan
against `bridgeTiles` — the *intended* belt grid — but bridges are only turned into plans later
(`placeDrillsAndBridges`, `bridge.js:638-706`), and **orphan bridges without a partner are then
dropped** (`bridge.js:680-705`) plus targets removed in the dry-run pruning loop
(`bridge.js:709-760`). Conveyors pointing at those tiles are never re-validated: the drill's ore
conveyor ends on a tile that stays empty, and the ore never leaves the drill.

### F2 — No route to the core (the player's headline ask)

The belt tool ends in a single **outlet** bridge one tile past the patch edge in the chosen
direction; the outlet dumps onto whatever is adjacent (an unlinked `ItemBridge` calls
`doDump()`). Nothing looks beyond the patch ring:

- `findExistingBridgePartner` (`bridge.js:799-809`) can link to a pre-existing bridge **exactly 3
  axis-aligned tiles** away — the only integration with the player's logistics, and it is
  coincidental.
- The optimizer's `routeOutputs` (`optimization.js`) lays straight conveyor/duct stubs of
  `Output Routing Length` tiles in one direction; on a packed patch most are cut short by the
  neighbouring drill footprints (measured earlier: 11→14 of 16 lines on a 10×10 patch).
- There is no item equivalent of `api.powerTargetNear` — the fill cannot even ask where the
  player's core/transport is.

Evidence: on the Desolate Rift region the save has **9 cores** within the dumped ±32-tile
window, yet for **all four directions** neither the belt plans (`meetsExisting=false`) nor the
optimizer stubs (`route/*: meetsExisting=false`) come within 5 tiles of any existing
conveyor/bridge/core.

This is not a regression — it is the shipped design ("the outlet is where you hook your belts
up") — but it is the gap the player is asking to close.

### F3 — Optimizer output routing is per-drill stubs, not a network

`routeOutputs` runs per drill plan, in the same direction, with a fixed length. It ignores
existing transports, other stubs (it may run alongside one), and the core; with `routeLength=4`
(the player's setting) it produces 9–20 conveyor tiles per patch that mostly stop at the first
neighbouring drill footprint. There is no trunk/merge, no junction/router use, no destination.

### F4 — Support reservation still costs wide patches (by design, worth revisiting)

Phase 3 made thin veins free and improved every measured power shape
(vein + power 95→100%, square + power 83.7→91.1%, round 84.9→86.9%, band 90.3→90.8%), but on
wall-pinched real patches the powered fill still loses 10–25%. The reservation lattice
(`reservePowerTiles`) cannot always step onto free ground when walls surround the patch.

### F5 — The player's "mined 20 of 51"

The exact vein from the screenshots was not found in the export as a filled state (no save
contains drills+bridges near lead). The closest matches (51–52-tile lead patches on Fortress
and Desolate Rift) measure 45/51 and 47/52 with the current build. Two facts from the export are
worth stating: **both AutoDrill mods are installed and enabled** (the Java one and this port —
the port stays inactive while the Java mod loads), and the belt-tool settings were
`min-ores=1`, `max-tiles=10000` (so not a settings issue). If the 20/51 session is still
reproducible, the fixture pipeline above can take the exact save.

---

## 3. Recommended work, ranked

| # | Change | Effort | Payoff |
|---|---|---|---|
| 1 | **Route items to the core**: `api.itemTargetNear` (core + player transport), and a routing pass that chains conveyors/ducts from every outlet (belt tool) and every drill stub or lane (optimizer) to that target, re-using the proven `util.findDuctPath`. Fall back to today's edge outlet when no target exists. | large | the player's headline ask: ore actually arrives |
| 2 | **Re-validate conveyors after bridge pruning**: drop/re-aim `beltPlans` whose target tile has no bridge plan (try re-aiming at an adjacent planned bridge first). | small | restores the 1–3 dead drills per patch (F1) |
| 3 | **Belt-tool coverage polish**: a final pass that takes any remaining ore tile with at least one free anchor and reaches it with a conveyor (the machinery exists — `connectByConveyor`), so a fill gets as close to 100% as the walls allow. | medium | +5–20% on ragged patches (F-coverage) |
| 4 | **Optimizer routing network**: merge per-drill stubs into a trunk (use junctions/routers), honour the direction but leave the patch toward the base, and make `Output Routing Length` mean the trunk length. | medium | drills' ore leaves the patch (F3) |
| 5 | **Pinned-patch support tuning**: when `reservePowerTiles`' candidates cannot step to free ground (all shifts blocked), prefer dropping fewer candidates and let `stitchPowerNetwork`+refill close the gap. | medium | +5–15% on walled patches with support ON (F4) |

Items 1–2 are the immediate "belting and routing" upgrade; 3–5 are the polish. A phase plan can
be cut from this table on request.

## 3a. Implemented (2026-10-29, same day)

Items **2–5** are in; item **1 (route to the core) was explicitly excluded by the maintainer** —
the network now leaves the patch in the chosen direction, and the player still makes the final
hook-up. What shipped:

- **F1 fixed, two ways**: `connectByConveyor` never worked at all (its goal check looked for a
  belt tile adjacent to a belt tile — grid tiles are three apart), so it now targets the free
  tiles beside the belt grid; and after the bridge pruning, every conveyor that would push into
  a tile with no bridge plan is re-aimed at a planned bridge beside it, or that tile gets a
  plain dump-outlet bridge. Drills whose transport was pruned away get a fresh conveyor line to
  the planned bridges (`belt repair` in `bridge.js`).
- **Leftover pass** (`bridge.js`, `fillLeftoverDrills`-style pass inside `placeDrillsAndBridges`):
  after the pattern and the gain-ordered leftovers, the remaining ore is walked in patch order
  and the first anchor that still fits (transport included) is taken. Bounded: 64 drills / 400
  attempts per fill.
- **Optimizer routing network** (`routeOutputs`): the per-drill runs are merged into one network
  that exits the patch in the chosen direction; `Output Routing Length` is the per-drill run and
  the merged network gets one more run of the same length beyond its farthest tile.
- **Pinned-patch support tuning** (`cheapestSpot`/`reservePowerTiles`): spots whose footprint
  holds no *mineable* cell of any candidate are no longer reserved (drills keep the ground, the
  node pass shifts, stitch+refill closes gaps); spots over mineable ground are held as before.
  A blanket "never reserve overhung spots" experiment was measured and rejected — it left 95 of
  145 drills unpowered on the dense round patch.

Measured (all gates re-run: engine checks 65→67, shape sweep, 124/512-shape vein batteries,
iOS-mode and compiled-engine checks, in-game suites 95/0 in both modes):

| metric | before | after |
|---|---|---|
| belt wiring on the committed Desolate Rift fixture, all 4 directions | 20–22 of 22 | **22/22** |
| real-map belt coverage rows still unwired | 6 rows (1–4 drills each) | 3 rows (1 drill each, no path fits) |
| real-map belt coverage (18 patches) | 65–95% | 65–95% + leftover gains (e.g. 170-comp2 31→33, 19-comp3 37→38) |
| shape sweep, band + power | 90.8% | **94.3%** |
| shape sweep, round + power | 86.9% | **87.6%** |
| real-map optimizer rows (18 patches) | — | +1 tile on 0-comp1/165-comp3, +3 on 23-comp0, +2 on 23-comp1, 7-comp0 now 60/60 |
| in-game second fill (laser, support ON) | 1 drill / 9 ore tiles | **9 drills / 81 ore tiles** |
| 200-walk vein battery, full coverage | 300 of 512 | **302 of 512** |
| optimizer routing tiles (Desolate Rift fixture) | 9–20 stubs | 16–31, one merged network + exit run per direction |

---

## 4. Reproduce

```bash
# the committed fixture (Desolate Rift lead vein + the base context from the save)
./tools/realmap-probe.sh

# any other region: generate a fixture from a mapdump region (see the audit tooling note)
./tools/realmap-probe.sh tests/js/fixtures/<name>.js
```

The probe prints, per output direction: coverage, drills, wired drills, dumping bridges, and
whether the layout meets existing transport; then the optimizer coverage and routing stubs.
The in-game mapdump mod and the MSAV reader used to produce fixtures are development tools and
are not part of the shipped mod.
