# Phase 4: Real-Map Shape Corpus, Offline Teacher & Distilled Layout Distillation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop guessing how the fillers behave on the shapes that actually occur in game. Build a committed corpus of **real ore patches** exported from player saves, score the engine on all of them, label each patch with what a slow offline solver proves achievable, classify every lost tile by cause, and turn the findings into small deterministic engine rules (layout-family order, adaptive effort, targeted fixes) — so accuracy and polish improve with evidence instead of intuition.

**Architecture:** Four layers, each committed in the repo:

1. **Corpus data** — the in-game dump mod (already written, currently in `/tmp/opencode/mapdump`) loads every save with `SaveIO.load`, finds every ore component of every ore type and dumps it (±24 tiles: floor, overlay, block, build) to text. A Python builder packs all patches into **one fake world** side by side (10-tile gutters) plus a manifest, so one harness run measures the whole corpus in seconds, not N runs of minutes.
2. **Scoreboard** — `tools/corpus-probe.sh` runs the belt tool (all directions), the optimizer (support ON/OFF) and the output routing over every patch and prints per-patch lines plus an aggregate summary and a result hash. A committed baseline makes every future change a measurable diff.
3. **Teacher** — the optimizer coverage optimum per patch via the existing exact solver (`tools/vein-solve.py`, PuLP/CBC, same `VEIN-INSTANCE/VEIN-CAND/VEIN-ENGINE` format the vein probe already emits), and the belt tool's achievable coverage via the existing randomised-restart reference packer (extracted from `tests/js/shape-sweep.js`). The gap engine↔teacher is the worklist.
4. **Gap miner → distilled rules** — a Python classifier buckets every left tile (no candidate / blocked by planned drills / reserved for power or lanes / missing belt transport / foreign ore), producing a ranked, reproducible report. Engine changes are then driven by that report and re-measured on the corpus: early exits when a patch is already covered, difficulty-aware family order and budget, and bounded fixes for the top failure classes.

**Tech Stack:** JavaScript (ES5 strict mode for Mindustry Rhino `optimizationLevel = -1` and `9`), `scripts/optimization.js`, `scripts/bridge.js`; fake-world harness (`tests/js/*.js`, `tools/*.sh`); Python 3 + `uv` (offline tooling only: fixture building, PuLP/CBC solving, gap classification).

**Spec:** `docs/ROADMAP.md` §4 (verification suite) and `docs/AUDIT-BELTING.md` (the belting/routing audit whose rig this phase generalises; its "recommended work" items 3–5 are the failures this corpus is built to find and fix).

---

## Current state (analysis)

Everything below exists and was verified on 2026-10-29; the plan builds on it, it does not re-create it.

**Tooling already committed**

| Thing | Where | What it does |
|---|---|---|
| Real-map fixture format | `tests/js/fixtures/desolate-rift-lead.js` | `AUTODRILL_FAKE_SCENARIO.terrain` (per-tile ore chars, `#` walls, `B` builds) + `REALMAP` (tap, save/map name, `built` list of the save's existing transport) |
| Fake-world terrain support | `tests/js/fake-api.js` (`OPTS.terrain`) | builds the fake world from those char rows; ore items with the game's tie-break ids (`copper 0, lead 1, coal 5, titanium 6, thorium 7, scrap 8`) |
| Real-map probe | `tests/js/realmap-probe.js`, `tools/realmap-probe.sh` | per patch: belt coverage/wiring (directed bridge flow), optimizer coverage (support ON/OFF), routing tiles, "meets existing transport" |
| Audit | `docs/AUDIT-BELTING.md` | the measurements + the model the scoreboard should keep reporting (coverage, wired drills, dumps/stuck, meetsExisting) |

**Raw data (the committed archive is the source of record; everything under /tmp is a convenience copy)**

| Thing | Path | Notes |
|---|---|---|
| Player save export (**committed**) | `tests/game-data/2026-10-29-save-export.zip` | the data this phase runs on: settings.bin, 40 saves, 10 maps, 29 schematics (2.0 MB). The mods of the original export are deliberately not in the repo — see `tests/game-data/README.md` |
| Player save export (working copy) | `/tmp/opencode/userdata/` (or `/tmp/game-data/` after extracting the committed zip) | convenience extraction; may disappear with /tmp |
| In-game dump mod | `/tmp/opencode/mapdump/` (`mod.hjson`, `scripts/main.js`) | loads every save via `SaveIO.load`, dumps lead components |
| Dump runner | `/tmp/opencode/mapdump-run.sh` | boots the real game under Xvfb with the dump mod + the user's content mods |
| Region dumps | `/tmp/opencode/dump/` (100 files, ~13 MB) | lead only, top-5 components per save, ±32 tiles |
| Fixture generator | `/tmp/opencode/make_fixture.py` | dump file → combined scenario+REALMAP fixture |

**The data is in the repo.** Everything this phase needs starts from the committed archive:

```bash
mkdir -p /tmp/game-data && unzip tests/game-data/2026-10-29-save-export.zip -d /tmp/game-data
SOURCE=/tmp/game-data ./tools/mapdump.sh      # after Task 1 Step 1
```

If /tmp is gone, just re-extract the committed zip — nothing needs to be asked for. Some saves
reference content from third-party mods that are not in the archive (the Asthosus sectors); the
dumper catches per-save load errors, logs `LOAD FAILED`, and continues. That is expected.

**IF the corpus needs extending** beyond what the archive holds (Task 1 Steps 2–3 already cover
every ore and component in it), ask the maintainer for a fresh save export; the committed
fixtures are the corpus of record and survive without /tmp.

**What the audit measured (the baseline this phase must beat)**

- Belt tool on 18 real lead veins (45–60 tiles): coverage 65–95 %, median ≈ 87 %; 1–3 drills with dead belts per patch (fixed in `304135f`, guarded by engine checks now); most patches wired 100 % after the fix.
- Optimizer with support ON: 8/18 patches at 100 %; walled patches lose 10–25 % (`blocked`/`unreachable` dominate — same with support OFF, so those tiles are genuinely pinned by walls/foreign ore, not by power reservations).
- Output routing: merged network + exit run now (16–31 tiles), but nothing checks it against the corpus.
- The vein battery (124 shapes / 512 walks) found none of the belting bugs; the real maps found them immediately. That is the case for the corpus.

**Opportunity areas the corpus is expected to expose** (measure first, fix second):

1. Left-tile classes: free candidate the gap filler missed (bug), packing loss (heuristic), power/lane reservation (trade), missing belt transport (belt tool), foreign ore / walls (not fixable).
2. Family selection: `chooseSelection` (`scripts/optimization.js:1543` by current numbering) always runs search → lattice → sweeps → restarts in the same order; the corpus can show which family actually wins per shape class, and how often the winner is decided in the first two.
3. Adaptive effort: `job.maxTries = Math.max(job.quality * 1000, entries.length * 3)` (`optimization.js:403`) and `SEARCH_BUDGET_MS = 3000` (`optimization.js:33`) are shape-blind — easy patches stop early only because `bestLattice` checks `job.coverable`, hard ones may need the budget moved to them.
4. The reference packer (`reference()` in `tests/js/shape-sweep.js`, ~line 116) already beats the engine on some synthetic shapes — on real patches, how often?

---

## Global Constraints

- Obey all four iOS/Rhino rules from `docs/ROADMAP.md` §3 in every `scripts/*.js` change: initialise every `var`, no object-returning helper calls inside hot loops, no `arr[idx[i]]++`, no Java subclassing.
- **Determinism**: the same patch must fill the same way on every device. No `Math.random()`; corpus-derived tables are fixed data. A corpus run twice must produce the same `CORPUS-HASH`.
- **Budget**: unchanged wall-clock contract for the mod (`SEARCH_BUDGET_MS`, chunked path unaffected); corpus tooling may be arbitrarily slow (offline).
- No new runtime dependency for the mod. Python/`uv`/PuLP live in `tools/` and `tools/mapdata/` only.
- Every distilled rule must be traceable to a corpus measurement committed next to it (a comment naming the corpus run or the baseline file).
- The existing gates stay green after every task: `./tools/engine-tests.sh` (67 checks), `./tools/shape-sweep.sh`, `./tools/vein-probe.sh`, `AUTODRILL_VEIN_WALKS=200 ./tools/vein-probe.sh`, `./tools/ios-mode-check.sh`, `./tools/compile-check.sh`, `./tools/run-tests.sh normal|ios` (95/0 each), `./tools/guard-check.sh`.

## Review Focus

1. **Corpus representativeness** — all five Serpulo ores plus scrap where present, patches from ≥ 25 distinct saves/maps, sizes 12–200+ tiles, and the known hard families (thin veins, ragged clusters, walled pockets, mixed borders) present. The committed Desolate Rift fixture stays in the corpus.
2. **Teacher trustworthiness** — the ILP optimum is exact only under the candidate rules fed to it; label every optimum with `status` and the solver used, cap ILP input (≤ 300 candidates), and use the restarts packer for bigger patches with its result explicitly labelled an upper-bound reference, never "the optimum".
3. **Scoreboard stability** — per-patch lines must be diffable (fixed order, fixed formatting) and the summary must include a hash so an accidental behaviour change cannot slip through as "the same numbers".
4. **Engine untouched by tooling** — corpus code lives in `tests/`, `tools/` and `tools/mapdata/`; `scripts/` only changes in Task 5, each change carrying a corpus before/after and a regression check.
5. **No overfitting** — rules must improve the corpus aggregate without a single patch regressing by more than 1 tile (or the regression is documented as a deliberate trade in the task's report).

## File Structure

| File | Responsibility |
|---|---|
| `tests/ingame/autodrill-mapdump/{mod.hjson,scripts/main.js}` | the in-game dumper (committed copy of `/tmp/opencode/mapdump`, extended to all ore types) |
| `tools/mapdump.sh` | boots the game under Xvfb with the dumper (+ content mods), waits for `MAPDUMP-DONE` |
| `tools/mapdata/make_fixture.py` | one dump file → one `AUTODRILL_FAKE_SCENARIO`+`REALMAP` fixture (moved from `/tmp/opencode/make_fixture.py`), gains the mega-world mode |
| `tools/mapdata/build_corpus.py` | all dump files → `tests/js/fixtures/corpus/world.js` (single fake world, patches in gutters) + `manifest.json` |
| `tests/js/fixtures/corpus/world.js` | committed corpus terrain + `CORPUS = [{name, tap, ore, tiles, save, built}]` |
| `tests/js/fixtures/corpus/manifest.json` | per-patch metadata (name, save, map, ore, tiles, bbox, tap, expected classes) |
| `tests/js/fixtures/corpus/baseline.txt` | committed scoreboard (one line per patch + summary + hash) |
| `tests/js/fixtures/corpus/teacher.json` | committed per-patch teacher labels (solver, status, optimum/reference, engine-at-label-time, gap) |
| `tests/js/corpus-probe.js` | the scoreboard: runs belt/optimizer/routing over every patch in `CORPUS`, prints `CORPUS …` lines, `--dump-candidates` mode for the ILP |
| `tools/corpus-probe.sh` | stages `corpus-probe.js` with `corpus/world.js` as the scenario; `--quick` runs a fixed subset |
| `tests/js/reference-pack.js` | the restarts reference packer factored out of `tests/js/shape-sweep.js` (shared by sweep, corpus, teacher) |
| `tools/mapdata/teacher_merge.py` | parses `vein-solve.py` output + reference results into `teacher.json` |
| `tools/mapdata/corpus_gaps.py` | engine results + teacher labels → per-tile failure classes → ranked report |
| `scripts/optimization.js` | Task 5 only: early exits, family order, adaptive effort, fixes for the top failure classes |
| `scripts/bridge.js` | Task 5 only (if the miner's top class is belt-side) |
| `docs/ROADMAP.md` | §4 gains the corpus gate command |

---

### Task 1: Commit the Map-Data Pipeline and Build the Shape Corpus

**Files:**
- Create: `tests/ingame/autodrill-mapdump/mod.hjson`, `tests/ingame/autodrill-mapdump/scripts/main.js`
- Create: `tools/mapdump.sh`, `tools/mapdata/make_fixture.py`, `tools/mapdata/build_corpus.py`, `tools/mapdata/README.md`
- Create (generated): `tests/js/fixtures/corpus/world.js`, `tests/js/fixtures/corpus/manifest.json`

**Interfaces:**
- Consumes: `tests/game-data/2026-10-29-save-export.zip` (committed), `/tmp/opencode/mapdump`, `/tmp/opencode/mapdump-run.sh`, `/tmp/opencode/make_fixture.py`, `/tmp/opencode/dump`
- Produces: a committed corpus loadable as `tests/js/scenario.js` (globals `AUTODRILL_FAKE_SCENARIO`, `CORPUS`); `tools/mapdata/build_corpus.py <dumpdir> <outdir>`

- [ ] **Step 1: Commit the dumper and the runner**

  Copy `/tmp/opencode/mapdump/*` into `tests/ingame/autodrill-mapdump/` and `/tmp/opencode/mapdump-run.sh` into `tools/mapdump.sh`; parameterise the runner:

  ```bash
  SOURCE="${SOURCE:-/tmp/game-data}"             # game-data export (extract the committed zip)
  OUT="${OUT:-/tmp/opencode/dump2}"              # where the text dumps go
  CONTENT_MODS="${CONTENT_MODS:-$SOURCE/mods}"   # skipped when missing
  ```

  Keep the mod out of `dist/` (it already is: `tools/pack.sh` packs the repo root files only — verify with `./tools/pack.sh >/dev/null && unzip -l dist/*.zip | grep -c mapdump` → `0`).

- [ ] **Step 2: Extend the dumper to every ore and every component**

  In `tests/ingame/autodrill-mapdump/scripts/main.js`:
  - recognise **all** ore overlays: `String(t.overlay().name).indexOf("ore-") === 0` (lead, copper, coal, titanium, thorium, scrap, sand);
  - component minimum 12 tiles (was 15), pad 24 (was 32);
  - deterministic order: components sorted by size desc, then top-left coord;
  - cap per save at 40 dumps; file name `<save>_<oreShort>_<index>.txt` (`oreShort` = the overlay name without `ore-`);
  - keep the existing header lines and the per-tile `#<block>` markers (they become the corpus `built` list).

  Run:

  ```bash
  mkdir -p /tmp/game-data && unzip -o tests/game-data/2026-10-29-save-export.zip -d /tmp/game-data
  SOURCE=/tmp/game-data OUT=/tmp/opencode/dump2 ./tools/mapdump.sh
  ```

  Expected: `MAP DUMP COMPLETE`; `ls /tmp/opencode/dump2 | wc -l` ≥ 150 dumps covering ≥ 5 ore
  types; a handful of `LOAD FAILED` lines for the saves whose mods are not in the archive
  (Asthosus sectors) — fine, they are skipped.

- [ ] **Step 3: Build the single-world corpus**

  Write `tools/mapdata/build_corpus.py`:
  - reads every `*.txt` dump; for each region takes the patch's bbox ± 6 tiles (smaller than the dump's 24 — the dump is only the source, the corpus keeps enough context for walls/other ore and the belt ring);
  - lays patches into one grid with **≥ 10-tile gutters**, world size = smallest multiple of 8 that fits (≤ 512×512);
  - ore chars: `l→lead, c→copper, k→coal, t→titanium, h→thorium, s→scrap`; `#` solid, `B` built, `.` free (the exact `tests/js/fake-api.js` terrain alphabet);
  - writes `world.js`:

    ```javascript
    AUTODRILL_FAKE_SCENARIO = { world: W, worldH: H, patches: [], terrain: { x0: 0, y0: 0, chars: {...}, rows: [...] } };
    var CORPUS = [ {name: "271-desolate-rift-lead-0", save: "sector-serpulo-271.msav", map: "Desolate Rift",
                    ore: "lead", tiles: 55, tap: [x, y], built: [[x, y, "core-nucleus"], ...]}, ... ];
    ```

  - and `manifest.json` (same data, Python-readable).
  - Deterministic: sorted input order, no timestamps in the files.

  Run: `python3 tools/mapdata/build_corpus.py /tmp/opencode/dump2 tests/js/fixtures/corpus`
  Expected: prints patch count per ore and total tiles; `wc -c tests/js/fixtures/corpus/world.js` ≤ 1 MB.

- [ ] **Step 4: Verify a fixture loads and the patch count is right**

  Run: `python3 -c "import json; m=json.load(open('tests/js/fixtures/corpus/manifest.json')); print(len(m), sorted(set(p['ore'] for p in m)))"`
  Expected: the same count as `build_corpus.py` printed, all ore names present; spot-check one patch in `world.js`: `CORPUS[0].tap` sits on that patch's ore char in `rows`.

- [ ] **Step 5: Commit**

  ```bash
  git add tests/ingame/autodrill-mapdump tools/mapdump.sh tools/mapdata tests/js/fixtures/corpus
  git commit -m "tools: real-map corpus pipeline - in-game dumper, fixture builder, committed shape corpus"
  ```

---

### Task 2: The Corpus Scoreboard (per-patch metrics + hash + committed baseline)

**Files:**
- Create: `tests/js/corpus-probe.js`, `tools/corpus-probe.sh`
- Create (generated): `tests/js/fixtures/corpus/baseline.txt`
- Modify: `docs/ROADMAP.md` §4 (add the gate command)

**Interfaces:**
- Consumes: `CORPUS` (Task 1), `fake-api.js` terrain, `bridge.fill`, `optimization.fillDetailed`
- Produces: `CORPUS <name> ore=… belt=covered/total/… laser=…/… route=… time=…` lines; `CORPUS-SUMMARY patches=… beltMedian=… beltWorst=… wiredBad=… laserOnMedian=… laserOffMedian=… routeMedian=… hash=…`

- [ ] **Step 1: Write the probe**

  `tests/js/corpus-probe.js` (model it on `tests/js/realmap-probe.js`; reuse its `coverage()` and directed `transport()` model — copy them, do not import, the two probes must stay runnable side by side):

  ```javascript
  // per patch:
  //   belt: one fill per direction; report covered/total, wired drills, dumps/stuck
  //   laser: fillDetailed support ON and OFF; report covered/total + blocked/unreachable
  //   route: laser + support ON + direction.RIGHT + routeLength 4; count conveyor tiles
  //   time: api.now() deltas, reported but never asserted in the probe (the gate uses them)
  // every line uses fixed formatting: CORPUS <name> belt=53/58 wired=18/18 laserOn=58/58 ...
  // --quick: only the first 12 patches of CORPUS in a fixed order (the manifest order)
  // --list: print one line per patch and exit
  ```

  The result hash: FNV-1a over all `CORPUS` lines, printed as `hash=0x…` (stable across runs and machines; no floats, no times in the hash).

- [ ] **Step 2: Write the runner**

  `tools/corpus-probe.sh` mirrors `tools/realmap-probe.sh` (stages `scripts/`, copies `corpus/world.js` as `tests/js/scenario.js`, runs `ScriptHarness`), passes arguments through, and exits non-zero when a `CHECK FAIL`-style line appears (the probe prints `CORPUS-FAIL …` for any patch where the fill throws or a plan overlaps).

- [ ] **Step 3: Baseline**

  Run: `./tools/corpus-probe.sh | tee /tmp/corpus-baseline.txt` then copy the last lines into `tests/js/fixtures/corpus/baseline.txt` with a header naming the commit:

  ```
  # corpus baseline, commit 304135f, 2026-10-29
  # every CORPUS line + the summary; regenerate with tools/corpus-probe.sh
  ```

  Expected: ≥ 150 patches, 0 `CORPUS-FAIL`; belt median ≈ 85–90 %, wired losses ≤ 3 patches; laser-on median ≥ 90 %; hash present.

- [ ] **Step 4: Gate**

  Add to `docs/ROADMAP.md` §4: `./tools/corpus-probe.sh --quick` (≈ 12 patches, seconds). The full run stays an offline tool.

- [ ] **Step 5: Commit**

  ```bash
  git add tests/js/corpus-probe.js tools/corpus-probe.sh tests/js/fixtures/corpus/baseline.txt docs/ROADMAP.md
  git commit -m "tools: corpus scoreboard - per-patch metrics, stable hash, committed baseline"
  ```

---

### Task 3: The Offline Teacher (exact optimizer optimum + belt reference)

**Files:**
- Modify: `tests/js/corpus-probe.js` (add `--dump-candidates`)
- Create: `tests/js/reference-pack.js` (extracted from `tests/js/shape-sweep.js`)
- Modify: `tests/js/shape-sweep.js` (use the shared module)
- Create: `tools/mapdata/teacher_merge.py`
- Create (generated): `tests/js/fixtures/corpus/teacher.json`

**Interfaces:**
- Consumes: `CORPUS`, the `VEIN-INSTANCE`/`VEIN-CELL`/`VEIN-CAND`/`VEIN-ENGINE` line format from `tests/js/vein-probe.js` (~lines 232–248), `tools/vein-solve.py`, `reference(test, drill, minOres, restarts)`
- Produces: `teacher.json` = `{ "<patch>": {"solver": "pulp:optimal|reference", "opt": 55, "engine": 52, "gap": 3, "beltRef": 55, "beltEngine": 52, "beltGap": 3, "unreachable": 0 } }`

- [ ] **Step 1: Factor the reference packer**

  Move the whole `reference()` function (and its helpers) from `tests/js/shape-sweep.js` into `tests/js/reference-pack.js` exporting `packReference(shape, drill, minOres, restarts)`; `shape-sweep.js` imports it; behaviour must be byte-identical (the sweep output must not change — run `./tools/shape-sweep.sh` before/after and diff the `SWEEP` lines).

- [ ] **Step 2: Candidate dump for the ILP**

  In `corpus-probe.js`, `--dump-candidates` prints for every patch, with **support OFF** and the **laser drill**:

  ```
  VEIN-INSTANCE <name> drill=laser minOres=2 world=<W> total=<n>
  VEIN-CELL x y                       (one per patch ore cell)
  VEIN-CAND x y foot=k1,k2,.. mine=k1,..    (the job's candidates: job.entries cellKeys/mineableKeys)
  VEIN-ENGINE x y                     (the engine's chosen drill anchors, support OFF)
  ```

  The keys are `x + y * world` like the existing dump. Cap: skip instances with > 300 candidates (the solver would crawl; those get `reference` labels only) and print `VEIN-SKIP <name> cands=…`.

- [ ] **Step 3: Solve and merge**

  ```bash
  ./tools/corpus-probe.sh --dump-candidates > /tmp/corpus-cands.txt
  uv run --with 'pulp==2.9.0' tools/vein-solve.py /tmp/corpus-cands.txt > /tmp/corpus-opt.txt
  python3 tools/mapdata/teacher_merge.py /tmp/corpus-opt.txt tests/js/fixtures/corpus/teacher.json
  ```

  `teacher_merge.py` also runs/uses the reference packer results for the belt tool: add a `--teacher` mode to `corpus-probe.js` that prints `BELT-REF <name> ref=<n>/<total> engine=<n>` using `packReference` for the mechanical drill with `minOres=1`, 200 restarts. Merge builds `teacher.json` and prints the **worklist**: every patch with `gap > 0` or `beltGap > 0`, sorted by gap desc.

- [ ] **Step 4: Verify and commit**

  Run the three commands above; expected: ≥ 100 patches labelled, `opt ≥ engine` everywhere, `status=Optimal` for the ILP rows, worklist non-empty (today's audit says the engine is short on several real patches — e.g. 19-comp3 and 165-comp4 are far below their packing capability).
  Wait — 165-comp4's gap is wall-driven; that is fine, the teacher's value is precisely to say "reachable vs not".

  ```bash
  git add tests/js/reference-pack.js tests/js/shape-sweep.js tests/js/corpus-probe.js tools/mapdata/teacher_merge.py tests/js/fixtures/corpus/teacher.json
  git commit -m "tools: corpus teacher - exact ILP optimum per patch + restarts reference for the belt tool"
  ```

---

### Task 4: The Gap Miner (classify every lost tile by cause)

**Files:**
- Modify: `tests/js/corpus-probe.js` (add `--json <path>`: per-patch plan lists + left tiles + reserved tiles + classes)
- Create: `tools/mapdata/corpus_gaps.py`
- Create (generated): `docs/AUDIT-CORPUS-GAPS.md` (committed report; regenerate with the tool)

**Interfaces:**
- Consumes: `--json` output + `teacher.json`
- Produces: for every patch, `left = unreachable + freeAnchor + blockedByPlans + reserved + foreignOre`; each `blockedByPlans` tile names the blocking plan(s); a ranked class table and a top-20 patch list

- [ ] **Step 1: Emit pre-classified machine-readable results**

  Classification needs the engine's own rules (candidate set, reserved tiles, occupancy), so it
  runs **inside the probe** — Python must not re-implement the rules. `--json <path>`: one
  object per patch whose `left` tiles are already bucketed:

  ```json
  {"name":"271-desolate-rift-lead-0","ore":"lead","tiles":55,
   "engine":{"drills":[[x,y],...],"belts":[[x,y,"bridge"|"conveyor",cfgX,cfgY],...],"covered":52},
   "classes":{
     "unreachable":[[x,y],...],
     "freeAnchor":[[x,y],...],
     "blockedByPlans":[[[x,y],["drill@x,y","conveyor@x,y"]],...],
     "reserved":[[x,y],...],
     "foreignOre":[[x,y],...]}}
  ```

  The probe also checks each class against the **belt fill** when that run left tiles
  (transport loss is belt-side: a free anchor whose only missing piece is a conveyor line goes
  to `beltTransport`).

  (JSON in the probe's own code, no library — the fake world has none.)

- [ ] **Step 2: The reporter**

  `tools/mapdata/corpus_gaps.py` only reads the JSON + `teacher.json` and aggregates the classes
  the probe assigned:

  Print per patch: `GAP <name> left=<n> freeAnchor=<n> blocked=<n> reserved=<n> beltTransport=<n> foreign=<n> unreachable=<n>`; then aggregate by class, then the top 20 patches by `freeAnchor`, then by `blocked`, then by `beltTransport`. Fail loudly when `freeAnchor > 0` (those are engine bugs by definition: a free legal candidate that mines an uncovered tile exists) or when the classes do not sum to `total - covered - engine picks-outside-patch` for any patch.

- [ ] **Step 3: Run and write the report**

  Run: `python3 tools/mapdata/corpus_gaps.py /tmp/corpus.json tests/js/fixtures/corpus/teacher.json > docs/AUDIT-CORPUS-GAPS.md` (with a header added by the tool: date, commit, corpus count, hash).
  Expected: `freeAnchor=0` (or a short list that becomes the first Task 5 fixes); `blocked`/`reserved`/`foreign`/`unreachable` sum to the teacher gap per patch.

- [ ] **Step 4: Commit**

  ```bash
  git add tests/js/corpus-probe.js tools/mapdata/corpus_gaps.py docs/AUDIT-CORPUS-GAPS.md
  git commit -m "tools: corpus gap miner - every left tile classified, report committed"
  ```

---

### Task 5: Distil — early exits, difficulty-aware effort, targeted fixes

**Files:**
- Modify: `scripts/optimization.js` (and `scripts/bridge.js` only if the miner's top class is belt-side)
- Modify: `tests/js/engine-tests.js` (one regression check per fix)
- Modify: `tests/js/fixtures/corpus/baseline.txt` (regenerated)

**Interfaces:**
- Consumes: `docs/AUDIT-CORPUS-GAPS.md` (the worklist), `baseline.txt`
- Produces: engine changes with a corpus before/after table in the task report; unchanged or better per-patch numbers

This task is **measurement-driven**: the exact fixes depend on Tasks 3–4. The bounded changes that are justified either way:

- [ ] **Step 1: Early exits (safe, always-on)**

  In `chooseSelection` (`scripts/optimization.js:1543`): after the search family, after the lattice and after every sweep/restart batch, `if(best.score >= job.coverable) break;`. Deterministic: no later family can score *strictly* higher than `coverable`, and `chooseSelection` only replaces the best on a strictly higher score — so the chosen layout is identical and the corpus **hash must not change at all**. Watch two existing checks:
  - `engine-tests.js` "quality 10 tries more layouts than quality 1" reads `stats.candidateScores.sweeps.length`; the round fixture is not fully covered by the early families, so both qualities should still run all their sweeps — if the numbers equalise anyway, restrict the early exit to the lattice/search (keep the sweep loop intact) rather than weakening the check;
  - `stats.ms*` timings shrink; that is the point.

- [ ] **Step 2: Difficulty-aware family order (bounded, table-driven)**

  From the corpus, compute per patch: `coverable/target`, candidate density (`entries.length / coverable`), wall ratio, and which family produced the winning score (add `job.candidateScores.family` = the winning family's index when it changes the best — one integer, no behaviour change). The task report must contain the cross-tab. Then implement the smallest rule the table supports, e.g.:

  ```javascript
  // data from tests/js/fixtures/corpus/baseline.txt + teacher.json (2026-…):
  // ragged shapes (coverable/target < 0.97) are won by bottleneck-first in N% of patches;
  // regular blobs are won by lattice. Reorder, do not remove: every family still runs
  // until coverable is reached or the list is exhausted.
  ```

  Keep it a fixed array of family ids selected by a handful of thresholds; no loops over data at runtime.

- [ ] **Step 3: Effort where the evidence is**

  Same table: move `job.maxTries` toward the shapes that need it. Suggested bound (verify against the corpus): after the first sweep batch, if `best.score < job.coverable * 0.98` allow `job.restartOrders` to grow by up to `2 * job.quality` entries and `job.maxTries` by 50 %; never exceed the wall-clock budget. Measure the corpus summary and the worst-case time.

- [ ] **Step 4: Fix the top failure classes**

  Walk `docs/AUDIT-CORPUS-GAPS.md` top-down; for each class with a reproducible patch:
  - add a focused engine check in `tests/js/engine-tests.js` (fixture derived from the corpus patch, like the existing `fillAt`/`veinCoverage` fixtures);
  - fix it in `scripts/` with the smallest change;
  - re-run the corpus; the patch's `freeAnchor`/gap must drop and no other patch may regress more than 1 tile.
  Suggested candidates by probability (confirm with the report before coding): power-reservation spots still holding *mineable* ground on walled patches (tune the `spotOre` rule in `reservePowerTiles`), belt-tool `skipped` candidates with a free conveyor path the fixed `connectByConveyor` still misses (raise its 80-node/12-tile caps for the last pass only), and rim candidates the min-ores filter hides.

- [ ] **Step 5: Full gates + corpus**

  ```bash
  bunx eslint scripts tests/ingame
  ./tools/ios-mode-check.sh
  ./tools/engine-tests.sh
  ./tools/corpus-probe.sh --quick
  ./tools/shape-sweep.sh
  ./tools/vein-probe.sh
  AUTODRILL_VEIN_WALKS=200 ./tools/vein-probe.sh
  ./tools/compile-check.sh
  ./tools/run-tests.sh normal
  ./tools/run-tests.sh ios
  ./tools/guard-check.sh
  ./tools/corpus-probe.sh | tee /tmp/corpus-after.txt   # regenerate baseline.txt from this
  ```

  Expected: all suites PASS; corpus summary strictly better than `baseline.txt` on at least one metric with no patch worse by > 1 tile; `hash` updated in the committed baseline with a comment naming the task.

- [ ] **Step 6: Commit**

  ```bash
  git add scripts tests/js/fixtures/corpus/baseline.txt tests/js/engine-tests.js
  git commit -m "engine: corpus-distilled layout order, adaptive effort and gap fixes (phase 4)"
  ```

---

## Verification suite (after every task)

```bash
# 1. lint & static iOS checks
bunx eslint scripts tests/ingame
./tools/ios-mode-check.sh

# 2. engine + coverage gates
./tools/engine-tests.sh
./tools/corpus-probe.sh --quick
./tools/shape-sweep.sh
./tools/vein-probe.sh
AUTODRILL_VEIN_WALKS=200 ./tools/vein-probe.sh

# 3. compiled-engine check
./tools/compile-check.sh

# 4. full in-game suites (both engines)
./tools/run-tests.sh normal
./tools/run-tests.sh ios
./tools/guard-check.sh

# 5. the corpus itself (offline, minutes)
./tools/corpus-probe.sh
```

## Notes for the implementing agent

- The corpus is data: never hand-edit `world.js`/`manifest.json`/`baseline.txt`; regenerate with the tools and commit the diff.
- The fake world's world size is fixed by the scenario; patches must never share ore-adjacent gutters (10 tiles), or one patch's scan will eat a neighbour's tiles and every number becomes noise.
- `SaveIO.load` in the dumper mutates the running game per save; the dump mod is a dev tool and must never ship (`tools/pack.sh` excludes `tests/`).
- The source of truth for the game data is `tests/game-data/2026-10-29-save-export.zip` (committed, 2.0 MB). Extract it to `/tmp/game-data` and point `SOURCE` there; never edit the archive. The committed corpus (`tests/js/fixtures/corpus/`) is the durable record and is enough for Tasks 2–5.
- Keep every threshold you distil in a comment with the corpus run that justified it; if someone re-runs the corpus later and a rule looks wrong, the comment is the breadcrumb.
