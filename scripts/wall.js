// AutoDrill (iOS) - wall.js
// Port of autodrill/filler/WallDrill.java: Erekir wall-ore bores (plasma bore) with
// duct chains and beam nodes carrying the output away.

"use strict";

var api = require("api");

var DEBUG = false;
exports.setDebug = function(value){ DEBUG = value; };
function dbg(msg){ if(DEBUG) api.log("[wall] " + msg); }
var util = require("util");
var dir = require("direction");

/** Java integer division truncates toward zero; Math.floor would be wrong for negatives. */
function jdiv(a, b){
    return Math.trunc(a / b);
}

/** Java: WallDrill.fill */
function fill(tile, drill, direction, teamOverride){
    var team = teamOverride != null ? teamOverride : api.team();
    var tiles = getConnectedWallTiles(tile, direction);

    var boreTiles = [];
    var occupiedSecondaryAxis = [];

    var opposite = dir.opposite(direction);
    var offset = drillOffset(direction, drill);
    var offsetOpposite = ductOffset(opposite, drill);

    var allPlans = [];
    var i = 0, j = 0, k = 0;

    var size = api.size(drill);
    var beamRange = api.beamRange(drill);
    var lowJ = jdiv(-(size - 1), 2);
    var highJ = jdiv(size, 2);

    // --- Phase 1: valid bore placements -------------------------------------------------
    for(i = 0; i < tiles.length; i++){
        var wallTile = tiles[i];

        for(var step = 0; step < beamRange; step++){
            var boreTile = api.nearby(wallTile,
                (step + 1) * -direction.x + offset.x,
                (step + 1) * -direction.y + offset.y);
            if(boreTile == null) continue;

            var borePlan = util.newPlan(api.tx(boreTile), api.ty(boreTile), direction.r, drill);
            if(!util.canPlaceWithoutPlanCollision(borePlan, team, allPlans)) continue;

            var sa = dir.secondary(direction, api.tx(boreTile), api.ty(boreTile));

            var occupied = false;
            for(j = lowJ; j <= highJ; j++){
                if(occupiedSecondaryAxis.indexOf(sa + j) !== -1){
                    occupied = true;
                    break;
                }
            }
            if(occupied) continue;

            for(j = lowJ; j <= highJ; j++){
                occupiedSecondaryAxis.push(sa + j);
            }

            boreTiles.push(boreTile);
            allPlans.push(borePlan);
            break;
        }
    }
    if(boreTiles.length === 0) return [];

    // --- Phase 2: duct tiles next to every bore -----------------------------------------
    var ductTiles = [];
    for(i = 0; i < boreTiles.length; i++){
        var bore = boreTiles[i];
        for(j = lowJ; j <= highJ; j++){
            var ductTile = api.nearby(bore,
                -offsetOpposite.x + opposite.x + (j * Math.abs(direction.y)),
                -offsetOpposite.y + opposite.y + (j * Math.abs(direction.x)));
            if(ductTile == null) continue;
            ductTiles.push(ductTile);
        }
    }
    if(ductTiles.length === 0) return [];

    // --- Phase 3: build the connecting duct network -------------------------------------
    var outerCandidates = [];
    for(i = 0; i < ductTiles.length; i++){
        var candidate = ductTiles[i];
        var candidateSa = dir.secondary(direction, api.tx(candidate), api.ty(candidate));
        var matchesBore = false;
        for(j = 0; j < boreTiles.length; j++){
            if(dir.secondary(direction, api.tx(boreTiles[j]), api.ty(boreTiles[j])) === candidateSa){
                matchesBore = true;
                break;
            }
        }
        if(!matchesBore) outerCandidates.push(candidate);
    }

    var outerMostDuctTile = util.argMax(outerCandidates, function(t){
        return -dir.primary(direction, api.tx(t), api.ty(t));
    });
    if(outerMostDuctTile == null) return [];

    util.sortStable(ductTiles, function(t){
        return api.dst2ToTile(t, outerMostDuctTile);
    });

    var connectingTiles = [outerMostDuctTile];

    // Every duct candidate is connected to the trunk along the shortest path of tiles a duct
    // can actually be placed on. The original walked in primary/secondary steps, which could
    // wander far away from the bores (and could loop forever without a guard).
    var ductsBlock = api.block("duct");
    var routeBudget = 4000;

    for(i = 0; i < ductTiles.length; i++){
        var ductTile2 = ductTiles[i];
        if(util.containsTile(connectingTiles, ductTile2)) continue;
        if(routeBudget <= 0) break;

        var path = util.findDuctPath(ductTile2, connectingTiles, ductsBlock, team, routeBudget);
        if(path == null){
            dbg("no duct route from " + api.tx(ductTile2) + "," + api.ty(ductTile2));
            continue;
        }
        dbg("duct route from " + api.tx(ductTile2) + "," + api.ty(ductTile2) + " length=" + path.length);

        routeBudget -= path.length;
        for(j = 0; j < path.length; j++){
            if(!util.containsTile(connectingTiles, path[j])) connectingTiles.push(path[j]);
        }
    }

    // --- Phase 4: generate duct plans ---------------------------------------------------
    util.sortStable(connectingTiles, function(t){
        return api.dstToTile(t, outerMostDuctTile);
    });

    var visitedTiles = [outerMostDuctTile];
    var connectingWork = connectingTiles.slice();
    var ducts = api.block("duct");

    while(connectingWork.length > 0){
        var tile1 = null, tile2 = null;

        for(i = 0; i < connectingWork.length; i++){
            var connectingTile = connectingWork[i];
            var adjacent = null;
            for(k = 0; k < visitedTiles.length; k++){
                if(api.relativeTo(connectingTile, visitedTiles[k]) !== -1){
                    adjacent = visitedTiles[k];
                    break;
                }
            }
            if(adjacent != null){
                tile1 = adjacent;
                tile2 = connectingTile;
                visitedTiles.push(connectingTile);
                connectingWork.splice(i, 1);
                break;
            }
        }
        if(tile1 == null || tile2 == null){
            break;
        }

        if(api.pos(tile2) === api.pos(outerMostDuctTile)){
            var ductPlan1 = util.newPlan(api.tx(tile2), api.ty(tile2), opposite.r, ducts);
            if(util.canPlaceWithoutPlanCollision(ductPlan1, team, allPlans)){
                allPlans.push(ductPlan1);
            }

            var ductPlan2 = util.newPlan(api.tx(tile2) + opposite.x, api.ty(tile2) + opposite.y, opposite.r, ducts);
            if(util.canPlaceWithoutPlanCollision(ductPlan2, team, allPlans)){
                allPlans.push(ductPlan2);
            }
        }else{
            var ductPlan = util.newPlan(api.tx(tile2), api.ty(tile2), api.relativeTo(tile2, tile1), ducts);
            if(util.canPlaceWithoutPlanCollision(ductPlan, team, allPlans)){
                allPlans.push(ductPlan);
            }
        }
    }

    for(i = 0; i < connectingTiles.length; i++){
        var remaining = connectingTiles[i];
        var remainingIndex = util.indexOfTile(connectingTiles, remaining);

        var neighbour = null;
        for(k = 0; k < connectingTiles.length; k++){
            if(util.indexOfTile(connectingTiles, connectingTiles[k]) < remainingIndex
                && api.relativeTo(connectingTiles[k], remaining) !== -1){
                neighbour = connectingTiles[k];
                break;
            }
        }
        if(neighbour == null) continue;

        var finalPlan = util.newPlan(api.tx(remaining), api.ty(remaining), api.relativeTo(remaining, neighbour), ducts);
        if(util.canPlaceWithoutPlanCollision(finalPlan, team, allPlans)){
            allPlans.push(finalPlan);
        }
    }

    // --- Phase 5: beam nodes ------------------------------------------------------------
    // Nodes used to be placed by a fixed formula that overlapped the outlet duct in simple
    // geometries, in which case they were silently dropped. They are now searched for: step
    // away from the bore in the output direction until a node fits, then chain back toward
    // the bore (a beam node reaches 10 tiles, so links are made every 5 tiles).
    var beamNode = api.block("beamNode");
    var tilesize = api.tilesize();

    for(i = 0; i < boreTiles.length; i++){
        var boreTile2 = boreTiles[i];
        var beamNodeTile = null;

        for(j = 2; j <= 14; j++){
            var probe = api.nearby(boreTile2, opposite.x * j, opposite.y * j);
            if(probe == null) break;

            var probePlan = util.newPlan(api.tx(probe), api.ty(probe), 0, beamNode);
            if(util.canPlaceWithoutPlanCollision(probePlan, team, allPlans)){
                allPlans.push(probePlan);
                beamNodeTile = probe;
                break;
            }
        }
        if(beamNodeTile == null){
            dbg("no beam node spot beyond bore " + api.tx(boreTile2) + "," + api.ty(boreTile2));
            continue;
        }

        var chainGuard = 0;
        while(api.dstToTile(beamNodeTile, boreTile2) > 10 * tilesize && chainGuard++ < 200){
            beamNodeTile = api.nearby(beamNodeTile, direction.x * 5, direction.y * 5);
            if(beamNodeTile == null) break;

            var chainPlan = util.newPlan(api.tx(beamNodeTile), api.ty(beamNodeTile), 0, beamNode);
            if(util.canPlaceWithoutPlanCollision(chainPlan, team, allPlans)){
                allPlans.push(chainPlan);
            }
        }
    }

    util.commitPlans(allPlans);
    util.reportRefused("wall-drill blocks");
    return allPlans;
}

exports.fill = fill;

/** Java: WallDrill.getConnectedWallTiles */
function getConnectedWallTiles(tile, direction){
    var queue = [tile];
    var queueIndex = 0;
    var tiles = [];
    var visited = {};

    var sourceItemId = api.itemId(api.wallDrop(tile));
    var baseSetting = api.settingInt("mechanical-drill-max-tiles", 200);
    var maxTiles = Math.trunc(baseSetting * 0.25);

    while(queueIndex < queue.length && tiles.length < maxTiles){
        var current = queue[queueIndex++];
        var currentPos = api.pos(current);

        if(visited[currentPos] === true) continue;

        if(api.itemId(api.wallDrop(current)) === sourceItemId){
            for(var x = -2; x <= 2; x++){
                for(var y = -2; y <= 2; y++){
                    if(x === 0 && y === 0) continue;

                    var neighbour = api.nearby(current, x, y);
                    if(neighbour == null) continue;

                    var behind = api.nearby(neighbour, -direction.x, -direction.y);
                    if(visited[api.pos(neighbour)] !== true && behind != null && !api.solid(behind)){
                        queue.push(neighbour);
                    }
                }
            }
            tiles.push(current);
        }

        visited[currentPos] = true;
    }

    // Keep only the tiles furthest along the output direction for each secondary axis.
    var tilesCopy = tiles.slice();
    var kept = [];
    for(var i = 0; i < tiles.length; i++){
        var t1 = tiles[i];
        var pa1 = dir.primary(direction, api.tx(t1), api.ty(t1));
        var sa1 = dir.secondary(direction, api.tx(t1), api.ty(t1));

        var dominated = false;
        for(var j = 0; j < tilesCopy.length; j++){
            var t2 = tilesCopy[j];
            if(api.pos(t2) === api.pos(t1)) continue;
            if(dir.secondary(direction, api.tx(t2), api.ty(t2)) === sa1
                && dir.primary(direction, api.tx(t2), api.ty(t2)) < pa1){
                dominated = true;
                break;
            }
        }
        if(!dominated) kept.push(t1);
    }
    tiles = kept;

    util.sortStable(tiles, function(t){
        return dir.secondary(direction, api.tx(t), api.ty(t));
    });

    return tiles;
}

exports.getConnectedWallTiles = getConnectedWallTiles;

/** Java: WallDrill.getDirectionOffsetForDrill (switch on the rotation index, not identity) */
function drillOffset(direction, block){
    var offset2 = jdiv(api.size(block), 2);

    switch(direction.r){
        case 0: return {x: -offset2, y: 0};    // RIGHT
        case 1: return {x: 0, y: -offset2};    // UP
        case 2: return {x: -offset2, y: -1};   // LEFT
        default: return {x: -offset2, y: 0};   // DOWN
    }
}

/** Java: WallDrill.getDirectionOffsetForDuct */
function ductOffset(direction, block){
    var offset1 = jdiv(api.size(block) - 1, 2);
    var offset2 = jdiv(api.size(block), 2);

    switch(direction.r){
        case 0: return {x: -offset2, y: 0};    // RIGHT
        case 1: return {x: 0, y: -offset2};    // UP
        case 2: return {x: offset1, y: 0};     // LEFT
        default: return {x: offset1, y: 0};    // DOWN
    }
}
