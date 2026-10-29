// AutoDrill (iOS) - util.js
// Port of autodrill/filler/Util.java. All placement validation, tile collection and
// ore counting funnels through here so every filler uses identical rules.
//
// Differences from the Java original (behaviour-preserving):
//  * plans are plain JS objects {x, y, rot, block, configX, configY} instead of BuildPlan
//  * member tests use tile.pos() as a key instead of object identity
//  * Seq.sort is replaced by an explicitly stable sort (Java's sort is stable)

"use strict";

var api = require("api");

var DEBUG = false;

// NOTE: never name a module-level binding "log" or "print" - Mindustry's global.js
// declares those as consts in the shared lexical scope, and Rhino rejects the
// redeclaration inside a module.
function debugLog(msg){
    if(DEBUG){
        api.log(msg);
        api.trace("[util] " + msg);
    }
}

// ---------------------------------------------------------------- plan helpers

/** Creates a plain plan object. configX/configY may be null (= no config). */
function newPlan(x, y, rot, block, configX, configY){
    return {
        x: x,
        y: y,
        rot: rot,
        block: block,
        configX: (configX == null ? null : configX),
        configY: (configY == null ? null : configY)
    };
}

exports.newPlan = newPlan;

// ---------------------------------------------------------------- world bounds

function isWithinWorld(block, x, y){
    var halfLow = Math.floor((api.size(block) - 1) / 2);
    var halfHigh = Math.floor(api.size(block) / 2);
    return (x - halfLow) >= 0 && (y - halfLow) >= 0
        && (x + halfHigh) < api.worldW() && (y + halfHigh) < api.worldH();
}

exports.isWithinWorld = isWithinWorld;

// ---------------------------------------------------------------- placement

function canPlaceBlock(block, team, x, y, rot){
    if(!isWithinWorld(block, x, y)){
        debugLog("REJECT " + api.blockName(block) + " @ " + x + "," + y + " (out of world)");
        return false;
    }
    if(!api.validPlace(block, team, x, y, rot)){
        debugLog("REJECT " + api.blockName(block) + " @ " + x + "," + y + " (Build.validPlace)");
        return false;
    }
    return true;
}

exports.canPlaceBlock = canPlaceBlock;

function canPlacePlan(plan, team){
    return canPlaceBlock(plan.block, team, plan.x, plan.y, plan.rot);
}

exports.canPlacePlan = canPlacePlan;

/** Java: Util.getBlockRect - covers the full footprint in tile coordinates. */
function blockRect(x, y, block){
    var offset = Math.floor((api.size(block) - 1) / 2);
    return {x: x - offset, y: y - offset, w: api.size(block), h: api.size(block)};
}

/** Same as blockRect but with a pre-resolved block size (hot loops). */
function blockRectSized(x, y, size){
    var offset = Math.floor((size - 1) / 2);
    return {x: x - offset, y: y - offset, w: size, h: size};
}

exports.blockRect = blockRect;
exports.blockRectSized = blockRectSized;

/** Arc Rect.overlaps - exclusive edges. */
function rectsOverlap(a, b){
    return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

exports.rectsOverlap = rectsOverlap;

function footprintOverlapsPlanned(block, x, y, planned){
    var candidate = blockRect(x, y, block);
    for(var i = 0; i < planned.length; i++){
        var p = planned[i];
        if(rectsOverlap(candidate, blockRect(p.x, p.y, p.block))){
            debugLog("OVERLAP " + api.blockName(block) + " @ " + x + "," + y);
            return true;
        }
    }
    return false;
}

exports.footprintOverlapsPlanned = footprintOverlapsPlanned;

/** The single top-level gate: engine placement rules + no collision with already accepted plans. */
function canPlaceWithoutPlanCollision(plan, team, planned){
    if(!canPlacePlan(plan, team)) return false;
    return !footprintOverlapsPlanned(plan.block, plan.x, plan.y, planned);
}

exports.canPlaceWithoutPlanCollision = canPlaceWithoutPlanCollision;

// ---------------------------------------------------------------- plan occupancy

/**
 * Packed-cell occupancy for a set of plans. Collision tests against the whole plan list are
 * O(plans) each; the support/routing passes make thousands of them, which is what made a
 * large fill spend most of its time comparing rectangles. These three helpers make each test
 * and each insertion O(footprint).
 */
function occupancyOf(plans){
    var occ = {};
    for(var i = 0; i < plans.length; i++){
        markOccupancy(occ, plans[i].block, plans[i].x, plans[i].y, true);
    }
    return occ;
}

exports.occupancyOf = occupancyOf;

function markOccupancy(occ, block, x, y, on){
    var size = api.size(block);
    var offset = Math.floor((size - 1) / 2);
    var worldW = api.worldW();
    for(var cx = x - offset; cx < x - offset + size; cx++){
        for(var cy = y - offset; cy < y - offset + size; cy++){
            var key = cx + cy * worldW;
            if(on) occ[key] = true;
            else delete occ[key];
        }
    }
}

exports.markOccupancy = markOccupancy;

/** True when no cell of the block's footprint is taken in `occ`. */
function freeInOccupancy(occ, block, x, y){
    var size = api.size(block);
    var offset = Math.floor((size - 1) / 2);
    var worldW = api.worldW();
    for(var cx = x - offset; cx < x - offset + size; cx++){
        for(var cy = y - offset; cy < y - offset + size; cy++){
            if(occ[cx + cy * worldW] === true) return false;
        }
    }
    return true;
}

exports.freeInOccupancy = freeInOccupancy;

// ---------------------------------------------------------------- tile helpers

/** Java: Util.getNearbyTiles(x, y, block) and the (size1, size2) and (x, y, size) overloads. */
function nearbyTiles(x, y, size1, size2){
    if(size2 == null){
        var out = [];
        var edges = api.edges(size1);
        for(var i = 0; i < edges.length; i++){
            var t = api.tile(x + edges[i].x, y + edges[i].y);
            if(t != null) out.push(t);
        }
        return out;
    }

    var offset1 = (size1 % 2 === 1 && size2 % 2 === 0) ? 1 : 0;
    var offset2 = Math.floor((size2 * 2 - 1) / 2);
    return nearbyTiles(x - offset1, y - offset1, size1 + offset2);
}

exports.nearbyTiles = nearbyTiles;

/** Java: Util.getNearbyTiles(x, y, block) */
function nearbyTilesOfBlock(x, y, block){
    return nearbyTiles(x, y, api.size(block));
}

exports.nearbyTilesOfBlock = nearbyTilesOfBlock;

function containsTile(list, tile){
    var p = api.pos(tile);
    for(var i = 0; i < list.length; i++){
        if(api.pos(list[i]) === p) return true;
    }
    return false;
}

exports.containsTile = containsTile;

function indexOfTile(list, tile){
    var p = api.pos(tile);
    for(var i = 0; i < list.length; i++){
        if(api.pos(list[i]) === p) return i;
    }
    return -1;
}

exports.indexOfTile = indexOfTile;

// ---------------------------------------------------------------- ore counting

/**
 * Java: Util.countOre - counts mined drops of the drill's linked tiles and returns
 * {item: Item, count: int} for the winning item, or null when nothing can be mined.
 *
 * The selection replicates the Java comparator exactly:
 *   ascending by (!lowPriority), then ascending by count, then ascending by item id;
 *   the winner is the LAST element (Seq.peek()).
 */
function countOre(tile, drill){
    var counts = {};
    var items = {};
    var linked = api.linkedTiles(drill, tile);

    for(var i = 0; i < linked.length; i++){
        var other = linked[i];
        if(api.canMine(drill, other)){
            var item = api.getDrop(drill, other);
            if(item != null){
                var id = api.itemId(item);
                counts[id] = (counts[id] == null ? 0 : counts[id]) + 1;
                items[id] = item;
            }
        }
    }

    var ids = [];
    for(var key in counts) ids.push(key | 0);
    if(ids.length === 0) return null;

    ids.sort(function(a, b){
        var la = api.itemLowPriority(items[a]) ? 1 : 0;
        var lb = api.itemLowPriority(items[b]) ? 1 : 0;
        if(la !== lb) return la - lb;
        var ca = counts[a], cb = counts[b];
        if(ca !== cb) return ca - cb;
        return a - b;
    });

    var best = ids[ids.length - 1];
    return {item: items[best], count: counts[best]};
}

exports.countOre = countOre;

// ---------------------------------------------------------------- area expansion

/** Java: Util.expandArea - adds every tile in a (2*radius)x(2*radius) box around the set. */
function expandArea(tiles, radius){
    var seen = {};
    var i = null;
    for(i = 0; i < tiles.length; i++){
        seen[api.pos(tiles[i])] = true;
    }

    var expanded = [];
    for(i = 0; i < tiles.length; i++){
        // symmetric: the original used a half-open range, which only added the extra ring
        // on the -x/-y side (the drills could therefore overhang one row further there)
        for(var dx = -radius; dx <= radius; dx++){
            for(var dy = -radius; dy <= radius; dy++){
                if(dx === 0 && dy === 0) continue;
                var t = api.nearby(tiles[i], dx, dy);
                if(t == null) continue;
                var p = api.pos(t);
                if(seen[p] !== true){
                    seen[p] = true;
                    expanded.push(t);
                }
            }
        }
    }

    for(i = 0; i < expanded.length; i++) tiles.push(expanded[i]);
}

exports.expandArea = expandArea;

// ---------------------------------------------------------------- flood fill

/**
 * Java: Util.getConnectedTiles - breadth-first walk over tiles that can host a wall
 * (used as a buildability probe) and drop the same item as the source tile.
 * The frontier extends one tile past the patch edge.
 */
function getConnectedTiles(tile, maxTiles, teamOverride){
    api.trace("[util] flood fill start tile=" + api.tx(tile) + "," + api.ty(tile) + " max=" + maxTiles);

    var queue = [tile];
    var queueIndex = 0;
    var tiles = [];
    // 'seen' is set when a tile is enqueued: the buildability probe cannot change during a
    // fill, so probing a tile twice is pure waste (it used to happen a lot).
    var seen = {};

    var sourceItem = api.drop(tile);
    var sourceId = api.itemId(sourceItem);
    var team = teamOverride != null ? teamOverride : api.team();

    var copper = api.block("copperWall");
    var wall = api.environmentBuildable(copper) ? copper : api.block("berylliumWall");

    seen[api.pos(tile)] = true;

    var iterations = 0;

    while(queueIndex < queue.length && tiles.length < maxTiles){
        iterations++;
        if(DEBUG && (iterations % 500) === 0){
            debugLog("flood fill: iterations=" + iterations + " queue=" + queue.length + " tiles=" + tiles.length);
        }

        var current = queue[queueIndex++];

        if(!api.validPlace(wall, team, api.tx(current), api.ty(current), 0)){
            continue;
        }

        if(api.itemId(api.drop(current)) === sourceId){
            for(var x = -1; x <= 1; x++){
                for(var y = -1; y <= 1; y++){
                    if(x === 0 && y === 0) continue;
                    var neighbour = api.nearby(current, x, y);
                    if(neighbour == null) continue;
                    var neighbourPos = api.pos(neighbour);
                    if(seen[neighbourPos] !== true){
                        seen[neighbourPos] = true;
                        queue.push(neighbour);
                    }
                }
            }
            tiles.push(current);
        }
    }

    sortStable(tiles, function(t){
        return api.pos(t);
    });

    return tiles;
}

exports.getConnectedTiles = getConnectedTiles;

/**
 * Shortest path of tiles a block can be placed on, from `from` to any tile in `goals`.
 * Returns the path *excluding* the goal tile, or null when none is reachable.
 * Bounded by `budget` explored tiles; used for Erekir duct routing.
 */
function findDuctPath(from, goals, block, team, budget, blocked){
    var goalSet = {};
    var i = 0;
    for(i = 0; i < goals.length; i++){
        goalSet[api.pos(goals[i])] = true;
    }

    var startKey = api.pos(from);
    var cameFrom = {};        // packed pos -> parent packed pos (-1 for the start)
    var tileAt = {};          // packed pos -> tile (so the path can be rebuilt without scanning)
    var visited = {};
    var queue = [from];
    var queueIndex = 0;
    var explored = 0;

    visited[startKey] = true;
    cameFrom[startKey] = -1;
    tileAt[startKey] = from;

    while(queueIndex < queue.length && explored < budget){
        var current = queue[queueIndex++];
        explored++;

        if(goalSet[api.pos(current)] === true){
            var path = [];
            var key = api.pos(current);
            while(cameFrom[key] !== -1){
                path.push(tileAt[key]);
                key = cameFrom[key];
            }
            path.reverse();
            return path;
        }

        // cardinal steps only: ducts are one-way and leaving the run is what the layout wants
        for(i = 0; i < 4; i++){
            var neighbour = api.nearby(current, i === 0 ? 1 : (i === 1 ? -1 : 0), i === 2 ? 1 : (i === 3 ? -1 : 0));
            if(neighbour == null) continue;

            var nkey = api.pos(neighbour);
            if(visited[nkey] === true) continue;
            if(goalSet[nkey] !== true){
                if(blocked != null && blocked[nkey] === true) continue;
                if(!canPlaceBlock(block, team, api.tx(neighbour), api.ty(neighbour), 0)) continue;
            }

            visited[nkey] = true;
            cameFrom[nkey] = api.pos(current);
            tileAt[nkey] = neighbour;
            queue.push(neighbour);
        }
    }
    return null;
}

exports.findDuctPath = findDuctPath;

// ---------------------------------------------------------------- commit

var lastCommitted = [];
var refusedPlans = 0;

/** Counts a plan we wanted but the game's placement rules refused. */
function markRefused(){
    refusedPlans++;
}

/**
 * Reports how many wanted plans were refused, once per fill. The game silently refuses
 * anything outside the core build radius (or on blocked terrain), which is the usual reason
 * a player sees drills appear but no belts - the belts are simply rejected.
 */
function reportRefused(what){
    if(refusedPlans > 0){
        api.toast("[AutoDrill] " + refusedPlans + " " + what + " could not be placed (build range or blocked ground?)");
    }
    refusedPlans = 0;
}

exports.markRefused = markRefused;
exports.reportRefused = reportRefused;

/** Java: Util.commitPlans - submits plans to the player's build queue. */
function commitPlans(plans){
    var committed = [];
    for(var i = 0; i < plans.length; i++){
        var p = plans[i];
        var javaPlan = api.newPlan(p.x, p.y, p.rot, p.block, p.configX, p.configY);
        if(api.addPlan(javaPlan)){
            committed.push(javaPlan);
        }
    }
    lastCommitted = committed;
    debugLog("Committed " + committed.length + "/" + plans.length + " build plans.");
    return committed.length;
}

exports.lastCommitted = function(){
    return lastCommitted;
};

/** Removes the plans of the most recent fill from the player's queue. */
function undoLastCommitted(){
    var removed = 0;
    for(var i = 0; i < lastCommitted.length; i++){
        if(api.removePlan(lastCommitted[i])) removed++;
    }
    lastCommitted = [];
    return removed;
}

exports.undoLastCommitted = undoLastCommitted;

exports.commitPlans = commitPlans;

// ---------------------------------------------------------------- sorting helpers

/** Stable sort by numeric key (Java's Seq.sort is stable; Rhino's Array.sort is not guaranteed to be). */
function sortStable(items, keyFn){
    var decorated = new Array(items.length);
    for(var i = 0; i < items.length; i++){
        decorated[i] = {v: items[i], k: keyFn(items[i]), i: i};
    }

    decorated.sort(function(a, b){
        if(a.k < b.k) return -1;
        if(a.k > b.k) return 1;
        return a.i - b.i;
    });

    for(var j = 0; j < items.length; j++){
        items[j] = decorated[j].v;
    }
    return items;
}

exports.sortStable = sortStable;

/**
 * Arc's Seq.max(Floatf): the LAST element with the maximum value (comparison is >=).
 * Returns null for an empty list.
 */
function argMax(items, keyFn){
    var best = null, bestValue = -Infinity;
    for(var i = 0; i < items.length; i++){
        var value = keyFn(items[i]);
        if(value >= bestValue){
            bestValue = value;
            best = items[i];
        }
    }
    return best;
}

exports.argMax = argMax;

/** Arc's Seq.min(Floatf): the LAST element with the minimum value (comparison is <=). */
function argMin(items, keyFn){
    var best = null, bestValue = Infinity;
    for(var i = 0; i < items.length; i++){
        var value = keyFn(items[i]);
        if(value <= bestValue){
            bestValue = value;
            best = items[i];
        }
    }
    return best;
}

exports.argMin = argMin;

exports.setDebug = function(value){
    DEBUG = value;
};
