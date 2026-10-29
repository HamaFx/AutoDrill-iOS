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

## Implementation status — batch 1 (v1.1.0, 2026-10-28)

Items 1–4 of the recommended order are implemented and verified by the existing suite
(66/66 in both normal and iOS script modes):

| Item | Change | Measured (iOS mode = interpreted, worst case) |
|---|---|---|
| A8 + B5 | flood fill probes each tile exactly once; ore counting reuses one scratch `Seq` | bridge fill, 41×41 patch: 186 ms → **20 ms** |
| B2 + B4 | push/pop backtracking with copy-on-improvement; occupancy and coverage bitsets replace rect scans | |
| A1 | marginal-gain (union) scoring: a tile mined by two drills is counted once | new check "every drill mines ore no other drill mines" passes (worst 6 ≥ min 5) |
| A2 | canonical order + suffix upper bound; one global placement budget replaces the per-level halving decay | optimiser, 41×41 patch: 2129 ms → **97 ms** (39 plans vs 40 before) |

`Optimization Quality` now means *explored placements* (quality × 1000). Canonical ordering
removed the duplicate permutations, so the same number covers far more distinct layouts; large
patches still stop at the 2 s wall-clock cap or the budget, whichever comes first.

### Two Rhino interpreter landmines found while implementing this (iOS-specific, both reproduced)

1. **Uninitialised locals in functions containing nested functions.** `var x;` followed by an
   assignment throws *"Assignment to undefined x in strict mode"*. Rule: always initialise
   (`var x = null;`) — enforced by a static check in `tools/ios-mode-check.sh`.
2. **Helper calls in hot loops can never return.** Calling a function that builds and returns
   an object from inside the candidate loop made the loop repeat its last iteration and
   allocate until OutOfMemory — on desktop it is fine, on the interpreted iOS engine it dies.
   The candidate scan is therefore inlined (see the comment in `scripts/optimization.js`).
   `tools/engine-probe.sh` reproduces engine failures in seconds with no game running; it was
   what proved the merged pass fixes it.

## Implementation status — batch 2 (v1.2.0, 2026-10-28)

Items 5–10 of the recommended order are implemented as well (suite still 66/66 in both modes):

| Item | Change |
|---|---|
| B1 | The optimiser's search is now resumable and runs in slices across frames with a progress bar and a **cancel button** — no freeze even at high quality |
| A4 | Optional **output routing** for optimised drills: a straight conveyor (duct on Erekir) run in the chosen direction, set by the new *Output Routing Length* slider (0 = off, the original behaviour) |
| A7 | Existing bridges are now checked against their **real link** (`ItemBridgeBuild.link`, packed with `Point2.pack`) instead of "any bridge nearby" |
| A6 | Erekir duct routing uses a **bounded BFS** over buildable tiles; beam nodes are *searched* for instead of computed by a formula that collided with the outlet duct (and were silently dropped) |
| A5 | The water extractor picks the valid spot with the **highest water attribute** rather than the first one |
| A3 | `expandArea` is symmetric again (it previously added the extra ring on one side only) |
| C2–C4 | Toasts for: nothing placeable (out of build range), the quality budget being hit, and a partial fill ("mined X of Y ore tiles") |
| D1 | **Undo**: a HUD button removes the last fill's plans while they are still unbuilt |
| D2 | In-settings help paragraph + "show the tutorial again" button (rows appended after the preferences, the iOS-safe way) |
| E1 | `tools/make-ios-sim-jar.sh` rebuilds the iOS-simulation jar from the official sources — the strongest test rig is now reproducible in one command |
| E3 | `main` is treated as the release branch (what players install); work goes through `dev` |
| A8b | Upstream quirk fixed: a tap on a non-ore tile used to plan a pointless bridge matrix; with no drill candidates nothing is planned now |

### Hotfix 1.2.1 — belts/bridges sometimes missing

The item-bridge chain used Manhattan distance 3 to find a partner, which accepts *diagonal*
neighbours that an item bridge cannot link to, and whichever match came first in tile order
decided the outcome. On top of that, the orphan pruning cascaded: a single bridge whose target
fell outside the plan set removed the whole chain. In a real campaign sector this showed up as
"drills but no belts". Fixed by only accepting cardinal (axis) partners and by dropping a
bridge only when it is a genuinely dead end (no target *and* nothing feeding it). Verified in a
real sector: mechanical fill now plans 40 drills + 25 bridges (before: 40 drills, 0 bridges).

### Engine pass 1.4.0 — "it does not cover the patch"

Reported from the device: *"too much space is left behind, it will not cover all the resources
and not enough drills get built."* Reproduced with `tools/coverage-probe.sh`, which measures
coverage straight off the committed plans:

| Case (laser drill) | Before | After |
|---|---|---|
| 21×21 square patch (441 ore tiles) | 144 tiles mined (32.7 %), 16 drills | **441 (100 %), 49 drills** |
| 45×45 round patch (1,280) | 882 (68.9 %), 98 drills | **1,280 (100 %), 145 drills** |
| 41×41 patch, in-game suite | 40 drills | **196 drills, 100 % seen and mined** |
| Same patch, plans + support | 4,056 ms | **1,417 ms** |

Four causes, all fixed:

1. **The patch scan was truncated by Max Tiles** (100 ore tiles for laser, 200 mechanical),
   silently and in flood-fill order, so a big patch was filled in the middle and nowhere else.
   Defaults are now 2,500 (range 100–5,000), the scan is resumable so it cannot freeze the
   game, and a patch bigger than the limit is *reported* instead of half-filled.
2. **Min Ores made part of every patch unreachable.** A 3×3 drill on a one-tile-wide vein holds
   3 ore tiles, so the old default of 5 left the whole vein unmined - on a round patch it cost
   the rim. Defaults are now 2 for laser and airblast (1 for the 2×2 drills).
3. **The search could stop half-packed.** The budget (`quality × 1000` placements) also paid
   for the search's own alternatives, so on a big patch it ran out before the layout was
   complete. The budget is now `max(quality × 1000, candidates × 3)`: exploration is optional,
   a complete descent always fits.
4. **Coverage was never actually maximised** - the search maximises *marginal gain* but stops
   wherever the budget ends, and it may leave a rim that a lattice would have closed. Two
   layouts now compete with the search result, all three gap-filled, best score committed:
   - **lattice seed**: candidates congruent to (ax, ay) modulo the drill size cannot overlap
     each other, so every one of the size² translations is a perfect tiling - one pass, no
     overlap tests - and the filler patches whatever the tiling missed at the rim;
   - **gap filler**: single pass adding any still-free candidate that mines an ore tile nothing
     else mines. Placing only ever fills space, so one pass reaches the fixed point, and the
     result is guaranteed to have no "one more drill would have mined that" tile left.

Also fixed: the "mined X of N ore tiles" toast counted the search's *scratch* map, which is
empty by the time the search ends, so it always claimed 0 tiles mined. It now counts the
committed layout, splits what is left into *out of reach* (→ lower Min Ores) and *blocked*
(→ raise Optimization Quality), and stays quiet when coverage is complete.

Performance work needed to make the bigger defaults safe: plan collisions in the support pass
(water extractors, power nodes) and in routing were O(plans) per candidate - quadratic, and the
reason a several-hundred-drill fill took seconds. `util.occupancyOf/markOccupancy/freeInOccupancy`
make each test and insertion O(footprint); the same patch now plans in a third of the time.

Verified by `tools/engine-tests.sh` (15 checks: patch seen whole, 100 % coverage on square/round/
irregular/vein patches for 2×2/3×3 drills, no overlap, no free candidate with ore left, identical
repeat fills) and by the in-engine suite in both script modes (69/69), which now asserts the
coverage guarantee on a 1,681-tile patch in the real game.

### Water & power pass 1.5.0 — "does it do water and electricity?"

Reported from the device: *"I think this mod also has water and liquids support too but when I
touch water nothing happens. Also I think it supports electricity too but how can I build it?"*

Both exist, but only as a by-product of an optimised fill — and neither worked as advertised:

1. **Water extractors were planned on dry ground.** The support pass took a free ring tile next
   to every drill, whatever the floor was. Mindustry's `SolidPump` gets its output from
   `validTiles` (standing water under the footprint) plus `sumAttribute(Attribute.water)` — on
   stone both are zero, so the extractor was a dead block. `api.pumpsWaterAt` now asks the game
   (footprint over liquid water, or the block's own `canPlaceOn` for ground water); the in-engine
   map gets 37 extractors, none on dry ground.
2. **The power nodes were decoration, not a network.** One node per drill "if a free ring tile
   was left over": in a dense fill the rings are shared, so most drills got nothing and the ones
   that did were isolated — `connected=10/36` on a measured patch.
3. **A packed patch has no room for nodes at all.** The drills tile the patch edge to edge, so
   none of their tiles can hold a node: 80 of 145 drills sat outside node range. Power is now
   part of the layout — one reserved tile per `(laserRange - 1)²` of patch, chosen *before* the
   search, which then packs the drills around them (`reservePowerTiles`). Every drill ends up in
   link range of a node, and the node lattice is spaced so the nodes also chain to each other.
   The price is real and reported: **81 % of the patch mined against 100 % with the setting off**
   (120 drills + 60 nodes vs 145 drills and no power), which is why it stays a setting and the
   toast says where the tiles went.
4. **Nothing connected the patch to the player's grid** — the drills were wired to each other and
   to nothing else. A chain of nodes (bounded BFS over placeable tiles, a node every
   `laserRange - 2`) now runs from the patch to the nearest building that carries power, and when
   there is none nothing is placed and the network stays one piece, so attaching it later takes a
   single node. A reserved tile that something else took is shifted a tile or two rather than
   dropped, because a hole wider than link range splits the grid.

Tapping water now also says what is going on ("water is not ore - water extractors and power nodes
come with optimised drill fills") instead of looking ignored, and every fill ends with a summary
toast ("planned 172 drills + 37 water extractors + 83 power nodes (2 more wiring them to your
grid)"), which is how the water/power question came up in the first place.

Verified by `tools/engine-tests.sh` (22 checks, including every drill in node range of a planned
node, the network connected to the grid, the network in one piece with no grid in sight, and
extractors only where they would pump) and by the in-engine suite, 75/75 in both script modes,
which asserts the powered/unpowered layout on a 1,681-tile patch in the real game.

### Coverage & quality pass 1.6.0 — "still leaves resources behind, Min Ores and Quality do nothing"

Reported from the device while the Erekir work was in progress. Two of the three observations
were right, and one of them was my own doing:

1. **"Still leaves a lot of resources behind"** — true, and caused by the 1.5.0 power pass: the
   tiles kept free for the power blocks cost coverage (60 holes on a round patch: 81.4 % mined
   against 100 % with the support off). The reservation is now placed where it is cheapest
   instead of on a rigid grid: each power block takes the free tile nearest its lattice spot
   that costs the fewest ore tiles (a tile no drill can use costs nothing; a rim drill is
   dropped before a full one), and the bound/entries/coverage all agree with what survived.
   In-engine 1,681-tile patch: **80.7 % → 83.9 %** with power, 100 % without. Synthetic round
   patch: 81.4 % → 85.4 %. The leftover tiles are still reported, with the setting to turn off.
2. **"Min Ores is not working"** — it works, and the measurements say why it looks inert on a
   dense patch: round patch, laser, one-tile minimum 98.7 % vs default 100 % (137 vs 145
   drills). Where it really bites is thin ore: a one-tile-wide vein is mined end to end at the
   default 2 and **not at all** at the old default 5. What looked like Min Ores failing was the
   power reservation, which no Min Ores setting can recover.
3. **"Optimization Quality does nothing"** — right, and it was a design fault: the lattice seed
   usually beat the search outright, so the search's budget (and therefore the setting) never
   changed the result. The families now all compete and the setting controls how many greedy
   sweeps are tried (quality 1 → 1, quality 10 → 8), on top of the search budget. Measured
   sweep scores rise with quality (1004 → 1021 on the round patch), and the engine checks
   assert that quality 10 tries more layouts than quality 1.

Two further bugs surfaced while fixing these:

* **Drills could be planned on top of power blocks.** The reservation filtered `job.candidates`
  but not `job.entries` (the list the layouts iterate), and releasing a reserved tile released
  the occupancy flag a 4×4 drill also relied on (one flag per cell). Both fixed; the in-engine
  suite checks plan overlap on real game data and caught it.
* **The compiled script engine rejected the whole mod** ("Stack underflow: -1") because of one
  expression: a counts array sized at runtime with `counts[labels[i]]++`. iOS's interpreted
  engine ran it happily; desktop/Android would not load the mod at all. Rewritten with plain
  comparisons, documented next to the two other Rhino landmines, and `tools/compile-check.sh`
  (about 40 s, no game needed beyond loading) now guards the whole class of breakage.

### Water, walls and oil pass 1.7.0 — the rest of the approved list

* **Large Plasma Bore** — the original mod has this button written and commented out. It is
  tier 5 against the plasma bore's tier 3, so it is the only thing that bores **thorium** and
  **tungsten** wall ore; offered now whenever the wall under the tap is within its tier.
  Verified in-engine (bores + ducts + beam nodes, placeable, no overlaps).
* **Steam vents** — tapping a steam vent (Erekir) places vent condensers over it, powered. The
  condenser needs a lot of steam under it (`baseEfficiency + sumAttribute(steam) >= 9`, from the
  game's own `AttributeCrafter.canPlaceOn`), which is exactly a 3x3 patch of vent tiles, so the
  fill only accepts footprints that meet it. This is Erekir's water source.
* **Oil ground** (Serpulo) — tapping oil ground places oil extractors on the richest footprints,
  powered, and runs a pump and a conduit trunk from the nearest water: the extractor consumes
  water to run, so a fill without one would be dead machines. Verified in-engine (7 extractors,
  1 pump, 72 conduits on a test field) and in the real game (7 extractors, 1 pump, 11 conduits
  with the map's pool).
* The toolbar now says what it accepts when a tap turns up nothing: "nothing to mine here - tap
  an ore tile, a steam vent or oil ground".

**Known limit, reported honestly:** impact drills need water and eruption drills need hydrogen
*before they will run at all*, and a solidly packed drill field has no tile left for a conduit
to reach the interior. Delivering liquid to a dense field needs the layout to keep a conduit
lane between drill rows (about one tile in five, sharing the lane with the power blocks), which
is a layout change of its own and is **not** in this release. Until then the fills place the
drills and the player supplies the liquid - the toast says so.

### Hotfix 1.7.1 — the game crashed on laser and airblast fills

Reported from the device: *"when I choose the airblast drill and laser drill to build on top of
ores the game crashes"*. Exactly the two fills that use the optimiser, and exactly the two that
show a progress bar.

**Cause:** `api.setProgress` was handed a *number* while the game's `LoadFragment` wants a
`Floatp` provider. A number passes the type check as an object with a `get` that *is* that
number, and the bar then calls `get()` while it draws - an exception inside the render loop,
which on iOS takes the whole app down. It had been wrong since 1.4.0 (the chunked fill) and
only showed once the bar actually redrew during a long optimiser fill.

**Fix:** the progress value lives in `api.js`; the provider is created once per fill and reads
it, so a number can never be mistaken for a function again.

**Why the test rig missed it, and what changed:** every in-game check called the *synchronous*
`optimization.fill`, so the chunked path the UI actually uses (`fillAsync` → `Core.app.post`
per frame → the progress bar) was never executed against the real game. The suite now drives
`fillAsync` on the 1,681-tile patch and waits for it across frames, asserting the plans and
overlaps from its completion callback - that check reproduces the crash before the fix and
passes after it. The fake world's `setProgress` is now deliberately strict (numbers only), so
the same mistake fails the fast engine checks too. The chunked fill takes 1.9 s on the
interpreted (iOS-mode) build for 1,681 ore tiles, spread across frames.

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
