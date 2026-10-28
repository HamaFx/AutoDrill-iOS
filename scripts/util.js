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
        for(var dx = -radius; dx < radius; dx++){
            for(var dy = -radius; dy < radius; dy++){
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

// ---------------------------------------------------------------- commit

/** Java: Util.commitPlans - submits plans to the player's build queue. */
function commitPlans(plans){
    var committed = 0;
    for(var i = 0; i < plans.length; i++){
        var p = plans[i];
        if(api.addPlan(api.newPlan(p.x, p.y, p.rot, p.block, p.configX, p.configY))){
            committed++;
        }
    }
    debugLog("Committed " + committed + "/" + plans.length + " build plans.");
    return committed;
}

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
