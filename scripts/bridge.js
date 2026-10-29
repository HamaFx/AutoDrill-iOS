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

/** True when the tile can link (item bridges link three tiles along an axis) to one in the list. */
function pairsWithAny(tile, list){
    for(var i = 0; i < list.length; i++){
        var dx = api.tx(list[i]) - api.tx(tile);
        var dy = api.ty(list[i]) - api.ty(tile);
        if((dx === 0 && Math.abs(dy) === 3) || (dy === 0 && Math.abs(dx) === 3)) return true;
    }
    return false;
}

/** True when the tile carries the ore this fill is about. */
function isOreTile(tile, sourceDropId){
    return api.itemId(api.drop(tile)) === sourceDropId;
}

/**
 * Takes a drill candidate when it can actually work: it mines the tapped ore, meets Min Ores,
 * fits on free ground, and has a belt or bridge next to it (or can have one added) to carry its
 * ore out - a drill with nowhere to put its ore just fills up.
 *
 * Returns 1 when taken. NOTE: a number, not an object - helpers that build an object and are
 * called inside a hot loop are the Rhino trap documented in docs/AUDIT.md.
 */
function takeDrillCandidate(t, drill, sourceDropId, minOresPerDrill, team, bridgeTiles, occupied, phaseX, phaseY){
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
    if(!util.canPlaceBlock(drill, team, x, y, 0)) return 0;

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

        // first choice: the grid tiles the pattern keeps for its belts
        for(j = 0; j < eligible.length; j++){
            if(util.canPlaceBlock(api.block("itemBridge"), team, api.tx(eligible[j]), api.ty(eligible[j]), 0)){
                placeable.push(eligible[j]);
            }
        }

        // otherwise any free tile next to the drill that can link to the chain: an item bridge
        // reaches three tiles along an axis, so a tile that pairs with one already planned joins
        // the chain - which is what lets drills sit on ore the fixed pattern never covered
        for(j = 0; j < neighbours.length; j++){
            var candidate = neighbours[j];
            if(util.containsTile(bridgeTiles, candidate)) continue;
            if(util.containsTile(placeable, candidate)) continue;
            if(!util.canPlaceBlock(api.block("itemBridge"), team, api.tx(candidate), api.ty(candidate), 0)) continue;
            if(!pairsWithAny(candidate, bridgeTiles)) continue;

            placeable.push(candidate);
        }

        if(placeable.length === 0) return 0;

        for(j = 0; j < placeable.length; j++){
            if(!util.containsTile(bridgeTiles, placeable[j])) bridgeTiles.push(placeable[j]);
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
 */
function pickPhase(tiles, drill, targetSet){
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

    var phase = pickPhase(tiles, drill, targetSet);
    dbg("phase=" + phase.x + "," + phase.y + " patternOre=" + phase.score + " of " + targetCells);

    var plans = placeDrillsAndBridges(tile, tiles, drill, direction, teamOverride, phase.x, phase.y);

    reportCoverage(plans, drill, sourceDropId, targetCells, targetSet, truncated, maxTiles);
    return plans;
}

/**
 * The belt tool used to plan in silence, so a patch that was cut short by Max Tiles - or one
 * where a second ore is the only thing left - looked like the fill had stopped working. Same
 * plain result line the optimiser fills print.
 */
function reportCoverage(plans, drill, sourceDropId, targetCells, targetSet, truncated, maxTiles){
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
        }else{
            // the belt layout has to keep tiles for its belts, so a strip is always left; the
            // optimiser drills fill a patch right to its edge
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
    var team = teamOverride != null ? teamOverride : api.team();
    var configX = direction.x * 3;
    var configY = direction.y * 3;

    var drillTiles = [];
    var bridgeTiles = [];
    var leftovers = [];       // ore the pattern does not cover; picked up below
    var sourceDropId = api.itemId(api.drop(source));
    var i = null;

    for(i = 0; i < tiles.length; i++){
        if(isDrillTile(tiles[i], phaseX, phaseY)) drillTiles.push(tiles[i]);
        else if(isOreTile(tiles[i], sourceDropId)) leftovers.push(tiles[i]);
    }
    for(i = 0; i < tiles.length; i++){
        if(isBridgeTile(tiles[i], phaseX, phaseY)) bridgeTiles.push(tiles[i]);
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
    // --- whatever ore the pattern missed is picked up with the same rules.
    var occupied = {};
    var filtered = [];

    for(i = 0; i < drillTiles.length; i++){
        if(takeDrillCandidate(drillTiles[i], drill, sourceDropId, minOresPerDrill, team,
            bridgeTiles, occupied, phaseX, phaseY)){
            filtered.push(drillTiles[i]);
        }
    }

    for(i = 0; i < leftovers.length; i++){
        if(takeDrillCandidate(leftovers[i], drill, sourceDropId, minOresPerDrill, team,
            bridgeTiles, occupied, phaseX, phaseY)){
            filtered.push(leftovers[i]);
        }
    }
    drillTiles = filtered;

    dbg("after filter: drills=" + drillTiles.length + " bridgeTiles=" + bridgeTiles.length + " sourceDrop=" + sourceDropId);

    // No drill means no job: the chain only exists to carry their output. Upstream planned a
    // bridge matrix anyway when a non-ore tile was tapped, filling the map with useless plans.
    if(drillTiles.length === 0) return [];

    if(bridgeTiles.length === 0) return [];

    // --- Outlet: the bridge tile furthest in the chosen direction, plus one tile further out.
    var outerMost = util.argMax(bridgeTiles, function(t2){
        return direction.x === 0 ? api.ty(t2) * direction.y : api.tx(t2) * direction.x;
    });
    if(outerMost == null) return [];

    var outlet = api.nearby(outerMost, configX, configY);
    if(outlet == null) return [];

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

    var bridgePlans = [];
    var itemBridge = api.block("itemBridge");
    var withPartner = 0, asOutlet = 0, orphans = 0;

    for(i = 0; i < bridgeTiles.length; i++){
        var bridgeTile = bridgeTiles[i];

        var plannedPartner = null;
        for(var k = 0; k < bridgeTiles.length; k++){
            var candidate = bridgeTiles[k];
            if(candidate === bridgeTile) continue;
            // Item bridges only link along an axis, so a diagonal "distance 3" partner (e.g.
            // +1/+2) produces a dead bridge. The original only checked Manhattan distance and
            // took whichever match came first in tile order, which is why chains were
            // sometimes built and sometimes not.
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
                // A bridge whose target is missing is still worth keeping when something feeds
                // into it: dropping it used to cascade through the whole chain, which is why
                // belts appeared for some patches and not others. Only dead ends go.
                var fed = false;
                for(var r = 0; r < bridgePlans.length && !fed; r++){
                    var feeder = bridgePlans[r];
                    if(feeder !== bp && feeder.x + feeder.configX === bp.x && feeder.y + feeder.configY === bp.y){
                        fed = true;
                    }
                }
                if(!fed){
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
    return allPlans;
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
