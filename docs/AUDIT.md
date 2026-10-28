# Engine & system audit — AutoDrill (iOS) v1.0.0

Date: 2026-10-28 · Scope: `scripts/*.js` (this repo), `autodrill/filler/*.java` (upstream),
and the Mindustry 8.160.7 API it targets. No new tests were written for this audit; the
numbers below come from the existing iOS-mode suite runs and from reading the code.
Everything is a proposal — nothing here is implemented yet.

Baseline measured in the iOS-mode build (interpreted scripts, the worst case):

| Case | Time | Notes |
|---|---|---|
| Bridge fill, 41×41 patch (1,681 ore tiles) | 186 ms / 78 plans | 20 ms on desktop (compiled) |
| Optimiser fill, same patch | 2,129 ms / 40 plans | hits the 2 s budget; 511 ms on desktop |
| Flood fill | dominant Java-call source | 1 `validPlace` per dequeued tile + 1 `pos()` per neighbour |
| Ore counting | 1 `getLinkedTilesAs` (allocates a `Seq`) + one call per linked tile, **per candidate** | pre-filter cost scales with patch × drill size² |

---

## A. Engine — layout quality

**A1. The optimiser double-counts ore.** `recursiveMaxSearch` scores a branch as the *sum of
each drill's own ore count*. Two 3×3 drills that share a tile both count it, so the search
happily returns layouts that mine the same tile twice and leave other tiles unmined —
it maximises a number, not the ore actually extracted.
→ Score by **marginal gain** (track a covered-ore bitset per branch, add only new tiles).
Expected: real throughput improvement on dense patches, where footprint overlap is common.
Effort medium, risk low (scoring change only).

**A2. The optimiser re-explores permutations.** Every ordering of the same drill set is a
separate branch, so identical layouts are searched many times. The `maxTries / 2^(level+1)`
decay is a crude substitute for a real bound.
→ Canonical ordering (only consider tiles *after* the last placed index) + an **upper bound**
(sum of remaining marginal gains) turns this into branch-and-bound: same budget, better
layouts, or same quality in a fraction of the time. This is the single biggest algorithmic
upgrade available; it may allow raising the default `Optimization Quality` from 2.
Effort medium, risk medium (needs care with the existing "best so far" semantics).

**A3. `expandArea` is asymmetric.** The loops run `dx = -radius … radius-1`, so the extra
ring for drill overhang is only added on the −x/−y side (inherited from upstream).
→ Use `-radius … radius`; trivial fix, slightly better edge layouts.

**A4. Optimised drills have no output routing.** The bridge fillers place item bridges, but
laser/airblast/impact/eruption fills stop at drills (+water extractor/power node) — the
player hand-wires everything. That is the largest remaining functional gap versus the
bridge path.
→ Add optional transport for optimised drills (conveyor spine + bridge chain, chosen with
the same direction picker, or auto-routed toward the nearest core/duct).
Effort high, value high; keep it opt-in so existing behaviour stays available.

**A5. Support blocks are placed blindly.** `waterExtractor` is gated by the engine to
`Env.groundWater` tiles (verified: `envRequired`), but the mod takes the *first* valid tile
and never compares the **water attribute** that determines its output; power nodes
(`laserRange 6`, `maxNodes 10`, verified) are placed adjacent to drills but never chained to
each other or to the existing grid.
→ Pick the highest-water candidate for the extractor; chain nodes toward the grid.

**A6. Wall-drill duct routing is fragile.** The duct path is a hand-rolled walk with
arbitrary guards (the JS port needed a 1,000-step guard because the upstream loop can spin
forever), the "outermost duct" choice is unintuitive, and in a simple straight-crust test
the duct chain ran several tiles past the bores. The beam-node position is a hard-coded
formula that **collided with the outlet duct** in that test, so all nodes were silently
skipped.
→ BFS/A* along free tiles for ducts; place nodes by a small search that respects already
planned tiles, then chain toward the bore (beam node `range = 10`, verified).

**A7. Bridge pairing is a heuristic that we can now make exact.** `hasExistingBridgePointingAt`
assumes any bridge 3 tiles away points at us (the upstream comment states the config "can't
easily be read"). It can: `ItemBridgeBuild.link` and `config()` exist (verified).
Also `itemBridge.range = 4` (verified) while the matrix uses 3-tile links, so bridges are
placed more densely than necessary.
→ Verify the real link when pairing; optionally use 4-tile links to save bridges.

**A8. Flood fill makes redundant Java calls.** `visited` is tested *after* a `validPlace`
call, and neighbours are enqueued without a visited test, so tiles are probed and
re-enqueued repeatedly.
→ Test `visited` first, dedupe on enqueue. Small diff, immediate win (this is the hot path
of the cheapest filler).

---

## B. Performance & iOS responsiveness

**B1. Replace the 2 s budget with a chunked, cancellable search.** Today a big patch freezes
the game for up to two seconds (the toast only appears afterwards). Doing ~100–200k
operations per frame, with a progress indicator and tap-to-cancel, keeps frame time bounded
and lets users run high quality on huge patches.
Effort medium, value high (it is the only visible freeze in the mod).

**B2. Backtracking with push/pop instead of `.slice()` copies.** The search copies the
selection *and* the rect list at every branch; in interpreted JS that allocation churn is
significant.
→ Shared arrays with push/pop; no semantic change.

**B3. Summed-area table for ore counts.** `countOre` currently costs a `getLinkedTilesAs`
allocation plus one call per linked tile, for every candidate tile. A prefix-sum (integral
image) over ore tiles per patch gives **O(1)** counts for any footprint.
→ Straightforward; removes most Java calls from the pre-filter.
Requires care around patches near the map edge (padding).

**B4. Occupancy bitset for overlap tests.** Rect overlap is currently a scan over all placed
rects (O(depth) per candidate). A patch-local occupancy grid gives O(1) and pairs naturally
with B2/A1 (the ore-coverage bitset is the same trick).

**B5. Reuse scratch buffers.** `getLinkedTilesAs(block, new Seq())` allocates per call; a
single cleared scratch `Seq` works for the whole fill.

---

## C. Correctness & clarity

**C1. Ore tie-break inherits an odd rule.** `countOre` reproduces the upstream comparator
exactly, including the ordering that puts `lowPriority` items (sand, scrap) *last* and then
picks the last element — so a low-priority item can win a tie. Faithful, but it looks like an
upstream accident; worth deciding deliberately (e.g. always prefer the non-low-priority item,
except for the drills that specifically mine those).

**C2. Silent failure when outside the core radius.** `Build.validPlace` includes the core-radius
check, so fills far from the base produce nothing at all. A toast when ~all plans were
rejected ("out of build range?") would explain what happened.

**C3. The optimiser reports only that it stopped, not how far it got.** Include the number of
branches explored / the best score in the toast and the log — that makes the quality setting
tunable instead of magic.

**C4. Partial fills are silent.** If 34 of 41 tiles could be filled, no one hears about it.
A one-line summary toast ("filled 34/41 tiles") closes the loop.

---

## D. UX & features (ordered by user value)

**D1. Undo the last fill.** Keep the last plan list and offer "undo" (a small button on the
toolbar or a toast action). Cheap, prevents mis-taps; needs verification of
`player.unit().plans` removal API.

**D2. Help where iOS can't show descriptions.** The settings page cannot carry description
rows, but extra rows *can* be appended after the preference list (they survive the table's
rebuild). Add a short help paragraph plus a "Show tutorial again" button there.

**D3. Multi-patch fills.** Tap-and-drag or "fill every patch of this ore in view" (very handy
on Erekir, where ore comes in many small wall patches).

**D4. Presets.** Three one-tap presets (Safe / Balanced / Max) over the ten numeric settings,
keeping the advanced sliders below.

**D5. Translate the new strings.** Bundles exist for German/Russian; the new setting labels
and tooltips are English-only.

---

## E. System, repo and process

**E1. Make the iOS-mode test rig reproducible.** `tools/run-tests.sh ios` expects a patched
game jar (`Platform.getScriptContext()` forced to interpreted + RoboVM detection) that was
built by hand. Script the patch (compile `Platform.java`, `jar uf`) so anyone can reproduce
the strongest gate in one command.

**E2. Development files ship to users.** The game installs script mods from the repo zipball,
so `tests/`, `tools/`, `docs/` (≈700 KB) land in every user's mod folder. Harmless, but if it
ever matters, the dev tree can live on a `dev` branch with a small `main`.

**E3. Branch discipline matters more than usual here.** The game installs whatever is on
`main`. Use `dev` for work-in-progress and merge only verified changes — a broken `main`
breaks new installs *and* updates.

**E4. Versioning.** Keep semver in `mod.hjson`, tag releases `vX.Y.Z`, keep the `[vNNN]`
build tag in release titles (already wired in the release workflow).

---

## Recommended order

| # | Change | Effort | Payoff |
|---|---|---|---|
| 1 | A8 + B5 flood-fill/scratch reuse | small | faster cheapest filler |
| 2 | B2 + B4 shared arrays + occupancy bitset | small–medium | order-of-magnitude speed for the optimiser |
| 3 | A2 canonical order + upper bound | medium | much better layouts per second; may lift defaults |
| 4 | A1 marginal-gain scoring | medium | real ore throughput |
| 5 | B1 chunked, cancellable search | medium | removes the only freeze |
| 6 | A7 exact bridge linking | small–medium | correctness, fewer wasted bridges |
| 7 | A6 duct pathfinding + node placement | medium | fixes wander/collisions on Ekerir |
| 8 | A4 output routing for optimised drills | high | biggest functional gap |
| 9 | D1 + D2 undo and in-settings help | small | daily-use quality |
| 10 | E1 + E3 reproducible rig, branch discipline | small | keeps the project healthy |

## Explicitly not recommended

- No new test suites on top of the existing gates (the 64-check in-engine suite, the guard
  check and the iOS-mode loader already cover regressions). When a proposal above is
  implemented, extend the *existing* suite with cases for the changed behaviour only.
- No threads, no JIT/bytecode tricks: iOS runs interpreted, single-threaded Rhino — chunking
  is the supported way to stay responsive.
- No class subclassing (`extend()`), ever: hard iOS limit.
- Don't redesign the mechanical/pneumatic 6-tile matrix — it matches the layout players
  recognise; changes there make known-good patterns look wrong.
