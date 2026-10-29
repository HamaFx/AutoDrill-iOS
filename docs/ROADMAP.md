# AutoDrill (iOS) — Serpulo Drill Placement & Vein Coverage Upgrade Roadmap

Date: 2026-10-29 · Baseline: `AutoDrill (iOS)` v1.10.0 · Target Engine: Mindustry v8 Build 160.7 (`/home/ubuntu/Mindustry-src`)

This document is the master architectural specification and roadmap for upgrading Serpulo drill placement, irregular vein coverage, and support block planning in `/home/ubuntu/AutoDrill-iOS`. It pairs with three executable, task-by-task implementation plans under `docs/plans/`:

1. **[`docs/plans/2026-10-29-phase1-geometry-and-bridge-veins.md`](plans/2026-10-29-phase1-geometry-and-bridge-veins.md)** — **Phase 1: Multiblock Geometry Ground Truth (`4×4` Airblast, Dynamic Lane Pitch, Full-Footprint Foreign-Ore Facts) & `bridge.js` Mechanical/Pneumatic Vein Overhaul**
2. **[`docs/plans/2026-10-29-phase2-optimizer-vein-solver.md`](plans/2026-10-29-phase2-optimizer-vein-solver.md)** — **Phase 2: `optimization.js` Bottleneck-First (Forced Degree-1/2 Tile) Vein Seeding, Translation-Invariant Multi-Lattice Repair, Window-Local Deep Repair & Adaptive 1-Tile Rim Fallback**
3. **[`docs/plans/2026-10-29-phase3-power-and-water-support.md`](plans/2026-10-29-phase3-power-and-water-support.md)** — **Phase 3: True-Cost / Pack-First Power Node Placement, Post-Bridge Gap Refill, Shared `2×2` Water Extractor Scoring & Output Routing Priority**

---

## 1. Mindustry v160.7 Ground Truth (Checked Against `/home/ubuntu/Mindustry-src`)

| Block | Field (`Blocks.java`) | Footprint (`size`) | `sizeOffset` (`-((size-1)/2)`) | Footprint Span from Anchor `(x, y)` | Tier & Max Ore | Notes |
|---|---|---|---|---|---|---|
| Mechanical Drill | `Blocks.mechanicalDrill` | `2` (`2×2`) | `0` | `[x, x+1] × [y, y+1]` | Tier `2` (Copper, Lead, Scrap, Sand, Coal) | `drillTime = 600`, Water boost `2.56×` (`0.05/frame`) |
| Pneumatic Drill | `Blocks.pneumaticDrill` | `2` (`2×2`) | `0` | `[x, x+1] × [y, y+1]` | Tier `3` (+ Titanium) | `drillTime = 400`, Water boost `2.56×` (`3.5/60`) |
| Laser Drill | `Blocks.laserDrill` | `3` (`3×3`) | `-1` | `[x-1, x+1] × [y-1, y+1]` | Tier `4` (+ Thorium) | `drillTime = 280`, Power `66/s`, Water boost `2.56×` (`0.08/frame`) |
| Airblast Drill | `Blocks.blastDrill` | **`4` (`4×4`)** | `-1` | **`[x-1, x+2] × [y-1, y+2]`** | Tier `4` (+ Thorium, Tungsten) | `drillTime = 280`, Power `180/s`, Water boost `3.24×` (`0.1/frame`) |
| Water Extractor | `Blocks.waterExtractor` | `2` (`2×2`) | `0` | `[x, x+1] × [y, y+1]` | `SolidPump` (`Env.groundWater`) | `pumpAmount = 0.11f`, `baseEfficiency = 1.0f`, `canPump(t) = !t.floor().isLiquid` |
| Oil Extractor | `Blocks.oilExtractor` | `3` (`3×3`) | `-1` | `[x-1, x+1] × [y-1, y+1]` | `Fracker` (`Attribute.oil`) | Requires `1/s` Sand + `9/s` Water + `180/s` Power |
| Bridge Conveyor | `Blocks.itemBridge` | `1` (`1×1`) | `0` | `[x, x] × [y, y]` | `BufferedItemBridge` | Orthogonal link range `1..4` (`range = 4`), `checkDouble` forbids `A <-> B` 2-cycles |
| Power Node | `Blocks.powerNode` | `1` (`1×1`) | `0` | `[x, x] × [y, y]` | `PowerBlock` | `laserRange = 6`, `maxNodes = 10`, insulated by Plastanium walls |

### Critical Engine Rules (`Drill.java`, `Tile.java`, `SolidPump.java`, `ItemBridge.java`)

1. **Even-Sized Multiblock Asymmetry (`Tile.getLinkedTilesAs`, `Tile.java:521-526`)**:
   - A block of size `S` anchored at `(x, y)` occupies `[x - halfLow, x + halfHigh] × [y - halfLow, y + halfHigh]`, where `halfLow = Math.floor((S - 1) / 2)` and `halfHigh = Math.floor(S / 2)`.
   - Conversely, for a drill footprint to cover an ore tile at `(ox, oy)`, the drill's anchor `(x, y)` must lie in **`[ox - halfHigh, ox + halfLow] × [oy - halfHigh, oy + halfLow]`**.
   - For `S = 2` (`halfLow = 0, halfHigh = 1`), valid anchors covering `(ox, oy)` are `[ox - 1, ox] × [oy - 1, oy]`.
   - For `S = 4` (`halfLow = 1, halfHigh = 2`), valid anchors covering `(ox, oy)` are `[ox - 2, ox + 1] × [oy - 2, oy + 1]`.
2. **Dominant Ore Tie-Break (`Drill.countOre`, `Drill.java:1407-1438`)**:
   - Mindustry counts minable tiles across the full `S × S` footprint, sorts items ascending by `(!item.lowPriority, count, item.id)`, and selects `itemArray.peek()` as `returnItem` (`dominantItem`).
   - If an overhanging drill at the edge of a Copper patch touches more (or equal-count higher-`id`) Lead/Coal/Titanium tiles outside the Copper patch, the drill mines the foreign ore instead of Copper.
3. **SolidPump (`Water Extractor`) Placement & Output (`SolidPump.java:1683-1774`)**:
   - `canPump(tile)` is `tile != null && !tile.floor().isLiquid`. Standing water tiles (`isLiquid === true`) contribute `0` to `waterExtractor`.
   - `canPlaceOn(tile, team, rot)` sums `baseEfficiency (1.0) + t.floor().attributes.get(Attribute.water)` over all non-liquid tiles in the `2×2` footprint and requires `sum > 0.00001f`.

---

## 2. Root-Cause Inventory (What Breaks Today and Where)

### Subsystem 1 — Multiblock Geometry & Foreign-Ore Footprint Blindness
- **G1 (`tests/js/fake-api.js:31`, `docs/MINDUSTRY.md:815`)**: `blastDrill` is defined with `size = 3` instead of `size = 4`. Every offline test (`engine-tests.js`, `vein-probe.js`, `shape-sweep.js`) tested Airblast as a `3×3` drill.
- **G2 (`scripts/optimization.js:2493, 2969-2981`)**: `reserveLaneTiles` hardcodes `LANE_PITCH = 4` and `LANE_HOP = 3`. Because any `4×4` (`blastDrill`, `impactDrill`) or `5×5` (`eruptionDrill`) block spans 4+ consecutive rows and 4+ consecutive columns, every interior placement collides with a reserved lane tile (`y ≡ minY (mod 4)` and `x ≡ minX (mod 3)`), causing **0 interior drills** when `Build Belt Lanes` is enabled.
- **G3 (`scripts/optimization.js:2597, 2609-2690`)**: `scanTiles` expands `job.tiles` by `Math.floor(job.size / 2)` (`1` for `size = 3`, `2` for `size = 4`). However, a candidate centered on that expanded ring has footprint cells extending up to `2 * Math.floor(job.size / 2)` outside the ore patch. Those outer cells are absent from `job.cellFacts` (`cellFacts[ckey] === undefined`), so `scanCandidates` (`line 2679`) ignores foreign ores on the outer ring of overhanging drills and places drills that mine the wrong resource in-game.

### Subsystem 2 — `bridge.js` Mechanical & Pneumatic Vein Failures
- **B1 (`scripts/bridge.js:2137-2140`)**: `else if (isOreTile(tiles[i], sourceDropId)) leftovers.push(tiles[i]);` discards all non-ore tiles from the `expandArea` ring unless they land on the sparse 2-in-9 `isDrillTile` mask. Because a `2×2` drill at `(x, y)` covers `[x, x+1] × [y, y+1]`, mining the `-x` (left) or `-y` (bottom) edge of a vein—or any 1-wide vein with a wall on its `+x` or `+y` side—requires placing the drill anchor on the non-ore tile at `x - 1` or `y - 1`. Discarding non-ore anchors from `leftovers` leaves up to 67% of walled/thin veins unmined.
- **B2 (`scripts/bridge.js:1830-1849, 1776-1820, 1925-1943`)**:
  - Line 1925 (`if (connectByConveyor(...)) return 1;`) returns early **before** lines 1938–1942 mark the drill's `2×2` footprint in `occupied`.
  - Neither `addConveyorToGrid` nor `connectByConveyor` marks placed conveyor tiles in `occupied`, and `addConveyorToGrid` does not check `occupied`.
- **B3 (`scripts/bridge.js:2141-2183, 2275-2289`)**: `bridgeTiles` are not marked in `occupied` before the `leftovers` loop, so `leftovers` drills overwrite `bridgeTiles`. In the dry-run phase, drills are committed before bridges, causing the overwritten bridges to fail collision checks and severing the bridge network.
- **B4 (`scripts/bridge.js:2235-2250, 2351-2366`)**:
  - When a bridge tile has no partner at cardinal distance 3 *closer* to `outlet`, the partner loop (`k = 0 .. bridgeTiles.length - 1`) links it to a partner *further* from `outlet`, creating invalid `A <-> B` 2-cycles (`ItemBridge.java:1947`).
  - In the pruning loop (`line 2362`), a bridge whose target was rejected (`!targetExists`) is still kept if another bridge feeds it (`if (!fed)`), leaving a broken link.
- **B5 (`scripts/bridge.js:2177-2182`)**: `leftovers` is iterated in raw tile-index order instead of descending marginal uncovered ore gain.

### Subsystem 3 — `optimization.js` Irregular Vein Solver & Local Repair
- **O1 (`scripts/optimization.js:2725-2730, 3193-3270`)**: Candidates are ordered strictly by `-e.winnerCount`. On blobs with tendrils, staircases, and corners, interior `winnerCount = 6..9` drills are placed first and block the only degree-1 or degree-2 candidate (`winnerCount = 2..3`) that can cover a vein tip or corner. Branch-and-bound exhausts its `maxTries` budget at the bottom of the recursion tree and never backtracks to index `0..5`.
- **O2 (`scripts/optimization.js:3473-3497`)**: `bestLattice` tests `(api.tx(entry.tile) - ax) % size !== 0` in world coordinates and keeps only the first translation (`score > best.score`). Shifting the same vein by 1 tile changes which translation wins a tie, and `repairSelection` only runs on that single winner.
- **O3 (`scripts/optimization.js:3678-3897`)**:
  - `swapRepair` only tests inserting 1 candidate at a time (`cand`), missing coupled 2-candidate slides along a vein.
  - `deepRepair` is disabled whenever `entries.length > 320` (`DEEP_REPAIR_MAX_ENTRIES = 320`, `line 3811`), even though `deepRepair` only ruins a local `radius = 4` window (`<= 12` drills) around uncovered tiles.
- **O4 (`scripts/optimization.js:2706`)**: At the default `minOres = 2` for Laser/Airblast, a 1-tile protruding vein tip pinched by walls where a `3×3`/`4×4` drill can physically only cover `1` ore tile is rejected as `unreachable`.

### Subsystem 4 — Power & Water Support Pass (`scripts/optimization.js`, `scripts/api.js`)
- **S1 (`scripts/optimization.js:2905-2932, 3012-3120`)**:
  - `spotCost` only checks `candidateAt[x + y * worldW]` (the single drill centered at `(x, y)`), ignoring the up to 9 (`3×3`) or 16 (`4×4`) candidates whose footprints overlap `(x, y)`.
  - When `spot.cost === 0` (`line 3071`), `spot` is added to `job.reservedNodes` (`line 3069`) without marking `reserved[spot] = true`. Drills then overhang `spot`, blocking the node (`line 4238`), which forces `stitchPowerNetwork` / `chainBetween` (`lines 4388, 4573`) to delete a placed drill (`removePlan`) without re-packing the uncovered ore.
  - Reserving an interior lattice *before* packing sacrifices 15–19% of ore on patches where perimeter/gap nodes (`laserRange = 6`) could power the drills at 0% ore cost.
- **S2 (`scripts/api.js:484-502`, `scripts/optimization.js:3967, 3985, 4167-4195`)**:
  - `api.pumpsWaterAt` treats liquid water tiles as pumpable by `waterExtractor`, contradicting `SolidPump.canPump` (`!tile.floor().isLiquid`), and scores only the single anchor tile `api.waterAt(nearby[j])` instead of the `2×2` footprint sum.
  - `placeWaterExtractorsAndPowerNodes` places 1 extractor per drill (without sharing across adjacent drills) and runs *before* `routeOutputs`, blocking requested conveyor output lines.

---

## 3. Non-Negotiable iOS / Rhino Guardrails (Must Obey in Every Task)

Every agent editing `scripts/*.js` or `tests/**/*.js` **must** obey these four rules (enforced by `./tools/ios-mode-check.sh` and `./tools/compile-check.sh`):

1. **Always initialize local `var` declarations**: Write `var x = null;` or `var i = 0;`, **never** bare `var x;` or `var a, b;`. In Rhino's interpreted mode (`optimizationLevel = -1`) with `"use strict"`, an uninitialized `var` inside a function containing a nested function throws `ReferenceError: Assignment to undefined`.
2. **Never call a helper that returns a newly allocated `{...}` or `[...]` object inside a hot loop**: On iOS's interpreted Rhino engine, calling an object-returning helper inside a candidate scan loop corrupts loop state and spins until `OutOfMemoryError`. Inline object construction or return primitive numbers/booleans in hot loops.
3. **Never index a runtime-sized array with `counts[labels[i]]++`**: Rhino's bytecode compiler (`optimizationLevel = 9`, desktop/Android) fails with `Stack underflow: -1` on compound increment of nested array indexing. Separate read and write (`var idx = labels[i]; counts[idx] = counts[idx] + 1;`).
4. **Never subclass Java classes (`extend()`, `JavaAdapter`, `new SomeClass(){}`) or shadow `global.js` bindings (`log`, `print`)**: Only implement Java interfaces (`Cons`, `Boolp`, `Floatp`, `Runnable`, `InputProcessor`, `StringProcessor`).

---

## 4. Verification Suite Commands (Run After Every Task)

All commands run from `/home/ubuntu/AutoDrill-iOS`:

```bash
# 1. Lint & static iOS Rhino checks (takes ~3s)
bunx eslint scripts tests/ingame
./tools/ios-mode-check.sh

# 2. Fast fake-world engine & coverage gates (takes ~5s each)
./tools/engine-tests.sh
./tools/corpus-probe.sh --quick   # the committed real-map corpus (first 12 patches)
./tools/shape-sweep.sh
./tools/vein-probe.sh
AUTODRILL_VEIN_WALKS=200 ./tools/vein-probe.sh

# 3. Desktop compiled-mode bytecode verification (takes ~15s)
./tools/compile-check.sh

# 4. Full in-game test suites in both desktop (compiled) and iOS-sim (interpreted) modes
./tools/run-tests.sh normal
./tools/run-tests.sh ios
./tools/guard-check.sh
```
