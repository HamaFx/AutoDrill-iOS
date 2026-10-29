# Phase 2: Optimizer Irregular Vein Solver & Local Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade `scripts/optimization.js` so thin, branched, stepped, and wall-pinched Serpulo ore veins achieve 100% coverage of reachable tiles across all map positions and patch sizes.

**Architecture:** We add four complementary upgrades to `scripts/optimization.js`: (1) a **Bottleneck-First (Forced-Tile Degree-1/2)** layout family that computes how many legal candidates cover each ore tile and places drills on forced/low-degree vein tips and corners before high-count interior blobs can block them; (2) **Translation-Invariant Multi-Lattice Selection** that anchors lattice coordinates to the patch bounding box `(tx - minX) % size` and runs `swapRepair` on all top-scoring lattice phases; (3) **Window-Local Deep Repair + 2-Candidate Coupled Swap** that removes the `entries.length <= 320` cutoff by filtering insertions to the local ruin window; and (4) an **Adaptive `minOres = 1` Rim Fallback** for 1-tile vein tips that no `minOres >= 2` placement can reach.

**Tech Stack:** JavaScript (ES5 strict mode for Mindustry Rhino `optimizationLevel = -1` and `9`), `scripts/optimization.js`, `tools/vein-probe.sh`, `tools/vein-solve.py`.

**Spec:** `docs/ROADMAP.md` (Sections 2 Subsystem 3, 3, and 4)

## Global Constraints

- Obey all four iOS/Rhino rules in `docs/ROADMAP.md` Section 3: initialize every `var` (`var x = null;`), never call object-returning helpers inside hot loops, never write `arr[idx[i]]++`, and never pass comparator callbacks inside `swapRepair` / `repairSelection` hot loops (use inline insertion sort or bucket sort).
- Every layout family and repair step must be strictly deterministic (no `Math.random()`) and strictly non-degrading (`newScore > bestScore`).
- Keep worst-case planning time under the 3,000 ms wall-clock budget on iOS interpreted mode (`./tools/run-tests.sh ios`).

## Review Focus

1. **Same irregular vein shifted by `+1` or `+2` tiles on the map (`AUTODRILL_VEIN_SHIFT=1` / `2`)** — must produce identical coverage regardless of world coordinate modulo `size`.
2. **Blob with 1-tile-wide tendrils or stepped diagonal arms (`blob7+4arms` and 200 random drunkard-walk veins)** — interior `winnerCount = 9` drills must not lock out the only candidate covering the tendril tip.
3. **Large patch (`> 320` candidates, e.g. 1,200+ ore tiles) with 1–2 leftover blocked tiles** — window-local `deepRepair` must still run on the local `radius = 4` neighborhood in `< 50 ms` instead of skipping when `entries.length > 320`.
4. **Coupled 2-drill shift along a thin vein** — when uncovering 1 tile requires dropping a blocker and inserting 2 non-overlapping candidates in its neighborhood, `swapRepair` / `deepRepair` must find it.
5. **1-tile protruding vein tip pinched by walls where `minOres = 2` leaves the tip `unreachable`** — adaptive rim fallback must cover the leftover tip when a valid `1`-ore placement fits without overlapping existing drills.

## File Structure

| File | Responsibility |
|---|---|
| `scripts/optimization.js` | Candidate degree analysis, bottleneck-first sweep order, translation-invariant lattice + multi-phase repair, window-local deep repair, and 1-ore rim gap-fill fallback |
| `tests/js/engine-tests.js` | Regression checks for translation invariance, 200-walk vein battery, large-patch deep repair, and 1-tile walled tip fallback |

---

### Task 1: Add Bottleneck-First (Degree-1 / Low-Degree Forced Tile) Sweep Orders

**Files:**
- Modify: `scripts/optimization.js:2780-2798, 3327-3350`
- Test: `tests/js/engine-tests.js`

**Interfaces:**
- Consumes: `job.entries` (`Array<{tile, cellKeys, mineableKeys, winnerCount}>`)
- Produces: `buildBottleneckOrders(entries)` in `scripts/optimization.js`, prepended to `job.sweepOrders` and `job.deepOrders`

- [ ] **Step 1: Write the failing test in `tests/js/engine-tests.js`**

Add in `tests/js/engine-tests.js` (inside section `2b. vein shapes`):

```javascript
(function(){
    // Check across 30 deterministic walk veins at default quality (quality=2):
    // every single reachable ore tile must be covered (0 blocked leftovers).
    var blockedShapes = 0;
    for(var wi = 0; wi < 30; wi++){
        var seed = 101 + wi * 7919;
        var steps = 45 + (wi * 37) % 60;
        var cells = place(walkVein(seed, steps, 6 + (wi % 5)), 10, 108);
        // clear previous test ore in the 10..95, 105..138 slot
        for(var cx = 5; cx < 95; cx++){
            for(var cy = 104; cy < 139; cy++){
                // reset via fresh scenario or dedicated slot
            }
        }
    }
})();
```
And run the 200-walk vein probe baseline:
Run: `AUTODRILL_VEIN_WALKS=200 ./tools/vein-probe.sh | tail -n 5`

- [ ] **Step 2: Verify baseline partial count on 200 random walks**

Run: `AUTODRILL_VEIN_WALKS=200 AUTODRILL_VEIN_DRILL=laserDrill ./tools/vein-probe.sh | grep "BATTERY RESULT"`
Expected: Shows `partial=6` (or more when `AUTODRILL_VEIN_SHIFT=1` or `2`).

- [ ] **Step 3: Implement `buildBottleneckOrders(entries)` in `scripts/optimization.js`**

In `scripts/optimization.js` right below `buildSweepOrders(entries)`:
1. Compute `tileDeg[key]` = number of entries in `entries` whose `mineableKeys` contains `key`.
2. For each entry `e` at index `i`, compute:
   - `minDeg`: the minimum `tileDeg[k]` across `k` in `e.mineableKeys` (an entry covering a degree-1 forced tile has `minDeg === 1`; degree-2 has `minDeg === 2`).
   - `raritySum`: the sum of `Math.floor(1000 / tileDeg[k])` across `k` in `e.mineableKeys`.
3. Build two deterministic bottleneck orders:
   - **Order A (Forced-First, High-Gain Tie-Break)**: sort indices ascending by `minDeg`, then descending by `e.winnerCount`, then descending by `raritySum`.
   - **Order B (Rarity-Weighted Gain)**: sort indices descending by `raritySum`.
4. Prepend both orders to `job.sweepOrders` in `setupSearch(job)` (`line 2783`) and always execute the first `Math.max(3, Math.min(job.sweepOrders.length, job.quality + 2))` sweeps in `chooseSelection(job)` (`line 3575`).

- [ ] **Step 4: Run verification gates**

Run: `AUTODRILL_VEIN_WALKS=200 AUTODRILL_VEIN_DRILL=laserDrill ./tools/vein-probe.sh | grep "BATTERY RESULT" && ./tools/engine-tests.sh && ./tools/ios-mode-check.sh`
Expected: Partial count drops significantly and all checks in `engine-tests.sh` and `ios-mode-check.sh` PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/optimization.js tests/js/engine-tests.js
git commit -m "feat(optimization): add bottleneck-first (forced degree-1/2 tile) candidate sweep orders"
```

---

### Task 2: Make `bestLattice` Translation-Invariant and Repair All Tied/Top Lattice Phases

**Files:**
- Modify: `scripts/optimization.js:3473-3497, 3560-3601`
- Test: `tests/js/engine-tests.js`

**Interfaces:**
- Consumes: `job.entries`, `fillGaps(job, selection)`, `swapRepair(job, selection, trialCap)`
- Produces: Translation-invariant `bestLattice(job)` in `scripts/optimization.js`

- [ ] **Step 1: Write the failing test in `tests/js/engine-tests.js`**

Add in `tests/js/engine-tests.js` (inside section `2b. vein shapes`):

```javascript
(function(){
    // Translation invariance: walk72 (73 cells) shifted by (0,0), (1,0), (2,0), (0,1), (1,1)
    // must cover all 73/73 cells at every shift.
    var baseCells = walkVein(101 + 72 * 7919, 40 + (72 * 37) % 81, 6 + (72 % 6));
    var shifts = [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1]];
    var shiftMisses = 0;
    for(var si = 0; si < shifts.length; si++){
        var freshApi = makeApi();
        for(var k in freshApi) api[k] = freshApi[k];
        var placed = place(baseCells, 10 + shifts[si][0], 108 + shifts[si][1]);
        var got = veinCoverage(placed);
        if(got.covered < got.total) shiftMisses++;
    }
    check("vein shapes: coverage is 100% across all map coordinate shifts modulo drill size",
        shiftMisses === 0, "shiftMisses=" + shiftMisses + "/" + shifts.length);
})();
```

- [ ] **Step 2: Run `./tools/engine-tests.sh` to verify it fails**

Run: `./tools/engine-tests.sh`
Expected: FAIL (`shiftMisses > 0`, matching `docs/AUDIT.md:640-648` where shift 0 and shift 2 only cover `72/73`).

- [ ] **Step 3: Anchor `bestLattice` to patch-relative `(minX, minY)` and run fast `swapRepair` on top lattice phases**

In `scripts/optimization.js:3473-3497` (`bestLattice(job)`):
1. Compute the minimum candidate coordinate `minX, minY` across `job.entries`.
2. Test `((api.tx(entry.tile) - minX - ax) % size + size) % size !== 0` and `((api.ty(entry.tile) - minY - ay) % size + size) % size !== 0` so lattice phase `(ax, ay)` is 100% invariant to world translation.
3. For any lattice translation whose `filled` score is `< job.coverable` and within `size * size` of `best.score`, run a lightweight `swapRepair(job, filled, 8)` before comparing against `best.score` (stopping early as soon as `best.score === job.coverable`).

- [ ] **Step 4: Run verification gates**

Run: `./tools/engine-tests.sh && AUTODRILL_VEIN_SHIFT=0 ./tools/vein-probe.sh | tail -n 3 && AUTODRILL_VEIN_SHIFT=1 ./tools/vein-probe.sh | tail -n 3 && AUTODRILL_VEIN_SHIFT=2 ./tools/vein-probe.sh | tail -n 3 && ./tools/ios-mode-check.sh`
Expected: PASS (`shiftMisses=0/5`, identical battery results across shifts 0, 1, and 2).

- [ ] **Step 5: Commit**

```bash
git add scripts/optimization.js tests/js/engine-tests.js
git commit -m "fix(optimization): make bestLattice translation-invariant and repair tied lattice phases"
```

---

### Task 3: Window-Local `deepRepair` (Remove 320-Entry Cutoff) & Coupled 2-Candidate Local Swap

**Files:**
- Modify: `scripts/optimization.js:3661-3897`
- Test: `tests/js/engine-tests.js`

**Interfaces:**
- Consumes: `job.entries`, `job.deepOrders`, `swapRepair(job, selection, trialCap)`
- Produces: Window-filtered `localInsertion(job, order, base, windowSet)` and coupled 2-candidate repair in `repairSelection(job, selection)` (`scripts/optimization.js`)

- [ ] **Step 1: Write the failing test in `tests/js/engine-tests.js`**

Add in `tests/js/engine-tests.js`:

```javascript
(function(){
    var res = AUTODRILL_VEIN_WALKS_TEST; // run 200 walk veins through optimization.fillDetailed
    // Assert 0 partial veins out of 200 random walks on laserDrill (support off)
})();
```
And test with `AUTODRILL_VEIN_WALKS=200 AUTODRILL_VEIN_DRILL=laserDrill ./tools/vein-probe.sh`.

- [ ] **Step 2: Run 200-walk battery to inspect any remaining partial walk shapes**

Run: `AUTODRILL_VEIN_WALKS=200 AUTODRILL_VEIN_DRILL=laserDrill ./tools/vein-probe.sh | grep -E "covered=.*\(9|BATTERY RESULT"`
Expected: Identify the remaining 1–6 shapes where a 2-drill coupled shift or larger window is required.

- [ ] **Step 3: Filter `deepRepair` to a local candidate window (`radius = 6`) and remove `DEEP_REPAIR_MAX_ENTRIES`**

In `scripts/optimization.js:3800-3897` (`repairSelection`):
1. Remove the `entries.length <= DEEP_REPAIR_MAX_ENTRIES` condition on line 3811.
2. Increase `DEEP_REPAIR_RADIUS` from `4` to `5` (`window` radius `DEEP_REPAIR_RADIUS + job.size`) and `DEEP_REPAIR_MAX_RUIN` from `12` to `16`.
3. Pre-filter `windowEntries`: only candidates in `job.entries` whose center `(tx, ty)` is within Chebyshev distance `DEEP_REPAIR_RADIUS + job.size + 1` of `(tileX, tileY)` can possibly fit in the ruined window! Build `localOrders` by filtering `job.deepOrders[oi]` to indices in `windowEntries`.
4. Because `localOrders` has at most ~25–60 candidates (even on a 5,000-tile patch!), `greedyInsert` + `fillGaps` over the local window runs in `< 1 ms` regardless of total patch size.
5. Also add a **2-candidate coupled seeding step** inside `deepRepair`: for the uncovered tile `tile`, iterate over each candidate `candA` that directly mines `tile`, place `candA` into `base` (if compatible with `base`), and then run `greedyInsert` + `swapRepair` over `localOrders`. This guarantees that the uncovered tile itself is forced to be covered first while the neighborhood repacks around `candA`!

- [ ] **Step 4: Run verification gates**

Run: `AUTODRILL_VEIN_WALKS=200 AUTODRILL_VEIN_DRILL=laserDrill ./tools/vein-probe.sh | grep "BATTERY RESULT" && ./tools/vein-probe.sh | grep "BATTERY RESULT" && ./tools/engine-tests.sh && ./tools/ios-mode-check.sh`
Expected: `200/200` random walks and `53/53` hand-built shapes achieve 100% coverage of reachable tiles (`partial=0` on `laserDrill`), and all engine/iOS checks PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/optimization.js tests/js/engine-tests.js
git commit -m "feat(optimization): force uncovered-tile seed in window-local deepRepair"
```

---

### Task 4: Adaptive `minOres = 1` Rim Fallback for Pinched 1-Tile Vein Tips

**Files:**
- Modify: `scripts/optimization.js:2553-2560, 2705-2716, 3504-3550`
- Test: `tests/js/engine-tests.js`

**Interfaces:**
- Consumes: `job.rimCandidates` (candidates with `winner === sourceDropId` and `1 <= count < job.minOres` when `job.minOres === 2`)
- Produces: Post-repair rim gap-fill in `finish(job)` (`scripts/optimization.js`) that covers otherwise-unreachable 1-tile vein tips when `job.minOres <= 2`

- [ ] **Step 1: Write the failing test in `tests/js/engine-tests.js`**

Add in `tests/js/engine-tests.js`:

```javascript
(function(){
    // A 3x3 copper patch with a 1-tile tip protruding into a 3-wide walled corridor where
    // any 3x3 laser drill covering the tip can only touch 1 copper tile.
    // At the shipping default (minOres=2), the tip must still be mined by the rim fallback.
    var corridorWalls = [
        [40, 118], [41, 118], [42, 118],
        [40, 122], [41, 122], [42, 122]
    ];
    S.wallCells = corridorWalls;
    var freshApi = makeApi();
    for(var k in freshApi) api[k] = freshApi[k];

    var cells = [
        [37, 119], [38, 119], [39, 119],
        [37, 120], [38, 120], [39, 120], [40, 120],
        [37, 121], [38, 121], [39, 121]
    ];
    var got = veinCoverage(cells);

    S.wallCells = null;
    freshApi = makeApi();
    for(k in freshApi) api[k] = freshApi[k];

    check("vein shapes: 1-tile walled tip is covered at default minOres=2 via rim fallback",
        got.covered === got.total, "covered=" + got.covered + "/" + got.total);
})();
```

- [ ] **Step 2: Run `./tools/engine-tests.sh` to verify it fails**

Run: `./tools/engine-tests.sh`
Expected: FAIL (`covered=9/10` because the tip at `[40, 120]` only has 1-ore placements due to the corridor walls, which `minOres = 2` filters out).

- [ ] **Step 3: Collect `job.rimCandidates` (`count === 1`) when `job.minOres === 2` and fill unreachable tips after main packing**

1. In `newJob` (`scripts/optimization.js:2553`), initialize `rimCandidates: []`.
2. In `scanCandidates` (`scripts/optimization.js:2706`), if `winner === sourceDropId` and `counts[winner].count < minOres`:
   - When `minOres <= 2` and `counts[winner].count >= 1` and `util.canPlaceBlock(job.drill, job.team, api.tx(cand), api.ty(cand), 0)`, push the candidate into `job.rimCandidates` (and filter `job.rimCandidates` against `job.reserved` and `job.plannedBlocked` in `setupSearch`).
3. In `finish(job)` (`scripts/optimization.js:3918`), after `repairSelection`, if `score < job.targetCells` and `job.rimCandidates.length > 0`, run a single greedy gap-fill pass over `job.rimCandidates` adding any non-overlapping rim candidate that covers at least 1 still-uncovered ore tile, and update `score` / `covered` / `job.coverable`.

- [ ] **Step 4: Run all verification gates**

Run: `./tools/engine-tests.sh && ./tools/vein-probe.sh && ./tools/shape-sweep.sh && ./tools/ios-mode-check.sh && ./tools/compile-check.sh`
Expected: All checks PASS (`failed=0`).

- [ ] **Step 5: Commit**

```bash
git add scripts/optimization.js tests/js/engine-tests.js
git commit -m "feat(optimization): add rim fallback for 1-tile walled vein tips at default minOres"
```
