# AutoDrill for iOS — Implementation Plan

**Goal:** Ship an iOS-compatible JavaScript edition of AutoDrill that installs as a normal mod on the stock App Store Mindustry (8.160.x) and reproduces the Java mod's behaviour.

**Architecture:** A script mod (`scripts/*.js`, Rhino). All Java/Mindustry access is funnelled through `scripts/api.js` so the placement algorithms can be unit-tested against a fake world; the algorithms (`util.js`, `bridge.js`, `optimization.js`, `wall.js`) are plain JavaScript and never subclass a Java class (the one thing iOS cannot do). UI/wiring lives in `ui.js`, driven from `main.js`.

**Tech stack:** JavaScript (Rhino/CommonJS `require`), Mindustry v8 script-mod API, GPL-3.0.

**Spec:** `/home/ubuntu/autodrill-ios-research/REPORT.md` (analysis + feasibility evidence)

## Global Constraints

- `minGameVersion: 160` (iOS interface support landed in v160); `iosCompatible: true`; internal name `auto-drill-ios`; `hidden: true`.
- No `extend(...)`, no `JavaAdapter`, no `new <Class>(){...}`, no custom `Mod`/`Element`/`Setting`/`InputListener`. Interfaces only.
- Objects are compared by `pos()` (tiles), `id` (content) and item id — never by wrapper identity, never as Map keys.
- Sorts that Java performs must be stable; use `sortStable(values, keyFn)`.
- Settings keys keep the Java mod's keys where they exist (`mechanical-drill-max-tiles`, `mechanical-drill-min-ores`, `pneumatic-drill-*`, `laser-drill-*`, `airblast-drill-*`) and use stable ASCII keys for the rest (the Java mod localised them by accident).
- GPL-3.0, credit Pointifix. Java mod untouched.

## Review Focus

1. **Patch on a map edge** — BFS must stop cleanly at `nearby() == null` and no plan may be created outside the world.
2. **A tapped tile with no ore / wrong ore** — the toolbar must show no drill buttons, and fill must be a no-op rather than an error.
3. **Tapping the HUD toggle then the game** — toolbar appears at the tile, closes on outside tap, never blocks normal building.
4. **Java mod also installed** — the iOS edition must disable itself instead of drawing a second toolbar.
5. **Enormous ore patch** — must respect max-tiles, and the optimizer must respect its time budget instead of freezing the game.

## File Structure

| File | Responsibility |
|---|---|
| `mod.hjson` | metadata (`auto-drill-ios`, `iosCompatible: true`, `minGameVersion: 160`) |
| `scripts/api.js` | the only file that calls Mindustry/Java; exports `tile/nearby/pos/width/...`, `validPlace`, `newPlan`, `addBuild`, `linkedTiles`, drill queries, settings, `log`, `time`, `now` |
| `scripts/direction.js` | UP/DOWN/LEFT/RIGHT tables + primary/secondary axis helpers |
| `scripts/util.js` | placement validation, rect overlap, flood fill, `expandArea`, `countOre`, `commitPlans`, `sortStable`, `argMax/argMin` (last-extreme, matching Arc) |
| `scripts/bridge.js` | mechanical/pneumatic layout + item-bridge chain + orphan pruning |
| `scripts/optimization.js` | laser/airblast/impact/eruption layout, recursive search with time budget, water extractors + power nodes |
| `scripts/wall.js` | plasma-bore wall layout + ducts + beam nodes |
| `scripts/ui.js` | HUD toggle, tap toolbar, direction table, tutorial dialog, settings category, key handling |
| `scripts/main.js` | wires everything, registers `ClientLoadEvent`, Java-mod guard |
| `bundles/*.properties` | mod strings (+ `setting.<key>.description` tooltips) |
| `sprites/*.png` | copied from the Java mod |
| `tests/` | Rhino harness: iOS-mode interface check + fake-world unit tests for all four algorithms |
| `tools/` | `pack.sh`, `ios-mode-check.sh` |

---

### Task 1: Repo skeleton and packaging

**Files:** create `mod.hjson`, `README.md`, `LICENSE`, `bundles/*`, `sprites/*`, `tools/pack.sh`

- [ ] Copy `LICENSE`, `sprites/`, `icon.png`, `bundles/*` from `/home/ubuntu/AutoDrill`.
- [ ] `mod.hjson`: `name: "auto-drill-ios"`, `displayName: "AutoDrill (iOS)"`, `author: "Pointifix (JS/iOS port)"`, `version: "1.0.0"`, `minGameVersion: 160`, `hidden: true`, `iosCompatible: true`.
- [ ] `tools/pack.sh` zips the mod root into `dist/auto-drill-ios_v1.0.0.zip` (excludes `tests/`, `tools/`, `dist/`, `docs/`, `.git`).
- [ ] Verify: `unzip -l` shows `mod.hjson` and `scripts/main.js` at the zip root.

### Task 2: `api.js` — the Java boundary

**Interfaces (produced):** `impl.tile(x,y)`, `impl.nearby(tile,dx,dy)`, `impl.pos(tile)`, `impl.tx(tile)`, `impl.ty(tile)`, `impl.worldW()`, `impl.worldH()`, `impl.drop(tile)`, `impl.wallDrop(tile)`, `impl.solid(tile)`, `impl.floorItemDrop(tile)`, `impl.size(block)`, `impl.blockName(block)`, `impl.itemId(item)`, `impl.canMine(drill,tile)`, `impl.getDrop(drill,tile)`, `impl.beamRange(drill)`, `impl.beamTier(drill)`, `impl.validPlace(block,team,x,y,rot)`, `impl.edges(size)` → array of `{x,y}`, `impl.linkedTiles(block,tile)` → array, `impl.addPlan(plan)`, `impl.team()`, `impl.newPlan(x,y,rot,block,config?)`, `impl.block(name)`, `impl.mechanicalDrill()` etc., `impl.teamId(team)`, `impl.settingInt(key,def)`, `impl.settingBool(key,def)`, `impl.settingString(key,def)`, `impl.putSetting(key,value)`, `impl.log(msg)`, `impl.now()`, `impl.tilesize()`, `impl.cameraProject(x,y)` → `{x,y}`, `impl.interfaceOf(...)` helpers.
- [ ] Implement as `buildReal()` + `exports` fan-out; `buildReal()` returns `AUTODRILL_API_FAKE` when the global exists (test hook).
- [ ] Verify with the Rhino iOS-mode harness: every function callable at opt `-1` with `Kit.isIos` true.

### Task 3: `direction.js` + `util.js`

**Interfaces (produced):** `dir.RIGHT/UP/LEFT/DOWN` (`{x,y,r}`), `dir.opposite(d)`, `dir.primary(d,x,y)`, `dir.secondary(d,x,y)`; `util.canPlaceBlock`, `util.canPlaceWithoutPlanCollision`, `util.isWithinWorld`, `util.blockRect`, `util.rectsOverlap`, `util.nearbyTiles(x,y,size[,size2])`, `util.countOre(tile,drill)`, `util.getConnectedTiles(tile,maxTiles)`, `util.expandArea(tiles,radius)`, `util.commitPlans(plans)`, `util.sortStable(items,keyFn)`, `util.argMax/argMinLast(items,keyFn)`.

- [ ] Unit tests (fake world): a 6×6 ore patch yields the expected connected tile set; `countOre` picks the majority ore with the Java comparator's tie order; rect overlap matches `Rect.overlaps` semantics (exclusive edges); flood fill stops at unbuildable/solid tiles and map edges.
- [ ] Implement with the exact Java semantics, including `(size*2-1)/2` integer division in `nearbyTiles`.

### Task 4: `bridge.js`

- [ ] Unit tests: a 9×9 copper patch produces the 6-pattern drill matrix, every bridge has a partner at Manhattan distance 3, orphan bridges/outlets are pruned, and no two footprints overlap.
- [ ] Port `BridgeDrill` verbatim (isDrillTile/isBridgeTile modulo tables, pre-filter with ore count + placement + bridge-eligible neighbours, outlet selection, dry-run validation, prune loop).

### Task 5: `optimization.js`

- [ ] Unit tests: identical selection to the Java algorithm for a fixed patch at quality 1 (brute force reference implemented in the test), min-ore filtering, water extractor + power node next to each drill, time budget aborts a huge patch without throwing.
- [ ] Port `OptimizationDrill` (prefix mapping, pre-filter, `recursiveMaxSearch` with in-place `selection` mutation, `Math.pow(2, level+1)` termination, optional support blocks).

### Task 6: `wall.js`

- [ ] Unit tests: Erekir wall patch produces bores on the correct side, one bore per secondary axis, duct chain connects each bore to the outermost duct, beam nodes chained when far.
- [ ] Port `WallDrill` (wall BFS with `mechanical-drill-max-tiles * 0.25`, secondary-axis retain filter, duct path walking, four phases + commit).

### Task 7: `ui.js` + `main.js`

- [ ] Tutorial dialog on first run (setting `auto-drill-ios-welcome`), HUD toggle, tap toolbar with drill buttons, direction table, settings category (sliders/checks/text only — no `Setting` subclass, descriptions via `setting.*.description` bundle tooltips).
- [ ] Activation key via `Core.input.addProcessor(new InputProcessor({...}))` with all 8 methods defined; compare `KeyCode` by `ordinal()`.
- [ ] Guard: `Vars.mods.locateMod("auto-drill")` → log and do nothing.
- [ ] Verify: harness loads `main.js` with a fake API and asserts registration calls happen (fake records them); iOS-mode check passes.

### Task 8: Packaging, release, verification

- [ ] `tools/ios-mode-check.sh`: run all scripts through the Rhino harness (opt `-1`, `Kit.isIos`) and fail on `extend(`/`JavaAdapter`/`new <Class>(){` patterns.
- [ ] API audit: reflection check of every symbol `api.js` calls against the released `Mindustry.jar` (8.160.7).
- [ ] Best-effort: launch desktop Mindustry 8.160.7 against the packed zip, confirm the mod loads with no script errors.
- [ ] Write `README.md` (install via browser or manual zip import; settings; known differences: no settings dividers, iOS script performance).
- [ ] Publish checklist: GitHub topic `mindustry-mod`, release titled with `[v160]`, `iosCompatible: true` in `mod.hjson`.

**Acceptance:** all unit tests pass, iOS-mode check passes, mod loads cleanly in desktop 8.160.7, and on the user's iPhone 14 Pro Max the toolbar appears, fills patches for all drill types, and no script error is logged.
