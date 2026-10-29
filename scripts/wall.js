// AutoDrill (iOS) - wall.js
// Erekir wall-ore bores (plasma bore / large plasma bore) with duct chains and beam nodes
// carrying the output away.
//
// Ported from autodrill/filler/WallDrill.java and then rebuilt around what BeamDrill actually
// does (v160.7): a bore has one lane per block side across its facing direction, and each lane
// mines the FIRST solid tile within `range`. Wall ore stays solid forever, so every ore tile
// needs a lane that sees it - a compact patch needs as many placements as the lanes allow,
// and a beam is blocked by anything solid in front, including other bores. The original kept
// one tile per secondary axis (min primary) and placed one bore per kept tile, which misses
// every second ore tile on the same row: on a speckled Erekir face - the generator only marks
// some exposed tiles - that is most of the patch. The greedy below covers the patch instead.
//
// The chosen `direction` is the OUTPUT direction (where the duct trunk leaves); bores face
// whatever side their ore tile is on. `getConnectedWallTiles` is kept as the direction-filtered
// surface walk the engine checks use; the fill works from the whole patch.

"use strict";

var api = require("api");
var optimization = require("optimization");

var DEBUG = false;
exports.setDebug = function(value){ DEBUG = value; };
function dbg(msg){ if(DEBUG) api.log("[wall] " + msg); }
var util = require("util");
var dir = require("direction");

/** Block.nearbySide - the lane-start tile just outside a block on one side (v160.7). */
function laneStart(px, py, size, rot, index){
    var cornerX = px - Math.floor((size - 1) / 2), cornerY = py - Math.floor((size - 1) / 2);
    if(rot === 0) return {x: cornerX + size, y: cornerY + index};
    if(rot === 1) return {x: cornerX + index, y: cornerY + size};
    if(rot === 2) return {x: cornerX - 1, y: cornerY + index};
    return {x: cornerX + index, y: cornerY - 1};
}

/** The first solid tile a lane sees (planned bores are solid and block beams), or null. */
function laneTarget(startX, startY, rot, range, solidAt){
    var dx = rot === 0 ? 1 : (rot === 2 ? -1 : 0);
    var dy = rot === 1 ? 1 : (rot === 3 ? -1 : 0);

    for(var j = 0; j < range; j++){
        var tx = startX + dx * j, ty = startY + dy * j;
        var tile = api.tile(tx, ty);
        if(tile == null) return null;
        if(solidAt[api.pos(tile)] === true) return null;
        if(api.solid(tile)) return tile;
    }
    return {x: startX + dx * range, y: startY + dy * range, beyond: true};
}

/**
 * The wall-ore patch: same-item wall ore reachable from the tapped tile. The walk steps up to
 * two tiles at a time (the original's reach) so small gaps along a face do not split the patch,
 * but it only ever lands on ore - unlike the original it does not filter by the output
 * direction, because the bores may face any way.
 */
function wallOrePatch(tile){
    var queue = [tile];
    var queueIndex = 0;
    var tiles = [];
    var visited = {};
    var sourceItemId = api.itemId(api.wallDrop(tile));

    var baseSetting = api.settingInt("mechanical-drill-max-tiles", optimization.settingDefaults.mechanical.tiles);
    var maxTiles = Math.min(600, Math.max(100, Math.trunc(baseSetting * 0.25)));

    visited[api.pos(tile)] = true;
    while(queueIndex < queue.length && tiles.length < maxTiles){
        var current = queue[queueIndex++];
        tiles.push(current);

        for(var x = -2; x <= 2; x++){
            for(var y = -2; y <= 2; y++){
                if(x === 0 && y === 0) continue;
                var neighbour = api.nearby(current, x, y);
                if(neighbour == null) continue;
                var npos = api.pos(neighbour);
                if(visited[npos] === true) continue;
                if(api.itemId(api.wallDrop(neighbour)) !== sourceItemId) continue;
                visited[npos] = true;
                queue.push(neighbour);
            }
        }
    }
    return tiles;
}

/**
 * Candidate bores: every placement whose lane sees at least one patch tile, with the tiles that
 * placement would mine. Enumerated once; the greedy re-scores them as the patch fills up.
 */
function boreCandidates(patchTiles, drill, range, size, team){
    var candidates = [];
    var i = 0;
    var seen = {};

    for(i = 0; i < patchTiles.length; i++){
        var t = patchTiles[i];
        var tx = api.tx(t), ty = api.ty(t);

        for(var r = 0; r < 4; r++){
            var fd = dir.all[r];
            for(var j = 0; j < range; j++){
                // the lane would start j tiles in front of the anchor and see this tile
                var sx = tx - fd.x * j, sy = ty - fd.y * j;

                // path from the lane start to the tile must be clear
                var clear = true;
                for(var k = 0; k < j && clear; k++){
                    var pt = api.tile(sx + fd.x * k, sy + fd.y * k);
                    if(pt == null || api.solid(pt)) clear = false;
                }
                if(!clear) continue;

                for(var lane = 0; lane < size; lane++){
                    // anchor that puts lane `lane` at (sx, sy) for this facing
                    var ax = 0, ay = 0;
                    var half = Math.floor((size - 1) / 2);
                    if(r === 0){ ax = sx - size + half; ay = sy - lane + half; }
                    else if(r === 1){ ax = sx - lane + half; ay = sy - size + half; }
                    else if(r === 2){ ax = sx + 1 + half; ay = sy - lane + half; }
                    else { ax = sx - lane + half; ay = sy + 1 + half; }

                    var anchorTile = api.tile(ax, ay);
                    if(anchorTile == null) continue;

                    var plan = util.newPlan(ax, ay, r, drill);
                    var candKey = (ax + 4096) + (ay + 4096) * 8192 + r * 8192 * 8192;
                    if(seen[candKey] === true) continue;
                    seen[candKey] = true;

                    candidates.push({plan: plan, x: ax, y: ay, rot: r, tile: anchorTile});
                }
            }
        }
    }
    return candidates;
}

/** Java: WallDrill.fill */
function fill(tile, drill, direction, teamOverride){
    var team = teamOverride != null ? teamOverride : api.team();
    var patch = wallOrePatch(tile);
    if(patch.length === 0) return [];

    var sourceItemId = api.itemId(api.wallDrop(tile));
    var size = api.size(drill);
    var range = api.beamRange(drill);

    var allPlans = [];
    var solidAt = {};          // planned bores: solid, so they block later beams
    var covered = {};          // patch tiles a chosen bore mines
    var coveredCount = 0;
    var boreTiles = [];        // {tile, facing}
    var i = 0, j = 0, k = 0;

    // --- Phase 1: cover the patch with as few bores as the lanes allow -------------------
    var candidates = boreCandidates(patch, drill, range, size, team);
    var live = [];
    for(i = 0; i < candidates.length; i++){
        var candidate = candidates[i];
        var plan = candidate.plan;
        if(!util.canPlaceBlock(drill, team, plan.x, plan.y, plan.rot)) continue;
        live.push(candidate);
    }

    while(coveredCount < patch.length){
        // score every still-valid candidate: how many uncovered tiles its lanes would mine
        var best = null;
        var bestScore = 0;

        for(i = 0; i < live.length; i++){
            var cand = live[i];
            if(cand === null) continue;

            var score = 0;
            for(j = 0; j < size; j++){
                var lane = laneStart(cand.x, cand.y, size, cand.rot, j);
                var target = laneTarget(lane.x, lane.y, cand.rot, range, solidAt);
                if(target == null || target.beyond === true) continue;
                var key = api.pos(target);
                if(covered[key] === true) continue;
                if(api.itemId(api.wallDrop(target)) !== sourceItemId) continue;
                score++;
            }
            if(score > bestScore){
                bestScore = score;
                best = cand;
            }
        }
        if(best == null || bestScore === 0) break;

        // commit: the bore, its lane cover, and its footprint as a beam blocker
        allPlans.push(best.plan);
        solidAt[api.pos(best.tile)] = true;
        boreTiles.push({tile: best.tile, facing: best.rot});

        for(j = 0; j < size; j++){
            var lane2 = laneStart(best.x, best.y, size, best.rot, j);
            var target2 = laneTarget(lane2.x, lane2.y, best.rot, range, solidAt);
            if(target2 == null || target2.beyond === true) continue;
            var key2 = api.pos(target2);
            if(covered[key2] !== true
                && api.itemId(api.wallDrop(target2)) === sourceItemId){
                covered[key2] = true;
                coveredCount++;
            }
        }

        // drop candidates that overlap the chosen bore
        for(i = 0; i < live.length; i++){
            var other = live[i];
            if(other === null) continue;
            var rect = util.blockRect(other.plan.x, other.plan.y, drill);
            var chosenRect = util.blockRect(best.plan.x, best.plan.y, drill);
            if(util.rectsOverlap(rect, chosenRect)) live[i] = null;
        }
    }

    if(boreTiles.length === 0) return [];

    // --- Phase 2: duct tiles behind every bore -------------------------------------------
    // The duct must sit next to the bore; the natural spot is behind it (its beams go the other
    // way). If that side is blocked, try the output side and then the rest.
    var ductTiles = [];

    for(i = 0; i < boreTiles.length; i++){
        var bore = boreTiles[i];
        var sides = [dir.opposite(dir.all[bore.facing]), direction, dir.opposite(direction), dir.all[bore.facing]];

        for(k = 0; k < sides.length; k++){
            var side = sides[k];
            var added = 0;
            for(j = 0; j < size; j++){
                var lane3 = laneStart(bore.tile.x, bore.tile.y, size, side.r, j);
                var ductTile = api.tile(lane3.x, lane3.y);
                if(ductTile == null) continue;
                if(util.containsTile(ductTiles, ductTile)) continue;
                var sidePlan = util.newPlan(api.tx(ductTile), api.ty(ductTile), side.r, api.block("duct"));
                if(!util.canPlaceWithoutPlanCollision(sidePlan, team, allPlans)) continue;
                ductTiles.push(ductTile);
                added++;
            }
            if(added > 0) break;
        }
    }
    if(ductTiles.length === 0) return [];

    // --- Phase 3: choose the outlet and the trunk ----------------------------------------
    // The outlet is the duct tile furthest along the output direction that is not lined up
    // with a bore; when every tile is (a small patch), take the furthest along the direction.
    var outerCandidates = [];
    for(i = 0; i < ductTiles.length; i++){
        var candidate2 = ductTiles[i];
        var candidateSa = dir.secondary(direction, api.tx(candidate2), api.ty(candidate2));
        var matchesBore = false;
        for(j = 0; j < boreTiles.length; j++){
            if(dir.secondary(direction, api.tx(boreTiles[j].tile), api.ty(boreTiles[j].tile)) === candidateSa){
                matchesBore = true;
                break;
            }
        }
        if(!matchesBore) outerCandidates.push(candidate2);
    }
    if(outerCandidates.length === 0) outerCandidates = ductTiles;

    var outerMostDuctTile = util.argMax(outerCandidates, function(t){
        return -dir.primary(direction, api.tx(t), api.ty(t));
    });
    if(outerMostDuctTile == null) return [];

    util.sortStable(ductTiles, function(t){
        return api.dst2ToTile(t, outerMostDuctTile);
    });

    var connectingTiles = [outerMostDuctTile];
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

    var opposite = dir.opposite(direction);
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
    // A node is placed behind every bore (on its back side, so it keeps out of the beam) and
    // chained toward the output direction, so the bores have power. Beam nodes reach 10 tiles,
    // so links are made every 5.
    var beamNode = api.block("beamNode");
    var nodeRange = Math.floor(api.powerRangeOf(beamNode));
    var tilesize = api.tilesize();

    for(i = 0; i < boreTiles.length; i++){
        var bore2 = boreTiles[i];
        var back = dir.opposite(dir.all[bore2.facing]);
        var beamNodeTile = null;

        for(j = 2; j <= 14; j++){
            var probe = api.nearby(bore2.tile, back.x * j, back.y * j);
            if(probe == null) break;

            var probePlan = util.newPlan(api.tx(probe), api.ty(probe), 0, beamNode);
            if(util.canPlaceWithoutPlanCollision(probePlan, team, allPlans)){
                allPlans.push(probePlan);
                beamNodeTile = probe;
                break;
            }
        }
        if(beamNodeTile == null){
            dbg("no beam node spot beyond bore " + api.tx(bore2.tile) + "," + api.ty(bore2.tile));
            continue;
        }

        var chainGuard = 0;
        while(api.dstToTile(beamNodeTile, bore2.tile) > nodeRange * tilesize && chainGuard++ < 200){
            beamNodeTile = api.nearby(beamNodeTile, direction.x * 5, direction.y * 5);
            if(beamNodeTile == null) break;

            var chainPlan = util.newPlan(api.tx(beamNodeTile), api.ty(beamNodeTile), 0, beamNode);
            if(util.canPlaceWithoutPlanCollision(chainPlan, team, allPlans)){
                allPlans.push(chainPlan);
            }
        }
    }

    // --- Phase 6: wire the network into the player's grid --------------------------------
    linkPowerGrid(allPlans, team, beamNode, tile);

    util.commitPlans(allPlans);

    // --- say what happened, and what is next to it ---------------------------------------
    // Wall ore is infinite, and the generator leaves it speckled: the tapped patch is only the
    // connected part. Report the coverage and, when there is more ore of the same item nearby
    // that no walk could reach, say how much (tap it to bore those too).
    var mined = 0;
    for(i = 0; i < patch.length; i++){
        if(covered[api.pos(patch[i])] === true) mined++;
    }
    if(mined < patch.length){
        api.toast("[AutoDrill v" + api.modVersion() + "] wall ore: bored " + mined + " of "
            + patch.length + " tiles - the rest has no clear line for a "
            + api.blockName(drill) + " (tap it from another side or use a bigger bore?)");
    }else{
        api.toast("[AutoDrill v" + api.modVersion() + "] wall ore: bored all " + mined + " tiles");
    }

    var separate = 0;
    var checked = {};
    var patchSet = {};
    for(i = 0; i < patch.length; i++) patchSet[api.pos(patch[i])] = true;

    for(i = 0; i < patch.length && separate < 500; i++){
        for(k = -9; k <= 9; k++){
            for(j = -9; j <= 9; j++){
                var nearTile = api.nearby(patch[i], k, j);
                if(nearTile == null) continue;
                var nearKey = api.pos(nearTile);
                if(checked[nearKey] === true || patchSet[nearKey] === true) continue;
                checked[nearKey] = true;
                if(api.itemId(api.wallDrop(nearTile)) !== sourceItemId) continue;
                separate++;
            }
        }
    }
    if(separate > 0){
        api.toast("[AutoDrill v" + api.modVersion() + "] note: " + separate
            + " more wall ore tiles of this kind are nearby but not connected - tap them to bore those too");
    }

    util.reportRefused("wall-drill blocks");
    return allPlans;
}

exports.fill = fill;

/**
 * Chains beam nodes from the fill's network to the nearest building that carries power, so the
 * bores are not an island. Silent when there is no power anywhere near - the player then only
 * has to attach one node.
 */
function linkPowerGrid(allPlans, team, beamNode, tap){
    var POWER_LINK_RADIUS = 90;
    var range = Math.floor(api.powerRangeOf(beamNode));
    if(range < 2) return 0;

    var target = api.powerTargetNear(api.tx(tap), api.ty(tap), POWER_LINK_RADIUS);
    if(target == null) return 0;

    // nearest planned node to the grid
    var start = null, startDist = 0;
    var i = 0;
    for(i = 0; i < allPlans.length; i++){
        if(api.blockId(allPlans[i].block) !== api.blockId(beamNode)) continue;
        var dx = allPlans[i].x - api.tx(target), dy = allPlans[i].y - api.ty(target);
        var d = dx * dx + dy * dy;
        if(start == null || d < startDist){
            start = allPlans[i];
            startDist = d;
        }
    }
    if(start == null) return 0;
    if(startDist <= range * range) return 0;    // already inside the grid's reach

    var step = Math.max(2, range - 2);
    var budget = 900;
    var path = util.findDuctPath(api.tile(start.x, start.y), [api.tile(api.tx(target), api.ty(target))],
        beamNode, team, budget, null);
    if(path == null) return 0;

    var placed = 0;
    var lastX = start.x, lastY = start.y;

    for(i = 0; i < path.length; i++){
        var t = path[i];
        var toTargetX = api.tx(target) - lastX, toTargetY = api.ty(target) - lastY;
        if(toTargetX * toTargetX + toTargetY * toTargetY <= range * range) break;

        var fromLastX = t.x - lastX, fromLastY = t.y - lastY;
        if(fromLastX * fromLastX + fromLastY * fromLastY < step * step && i < path.length - 1) continue;

        var plan = util.newPlan(t.x, t.y, 0, beamNode);
        if(!util.canPlaceWithoutPlanCollision(plan, team, allPlans)) continue;

        allPlans.push(plan);
        lastX = t.x;
        lastY = t.y;
        placed++;
    }
    if(placed > 0) dbg("power: chained " + placed + " nodes to the grid");
    return placed;
}

/** Java: WallDrill.getConnectedWallTiles */
function getConnectedWallTiles(tile, direction){
    var queue = [tile];
    var queueIndex = 0;
    var tiles = [];
    var visited = {};

    var sourceItemId = api.itemId(api.wallDrop(tile));
    // The wall fill explores a quarter of what a normal fill does (as in the original), but
    // bounded: it is a different tool with its own cost, and the patch-size setting is not
    // about it.
    var baseSetting = api.settingInt("mechanical-drill-max-tiles", optimization.settingDefaults.mechanical.tiles);
    var maxTiles = Math.min(600, Math.max(100, Math.trunc(baseSetting * 0.25)));

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

