# Phase 3: Power & Water Support Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate unnecessary ore loss from `Water & Power Support` by fixing `reservePowerTiles` cost accounting and perimeter/gap node placement, refilling gaps whenever `stitchPowerNetwork` drops a drill, fixing `waterExtractor` `SolidPump` footprint scoring and sharing, and running `routeOutputs` before support blocks.

**Architecture:** First, fix `spotCost` and `reservePowerTiles` in `scripts/optimization.js` so `spotCost` measures the true footprint overlap across all candidate drills, always reserves the chosen `spot` when `spot` lies inside any candidate's footprint, and skips reserving interior tiles whenever perimeter/outside tiles within `laserRange` (`6` tiles) already reach the vein (so thin/medium veins lose 0% ore to power nodes!). Second, whenever `stitchPowerNetwork` or `chainBetween` removes a blocking drill, immediately re-fill the resulting free gap with non-overlapping candidate drills. Third, align `api.pumpsWaterAt` and `waterExtractor` scoring with Mindustry's `SolidPump.java` (`!tile.floor().isLiquid`, `2×2` attribute sum), share each `waterExtractor` across adjacent drills, and run `routeOutputs` before support placement so conveyors are never blocked.

**Tech Stack:** JavaScript (ES5 strict mode for Mindustry Rhino `optimizationLevel = -1` and `9`), `scripts/api.js`, `scripts/optimization.js`, `tests/js/fake-api.js`, `tests/js/engine-tests.js`.

**Spec:** `docs/ROADMAP.md` (Sections 1, 2 Subsystem 4, 3, and 4)

## Global Constraints

- Obey all four iOS/Rhino rules in `docs/ROADMAP.md` Section 3: initialize every `var` (`var x = null;`), no object-returning helper calls inside hot loops, no `arr[idx[i]]++`, and no Java class subclassing.
- Every placed drill in a powered fill (`withSupport === true`) must remain within `info.range` of a placed power block (or `powerTarget`), all placed power blocks must form a single connected component (wired to `powerTarget` when within `POWER_LINK_RADIUS = 90`), and zero plans may overlap.

## Review Focus

1. **Thin or medium vein (width `<= 6` tiles) with `Water & Power Support` ON** — `powerNode` (`laserRange = 6`) reaches every drill from outside the ore vein, so `reservePowerTiles` must reserve **0 ore tiles** and achieve **100% ore coverage** even with support ON.
2. **Power reservation on a tile where no drill is *centered* (`candidateAt[key] === undefined`) but 3–4 drills overhang it** — `spotCost` must return the true footprint overlap cost (`> 0`) and `reservePowerTiles` must mark `reserved[key] = true` so drills do not overhang the reserved power node spot.
3. **`stitchPowerNetwork` / `chainBetween` dropping a `3×3` or `4×4` drill to place a `1×1` power node** — the remaining `8` or `15` freed tiles must be gap-filled by any valid candidate drill that avoids the new `1×1` power node.
4. **Water Extractor placement near liquid water vs dry ground (`SolidPump.java`)** — `waterExtractor` must never be placed on liquid water tiles (`isLiquid === true`) and must pick the `2×2` spot with the highest 4-tile sum of `Attribute.water`, sharing 1 extractor across up to 3 adjacent drills.
5. **Optimiser fill with `Output Routing Length > 0` and `Water & Power Support` ON** — `routeOutputs` must place each drill's straight conveyor/duct line *before* `placeWaterExtractorsAndPowerNodes` so extractors and nodes do not block the chosen output side.

## File Structure

| File | Responsibility |
|---|---|
| `scripts/optimization.js` | Footprint-aware `spotCost`, perimeter-aware `reservePowerTiles`, post-bridge drill gap refill, shared `2×2` `waterExtractor` placement, and `routeOutputs` ordering |
| `scripts/api.js` | `api.pumpsWaterAt` and `api.waterEfficiencyAt` matching `SolidPump.canPlaceOn` / `Block.sumAttribute` |
| `tests/js/fake-api.js` | Matching `waterEfficiencyAt` helper for fake-world tests |
| `tests/js/engine-tests.js` | Assertions for 100% vein coverage with power ON, true `spotCost`, shared water extractors, and unobstructed output routing |

---

### Task 1: Fix `spotCost` Footprint Accounting & Skip Interior Power Reservations on Narrow Veins

**Files:**
- Modify: `scripts/optimization.js:2905-2933, 3012-3120`
- Test: `tests/js/engine-tests.js`

**Interfaces:**
- Consumes: `job.candidates`, `powerSupport()` (`{block, range, size, linkBlock}`)
- Produces: Footprint-accurate `spotCost(job, cellCost, x, y, blockSize)` and perimeter-first `reservePowerTiles(job)` in `scripts/optimization.js`

- [ ] **Step 1: Write the failing test in `tests/js/engine-tests.js`**

Add in `tests/js/engine-tests.js` (inside section `2. full coverage`):

```javascript
var rVeinPow = fillAt(vein, laser, null, true);
var cVeinPow = coverageOf(vein, rVeinPow.plans, laser);
check("1-wide vein with power support ON: 100% of ore tiles are mined (power nodes sit outside the vein)",
    cVeinPow.covered === cVeinPow.total,
    "covered=" + cVeinPow.covered + "/" + cVeinPow.total + " drills=" + cVeinPow.drills);
```

- [ ] **Step 2: Run `./tools/engine-tests.sh` to verify it fails**

Run: `./tools/engine-tests.sh`
Expected: FAIL (`covered=38/40` or `95%`, matching `docs/AUDIT.md:541` where `vein + power support` lost 5% of ore because `reservePowerTiles` placed its center lattice point right on the vein).

- [ ] **Step 3: Compute footprint-overlap `cellCost` and prefer zero-cost outside tiles in `reservePowerTiles`**

In `scripts/optimization.js:2905-2933, 3012-3120`:
1. Build `cellCost[ckey]`: for every candidate `c` in `job.candidates` and every footprint cell `ckey` in `c.cellKeys`, set `cellCost[ckey] = Math.max(cellCost[ckey] || 0, c.winnerCount)` (or sum of `mineableKeys.length` for tiles in `c.mineableKeys` so direct ore tiles have higher cost than non-ore overhang cells).
2. Define `spotCost(job, cellCost, x, y, size)` as the sum of `cellCost` over the `size × size` footprint of the power block at `(x, y)` (returning `1e9` if `!util.canPlaceBlock(info.block, job.team, x, y, 0)`).
3. In `cheapestSpot(job, cellCost, x, y, radius, size)`, search up to `radius = 3` (since `step = range - size = 5` and `laserRange = 6` allows up to 3 tiles of shift when needed to reach free ground beside a narrow vein) for the minimum-cost buildable tile.
4. In `reservePowerTiles` (`line 3071`), always mark the `size × size` footprint of `spot` in `reserved` (even when `spot.cost === 0` because `spot` is outside the ore patch!) so drills cannot overhang `spot` and block the power node later.

- [ ] **Step 4: Run verification gates**

Run: `./tools/engine-tests.sh && ./tools/shape-sweep.sh && ./tools/ios-mode-check.sh`
Expected: PASS (`1-wide vein with power support ON` covers `40/40 = 100%`, and `round + power` coverage increases while keeping `unpowered drills = 0`).

- [ ] **Step 5: Commit**

```bash
git add scripts/optimization.js tests/js/engine-tests.js
git commit -m "fix(optimization): use true footprint overlap cost in reservePowerTiles and preserve 100% vein coverage"
```

---

### Task 2: Refill Freed Drill Gaps After `stitchPowerNetwork` and `chainBetween`

**Files:**
- Modify: `scripts/optimization.js:3975-3995, 4380-4396, 4570-4581`
- Test: `tests/js/engine-tests.js`

**Interfaces:**
- Consumes: `job.entries`, `allPlans`, `occupied`
- Produces: `refillAfterPowerBridge(job, selection, allPlans, occupied)` in `scripts/optimization.js`

- [ ] **Step 1: Write the failing test in `tests/js/engine-tests.js`**

Add in `tests/js/engine-tests.js` (inside section `4. the gap filler`):

```javascript
check("after power stitching and grid linking, no free candidate with uncovered ore remains",
    freeWithGain === 0, "freeWithGain=" + freeWithGain);
```
(Also verify when `stitchPowerNetwork` or `chainBetween` drops a drill that `refillAfterPowerBridge` re-inserts any shifted candidate drill that avoids the new `1×1` power node.)

- [ ] **Step 2: Run `./tools/engine-tests.sh` to verify**

Run: `./tools/engine-tests.sh`
Expected: Check `freeWithGain === 0` and `job.powerRemovedDrills`.

- [ ] **Step 3: Implement `refillAfterPowerBridge` in `scripts/optimization.js`**

In `scripts/optimization.js`:
1. Whenever `stitchPowerNetwork` or `chainBetween` increments `job.powerRemovedDrills` (`lines 4390, 4575`), remove the dropped drill's entry from `selection` as well as `allPlans`.
2. After `stitchPowerNetwork` and `linkPowerGrid` finish in `finish(job)` (`line 3983`), if `job.powerRemovedDrills > 0`:
   - Recompute `covered` ore keys from the surviving drill plans in `allPlans`.
   - Iterate `job.entries`: for any candidate `entry` whose footprint is free in `occupied` (`util.freeInOccupancy(occupied, job.drill, tx, ty)`) and that covers at least `1` uncovered ore key in `entry.mineableKeys`, place the drill plan, mark `occupied`, add to `selection`, and update `covered`.
   - Recompute `covered` (`score`) and `drillCount` directly from the final surviving drill plans in `allPlans` instead of subtracting an approximate `job.powerRemovedOre`.

- [ ] **Step 4: Run verification gates**

Run: `./tools/engine-tests.sh && ./tools/shape-sweep.sh && ./tools/ios-mode-check.sh`
Expected: PASS (`failed=0`).

- [ ] **Step 5: Commit**

```bash
git add scripts/optimization.js tests/js/engine-tests.js
git commit -m "feat(optimization): refill freed drill gaps after power network bridging"
```

---

### Task 3: Fix `SolidPump` (`waterExtractor`) Footprint Scoring & Share Extractors Across Adjacent Drills

**Files:**
- Modify: `scripts/api.js:420-425, 484-502`
- Modify: `tests/js/fake-api.js:238-248`
- Modify: `scripts/optimization.js:4140-4196`
- Test: `tests/js/engine-tests.js`

**Interfaces:**
- Consumes: `block.canPlaceOn(tile, team, 0)`, `tile.floor().isLiquid`, `tile.floor().attributes.get(Attribute.water)`
- Produces: `api.waterExtractorEfficiency(block, x, y, team)` in `scripts/api.js` and `tests/js/fake-api.js`; shared extractor placement in `placeWaterExtractorsAndPowerNodes` (`scripts/optimization.js`)

- [ ] **Step 1: Write the failing test in `tests/js/engine-tests.js`**

Add in `tests/js/engine-tests.js` (inside section `6a. water extractors`):

```javascript
(function(){
    // One 2x2 water extractor produces 6.6 water/s, enough to boost two laser drills (4.8/s)
    // or airblast drills (6.0/s) when touching both. A packed patch must share extractors
    // across adjacent drills rather than placing 1 per drill.
    var extCount = r1.stats.extractors;
    var drillCount = r1.stats.drills;
    check("water extractors are shared across adjacent drills (fewer extractors than drills)",
        extCount > 0 && extCount <= Math.ceil(drillCount * 0.75),
        "extractors=" + extCount + " drills=" + drillCount);
})();
```

- [ ] **Step 2: Run `./tools/engine-tests.sh` to verify it fails**

Run: `./tools/engine-tests.sh`
Expected: FAIL when every drill places its own dedicated extractor without checking if an already-placed extractor already touches it.

- [ ] **Step 3: Fix `api.pumpsWaterAt` for `waterExtractor` and share extractors across up to 2–3 adjacent drills**

1. In `scripts/api.js:484-502` (`api.pumpsWaterAt(block, x, y, team)`):
   - When `String(block.name) === "water-extractor"`, return `tile != null && block.canPlaceOn(tile, team, 0)` (in Mindustry `SolidPump.java:1683-1695`, `waterExtractor` only pumps non-liquid tiles `!t.floor().isLiquid`; standing water loop only applies to liquid pumps like `mechanicalPump` / `impulsePump`).
   - Add `api.waterAtFootprint = function(block, x, y)` in `scripts/api.js` and `tests/js/fake-api.js` that sums `1.0 + api.waterAt(t)` over all non-liquid tiles in the `size × size` footprint of `block` at `(x, y)`.
2. In `scripts/optimization.js:4167-4195` (`placeWaterExtractorsAndPowerNodes`):
   - Track placed extractors `placedExtractors = []` (`{x, y, users}` with `maxUsers = 2`).
   - Before placing a new `waterExtractor` for drill `selection[i]`, check if any extractor in `placedExtractors` with `users < 2` has a footprint edge-adjacent to `selection[i]` (`rectsTouchCardinal`). If so, increment `users++` and skip placing a redundant extractor!
   - When scoring candidate `nearby[j]` spots for a new extractor, score by `api.waterAtFootprint(waterExtractor, plan.x, plan.y) * 100 + adjacentUnboostedDrills * 50`, so each extractor sits at the corner touching 2–3 drills on the richest ground-water footprint.

- [ ] **Step 4: Run verification gates**

Run: `./tools/engine-tests.sh && ./tools/ios-mode-check.sh`
Expected: PASS (`failed=0`).

- [ ] **Step 5: Commit**

```bash
git add scripts/api.js tests/js/fake-api.js scripts/optimization.js tests/js/engine-tests.js
git commit -m "feat(optimization): score full 2x2 SolidPump footprint and share water extractors across adjacent drills"
```

---

### Task 4: Run `routeOutputs` Before Support Block Placement so Conveyors Are Never Blocked

**Files:**
- Modify: `scripts/optimization.js:3955-3990, 4150-4164`
- Test: `tests/js/engine-tests.js`

**Interfaces:**
- Consumes: `routeOutputs(job, allPlans, occupied)`, `placeWaterExtractorsAndPowerNodes(...)`
- Produces: Unobstructed conveyor/duct output lines when `routeLength > 0` in `finish(job)` (`scripts/optimization.js`)

- [ ] **Step 1: Write the failing test in `tests/js/engine-tests.js`**

Add in `tests/js/engine-tests.js`:

```javascript
(function(){
    util.undoLastCommitted();
    var routedRes = optimization.fillDetailed(centreOf(small), laser, true, "sharded", direction.RIGHT, 4);
    var convCount = 0;
    for(var i = 0; i < routedRes.plans.length; i++){
        if(api.blockName(routedRes.plans[i].block) === "conveyor") convCount++;
    }
    check("output routing with support ON: conveyors are placed before extractors/nodes can block them",
        convCount >= 8 && overlapCells(routedRes.plans) === 0,
        "conveyors=" + convCount + " drills=" + routedRes.stats.drills);
})();
```

- [ ] **Step 2: Run `./tools/engine-tests.sh` to verify**

Run: `./tools/engine-tests.sh`
Expected: Observe how many conveyors are blocked when `placeWaterExtractorsAndPowerNodes` claims the `direction.RIGHT` ring tiles before `routeOutputs`.

- [ ] **Step 3: Move `routeOutputs(job, allPlans, occupied)` ahead of `placeWaterExtractorsAndPowerNodes` in `finish(job)`**

In `scripts/optimization.js:3955-3986`:
1. Hold `job.reservedNodes` in `occupied` first, then call `var routed = routeOutputs(job, allPlans, occupied);` **before** `placeWaterExtractorsAndPowerNodes`, `placeLaneSupplies`, `stitchPowerNetwork`, and `linkPowerGrid`.
2. In `placeWaterExtractorsAndPowerNodes` (`line 4153`), also mark `conveyor` and `duct` plans in `drillCells` so releasing a reserved node spot never unmarks a placed conveyor tile.

- [ ] **Step 4: Run the full verification gate battery**

Run:
```bash
bunx eslint scripts tests/ingame
./tools/ios-mode-check.sh
./tools/engine-tests.sh
./tools/shape-sweep.sh
./tools/vein-probe.sh
AUTODRILL_VEIN_WALKS=200 ./tools/vein-probe.sh
./tools/compile-check.sh
./tools/run-tests.sh normal
./tools/run-tests.sh ios
./tools/guard-check.sh
```
Expected: All suites PASS (`failed=0`).

- [ ] **Step 5: Commit**

```bash
git add scripts/optimization.js tests/js/engine-tests.js
git commit -m "fix(optimization): route drill output conveyors before placing water extractors and power nodes"
```
