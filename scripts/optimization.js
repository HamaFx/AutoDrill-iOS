// AutoDrill (iOS) - optimization.js
// Port of autodrill/filler/OptimizationDrill.java: laser/airblast/impact/eruption layouts.
//
// The search maximises the ore actually mined by the placed drills. Compared with the
// original algorithm it changes three things, all of them performance or quality of the
// *search*, not of the placement rules:
//
//  1. Marginal gain instead of per-drill sums: a tile mined by two drills used to be
//     counted twice, so the search could prefer layouts that mine the same tile twice.
//  2. Canonical order: only drills after the last placed one are considered, so each set of
//     drills is explored once instead of once per permutation.
//  3. An optimistic bound (every remaining candidate at full value) prunes branches that
//     cannot beat what the node has already found.
//
// Placement rules (which ore a drill must cover, minimum ores, footprint validity) are
// unchanged. The search still runs under a wall-clock budget and the same "quality" knob.
//
// Note on counting: the winner-item rule of the original `Util.countOre` (including its
// low-priority tie-break) is reproduced exactly here, but it is now computed in plain
// JavaScript from pre-read tile facts instead of one Java call per linked tile.

"use strict";

var api = require("api");
var util = require("util");

var SEARCH_BUDGET_MS = 2000;
var CHECK_INTERVAL = 64;
var MAX_PLACEMENTS_SAFETY = 4;   // x maxTries: absolute ceiling so a search can never run away
var DEBUG = false;

exports.setDebug = function(value){
    DEBUG = value;
};

function debugLog(msg){
    if(DEBUG){
        api.log("[optimization] " + msg);
        api.trace("[optimization] " + msg);
    }
}

var SETTING_DEFAULTS = {
    mechanical: {tiles: 200, ores: 1},
    pneumatic: {tiles: 150, ores: 2},
    laser: {tiles: 100, ores: 5},
    airblast: {tiles: 100, ores: 9}
};

var KEY_QUALITY = "auto-drill-ios-optimization-quality";
var KEY_SUPPORT = "auto-drill-ios-place-water-extractor-and-power-nodes";

/** Java: OptimizationDrill.getDrillSettingsPrefix */
function settingsPrefix(drill){
    var id = api.blockId(drill);
    if(id === api.blockId(api.block("mechanicalDrill"))) return "mechanical";
    if(id === api.blockId(api.block("pneumaticDrill"))) return "pneumatic";
    if(id === api.blockId(api.block("laserDrill"))) return "laser";
    if(id === api.blockId(api.block("blastDrill"))) return "airblast";
    return "airblast"; // impact and eruption drills share the airblast settings
}

exports.settingsPrefix = settingsPrefix;

/** Java: OptimizationDrill.fill(tile, drill[, waterExtractorsAndPowerNodes]) */
function fill(tile, drill, waterExtractorsAndPowerNodes, teamOverride){
    api.trace("[optimization] fill start drill=" + api.blockName(drill)
        + " tile=" + api.tx(tile) + "," + api.ty(tile));

    var withSupport = waterExtractorsAndPowerNodes !== false;
    var team = teamOverride != null ? teamOverride : api.team();

    var prefix = settingsPrefix(drill);
    var maxTiles = api.settingInt(prefix + "-drill-max-tiles", SETTING_DEFAULTS[prefix].tiles);
    var minOresPerDrill = api.settingInt(prefix + "-drill-min-ores", SETTING_DEFAULTS[prefix].ores);

    var tiles = util.getConnectedTiles(tile, maxTiles, teamOverride);
    var size = api.size(drill);
    var half = Math.floor((size - 1) / 2);
    util.expandArea(tiles, Math.floor(size / 2));

    var sourceDropId = api.itemId(api.drop(tile));
    debugLog("stage: patch tiles=" + tiles.length + " size=" + size + " sourceDrop=" + sourceDropId);

    // ------------------------------------------------------------------ tile facts
    // Every Java call happens here, once per patch tile: the search itself is pure JS.
    var worldW = api.worldW();
    var cellFacts = {};      // key(x,y) -> {canMine, dropId, mineable}
    var lowPriority = {};    // dropId -> boolean
    var i = 0;

    for(i = 0; i < tiles.length; i++){
        var t = tiles[i];
        var item = api.getDrop(drill, t);
        var itemId = api.itemId(item);
        if(lowPriority[itemId] === undefined) lowPriority[itemId] = api.itemLowPriority(item);

        var canMine = api.canMine(drill, t);
        cellFacts[api.tx(t) + api.ty(t) * worldW] = {
            canMine: canMine,
            dropId: itemId,
            mineable: canMine && itemId === sourceDropId
        };
    }

    debugLog("stage: cell facts=" + tiles.length);

    // ------------------------------------------------------------------ candidates
    // NOTE: this pass is deliberately inlined instead of calling a helper that returns an
    // object. The interpreted Rhino engine iOS uses does not return from such a helper when
    // it is called in this loop (reproduced: the loop never advances and the heap grows
    // until OutOfMemory). Inlining also removes a pass over the patch.
    var candidates = [];
    for(i = 0; i < tiles.length; i++){
        var cand = tiles[i];
        var cx0 = api.tx(cand) - half, cy0 = api.ty(cand) - half;

        var cellKeys = [];       // every footprint cell - identical to the original rect test
        var mineableKeys = [];   // footprint cells holding the ore this fill is about
        var counts = {};         // dropId -> {count, lowPriority}
        var minedCells = 0;
        var ci = 0, cj = 0, ckey = 0;

        for(ci = 0; ci < size; ci++){
            for(cj = 0; cj < size; cj++){
                ckey = (cx0 + ci) + (cy0 + cj) * worldW;
                cellKeys.push(ckey);

                var fact = cellFacts[ckey];
                if(fact === undefined || !fact.canMine) continue;

                minedCells++;
                var count = counts[fact.dropId];
                if(count === undefined){
                    count = {count: 0, lowPriority: lowPriority[fact.dropId] === true};
                    counts[fact.dropId] = count;
                }
                count.count++;
                if(fact.mineable) mineableKeys.push(ckey);
            }
        }
        if(minedCells === 0) continue;

        // Same ordering as the original comparator: (!lowPriority) asc, count asc, id asc -
        // the winner is the last element.
        var ids = [];
        for(var id in counts) ids.push(id | 0);
        ids.sort(function(a, b){
            var la = counts[a].lowPriority ? 1 : 0;
            var lb = counts[b].lowPriority ? 1 : 0;
            if(la !== lb) return la - lb;
            if(counts[a].count !== counts[b].count) return counts[a].count - counts[b].count;
            return a - b;
        });

        var winner = ids[ids.length - 1];
        if(winner !== sourceDropId || counts[winner].count < minOresPerDrill) continue;
        if(!util.canPlaceBlock(drill, team, api.tx(cand), api.ty(cand), 0)) continue;

        candidates.push({
            tile: cand,
            cellKeys: cellKeys,
            mineableKeys: mineableKeys,
            winnerId: winner,
            winnerCount: counts[winner].count
        });
    }
    // Highest yield first; ties keep flood-fill order (Java's sort is stable).
    util.sortStable(candidates, function(e){
        return -e.winnerCount;
    });

    debugLog("stage: candidates=" + candidates.length);

    // suffix[i] = sum of the yields of all candidates from i on: an optimistic bound on the
    // gain still reachable, used to prune branches that cannot beat the current best.
    var suffix = new Array(candidates.length + 1);
    suffix[candidates.length] = 0;
    for(i = candidates.length - 1; i >= 0; i--){
        suffix[i] = suffix[i + 1] + candidates[i].winnerCount;
    }

    var quality = api.settingInt(KEY_QUALITY, 2);
    var started = api.now();
    var context = {
        // Quality buys a number of *explored placements*, not "tries per depth level": with
        // canonical ordering every placement explores a set no sibling will visit again, so
        // a single budget is both simpler and strictly more useful than the old decay.
        maxTries: quality * 1000,
        placements: 0,
        checks: 0,
        exhausted: false,
        deadline: api.now() + SEARCH_BUDGET_MS,
        aborted: false,
        occ: {},          // footprint cell -> number of placed drills covering it
        covered: {},      // mined cell -> number of placed drills mining it
        suffix: suffix
    };

    var path = [];
    var result = search(context, candidates, 0, path, 0);
    var selection = result.selection == null ? [] : result.selection;

    debugLog("patch=" + tiles.length + " candidates=" + candidates.length
        + " selected=" + selection.length + " score=" + result.score
        + " placements=" + context.placements + " checks=" + context.checks
        + " ms=" + (api.now() - started)
        + " stopped=" + (context.aborted ? "time" : (context.exhausted ? "budget" : "no")));

    if(context.aborted){
        api.toast("[AutoDrill] search stopped after " + SEARCH_BUDGET_MS + " ms - lower Optimization Quality for faster results");
    }

    var allPlans = [];
    for(i = 0; i < selection.length; i++){
        var chosen = selection[i].tile;
        var plan = util.newPlan(api.tx(chosen), api.ty(chosen), 0, drill);
        if(util.canPlaceWithoutPlanCollision(plan, team, allPlans)){
            allPlans.push(plan);
        }
    }

    if(withSupport && api.settingBool(KEY_SUPPORT, true)){
        placeWaterExtractorsAndPowerNodes(selection, drill, team, allPlans);
    }

    util.commitPlans(allPlans);
    return allPlans;
}

exports.fill = fill;

/** True when no placed drill already occupies any of the entry's footprint cells. */
function free(occ, entry){
    var keys = entry.cellKeys;
    for(var i = 0; i < keys.length; i++){
        var occupied = occ[keys[i]];
        if(occupied !== undefined && occupied > 0) return false;
    }
    return true;
}

/** Occupies the footprint and returns the number of newly mined ore cells (marginal gain). */
function place(context, entry){
    var i = 0, key = 0, gain = 0;
    var keys = entry.cellKeys;

    for(i = 0; i < keys.length; i++){
        key = keys[i];
        context.occ[key] = (context.occ[key] === undefined ? 0 : context.occ[key]) + 1;
    }

    keys = entry.mineableKeys;
    for(i = 0; i < keys.length; i++){
        key = keys[i];
        var covered = context.covered[key];
        if(covered === undefined || covered === 0) gain++;
        context.covered[key] = (covered === undefined ? 0 : covered) + 1;
    }

    return gain;
}

/** Exact inverse of place(). */
function unplace(context, entry){
    var i = 0, key = 0;
    var keys = entry.cellKeys;

    for(i = 0; i < keys.length; i++){
        key = keys[i];
        context.occ[key] = (context.occ[key] === undefined ? 0 : context.occ[key]) - 1;
    }

    keys = entry.mineableKeys;
    for(i = 0; i < keys.length; i++){
        key = keys[i];
        context.covered[key] = (context.covered[key] === undefined ? 0 : context.covered[key]) - 1;
    }
}

/**
 * Depth-first search over sets of drills.
 *
 * `path` is the shared selection of the current branch and is restored on the way out;
 * nothing is copied unless a branch improves on the best score seen so far. The returned
 * `selection` is null when the best result is exactly the path the caller passed in.
 */
function search(context, entries, index, path, pathScore){
    // best starts at the caller's score: bestSelection stays null unless a branch improves
    // on it, which is what makes the copy-on-improvement optimisation correct.
    var best = pathScore;
    var bestSelection = null;

    for(var i = index; i < entries.length; i++){
        if(context.aborted || context.exhausted) break;

        context.checks++;
        if((context.checks % CHECK_INTERVAL) === 0 && api.now() > context.deadline){
            context.aborted = true;
            break;
        }

        // even at full value, everything left together cannot beat the best so far
        if(pathScore + context.suffix[i] <= best) break;

        if(DEBUG && (context.checks % 20000) === 0){
            debugLog("search: checks=" + context.checks + " placements=" + context.placements + " depth=" + path.length);
        }

        var entry = entries[i];
        if(!free(context.occ, entry)) continue;

        if(context.placements >= context.maxTries
            || context.placements >= context.maxTries * MAX_PLACEMENTS_SAFETY){
            context.exhausted = true;
            break;
        }
        context.placements++;

        var gain = place(context, entry);
        path.push(entry);
        var child = search(context, entries, i + 1, path, pathScore + gain);

        if(child.score > best){
            best = child.score;
            bestSelection = child.selection != null ? child.selection : path.slice();
        }

        path.pop();
        unplace(context, entry);
    }

    return {score: best, selection: bestSelection};
}

/** Java: OptimizationDrill.placeWaterExtractorsAndPowerNodes */
function placeWaterExtractorsAndPowerNodes(selection, drill, team, allPlans){
    var waterExtractor = api.block("waterExtractor");
    var powerNode = api.block("powerNode");
    var drillSize = api.size(drill);
    var i = 0, j = 0;

    for(i = 0; i < selection.length; i++){
        var tile = selection[i].tile;
        var nearby = util.nearbyTiles(api.tx(tile), api.ty(tile), drillSize, api.size(waterExtractor));
        for(j = 0; j < nearby.length; j++){
            var plan = util.newPlan(api.tx(nearby[j]), api.ty(nearby[j]), 0, waterExtractor);
            if(util.canPlaceWithoutPlanCollision(plan, team, allPlans)){
                allPlans.push(plan);
                break;
            }
        }
    }

    for(i = 0; i < selection.length; i++){
        var tile2 = selection[i].tile;
        var nearby2 = util.nearbyTiles(api.tx(tile2), api.ty(tile2), drillSize, api.size(powerNode));
        for(j = 0; j < nearby2.length; j++){
            var plan2 = util.newPlan(api.tx(nearby2[j]), api.ty(nearby2[j]), 0, powerNode);
            if(util.canPlaceWithoutPlanCollision(plan2, team, allPlans)){
                allPlans.push(plan2);
                break;
            }
        }
    }
}
