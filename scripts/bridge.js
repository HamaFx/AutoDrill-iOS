// AutoDrill (iOS) - bridge.js
// Port of autodrill/filler/BridgeDrill.java: fills a patch with 2x2 drills in the
// classic matrix pattern plus item-bridge chains carrying the output away.

"use strict";

var api = require("api");
var util = require("util");
var optimization = require("optimization");

var DEBUG = false;

exports.setDebug = function(value){
    DEBUG = value;
};

function dbg(msg){
    if(DEBUG){
        api.log("[bridge] " + msg);
        api.trace("[bridge] " + msg);
    }
}

// The patch-size / min-ores defaults live in optimization.js: one table, so the fillers
// cannot drift apart.
var SETTING_DEFAULTS = optimization.settingDefaults;

/** Java: BridgeDrill.isDrillTile */
function isDrillTile(tile, phaseX, phaseY){
    var x = api.tx(tile) - (phaseX == null ? 0 : phaseX);
    var y = api.ty(tile) - (phaseY == null ? 0 : phaseY);

    switch(((x % 6) + 6) % 6){
        case 0:
        case 2:
            if(((y - 1) % 6 + 6) % 6 === 0) return true;
            break;
        case 1:
            if(((y - 3) % 6 + 6) % 6 === 0 || ((y - 3) % 6 + 6) % 6 === 2) return true;
            break;
        case 3:
        case 5:
            if(((y - 4) % 6 + 6) % 6 === 0) return true;
            break;
        case 4:
            if(y % 6 === 0 || ((y % 6) + 6) % 6 === 2) return true;
            break;
    }
    return false;
}

exports.isDrillTile = isDrillTile;

/**
 * Runs a conveyor line from the drill to the nearest belt tile, routing around whatever is in
 * the way. This is what makes a patch that sits against a wall, a cliff or a building work: the
 * drill's own neighbours are all taken, so the ore has to travel a little further to leave.
 *
 * Returns 1 when the line was laid (its plans are queued in `beltPlans`).
 */
function connectByConveyor(neighbours, drill, team, bridgeTiles, beltPlans, occupied){
    var conveyor = api.block("conveyor");
    if(conveyor == null || bridgeTiles.length === 0) return 0;

    var worldW = api.worldW();
    for(var i = 0; i < neighbours.length; i++){
        var start = neighbours[i];
        var sx = api.tx(start), sy = api.ty(start);
        if(occupied[sx + sy * worldW] === true) continue;                 // a drill sits there
        if(!util.canPlaceBlock(conveyor, team, sx, sy, 0)) continue;      // wall or building

        var path = util.findDuctPath(start, bridgeTiles, conveyor, team, 80, occupied);
        if(path == null || path.length === 0 || path.length > 12) continue;

        // lay it: every conveyor points at the next tile, the last one at the belt
        var plans = [];
        var ok = true;

        // where the line ends: the belt tile the last conveyor pushes into
        var last = path[path.length - 1];
        var goal = null;
        for(var b = 0; b < bridgeTiles.length && goal == null; b++){
            var bdx = api.tx(bridgeTiles[b]) - api.tx(last);
            var bdy = api.ty(bridgeTiles[b]) - api.ty(last);
            if(Math.abs(bdx) + Math.abs(bdy) === 1) goal = bridgeTiles[b];
        }
        if(goal == null) continue;

        for(var k = 0; k < path.length && ok; k++){
            var cur = path[k];
            var next = k + 1 < path.length ? path[k + 1] : goal;
            var dx = api.tx(next) - api.tx(cur);
            var dy = api.ty(next) - api.ty(cur);
            var rot = dx === 1 ? 0 : (dy === 1 ? 1 : (dx === -1 ? 2 : 3));

            if(!util.canPlaceBlock(conveyor, team, api.tx(cur), api.ty(cur), rot)) ok = false;
            else plans.push(util.newPlan(api.tx(cur), api.ty(cur), rot, conveyor));
        }
        if(!ok || plans.length === 0) continue;

        for(var p = 0; p < plans.length; p++) beltPlans.push(plans[p]);
        // The laid line is taken ground: a later drill candidate must not be allowed to sit on
        // it (the dry run would refuse the conveyor instead, and the drill that needed it would
        // be left without transport).
        for(p = 0; p < plans.length; p++){
            occupied[plans[p].x + plans[p].y * worldW] = true;
        }
        return 1;
    }
    return 0;
}

/**
 * Adds a conveyor at `tile` when a belt tile sits right next to it, so the drill beside it can
 * hand its ore over. Returns 1 when the conveyor was taken (its plan is queued in `beltPlans`).
 *
 * A conveyor accepts on every face and passes on in its rotation, so all it needs is a belt tile
 * next to it: this is what lets drills at a patch edge - where the belt grid does not reach -
 * work at all.
 */
function addConveyorToGrid(tile, team, bridgeTiles, beltPlans, occupied){
    var conveyor = api.block("conveyor");
    if(conveyor == null) return 0;
    if(util.containsTile(bridgeTiles, tile)) return 0;

    var x = api.tx(tile), y = api.ty(tile);
    var worldW = api.worldW();
    if(occupied[x + y * worldW] === true) return 0;      // a drill or conveyor is there
    if(!util.canPlaceBlock(conveyor, team, x, y, 0)) return 0;

    // which way is the belt? conveyors only push forward, so point at it
    var directions = [{x: 1, y: 0, r: 0}, {x: 0, y: 1, r: 1}, {x: -1, y: 0, r: 2}, {x: 0, y: -1, r: 3}];
    for(var i = 0; i < directions.length; i++){
        var beside = api.tile(x + directions[i].x, y + directions[i].y);
        if(beside == null || !util.containsTile(bridgeTiles, beside)) continue;
        if(!util.canPlaceBlock(conveyor, team, x, y, directions[i].r)) continue;

        beltPlans.push(util.newPlan(x, y, directions[i].r, conveyor));
        occupied[x + y * worldW] = true;                 // no later drill may sit on it
        return 1;
    }
    return 0;
}

/**
 * Ore cells of `oreSet` a drill anchored at `tile` would cover that nothing covers yet.
 *
 * NOTE: returns a number, never an object - object-returning helpers inside a candidate loop
 * are the Rhino trap documented in docs/AUDIT.md.
 */
function uncoveredGain(tile, drill, oreSet, covered){
    var size = api.size(drill);
    var offset = Math.floor((size - 1) / 2);
    var worldW = api.worldW();
    var x = api.tx(tile), y = api.ty(tile);
    var gain = 0;

    for(var dx = 0; dx < size; dx++){
        for(var dy = 0; dy < size; dy++){
            var key = (x - offset + dx) + (y - offset + dy) * worldW;
            if(oreSet[key] === true && covered[key] !== true) gain++;
        }
    }
    return gain;
}

/** Marks the ore cells of `oreSet` a drill anchored at `tile` covers. */
function markCovered(tile, drill, oreSet, covered){
    var size = api.size(drill);
    var offset = Math.floor((size - 1) / 2);
    var worldW = api.worldW();
    var x = api.tx(tile), y = api.ty(tile);

    for(var dx = 0; dx < size; dx++){
        for(var dy = 0; dy < size; dy++){
            var key = (x - offset + dx) + (y - offset + dy) * worldW;
            if(oreSet[key] === true) covered[key] = true;
        }
    }
}

/**
 * Takes a drill candidate when it can actually work: it mines the tapped ore, meets Min Ores,
 * fits on free ground, and has a belt or bridge next to it (or can have one added) to carry its
 * ore out - a drill with nowhere to put its ore just fills up.
 *
 * Returns 1 when taken, 2 when the only thing missing is transport for its ore (which is worth
 * reporting - a drill that cannot get rid of its ore is not built), 0 otherwise.
 *
 * NOTE: a number, not an object - helpers that build an object and are called inside a hot loop
 * are the Rhino trap documented in docs/AUDIT.md.
 */
function takeDrillCandidate(t, drill, sourceDropId, minOresPerDrill, team, bridgeTiles, beltPlans, occupied, phaseX, phaseY){
    var size = api.size(drill);
    var offset = Math.floor((size - 1) / 2);
    var worldW = api.worldW();
    var x = api.tx(t), y = api.ty(t);
    var i = 0, j = 0;

    for(i = 0; i < size; i++){
        for(j = 0; j < size; j++){
            if(occupied[(x - offset + i) + (y - offset + j) * worldW] === true) return 0;
        }
    }

    var ore = util.countOre(t, drill);
    if(ore == null || api.itemId(ore.item) !== sourceDropId || ore.count < minOresPerDrill) return 0;
    if(!util.canPlaceBlock(drill, team, x, y, 0)){
        dbg("skip " + x + "," + y + ": the game refuses a drill here");
        return 0;
    }

    var neighbours = util.nearbyTilesOfBlock(x, y, drill);
    var eligible = [];
    for(j = 0; j < neighbours.length; j++){
        if(isBridgeTile(neighbours[j], phaseX, phaseY)) eligible.push(neighbours[j]);
    }

    var connected = false;
    for(j = 0; j < eligible.length; j++){
        if(util.containsTile(bridgeTiles, eligible[j])){
            connected = true;
            break;
        }
    }

    if(!connected){
        var placeable = [];

        // first choice: a belt tile of the grid, right next to the drill
        for(j = 0; j < eligible.length; j++){
            if(util.canPlaceBlock(api.block("itemBridge"), team, api.tx(eligible[j]), api.ty(eligible[j]), 0)){
                placeable.push(eligible[j]);
            }
        }

        if(placeable.length === 0){
            // second choice: one conveyor next to the drill that pushes into a belt tile beside
            // it. A conveyor takes and passes on any face, so this is all it takes for a drill
            // the grid misses - and a patched patch has plenty of those at its edges.
            for(j = 0; j < neighbours.length; j++){
                if(!addConveyorToGrid(neighbours[j], team, bridgeTiles, beltPlans, occupied)) continue;
                placeable.push(neighbours[j]);
                break;
            }
        }

        if(placeable.length === 0){
            // last resort, and the one that matters next to walls and buildings: a conveyor line
            // laid around the obstruction, from the drill to the nearest belt tile. It counts as
            // transport, so the drill is taken - and its footprint is still marked below, or the
            // next candidate would sit right on top of it.
            if(connectByConveyor(neighbours, drill, team, bridgeTiles, beltPlans, occupied)){
                connected = true;
            }
        }

        if(!connected){
            if(placeable.length === 0){
                dbg("skip " + x + "," + y + ": no belt tile or conveyor fits next to it");
                return 2;      // this one only fails for want of transport
            }

            for(j = 0; j < placeable.length; j++){
                if(!util.containsTile(bridgeTiles, placeable[j])){
                    bridgeTiles.push(placeable[j]);
                    // an active belt tile: a later drill must not overhang it, or the bridge
                    // plan is refused in the dry run and the chain it belongs to is severed
                    occupied[api.tx(placeable[j]) + api.ty(placeable[j]) * worldW] = true;
                }
            }
        }
    }

    for(i = 0; i < size; i++){
        for(j = 0; j < size; j++){
            occupied[(x - offset + i) + (y - offset + j) * worldW] = true;
        }
    }
    return 1;
}

/** Java: BridgeDrill.isBridgeTile (same phase as the drill pattern it belongs to) */
function isBridgeTile(tile, phaseX, phaseY){
    var x = api.tx(tile) - (phaseX == null ? 0 : phaseX);
    var y = api.ty(tile) - (phaseY == null ? 0 : phaseY);
    return ((x % 3) + 3) % 3 === 0 && ((y % 3) + 3) % 3 === 0;
}

/**
 * The pattern offset that covers the most ore under it.
 *
 * The original pattern is fixed to the world coordinates, so a patch got covered or barely
 * touched purely by where it happened to sit on the map - the same tap, twice, on two patches,
 * looked like a broken mod. Both the drill pattern and the belt grid are shifted together here,
 * and the offset that puts the most drills on ore wins.
 *
 * Only pattern drills the game would accept count: on a one-tile vein with a wall behind it,
 * the phases that anchor the drills on the vein row (wall in the footprint, refused) used to
 * score highest and produce the worst layouts - 27 of 40 vein tiles where the phases that
 * anchor on the free side reach 40 of 40.
 */
function pickPhase(tiles, drill, targetSet, team){
    var size = api.size(drill);
    var offset = Math.floor((size - 1) / 2);
    var worldW = api.worldW();
    var best = {x: 0, y: 0, score: -1};
    var i = 0, dx = 0, dy = 0;

    for(var px = 0; px < 3; px++){
        for(var py = 0; py < 3; py++){
            var score = 0;

            for(i = 0; i < tiles.length; i++){
                if(!isDrillTile(tiles[i], px, py)) continue;
                if(!util.canPlaceBlock(drill, team, api.tx(tiles[i]), api.ty(tiles[i]), 0)) continue;

                var x = api.tx(tiles[i]) - offset, y = api.ty(tiles[i]) - offset;
                for(dx = 0; dx < size; dx++){
                    for(dy = 0; dy < size; dy++){
                        if(targetSet[(x + dx) + (y + dy) * worldW] === true) score++;
                    }
                }
            }
            if(score > best.score) best = {x: px, y: py, score: score};
        }
    }
    return best;
}

exports.isBridgeTile = isBridgeTile;

/** Java: BridgeDrill.fill */
function fill(tile, drill, direction, teamOverride){
    if(api.size(drill) !== 2){
        api.warn("bridge fill called with a non-2x2 drill - ignoring");
        return;
    }

    var mechanical = api.blockId(drill) === api.blockId(api.block("mechanicalDrill"));
    var prefix = mechanical ? "mechanical" : "pneumatic";
    var maxTiles = api.settingInt(prefix + "-drill-max-tiles", SETTING_DEFAULTS[prefix].tiles);

    // one tile past the limit tells a patch that is exactly the limit apart from one that was cut
    var reached = util.getConnectedTiles(tile, maxTiles + 1, teamOverride);
    var truncated = reached.length > maxTiles;
    if(truncated) reached.length = maxTiles;

    var sourceDropId = api.itemId(api.drop(tile));
    var targetCells = 0;
    var targetSet = {};
    for(var i = 0; i < reached.length; i++){
        if(api.itemId(api.drop(reached[i])) === sourceDropId){
            targetCells++;
            targetSet[api.pos(reached[i])] = true;
        }
    }

    var tiles = reached;
    util.expandArea(tiles, Math.floor(api.size(drill) / 2));

    var phaseTeam = teamOverride != null ? teamOverride : api.team();
    var phase = pickPhase(tiles, drill, targetSet, phaseTeam);
    dbg("phase=" + phase.x + "," + phase.y + " patternOre=" + phase.score + " of " + targetCells);

    var outcome = placeDrillsAndBridges(tile, tiles, drill, direction, teamOverride, phase.x, phase.y);

    reportCoverage(outcome.plans, drill, sourceDropId, targetCells, targetSet, truncated, maxTiles,
        outcome.skipped);
    return outcome.plans;
}

/**
 * The belt tool used to plan in silence, so a patch that was cut short by Max Tiles - or one
 * where a second ore is the only thing left - looked like the fill had stopped working. Same
 * plain result line the optimiser fills print.
 */
function reportCoverage(plans, drill, sourceDropId, targetCells, targetSet, truncated, maxTiles, skipped){
    var size = api.size(drill);
    var offset = Math.floor((size - 1) / 2);
    var covered = {};
    var others = {};
    var built = 0;
    var drills = 0;
    var i = 0, dx = 0, dy = 0;

    if(targetCells === 0) return;

    for(i = 0; i < plans.length; i++){
        if(api.blockId(plans[i].block) !== api.blockId(drill)) continue;
        drills++;

        for(dx = 0; dx < size; dx++){
            for(dy = 0; dy < size; dy++){
                var tile = api.tile(plans[i].x - offset + dx, plans[i].y - offset + dy);
                if(tile == null) continue;

                var key = api.pos(tile);
                var item = api.itemId(api.drop(tile));

                // only tiles of the patch this fill was asked for count towards its coverage;
                // any other ore the drills happen to stand on is reported separately
                if(targetSet[key] === true){
                    covered[key] = true;
                }else if(item >= 0 && item !== sourceDropId){
                    others[item] = (others[item] === undefined ? 0 : others[item]) + 1;
                }
            }
        }
    }

    // ore that already has something on it (a second tap on the same patch)
    for(i in targetSet){
        var target = api.tile(i % api.worldW(), Math.floor(i / api.worldW()));
        if(target != null && api.hasBuilding(target)) built++;
    }

    var n = 0;
    for(i in covered) n++;

    var word = api.itemName(sourceDropId);
    if(word == null) word = "ore";

    if(drills === 0){
        api.toast("[AutoDrill v" + api.modVersion() + "] nothing could be placed here - is this inside your build range?");
        return;
    }

    if(n >= targetCells){
        api.toast("[AutoDrill v" + api.modVersion() + "] mined all " + n + " " + word + " tiles here"
            + (truncated ? " - but the patch is larger than Max Tiles (" + maxTiles
                + "), so only the part nearest your tap was filled" : ""));
    }else{
        var why = null;
        if(truncated){
            why = "the patch is larger than Max Tiles (" + maxTiles
                + ") - the fill covers the part nearest your tap, raise Max Tiles for the rest";
        }else if(built > 0){
            why = built + " tiles already have buildings on them";
        }else if(skipped > 0){
            // a drill fits on that ore, but nothing can carry its ore out: either the ground
            // around the patch takes no belts, or every tile next to it is already taken
            why = skipped + " more drills fit here but have no belt room next to them - free the"
                + " ground beside the patch (or use the laser or airblast drill, which needs none)";
        }else{
            why = "the belt layout keeps tiles for its bridges - use the laser or airblast drill"
                + " to cover every tile";
        }
        api.toast("[AutoDrill v" + api.modVersion() + "] mined " + n + " of " + targetCells + " " + word + " tiles - " + why);
    }

    var otherName = null, otherCount = 0;
    for(var otherId in others){
        if(others[otherId] > otherCount){
            otherCount = others[otherId];
            otherName = api.itemName(otherId | 0);
        }
    }
    if(otherName != null && otherCount >= 5){
        api.toast("[AutoDrill v" + api.modVersion() + "] note: this patch also has " + otherName + " (" + otherCount
            + " tiles) - a fill only covers the ore you tap, so tap a " + otherName
            + " tile for those");
    }
}

exports.fill = fill;

function placeDrillsAndBridges(source, tiles, drill, direction, teamOverride, phaseX, phaseY){
    // returns {plans, skipped} - skipped counts ore tiles a drill fits on but a belt cannot reach
    var team = teamOverride != null ? teamOverride : api.team();
    var configX = direction.x * 3;
    var configY = direction.y * 3;

    var drillTiles = [];
    var bridgeTiles = [];
    var beltPlans = [];       // conveyors added so a drill can reach the belt grid
    var leftovers = [];       // what the pattern missed; picked up below
    var sourceDropId = api.itemId(api.drop(source));
    var i = null;

    // The pattern keeps the tiles its belts run on. Everything else is a candidate: the ore the
    // pattern misses *and* the non-ore tiles a 2x2 drill has to anchor on to reach a patch
    // edge, a one-tile vein, or a vein with a wall beside it (a drill at (x, y) covers
    // [x, x+1] x [y, y+1], so a wall on the vein's +y side forces the anchor to y - 1).
    for(i = 0; i < tiles.length; i++){
        if(isDrillTile(tiles[i], phaseX, phaseY)) drillTiles.push(tiles[i]);
        else if(!isBridgeTile(tiles[i], phaseX, phaseY)) leftovers.push(tiles[i]);
    }
    for(i = 0; i < tiles.length; i++){
        if(!isBridgeTile(tiles[i], phaseX, phaseY)) continue;
        // A belt tile on a wall (the grid runs into a cliff, a wall, a building) can never host
        // a bridge. Keeping it in the list made the chain plan it anyway, the dry run refuse it
        // ("N buildings could not be placed"), and a drill "connected" to nothing.
        if(!util.canPlaceBlock(api.block("itemBridge"), team, api.tx(tiles[i]), api.ty(tiles[i]), 0)) continue;
        bridgeTiles.push(tiles[i]);
    }

    // The belt grid is the drills' transport, and a drill at the patch rim (or in a pocket) has
    // no grid tile next to it: the conveyor that carries its ore out needs a grid tile to push
    // into. Extend the grid by the ring around the scanned area - free ground only, so a wall
    // never counts as a connection - and the belts can leave the patch instead of stranding
    // the drills at its edge.
    var itemBridgeBlock = api.block("itemBridge");
    var ring = [];
    for(i = 0; i < tiles.length; i++){
        for(var rx = -1; rx <= 1; rx++){
            for(var ry = -1; ry <= 1; ry++){
                if(rx === 0 && ry === 0) continue;
                var ringTile = api.nearby(tiles[i], rx, ry);
                if(ringTile == null) continue;
                if(!isBridgeTile(ringTile, phaseX, phaseY)) continue;
                if(util.containsTile(bridgeTiles, ringTile)) continue;
                if(util.containsTile(ring, ringTile)) continue;
                if(!util.canPlaceBlock(itemBridgeBlock, team, api.tx(ringTile), api.ty(ringTile), 0)) continue;
                ring.push(ringTile);
            }
        }
    }
    for(i = 0; i < ring.length; i++) bridgeTiles.push(ring[i]);

    // every ore cell this fill could cover at all (the leftovers rule above)
    var oreSet = {};
    for(i = 0; i < tiles.length; i++){
        if(api.itemId(api.drop(tiles[i])) === sourceDropId) oreSet[api.pos(tiles[i])] = true;
    }

    var prefix = null;
    if(api.blockId(drill) === api.blockId(api.block("blastDrill"))){
        prefix = "airblast";
    }else if(api.blockId(drill) === api.blockId(api.block("laserDrill"))){
        prefix = "laser";
    }else if(api.blockId(drill) === api.blockId(api.block("pneumaticDrill"))){
        prefix = "pneumatic";
    }else{
        prefix = "mechanical";
    }
    var minOresPerDrill = api.settingInt(prefix + "-drill-min-ores", SETTING_DEFAULTS[prefix].ores);

    // The pattern keeps the tiles its belts run on and whatever falls between its cells. Ore
    // the pattern misses is picked up here, so a fill covers the patch instead of a sample of it.

    dbg("tiles=" + tiles.length + " drillTiles=" + drillTiles.length
        + " bridgeTiles=" + bridgeTiles.length + " leftovers=" + leftovers.length);

    // --- Pre-filter: correct resource, enough ores, placeable, and with something to carry the
    // --- ore away. The pattern's own tiles go first - its belts are laid out around them - then
    // --- what the pattern missed, in order of how much still-uncovered ore each drill would
    // --- cover: an anchor that reaches two untouched vein tiles is worth more than one whose
    // --- tiles something already mines.
    var occupied = {};
    var filtered = [];
    var coveredOre = {};      // ore cells the drills taken so far already mine
    var skipped = 0;

    for(i = 0; i < drillTiles.length; i++){
        var takenOne = takeDrillCandidate(drillTiles[i], drill, sourceDropId, minOresPerDrill, team,
            bridgeTiles, beltPlans, occupied, phaseX, phaseY);
        if(takenOne === 1){
            filtered.push(drillTiles[i]);
            markCovered(drillTiles[i], drill, oreSet, coveredOre);
        }else if(takenOne === 2) skipped++;
    }

    var scored = [];
    for(i = 0; i < leftovers.length; i++){
        scored.push({tile: leftovers[i], gain: uncoveredGain(leftovers[i], drill, oreSet, coveredOre)});
    }
    util.sortStable(scored, function(s){
        return -s.gain;
    });

    for(i = 0; i < scored.length; i++){
        var leftover = scored[i].tile;
        // the gain was measured before the loop; another candidate may have covered the ore
        // since, and a candidate that now mines nothing is not worth a drill
        if(uncoveredGain(leftover, drill, oreSet, coveredOre) === 0) continue;

        var takenTwo = takeDrillCandidate(leftover, drill, sourceDropId, minOresPerDrill, team,
            bridgeTiles, beltPlans, occupied, phaseX, phaseY);
        if(takenTwo === 1){
            filtered.push(leftover);
            markCovered(leftover, drill, oreSet, coveredOre);
        }else if(takenTwo === 2) skipped++;
    }
    drillTiles = filtered;
    dbg("filter: kept=" + filtered.length + " skipped=" + skipped
        + " (no room for belts next to them)");

    dbg("after filter: drills=" + drillTiles.length + " bridgeTiles=" + bridgeTiles.length + " sourceDrop=" + sourceDropId);

    // No drill means no job: the chain only exists to carry their output. Upstream planned a
    // bridge matrix anyway when a non-ore tile was tapped, filling the map with useless plans.
    if(drillTiles.length === 0) return {plans: [], skipped: skipped};

    if(bridgeTiles.length === 0) return {plans: [], skipped: skipped};

    // --- Outlet: the bridge tile furthest in the chosen direction, plus one tile further out.
    var outerMost = util.argMax(bridgeTiles, function(t2){
        return direction.x === 0 ? api.ty(t2) * direction.y : api.tx(t2) * direction.x;
    });
    if(outerMost == null) return {plans: [], skipped: skipped};

    var outlet = api.nearby(outerMost, configX, configY);
    if(outlet == null) return {plans: [], skipped: skipped};

    bridgeTiles.push(outlet);
    util.sortStable(bridgeTiles, function(t2){
        return api.dst2ToPoint(t2, api.tileWorldX(outlet), api.tileWorldY(outlet));
    });

    // --- Dry run: collect all plans, validate, then commit.
    var allPlans = [];
    for(i = 0; i < drillTiles.length; i++){
        var drillPlan = util.newPlan(api.tx(drillTiles[i]), api.ty(drillTiles[i]), 0, drill);
        if(util.canPlaceWithoutPlanCollision(drillPlan, team, allPlans)){
            allPlans.push(drillPlan);
        }else{
            util.markRefused();
        }
    }

    for(i = 0; i < beltPlans.length; i++){
        if(util.canPlaceWithoutPlanCollision(beltPlans[i], team, allPlans)){
            allPlans.push(beltPlans[i]);
        }else{
            util.markRefused();
        }
    }

    var bridgePlans = [];
    var itemBridge = api.block("itemBridge");
    var withPartner = 0, asOutlet = 0, orphans = 0;

    for(i = 0; i < bridgeTiles.length; i++){
        var bridgeTile = bridgeTiles[i];

        var plannedPartner = null;
        // bridgeTiles is sorted ascending by distance to the outlet, so k < i is strictly
        // closer to the outlet: a bridge can only ever link downhill, which makes A <-> B
        // 2-cycles impossible by construction (the game forbids them, ItemBridge.checkDouble).
        // The old full-range scan linked to whatever came first in the list - including a
        // partner further out when no closer tile sat exactly three away.
        for(var k = 0; k < i; k++){
            var candidate = bridgeTiles[k];
            // Item bridges only link along an axis, so a diagonal "distance 3" partner (e.g.
            // +1/+2) produces a dead bridge.
            var dx = api.tx(candidate) - api.tx(bridgeTile);
            var dy = api.ty(candidate) - api.ty(bridgeTile);
            if((dx === 0 && Math.abs(dy) === 3) || (dy === 0 && Math.abs(dx) === 3)){
                plannedPartner = candidate;
                break;
            }
        }

        var existingPartner = findExistingBridgePartner(bridgeTile);
        var partner = plannedPartner != null ? plannedPartner : existingPartner;

        if(bridgeTile === outlet){
            var hasIncoming = false;
            for(var m = 0; m < bridgeTiles.length; m++){
                var other = bridgeTiles[m];
                if(other === outlet) continue;
                var odx = api.tx(other) - api.tx(outlet);
                var ody = api.ty(other) - api.ty(outlet);
                if((odx === 0 && Math.abs(ody) === 3) || (ody === 0 && Math.abs(odx) === 3)){
                    hasIncoming = true;
                    break;
                }
            }
            var hasExistingIncoming = findExistingBridgePartner(outlet) != null;

            if(!hasIncoming && !hasExistingIncoming){
                orphans++;
                continue;
            }
            asOutlet++;

            var outletPlan = util.newPlan(api.tx(bridgeTile), api.ty(bridgeTile), 0, itemBridge, 0, 0);
            if(util.canPlaceWithoutPlanCollision(outletPlan, team, allPlans)){
                bridgePlans.push(outletPlan);
            }else{
                util.markRefused();
            }
        }else if(partner != null){
            withPartner++;
            var plan = util.newPlan(api.tx(bridgeTile), api.ty(bridgeTile), 0, itemBridge,
                api.tx(partner) - api.tx(bridgeTile), api.ty(partner) - api.ty(bridgeTile));
            if(util.canPlaceWithoutPlanCollision(plan, team, allPlans)){
                bridgePlans.push(plan);
            }else{
                util.markRefused();
            }
        }
        // No partner and not the outlet: an orphan bridge is skipped.
        else{
            orphans++;
        }
    }
    dbg("bridge plans: partner=" + withPartner + " outlet=" + asOutlet + " orphans=" + orphans);

    // --- Prune bridges whose target did not survive validation, until stable.
    var changed = true;
    while(changed){
        changed = false;
        for(var n = bridgePlans.length - 1; n >= 0; n--){
            var bp = bridgePlans[n];

            if(bp.configX === 0 && bp.configY === 0){
                var anyPointsHere = false;
                for(var p = 0; p < bridgePlans.length; p++){
                    if(p === n) continue;
                    var o = bridgePlans[p];
                    if(o.x + o.configX === bp.x && o.y + o.configY === bp.y){
                        anyPointsHere = true;
                        break;
                    }
                }
                if(!anyPointsHere){
                    anyPointsHere = hasExistingBridgePointingAt(bp.x, bp.y);
                }
                if(!anyPointsHere){
                    bridgePlans.splice(n, 1);
                    changed = true;
                }
                continue;
            }

            var targetX = bp.x + bp.configX;
            var targetY = bp.y + bp.configY;

            if(DEBUG && n >= bridgePlans.length - 3){
                var coords = [];
                for(var c = 0; c < bridgePlans.length && c < 8; c++){
                    coords.push(bridgePlans[c].x + "," + bridgePlans[c].y + "cfg" + bridgePlans[c].configX + "," + bridgePlans[c].configY);
                }
                dbg("prune check plan@" + bp.x + "," + bp.y + " cfg=" + bp.configX + "," + bp.configY
                    + " target=" + targetX + "," + targetY + " sample[" + coords.join(" ") + "]");
            }

            var targetExists = false;
            for(var q = 0; q < bridgePlans.length; q++){
                var other2 = bridgePlans[q];
                if(other2.x === targetX && other2.y === targetY){
                    targetExists = true;
                    break;
                }
            }
            if(!targetExists){
                var targetTile = api.tile(targetX, targetY);
                if(targetTile != null && api.buildOf(targetTile) != null
                    && api.blockId(api.blockOf(targetTile)) === api.blockId(itemBridge)){
                    targetExists = true;
                }
            }
            if(!targetExists){
                // The target was refused in the dry run (or never planned). A bridge that
                // another bridge feeds is kept - dropping it used to cascade through the whole
                // chain - but pointing at nothing is not a link: it becomes a terminal outlet
                // that drops its items onto the tiles beside it. A bridge nobody feeds is a
                // dead end and goes.
                var fed = false;
                for(var r = 0; r < bridgePlans.length && !fed; r++){
                    var feeder = bridgePlans[r];
                    if(feeder !== bp && feeder.x + feeder.configX === bp.x && feeder.y + feeder.configY === bp.y){
                        fed = true;
                    }
                }
                if(fed){
                    bp.configX = 0;
                    bp.configY = 0;
                    changed = true;
                }else{
                    bridgePlans.splice(n, 1);
                    changed = true;
                }
            }
        }
    }

    for(i = 0; i < bridgePlans.length; i++){
        allPlans.push(bridgePlans[i]);
    }

    dbg("committing: drills+bridge plans=" + allPlans.length + " (bridges kept=" + bridgePlans.length + ")");
    util.commitPlans(allPlans);
    util.reportRefused("buildings");
    return {plans: allPlans, skipped: skipped};
}

/** Java: BridgeDrill.findExistingBridgePartner */
function findExistingBridgePartner(bridgeTile){
    var offsets = [[3, 0], [-3, 0], [0, 3], [0, -3]];
    for(var i = 0; i < offsets.length; i++){
        var candidate = api.tile(api.tx(bridgeTile) + offsets[i][0], api.ty(bridgeTile) + offsets[i][1]);
        if(candidate != null && api.buildOf(candidate) != null
            && api.blockId(api.blockOf(candidate)) === api.blockId(api.block("itemBridge"))){
            return candidate;
        }
    }
    return null;
}

/**
 * Java: BridgeDrill.hasExistingBridgePointingAt - but exact.
 *
 * The original could only ask "is there a bridge nearby", because it assumed an item
 * bridge's config cannot be read. It can: an ItemBridgeBuild stores its target as
 * Point2.pack(x, y), so we check the real link. Search radius is the bridge's own reach.
 */
function hasExistingBridgePointingAt(x, y){
    var range = api.bridgeRange(api.block("itemBridge"));
    var packed = api.pointPacked(x, y);
    var i = 0;

    for(i = 1; i <= range; i++){
        if(bridgeAtPointsTo(x + i, y, packed) || bridgeAtPointsTo(x - i, y, packed)
            || bridgeAtPointsTo(x, y + i, packed) || bridgeAtPointsTo(x, y - i, packed)){
            return true;
        }
    }
    return false;
}

function bridgeAtPointsTo(x, y, packed){
    var tile = api.tile(x, y);
    if(tile == null) return false;
    var building = api.buildOf(tile);
    if(building == null || api.blockId(api.blockOf(tile)) !== api.blockId(api.block("itemBridge"))) return false;
    return api.bridgeLinkPacked(building) === packed;
}
