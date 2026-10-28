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

- **Output Routing Length** — when above 0, optimised drills also get a straight run of
  conveyors (ducts on Erekir) leading out in the direction you pick, so you do not have to
  place transport by hand. 0 keeps the original behaviour.
- A help paragraph and a "show the tutorial again" button at the bottom of the page.

Large fills run with a progress bar and a cancel button instead of freezing the game.

Two differences from the Java version, both caused by iOS mod limits:

- The settings page has no decorative divider/description rows (iOS cannot subclass the
  game's setting classes). The descriptions are available as tooltips instead.
- The layout search for laser/airblast/impact/eruption drills is capped at **2 seconds** and
  at *Optimization Quality × 1000* explored layouts, so the game never freezes; a toast tells
  you when the cap was hit. Each step now explores a *distinct* layout, so raising the quality
  goes further than it used to, and the drill it replays mines ore no other selected drill
  mines (no double counting).

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
- `tools/run-tests.sh <normal|ios>` — the in-engine suite in both script modes;
  `tools/guard-check.sh` — the "another AutoDrill is installed" check.
- `tools/pack.sh` — builds the release zip.
- `tests/ingame/` — a test mod and a screenshot driver that run inside the real game.
- `tests/harness/` — Rhino harness used by the iOS-mode check.
- `tools/make-ios-sim-jar.sh` — rebuilds the iOS-simulation game jar used by the iOS test mode.
- `docs/plans/` — the implementation plan; `docs/AUDIT.md` — engine audit; `docs/RELEASE.md` — release checklist.

Working rule: **`main` is what every player installs and updates from.** Do work on a `dev`
branch and only merge to `main` once the checks below pass.
