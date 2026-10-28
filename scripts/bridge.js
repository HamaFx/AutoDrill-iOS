// AutoDrill (iOS) - bridge.js
// Port of autodrill/filler/BridgeDrill.java: fills a patch with 2x2 drills in the
// classic matrix pattern plus item-bridge chains carrying the output away.

"use strict";

var api = require("api");
var util = require("util");

var SETTING_DEFAULTS = {
    mechanical: {tiles: 200, ores: 1},
    pneumatic: {tiles: 150, ores: 2},
    laser: {tiles: 100, ores: 5},
    airblast: {tiles: 100, ores: 9}
};

/** Java: BridgeDrill.isDrillTile */
function isDrillTile(tile){
    var x = api.tx(tile);
    var y = api.ty(tile);

    switch(x % 6){
        case 0:
        case 2:
            if((y - 1) % 6 === 0) return true;
            break;
        case 1:
            if((y - 3) % 6 === 0 || (y - 3) % 6 === 2) return true;
            break;
        case 3:
        case 5:
            if((y - 4) % 6 === 0) return true;
            break;
        case 4:
            if(y % 6 === 0 || y % 6 === 2) return true;
            break;
    }
    return false;
}

exports.isDrillTile = isDrillTile;

/** Java: BridgeDrill.isBridgeTile */
function isBridgeTile(tile){
    return api.tx(tile) % 3 === 0 && api.ty(tile) % 3 === 0;
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

    var tiles = util.getConnectedTiles(tile, maxTiles, teamOverride);
    util.expandArea(tiles, Math.floor(api.size(drill) / 2));
    return placeDrillsAndBridges(tile, tiles, drill, direction, teamOverride);
}

exports.fill = fill;

function placeDrillsAndBridges(source, tiles, drill, direction, teamOverride){
    var team = teamOverride != null ? teamOverride : api.team();
    var configX = direction.x * 3;
    var configY = direction.y * 3;

    var drillTiles = [];
    var bridgeTiles = [];
    var i = null;

    for(i = 0; i < tiles.length; i++){
        if(isDrillTile(tiles[i])) drillTiles.push(tiles[i]);
    }
    for(i = 0; i < tiles.length; i++){
        if(isBridgeTile(tiles[i])) bridgeTiles.push(tiles[i]);
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

    var sourceDropId = api.itemId(api.drop(source));

    // --- Pre-filter drill candidates: correct resource, enough ores, placeable,
    // --- and reachable by at least one bridge-eligible neighbour.
    var filtered = [];
    for(i = 0; i < drillTiles.length; i++){
        var t = drillTiles[i];
        var ore = util.countOre(t, drill);

        if(ore == null || api.itemId(ore.item) !== sourceDropId || ore.count < minOresPerDrill){
            continue;
        }
        if(!util.canPlaceBlock(drill, team, api.tx(t), api.ty(t), 0)){
            continue;
        }

        var neighbours = util.nearbyTilesOfBlock(api.tx(t), api.ty(t), drill);
        var bridgeEligible = [];
        var j = null;
        for(j = 0; j < neighbours.length; j++){
            if(isBridgeTile(neighbours[j])) bridgeEligible.push(neighbours[j]);
        }

        var connected = false;
        for(j = 0; j < bridgeEligible.length; j++){
            if(util.containsTile(bridgeTiles, bridgeEligible[j])){
                connected = true;
                break;
            }
        }
        if(connected){
            filtered.push(t);
            continue;
        }

        var placeable = [];
        for(j = 0; j < bridgeEligible.length; j++){
            if(util.canPlaceBlock(api.block("itemBridge"), team, api.tx(bridgeEligible[j]), api.ty(bridgeEligible[j]), 0)){
                placeable.push(bridgeEligible[j]);
            }
        }

        if(placeable.length > 0){
            for(j = 0; j < placeable.length; j++){
                bridgeTiles.push(placeable[j]);
            }
            filtered.push(t);
        }
    }
    drillTiles = filtered;

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
        }
    }

    var bridgePlans = [];
    var itemBridge = api.block("itemBridge");

    for(i = 0; i < bridgeTiles.length; i++){
        var bridgeTile = bridgeTiles[i];

        var plannedPartner = null;
        for(var k = 0; k < bridgeTiles.length; k++){
            var candidate = bridgeTiles[k];
            if(candidate === bridgeTile) continue;
            if(Math.abs(api.tx(candidate) - api.tx(bridgeTile)) + Math.abs(api.ty(candidate) - api.ty(bridgeTile)) === 3){
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
                if(Math.abs(api.tx(other) - api.tx(outlet)) + Math.abs(api.ty(other) - api.ty(outlet)) === 3){
                    hasIncoming = true;
                    break;
                }
            }
            var hasExistingIncoming = findExistingBridgePartner(outlet) != null;

            if(!hasIncoming && !hasExistingIncoming){
                continue;
            }

            var outletPlan = util.newPlan(api.tx(bridgeTile), api.ty(bridgeTile), 0, itemBridge, 0, 0);
            if(util.canPlaceWithoutPlanCollision(outletPlan, team, allPlans)){
                bridgePlans.push(outletPlan);
            }
        }else if(partner != null){
            var plan = util.newPlan(api.tx(bridgeTile), api.ty(bridgeTile), 0, itemBridge,
                api.tx(partner) - api.tx(bridgeTile), api.ty(partner) - api.ty(bridgeTile));
            if(util.canPlaceWithoutPlanCollision(plan, team, allPlans)){
                bridgePlans.push(plan);
            }
        }
        // No partner and not the outlet: an orphan bridge is skipped.
    }

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
                bridgePlans.splice(n, 1);
                changed = true;
            }
        }
    }

    for(i = 0; i < bridgePlans.length; i++){
        allPlans.push(bridgePlans[i]);
    }

    util.commitPlans(allPlans);
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
