# Phase 1: Multiblock Geometry Ground Truth & Bridge Drill Vein Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix `4×4` Airblast Drill geometry across the fake world, belt lanes, and candidate fact scanner, and overhaul `scripts/bridge.js` so `2×2` Mechanical and Pneumatic drills completely mine thin, walled, and irregular Serpulo veins without footprint collisions or dead bridge loops.

**Architecture:** First, align `tests/js/fake-api.js` and `docs/MINDUSTRY.md` with Mindustry v160.7's `Blocks.blastDrill.size = 4`, make `reserveLaneTiles` pitch dynamic (`job.size + 1`), and expand `scanTiles` / `scanFacts` so overhanging drill footprints see all foreign ores outside the patch edge. Second, fix `scripts/bridge.js` so `leftovers` includes valid non-ore overhang anchors sorted by marginal uncovered ore gain, `occupied` tracks all drills, bridges, and conveyors without early-return leaks, and bridge partner selection strictly advances toward `outlet` without `A <-> B` 2-cycles.

**Tech Stack:** JavaScript (ES5 strict mode for Mindustry Rhino `optimizationLevel = -1` and `9`), Mindustry v160.7 Scripting API (`scripts/*.js`), Java/Rhino harness (`tools/*.sh`, `tests/js/*.js`).

**Spec:** `docs/ROADMAP.md` (Sections 1, 2 Subsystems 1–2, 3, and 4)

## Global Constraints

- Obey all four iOS/Rhino rules in `docs/ROADMAP.md` Section 3: initialize every `var` at declaration (`var x = null;`), no object-returning helper calls inside hot candidate loops, no `arr[idx[i]]++` compound increments, and no Java class subclassing.
- Keep CommonJS module boundaries unchanged (`scripts/api.js` is the sole Java boundary; `scripts/util.js`, `scripts/bridge.js`, `scripts/optimization.js` remain pure JS).
- Do not change the classic 6×6 `isDrillTile` / `isBridgeTile` modulo pattern for interior patch tiles; all vein coverage gains in `bridge.js` must come from phase alignment, overhang-aware `leftovers` selection, collision-free `occupied` tracking, and cycle-free bridge/conveyor routing.

## Review Focus

1. **4×4 Airblast Drill with `Build Belt Lanes` enabled** — must place a valid non-zero grid of `4×4` Airblast drills with `lanePitch = 5` (`size + 1`) and `0` overlaps instead of `0` drills.
2. **Overhanging drill next to foreign ore (e.g. Copper patch bordered by Sand or Lead)** — `scanCandidates` must inspect all `size × size` footprint tiles even when they lie 2 tiles outside the tapped Copper patch, rejecting placements where the foreign ore wins `countOre`.
3. **1-tile-wide horizontal or vertical vein with a wall on its `+x` or `+y` side (`bridge.fill`)** — `2×2` Mechanical/Pneumatic drills must anchor on the `-x`/`-y` non-ore side (`x - 1` or `y - 1`) and cover 100% of the vein.
4. **Wall-adjacent drill routed via `connectByConveyor` (`bridge.fill`)** — must mark both the `2×2` drill footprint and every laid conveyor tile in `occupied` so subsequent `leftovers` drills never overlap them.
5. **L-shaped or obstructed vein where an interior bridge tile has no closer partner at distance 3** — must not link backward to a partner further from `outlet` (no `A <-> B` 2-cycles) and must prune any bridge whose target was rejected.

## File Structure

| File | Responsibility |
|---|---|
| `tests/js/fake-api.js` | Fake Mindustry world for fast CLI tests; must define `blastDrill` with `size = 4` (matching `Blocks.java:2921`) |
| `docs/MINDUSTRY.md` | Ground-truth table of Mindustry v160.7 drill sizes and tiers (`airblast` size `4`, tier `4`) |
| `scripts/optimization.js` | `scanTiles` / `scanFacts` footprint padding (`size - 1`) and dynamic `lanePitch = job.size + 1` in `reserveLaneTiles` |
| `scripts/bridge.js` | `2×2` Mechanical/Pneumatic matrix + overhang `leftovers` ranking + `occupied` tracking + cycle-free bridge chain |
| `tests/js/engine-tests.js` | Fast CLI assertion suite (`./tools/engine-tests.sh`) |

---

### Task 1: Fix `blastDrill` `4×4` Geometry & Dynamic Belt-Lane Pitch (`size + 1`)

**Files:**
- Modify: `tests/js/fake-api.js:30-35`
- Modify: `docs/MINDUSTRY.md:810-820`
- Modify: `scripts/optimization.js:2490-2495, 2947-3000`
- Test: `tests/js/engine-tests.js`

**Interfaces:**
- Consumes: `api.size(job.drill)` (`number`)
- Produces: `blastDrill.size === 4` in `fake-api.js`; dynamic `lanePitch = job.size + 1` in `reserveLaneTiles(job)` (`scripts/optimization.js`)

- [ ] **Step 1: Write the failing test in `tests/js/engine-tests.js`**

Add inside section `6h. belt lanes` of `tests/js/engine-tests.js`:

```javascript
check("fake-api: blastDrill is 4x4 like Mindustry Blocks.blastDrill",
    api.size(blast) === 4, "size=" + api.size(blast));

S.settings = {"auto-drill-ios-build-belt-lanes": true};
util.undoLastCommitted();
var blastLaneFill = optimization.fillDetailed(centreOf(round), blast, true, "sharded", null, 0);
S.settings = null;
check("lanes: 4x4 airblast drill places drills and lanes without being blocked by 4-row pitch",
    blastLaneFill.stats.drills >= 25 && blastLaneFill.stats.covered >= blastLaneFill.stats.target * 0.60
        && overlapCells(blastLaneFill.plans) === 0,
    "drills=" + blastLaneFill.stats.drills + " covered=" + blastLaneFill.stats.covered + "/" + blastLaneFill.stats.target);
```

- [ ] **Step 2: Run `./tools/engine-tests.sh` to verify it fails**

Run: `./tools/engine-tests.sh`
Expected: FAIL on `fake-api: blastDrill is 4x4` (`size=3`), and once `fake-api.js` is set to `4`, FAIL on `lanes: 4x4 airblast drill places drills` (`drills=0`).

- [ ] **Step 3: Update `fake-api.js`, `docs/MINDUSTRY.md`, and `reserveLaneTiles` in `scripts/optimization.js`**

1. In `tests/js/fake-api.js:31`, change `var blastDrill = block("blastDrill", 3, "serpulo");` to:
   ```javascript
   var blastDrill = block("blastDrill", 4, "serpulo");
   ```
2. In `docs/MINDUSTRY.md:814-815`, update `laser` tier to `4` and `airblast` size to `4`, tier to `4`.
3. In `scripts/optimization.js:2947-3000` (`reserveLaneTiles(job)`), compute `var lanePitch = Math.max(LANE_PITCH, job.size + 1);` and use `lanePitch` instead of `LANE_PITCH` in both the `alongX` (`y += lanePitch`) and `!alongX` (`x2 += lanePitch`) loops.

- [ ] **Step 4: Run verification gates**

Run: `./tools/engine-tests.sh && ./tools/shape-sweep.sh && ./tools/ios-mode-check.sh`
Expected: PASS (`failed=0`).

- [ ] **Step 5: Commit**

```bash
git add tests/js/fake-api.js docs/MINDUSTRY.md scripts/optimization.js tests/js/engine-tests.js
git commit -m "fix(optimization): use 4x4 blastDrill size in fake world and dynamic lane pitch"
```

---

### Task 2: Fix Full-Footprint Foreign-Ore Fact Scanning on Overhanging Drills

**Files:**
- Modify: `scripts/optimization.js:2590-2722`
- Test: `tests/js/engine-tests.js`

**Interfaces:**
- Consumes: `api.tile(x, y)`, `api.getDrop(drill, t)`, `api.canMine(drill, t)`, `api.itemId(item)`, `api.itemLowPriority(item)`
- Produces: `cellFactAt(job, x, y)` in `scripts/optimization.js` ensuring `scanCandidates` evaluates every tile in `[cx0, cx0 + size - 1] × [cy0, cy0 + size - 1]` even when `x, y` lies outside `job.tiles`

- [ ] **Step 1: Write the failing test in `tests/js/engine-tests.js`**

Add in `tests/js/engine-tests.js` (inside section `6e` mixed-patch tests):

```javascript
(function(){
    // A 2x4 copper strip at x=70..71, y=70..73 bordered on the right (x=72..73) by lead.
    // A 4x4 airblast or 3x3 laser overhanging into x=72..73 covers more/equal lead than copper
    // (and lead has higher item.id than copper, winning ties in Drill.countOre).
    S.leadRect = {x0: 72, y0: 70, x1: 75, y1: 79};
    var borderRes = fillAt(small, blast, null, false);
    var badBorder = 0;
    for(var bi = 0; bi < borderRes.plans.length; bi++){
        var bp = borderRes.plans[bi];
        if(api.blockId(bp.block) !== api.blockId(blast)) continue;
        var realOre = util.countOre(api.tile(bp.x, bp.y), blast);
        if(realOre == null || api.itemId(realOre.item) !== api.itemId(AUTODRILL_API_FAKE.__info().copper)){
            badBorder++;
        }
    }
    S.leadRect = null;
    check("mixed border: no overhanging drill has a foreign dominant item in util.countOre",
        badBorder === 0, "badBorder=" + badBorder);
})();
```

- [ ] **Step 2: Run `./tools/engine-tests.sh` to verify it fails**

Run: `./tools/engine-tests.sh`
Expected: FAIL with `badBorder > 0` because `scanCandidates` ignores `leadRect` tiles outside the radius-`Math.floor(size/2)` expanded `job.tiles`.

- [ ] **Step 3: Populate missing footprint cell facts on demand in `scanCandidates` (`scripts/optimization.js`)**

In `scripts/optimization.js:2663-2690` (`scanCandidates`), when `var fact = cellFacts[ckey];` is `undefined`:
- Look up `var ft = api.tile(cx0 + ci, cy0 + cj);`
- If `ft != null`, compute `item = api.getDrop(job.drill, ft)`, `itemId = api.itemId(item)`, cache `lowPriority[itemId]`, compute `canMine = api.canMine(job.drill, ft)`, and store `fact = {canMine: canMine, dropId: itemId, mineable: false}` in `cellFacts[ckey]` (`mineable` is `false` for tiles outside `job.tiles` so `targetCells` is unchanged, while `counts[fact.dropId]` accurately counts the foreign or unwalked ore for the dominant-item winner check).
- Also in `scanTiles(job)` (`line 2597`), ensure `expandArea` uses `Math.floor(job.size / 2)` so candidate centers on the `-x/-y` side of `4×4` drills (`cx0 = x - 1, x + 2 = ox => x = ox - 2`) are included in `job.tiles`.

- [ ] **Step 4: Run verification gates**

Run: `./tools/engine-tests.sh && ./tools/ios-mode-check.sh`
Expected: PASS (`failed=0`).

- [ ] **Step 5: Commit**

```bash
git add scripts/optimization.js tests/js/engine-tests.js
git commit -m "fix(optimization): inspect full footprint for foreign ores on overhanging candidates"
```

---

### Task 3: Allow Non-Ore Overhang Anchors & Marginal-Gain Ordering in `bridge.js` `leftovers`

**Files:**
- Modify: `scripts/bridge.js:2130-2185`
- Test: `tests/js/engine-tests.js`

**Interfaces:**
- Consumes: `util.countOre(tile, drill)`, `util.sortStable(items, keyFn)`
- Produces: Overhang-complete `leftovers` candidate list in `placeDrillsAndBridges` (`scripts/bridge.js`)

- [ ] **Step 1: Write the failing test in `tests/js/engine-tests.js`**

Add in `tests/js/engine-tests.js`:

```javascript
(function(){
    // 1-tile-wide horizontal copper vein (y=100, x=70..109) with a solid wall immediately
    // above it at y=101, x=70..109. A 2x2 mechanical drill at (x, y) covers [x, x+1] x [y, y+1],
    // so every drill MUST be anchored at y=99 (non-ore ground).
    var wallRow = [];
    for(var wx = 70; wx <= 109; wx++) wallRow.push([wx, 101]);
    S.wallCells = wallRow;
    var freshApi = makeApi();
    for(var k in freshApi) api[k] = freshApi[k];

    util.undoLastCommitted();
    var plans = bridge.fill({x: 85, y: 100}, api.block("mechanicalDrill"), direction.DOWN, "sharded");
    var cov = coverageOf(vein, plans, api.block("mechanicalDrill"));

    S.wallCells = null;
    freshApi = makeApi();
    for(k in freshApi) api[k] = freshApi[k];

    check("belt tool: 1-wide vein with wall on +y is mined via y-1 overhang anchors",
        cov.covered >= 36, "covered=" + cov.covered + "/" + cov.total + " drills=" + cov.drills);
})();
```

- [ ] **Step 2: Run `./tools/engine-tests.sh` to verify it fails**

Run: `./tools/engine-tests.sh`
Expected: FAIL (`covered` is only ~8–16 of 40 because `leftovers` discards all `y = 99` non-ore tiles).

- [ ] **Step 3: Include all valid overhang tiles in `leftovers` and sort by uncovered ore count in `scripts/bridge.js`**

In `scripts/bridge.js:2137-2185` (`placeDrillsAndBridges`):
1. Replace `else if(isOreTile(tiles[i], sourceDropId)) leftovers.push(tiles[i]);` with `else if(!isBridgeTile(tiles[i], phaseX, phaseY)) leftovers.push(tiles[i]);` so expanded ring tiles on `-x`/`-y` are eligible overhang anchors (`takeDrillCandidate` already checks `util.countOre(t, drill)` for `sourceDropId` and `minOresPerDrill`).
2. Before iterating `leftovers`, score each tile `t` in `leftovers` by how many **currently uncovered** `targetSet` ore cells its `2×2` footprint covers (`uncoveredGain`), sort `leftovers` descending by `uncoveredGain` using `util.sortStable`, and during the `leftovers` loop re-check that the candidate covers at least 1 still-uncovered `targetSet` cell before calling `takeDrillCandidate`.

- [ ] **Step 4: Run verification gates**

Run: `./tools/engine-tests.sh && ./tools/vein-probe.sh && ./tools/ios-mode-check.sh`
Expected: PASS (`failed=0`).

- [ ] **Step 5: Commit**

```bash
git add scripts/bridge.js tests/js/engine-tests.js
git commit -m "fix(bridge): allow non-ore overhang anchors in leftovers and prioritize uncovered ore"
```

---

### Task 4: Fix `occupied` Tracking Across Drills, Conveyors, and Bridge Tiles in `bridge.js`

**Files:**
- Modify: `scripts/bridge.js:1776-1850, 1867-1944, 2141-2185`
- Test: `tests/js/engine-tests.js`

**Interfaces:**
- Consumes: `occupied` (`Object<number, boolean>` keyed by `x + y * worldW`)
- Produces: Collision-free `takeDrillCandidate`, `addConveyorToGrid`, and `connectByConveyor` in `scripts/bridge.js`

- [ ] **Step 1: Write the failing test in `tests/js/engine-tests.js`**

Add in `tests/js/engine-tests.js`:

```javascript
(function(){
    // Walled pocket where bridge drills must use connectByConveyor and addConveyorToGrid:
    // no planned drill, conveyor, or bridge may be rejected during dry-run collision checks.
    var pocketWalls = [];
    for(var py = 60; py <= 80; py++) pocketWalls.push([69, py]);
    for(var px = 69; px <= 80; px++) pocketWalls.push([px, 80]);
    S.wallCells = pocketWalls;
    var freshApi = makeApi();
    for(var k in freshApi) api[k] = freshApi[k];

    util.undoLastCommitted();
    var plans = bridge.fill({x: 74, y: 74}, api.block("mechanicalDrill"), direction.RIGHT, "sharded");
    var cov = coverageOf(small, plans, api.block("mechanicalDrill"));

    S.wallCells = null;
    freshApi = makeApi();
    for(k in freshApi) api[k] = freshApi[k];

    check("belt tool: walled pocket has 0 overlaps and >= 88% coverage",
        overlapCells(plans) === 0 && cov.covered >= 88,
        "covered=" + cov.covered + "/100 overlaps=" + overlapCells(plans));
})();
```

- [ ] **Step 2: Run `./tools/engine-tests.sh` to verify behavior**

Run: `./tools/engine-tests.sh`
Expected: Inspect refused/colliding plans when `connectByConveyor` returns early at line 1925 without marking `occupied`.

- [ ] **Step 3: Fix `occupied` marking in `connectByConveyor`, `addConveyorToGrid`, and `takeDrillCandidate` (`scripts/bridge.js`)**

1. In `addConveyorToGrid(tile, team, bridgeTiles, beltPlans, occupied)` (`scripts/bridge.js:1830-1849`):
   - Accept `occupied` parameter.
   - Return `0` if `occupied[x + y * api.worldW()] === true`.
   - When a conveyor plan is pushed to `beltPlans`, set `occupied[x + y * api.worldW()] = true`.
2. In `connectByConveyor(neighbours, drill, team, bridgeTiles, beltPlans, occupied)` (`scripts/bridge.js:1776-1820`):
   - When `plans` are pushed to `beltPlans` (`line 1816`), mark every conveyor tile `occupied[plans[p].x + plans[p].y * worldW] = true`.
3. In `takeDrillCandidate` (`scripts/bridge.js:1915-1943`):
   - Pass `occupied` to `addConveyorToGrid`.
   - On line 1925, instead of returning `1` early when `connectByConveyor` succeeds, set `connected = true;` and fall through to lines 1938–1943 so the drill's `2×2` footprint is always marked in `occupied`!
   - When `placeable` bridge tiles are added to `bridgeTiles` (`lines 1933-1935`), mark each added bridge tile in `occupied` (`occupied[bx + by * worldW] = true`) so later `leftovers` drills cannot overwrite an active bridge tile.

- [ ] **Step 4: Run verification gates**

Run: `./tools/engine-tests.sh && ./tools/vein-probe.sh && ./tools/ios-mode-check.sh`
Expected: PASS (`failed=0`).

- [ ] **Step 5: Commit**

```bash
git add scripts/bridge.js tests/js/engine-tests.js
git commit -m "fix(bridge): mark occupied cells for connectByConveyor, conveyors, and active bridge tiles"
```

---

### Task 5: Eliminate Bridge Partner 2-Cycles & Prune Broken-Target Bridges in `bridge.js`

**Files:**
- Modify: `scripts/bridge.js:2232-2369`
- Test: `tests/js/engine-tests.js`

**Interfaces:**
- Consumes: `bridgeTiles` (sorted ascending by `dst2ToPoint` to `outlet`), `bridgePlans`
- Produces: Acyclic `bridgePlans` in `placeDrillsAndBridges` (`scripts/bridge.js`) where every non-outlet bridge links to an existing or planned bridge strictly closer to `outlet`

- [ ] **Step 1: Write the failing test in `tests/js/engine-tests.js`**

Add in `tests/js/engine-tests.js`:

```javascript
(function(){
    var plans = bridge.fill(centreOf(round), api.block("mechanicalDrill"), direction.RIGHT, "sharded");
    var itemBridgeId = api.blockId(api.block("itemBridge"));
    var bridgeMap = {};
    var bi = 0;
    for(bi = 0; bi < plans.length; bi++){
        if(api.blockId(plans[bi].block) === itemBridgeId){
            bridgeMap[plans[bi].x + "," + plans[bi].y] = plans[bi];
        }
    }
    var cycles = 0, dangling = 0;
    for(var bk in bridgeMap){
        var b = bridgeMap[bk];
        if(b.configX === 0 && b.configY === 0) continue;
        var tx = b.x + b.configX, ty = b.y + b.configY;
        var target = bridgeMap[tx + "," + ty];
        if(target == null){
            dangling++;
        }else if(target.x + target.configX === b.x && target.y + target.configY === b.y){
            cycles++;
        }
    }
    check("belt tool: no 2-cycle or dangling itemBridge links",
        cycles === 0 && dangling === 0, "cycles=" + cycles + " dangling=" + dangling);
})();
```

- [ ] **Step 2: Run `./tools/engine-tests.sh` to verify**

Run: `./tools/engine-tests.sh`
Expected: Verify whether any `cycles` or `dangling` bridge links occur on round/irregular patches.

- [ ] **Step 3: Restrict bridge partner search to closer indices (`k < i`) and prune broken targets in `scripts/bridge.js`**

1. In `scripts/bridge.js:2236` (`for(var k = 0; k < bridgeTiles.length; k++)`):
   - Because `bridgeTiles` is sorted ascending by `dst2ToPoint(t2, outlet)` on line 2205, change the partner search bound to `for(var k = 0; k < i; k++)` so a bridge at index `i` only links to a bridge at index `k < i` (closer to `outlet`), making `A <-> B` 2-cycles impossible by construction.
2. In `scripts/bridge.js:2351-2366`:
   - When `!targetExists`, if `bp` is fed by another bridge (`fed === true`), convert `bp` into an unconfigured terminal outlet (`bp.configX = 0; bp.configY = 0;`) so it dumps its items onto adjacent tiles instead of holding a broken link config to a non-existent target; if `!fed`, remove `bp` (`bridgePlans.splice(n, 1); changed = true;`).

- [ ] **Step 4: Run all verification gates**

Run: `./tools/engine-tests.sh && ./tools/shape-sweep.sh && ./tools/vein-probe.sh && ./tools/ios-mode-check.sh && ./tools/compile-check.sh`
Expected: All checks PASS (`failed=0`).

- [ ] **Step 5: Commit**

```bash
git add scripts/bridge.js tests/js/engine-tests.js
git commit -m "fix(bridge): prevent 2-cycle bridge links and convert broken-target bridges to outlets"
```
