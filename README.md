# AutoDrill (iOS)

Fills an ore patch with drills for you — the JavaScript edition of
[AutoDrill](https://github.com/Pointifix/AutoDrill) that runs on **iPhone and iPad**.

The original mod is a Java mod. iOS cannot load Java mods at all (the iOS build of
Mindustry compiles everything ahead of time and does not allow loading new code), so this
edition is a full port to Mindustry's JavaScript mod format, which iOS *does* support.
Nothing about the tool itself changed: same buttons, same layouts, same settings.

## Install

**Option A — in game (recommended)**

1. Update Mindustry to **8.160 or newer** (Settings → about; the App Store version is fine).
2. Mods → Browser → search for `AutoDrill (iOS)` → Install.
3. Enable it in the mod list and restart the game when asked.

**Option B — manual**

1. Download `auto-drill-ios_v*.zip` from the releases page.
2. On the device: open the zip in the **Files** app and share it to Mindustry, or use
   Mods → Import → File in game and pick the zip.
3. Enable the mod and restart.

## Use

- Tap the **AutoDrill icon** next to the minimap (or press `H` on a hardware keyboard) to
  arm the tool. A toolbar appears above the next tile you tap.
- Choose a drill. Mechanical/pneumatic drills and the Erekir plasma bore ask for an output
  direction first; the optimizer drills start filling immediately.
- Press the icon (or the key) again to disarm.
- Mis-tapped? The **arrow button** next to the AutoDrill icon removes the buildings the last
  fill planned, as long as they have not been built yet.

The tool is a *plan* tool: it queues the buildings as normal build plans, so you can still
review or cancel them before they are built.

## Settings

Settings → Auto Drill. Everything the Java mod offers is there: activation key, toggle
button visibility, per-drill maximum tiles and minimum ores, optimization quality, and
whether water extractors/power nodes are added to optimised drills. Two extras:

- **Water Extractors & Power Nodes** — optimised fills (laser, airblast, impact, eruption) plan
  a water extractor next to every drill that can have one (on water or ground water — never on
  dry land, where it would pump nothing) and build the power network the patch needs: a node
  lattice that puts every drill in link range, chained to your own grid when one is near. This
  costs a few ore tiles — the drills leave room for the nodes — so turning the setting off
  fills every tile but leaves the wiring (and the free tiles it needs) to you.
- **Optimization Quality** — how many layout attempts the fill makes (plus the search budget).
  Higher = fewer ore tiles left behind, slower fill.
- **Max Tiles** — how many ore tiles the fill looks at, nearest the tap first. It is a safety
  limit, not a target: 2,500 ships by default, which covers any normal patch whole. If a patch
  is bigger the fill says so and fills the part it saw.
- **Min Ores** — how many ore tiles a drill must cover to be built. Lower it to reach thin ore
  veins and the rim of a patch (1 mines everything); higher keeps only efficient drills.
- **Output Routing Length** — when above 0, optimised drills also get a straight run of
  conveyors (ducts on Erekir) leading out in the direction you pick, so you do not have to
  place transport by hand. 0 keeps the original behaviour.
- A help paragraph and a "show the tutorial again" button at the bottom of the page.

Large fills run with a progress bar and a cancel button instead of freezing the game: both the
patch scan and the layout search are resumable, so a patch with a few thousand ore tiles
reports progress instead of freezing.

### How a fill decides what to build

Four layouts compete and the best score wins:

1. **Layout search** — explores alternative placements (canonical order, marginal-gain
   scoring, optimistic pruning) within the *Optimization Quality* budget and a 3-second
   wall-clock backstop.
2. **Lattice seed** — drills on a grid translation of the patch; the tidy alignment a regular
   patch wants, and one pass over the candidates.
3. **Greedy sweeps** — the same candidates in eight spatial orders (rows, columns, diagonals).
   *Optimization Quality* says how many of them to try; they are what packs around holes, such
   as an irregular rim or a tile kept free for a power block.
4. **Gap filler** — adds any drill that still mines an ore tile nothing else mines.

The promise that follows: **every ore tile a drill can reach is mined**, Ore is only counted
once per drill, and nothing overlaps. A toast reports anything left over, naming the cause
(raise *Optimization Quality* for tiles blocked by other drills, lower *Min Ores* for tiles no
drill can reach at the current setting, raise *Max Tiles* when the patch was bigger than the
scan limit). Mindustry pays a drill out in proportion to the ore tiles of its dominant item
under it, so covered ore tiles *are* throughput.

Two differences from the Java version, both caused by iOS mod limits:

- The settings page has no decorative divider/description rows (iOS cannot subclass the
  game's setting classes). The descriptions are available as tooltips instead.
- The layout search is capped at **3 seconds** and at *Optimization Quality × 1000* explored
  layouts (never below a full greedy descent), so the game never freezes; a toast reports when
  the cap was hit. Each step explores a *distinct* layout, so raising the quality goes further
  than it used to.

## Notes

- The Java AutoDrill can stay installed on desktop/Android. If it is enabled on the same
  device, this edition stands down by design (you never get two toolbars).
- Requires **Mindustry 8.160+**; on iOS this is the version that made JS mods able to
  implement game interfaces, which this mod relies on.
- Licensed GPL-3.0, original mod by Pointifix.

## For developers

- `tools/ios-mode-check.sh` — lint + iOS-mode loader test (runs the mod through Rhino
  exactly as the iOS build does).
- `tools/engine-probe.sh` — runs the placement engine against a fake world in seconds, with
  no game needed. First stop when the engine misbehaves.
- `tools/engine-tests.sh` — the engine's promises as checks (whole patch seen, every reachable
  tile mined, no free drill left with ore, nothing overlapping, same patch = same layout).
- `tools/compile-check.sh` — loads the mod in the *compiled* script engine (desktop/Android).
  The interpreted engine iOS uses runs code the compiler rejects, so this catches desktop
  breakage in under a minute.
- `tools/coverage-probe.sh` — reports what fraction of a patch a fill mines, for any drill,
  patch shape and setting (`WORLD=… ORE=… ROUND=1 MAXTILES=… SUPPORT=0 tools/coverage-probe.sh`).
  `SUPPORT=0` measures the layout with no power extraction, which is where the 100 % coverage
  number lives.
- `tools/run-tests.sh <normal|ios>` — the in-engine suite in both script modes;
  `tools/guard-check.sh` — the "another AutoDrill is installed" check.
- `tools/pack.sh` — builds the release zip.
- `tests/ingame/` — a test mod and a screenshot driver that run inside the real game.
- `tests/harness/` — Rhino harness used by the iOS-mode check.
- `tools/make-ios-sim-jar.sh` — rebuilds the iOS-simulation game jar used by the iOS test mode.
- `docs/plans/` — the implementation plan; `docs/AUDIT.md` — engine audit; `docs/RELEASE.md` — release checklist.

Working rule: **`main` is what every player installs and updates from.** Do work on a `dev`
branch and only merge to `main` once the checks below pass.
