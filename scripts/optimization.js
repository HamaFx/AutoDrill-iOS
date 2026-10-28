// AutoDrill (iOS) - optimization.js
// Port of autodrill/filler/OptimizationDrill.java: laser/airblast/impact/eruption layouts.
// The recursive search maximises the total ore covered by non-overlapping drills.
//
// iOS addition: the search runs under a wall-clock budget. The Java version runs to
// completion synchronously; on iOS (interpreted scripts) a monstrous patch could
// otherwise stall the game, so the search stops early and reports that it did.

"use strict";

var api = require("api");
var util = require("util");

var SEARCH_BUDGET_MS = 2000;
var CHECK_INTERVAL = 64;

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
    var withSupport = waterExtractorsAndPowerNodes !== false;

    var team = teamOverride != null ? teamOverride : api.team();
    var prefix = settingsPrefix(drill);
    var maxTiles = api.settingInt(prefix + "-drill-max-tiles", SETTING_DEFAULTS[prefix].tiles);
    var minOresPerDrill = api.settingInt(prefix + "-drill-min-ores", SETTING_DEFAULTS[prefix].ores);

    var tiles = util.getConnectedTiles(tile, maxTiles, teamOverride);
    util.expandArea(tiles, Math.floor(api.size(drill) / 2));

    var sourceDropId = api.itemId(api.drop(tile));

    var counts = {};   // tile pos -> {item, count}
    var i = null;
    for(i = 0; i < tiles.length; i++){
        counts[api.pos(tiles[i])] = util.countOre(tiles[i], drill);
    }

    // Pre-filter: right resource, enough ores, full footprint placeable.
    var filtered = [];
    for(i = 0; i < tiles.length; i++){
        var t = tiles[i];
        var ore = counts[api.pos(t)];
        if(ore == null || api.itemId(ore.item) !== sourceDropId || ore.count < minOresPerDrill) continue;
        if(!util.canPlaceBlock(drill, team, api.tx(t), api.ty(t), 0)) continue;
        filtered.push(t);
    }
    // Highest yield first; ties keep flood-fill order (Java's sort is stable).
    util.sortStable(filtered, function(t2){
        return -counts[api.pos(t2)].count;
    });

    // Flatten everything the search needs into plain JS entries so the hot loop
    // performs no Java calls at all (this is the one place iOS script speed matters).
    var size = api.size(drill);
    var entries = [];
    for(i = 0; i < filtered.length; i++){
        var entryTile = filtered[i];
        entries.push({
            tile: entryTile,
            rect: util.blockRectSized(api.tx(entryTile), api.ty(entryTile), size),
            count: counts[api.pos(entryTile)].count
        });
    }

    var quality = api.settingInt(KEY_QUALITY, 2);
    var maxTries = quality * 1000;

    var context = {
        drill: drill,
        maxTries: maxTries,
        deadline: api.now() + SEARCH_BUDGET_MS,
        aborted: false,
        checks: 0
    };

    var selection = [];
    recursiveMaxSearch(context, entries, selection, [], 0, [], 0);

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

/**
 * Java: OptimizationDrill.recursiveMaxSearch.
 *
 * `selection` is mutated in place to hold the best branch found, exactly like the
 * Java Seq that is passed down and cleared/refilled on return.
 */
function recursiveMaxSearch(context, entries, selection, rects, sum, triesPerLevel, level){
    var max = sum;
    var maxSelection = selection.slice();

    if(triesPerLevel.length < level + 1){
        triesPerLevel[level] = 0;
    }

    // Java: maxTries / Math.pow(2, level + 1) - computed once, as in the original.
    var limit = context.maxTries / Math.pow(2, level + 1);

    for(var i = 0; i < entries.length; i++){
        if(context.aborted) break;

        context.checks++;
        if((context.checks % CHECK_INTERVAL) === 0 && api.now() > context.deadline){
            context.aborted = true;
            break;
        }

        var entry = entries[i];
        var rect = entry.rect;

        var overlaps = false;
        for(var j = 0; j < rects.length; j++){
            if(util.rectsOverlap(rects[j], rect)){
                overlaps = true;
                break;
            }
        }
        if(overlaps) continue;

        var newSum = sum + entry.count;
        var newSelection = selection.slice();
        newSelection.push(entry);
        var newRects = rects.slice();
        newRects.push(rect);

        var newMax = recursiveMaxSearch(context, entries, newSelection, newRects, newSum, triesPerLevel, level + 1);

        if(newMax > max){
            max = newMax;
            maxSelection = newSelection.slice();
        }

        triesPerLevel[level] = triesPerLevel[level] + 1;
        if(triesPerLevel[level] >= limit){
            break;
        }
    }

    selection.length = 0;
    for(var k = 0; k < maxSelection.length; k++){
        selection.push(maxSelection[k]);
    }

    return max;
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
