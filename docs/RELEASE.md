# Release checklist

The mod is ready to publish when every box below is ticked. Publishing itself needs a
GitHub repository owned by the porter (the in-game browser can only list repositories it
can read, and the listing is generated from the repository, not from a zip).

## 1. Gates (all must pass on the frozen code)

- [ ] `bunx eslint scripts tests/ingame` → clean
- [ ] `./tools/ios-mode-check.sh` → clean (static iOS rules + Rhino iOS-mode load)
- [ ] In-engine suite, desktop mode: `tools/run-tests.sh normal` → `failed=0`
- [ ] In-engine suite, **iOS mode**: `tools/run-tests.sh ios` → `failed=0`
- [ ] Guard test: `tools/guard-check.sh` → mod stands down when the Java mod is present
- [ ] `./tools/pack.sh` → zip contains `mod.hjson`, `scripts/`, `sprites/`, `bundles/` at the root
- [ ] Device test on a real iPhone/iPad (see below)

## 2. Device test (App Store Mindustry 8.160.x)

- [ ] Import the zip (browser or file import), enable, restart
- [ ] No red error text / no toast about script errors
- [ ] Icon next to the minimap appears; tapping it arms the tool
- [ ] Tap a copper patch → toolbar shows mechanical/pneumatic/laser/airblast
- [ ] Mechanical drill → direction picker → plans appear (with item bridges)
- [ ] Laser drill → plans appear with water extractor + power node
- [ ] Erekir wall ore → plasma bore → bores + ducts + beam nodes
- [ ] Settings page shows the Auto Drill category and all sliders
- [ ] Toggle button setting hides/shows the icon
- [ ] Large patch: no freeze; optimizer shows the "search stopped" toast at most
- [ ] Restart the device/game and confirm it still loads

## 3. Publish

- [ ] `mod.hjson` → `repo: "<owner>/<repo>"` and `version` bumped
- [ ] Repository has topic **`mindustry-mod`** (required for the auto-generated listing)
- [ ] Repository language must **not** be Java/Kotlin/Groovy/Scala, and the repo must not
      declare `java: true` — otherwise the browser hides it on iOS
- [ ] `iosCompatible: true` present in `mod.hjson`
- [ ] Release created with the build number in the title, e.g. `AutoDrill iOS 1.0.0 [v160]`,
      with the packed zip attached, and the same `version` inside `mod.hjson` at that tag
- [ ] Wait for `Anuken/MindustryMods` to refresh (about 2 hours), then install from the
      in-game browser on both an iOS device and a desktop/Android device
- [ ] README links the original mod and states the GPL-3.0 licence

## 4. After publishing

- [ ] Open an issue/PR on `Pointifix/AutoDrill` linking the iOS edition (optional but
      polite; the Java mod stays untouched for desktop/Android)
