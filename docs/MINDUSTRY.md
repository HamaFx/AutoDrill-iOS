# Mindustry mechanics relevant to AutoDrill (checked against v160.7 sources)

Notes taken from the game's own sources (v160.7) while auditing the mod's assumptions. They are
the ground truth this repo's engine and tools are written against; keep them in sync when the
game updates.

## Ores

| Planet | Ground ore (mined by rotary drills) | Wall ore (mined by beam drills) |
|---|---|---|
| Serpulo | copper, lead, scrap, coal, titanium, thorium | **none** |
| Erekir | tungsten, crystal thorium (beryllium in asteroids) | beryllium (`ore-wall-beryllium`) |
| asteroids | lead, copper, thorium, titanium | beryllium; `graphitic-wall` is a plain wall with a graphite drop |

* `ore-wall-thorium`, `ore-wall-graphite` and `ore-wall-tungsten` exist as blocks but are **not
  placed by any vanilla generator**; custom maps can use them, which is why the mod's wall tools
  still offer the large plasma bore for them.
* **Serpulo really has no wall ore** - a Serpulo fill can never legitimately show a plasma-bore
  button (the mod's UI asks `wallDrop != null`, which is null everywhere on Serpulo).
* Ground ore is an *overlay floor* (`OreBlock`); `Tile.drop()` = overlay drop, else floor drop.
* Wall ore is an overlay with `wallOre = true`; `Tile.wallDrop()` returns an item only when the
  tile's **block** is solid and not synthetic - player walls never carry ore.

### How the generators place ore

* **Serpulo ground ore** (`SerpuloPlanetGenerator`): per sector, copper+lead always, coal /
  titanium / thorium by sector noise, scrap 25 %. Placement is a **noise band** condition:
  `|0.5 - noise(x, y, 2, 0.7, 40+i*2)| > 0.22 + i*0.01 && |0.5 - noise(...)| > 0.37 + freq` -
  i.e. the *edges* of two noise fields, which produces the familiar irregular blobs with
  tendrils, holes and one-tile steps (and why the vein battery is the right test set).
* **Erekir ground ore**: tungsten by noise, crystal thorium by noise on crystalline stone.
* **Erekir wall ore** (`BasicGenerator.wallOre`, called by `ErekirPlanetGenerator` and the
  asteroid generator): for wall blocks that have an **axis neighbour of air** (`nearAir`, 4-way)
  and a noise value above a threshold, the overlay becomes wall ore. So wall ore appears as
  **speckled patches on exposed faces**, tile by tile - not as solid, contiguous faces.

## Drills

| Drill | Kind | Size | Tier | Notes |
|---|---|---|---|---|
| mechanical | Drill (rotary) | 2 | 0 | 2x2 footprint |
| pneumatic | Drill | 2 | 1 | |
| laser | Drill | 3 | 2 | optional water boost (`liquidBoostIntensity 1.6`) |
| airblast | Drill | 3 | 2 | optional water boost |
| plasma bore | BeamDrill | 2 | 3 | range 5, optional hydrogen boost |
| large plasma bore | BeamDrill | 3 | 5 | range 6, `itemCapacity 20` |
| impact | BurstDrill | 4 | 6 | **requires water** (10/60), ozone optional boost, blockedItem = thorium |
| eruption | BurstDrill | 5 | 7 | **requires hydrogen** (4/60), cyanogen optional boost |

* Rotary drills (`Drill.DrillBuild`): throughput scales with the **number of ore tiles of the
  dominant item** under the footprint (`lastDrillSpeed = speed * dominantItems * warmup / delay`),
  and the dominant item is picked by the comparator the mod replicates (low-priority items last,
  then count, then id). Covering an ore tile is throughput.
* Beam drills (`BeamDrill.updateTile`): each block **side** across the facing direction is a
  "lane"; a lane walks up to `range` tiles and mines the **first solid tile** it meets. The ore
  tile stays solid (wall ore is infinite), so **each lane mines exactly one tile, forever** - a
  compact wall-ore patch needs one bore (or lane) per ore tile, and beams are blocked by any
  earlier solid tile, including other bores.
* Burst drills are rotary drills for coverage purposes (same `dominantItems` scaling) but their
  liquid consumers are **requirements**: a fill that ignores them leaves inert machines.
* `Drill.canMine`: `hardness <= tier`, not `blockedItems`, tile not static. `Drill.canPlaceOn`
  for multiblocks requires at least one linked tile to be minable.
* `BeamDrill.canPlaceOn` requires a lane to see a minable wall tile within `range`.

## Things the mod decided because of the above

* Serpulo support = water extractors (laser/airblast boost) + power nodes; Erekir support = beam
  nodes/towers. No wall logic on Serpulo, because there is no wall ore there.
* Wall fills (`scripts/wall.js`) place bores per ore tile - the wall-ore battery
  (`tools/wall-probe.sh`) simulates the lane rule above to measure coverage.
* Impact/eruption fills cannot deliver water/hydrogen into a packed drill field; the toast says
  so. A conduit lane (like the belt lanes) is the open work item for Erekir liquids.
