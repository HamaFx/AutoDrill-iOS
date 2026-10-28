// AutoDrill (iOS) - optimization.js
// Port of autodrill/filler/OptimizationDrill.java: laser/airblast/impact/eruption layouts.
//
// The search maximises the ore actually mined by the placed drills:
//   * marginal gain - a tile mined by two drills counts once
//   * canonical order - each set of drills is explored once, not once per permutation
//   * an optimistic bound prunes branches that cannot beat the current best
//   * a quality budget (placements) plus a wall-clock backstop
//   * the search is resumable, so the UI can run it across frames with a progress bar and a
//     cancel button; the plain `fill` runs it in one go for tests and tools
//
// Placement rules (which ore a drill must cover, minimum ores, footprint validity) are
// unchanged from the Java original. Counting reproduces the original winner-item rule
// (including its low-priority tie-break) but computes it in plain JavaScript.

"use strict";

var api = require("api");
var util = require("util");

var SEARCH_BUDGET_MS = 3000;
var STEP_WORK = 12000;           // candidate visits per frame in the chunked path
var MAX_PLACEMENTS_SAFETY = 4;   // × the quality budget: an absolute ceiling
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
var KEY_ROUTE = "auto-drill-ios-output-routing-length";

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

/** Erekir drills feed ducts; Serpulo drills feed conveyors. */
function isErekirDrill(drill){
    var id = api.blockId(drill);
    return id === api.blockId(api.block("impactDrill")) || id === api.blockId(api.block("eruptionDrill"));
}

// ---------------------------------------------------------------------------- prepare

/**
 * Everything that needs the world: patch discovery, per-tile facts and the candidate list.
 * Returns a job object that `searchStep` can run in slices and `finish` can complete.
 */
function prepare(tile, drill, withSupport, teamOverride, direction, routeLength){
    var team = teamOverride != null ? teamOverride : api.team();

    var prefix = settingsPrefix(drill);
    var maxTiles = api.settingInt(prefix + "-drill-max-tiles", SETTING_DEFAULTS[prefix].tiles);
    var minOresPerDrill = api.settingInt(prefix + "-drill-min-ores", SETTING_DEFAULTS[prefix].ores);

    var tiles = util.getConnectedTiles(tile, maxTiles, teamOverride);
    var size = api.size(drill);
    var half = Math.floor((size - 1) / 2);
    util.expandArea(tiles, Math.floor(size / 2));

    var sourceDropId = api.itemId(api.drop(tile));

    var worldW = api.worldW();
    var cellFacts = {};      // key(x,y) -> {canMine, dropId, mineable}
    var lowPriority = {};    // dropId -> boolean
    var targetCells = 0;     // ore cells this fill is about
    var i = 0;

    for(i = 0; i < tiles.length; i++){
        var t = tiles[i];
        var item = api.getDrop(drill, t);
        var itemId = api.itemId(item);
        if(lowPriority[itemId] === undefined) lowPriority[itemId] = api.itemLowPriority(item);

        var canMine = api.canMine(drill, t);
        var mineable = canMine && itemId === sourceDropId;
        if(mineable) targetCells++;
        cellFacts[api.tx(t) + api.ty(t) * worldW] = {
            canMine: canMine,
            dropId: itemId,
            mineable: mineable
        };
    }

    debugLog("stage: patch tiles=" + tiles.length + " size=" + size + " sourceDrop=" + sourceDropId);

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

    var suffix = new Array(candidates.length + 1);
    suffix[candidates.length] = 0;
    for(i = candidates.length - 1; i >= 0; i--){
        suffix[i] = suffix[i + 1] + candidates[i].winnerCount;
    }

    debugLog("stage: candidates=" + candidates.length);

    var quality = api.settingInt(KEY_QUALITY, 2);

    return {
        drill: drill,
        team: team,
        withSupport: withSupport !== false,
        direction: direction == null ? null : direction,
        routeLength: routeLength == null ? 0 : routeLength,

        entries: candidates,
        suffix: suffix,
        targetCells: targetCells,

        occ: {},          // footprint cell -> number of placed drills covering it
        covered: {},      // mined cell -> number of placed drills mining it
        path: [],
        frames: [],
        result: {score: 0, selection: null},
        done: false,

        maxTries: quality * 1000,
        placements: 0,
        checks: 0,
        exhausted: false,
        aborted: false,
        cancelled: false,
        deadline: api.now() + SEARCH_BUDGET_MS
    };
}

// ---------------------------------------------------------------------------- search

function newFrame(index, score){
    return {index: index, score: score, best: score, bestSelection: null,
        child: null, childEntry: null, childActive: false};
}

/**
 * Runs the depth-first search for at most `work` candidate visits and returns true when the
 * whole search has finished. State lives in the job, so it can be resumed on a later frame -
 * that is what keeps a big layout from freezing the game.
 */
function searchStep(job, work){
    var entries = job.entries;
    var path = job.path;
    var visited = 0;

    if(job.frames.length === 0 && !job.done){
        job.frames.push(newFrame(0, 0));
    }

    while(job.frames.length > 0 && visited < work){
        var frame = job.frames[job.frames.length - 1];

        // ---- a child finished: fold its result in, then undo its placement ----
        if(frame.childActive){
            frame.childActive = false;
            if(frame.child.best > frame.best){
                frame.best = frame.child.best;
                // child.bestSelection is null when the child's best is exactly the path it was
                // given - which at this moment still includes the child's own entry
                frame.bestSelection = frame.child.bestSelection != null
                    ? frame.child.bestSelection
                    : path.slice();
            }
            unplace(job, frame.childEntry);
            path.pop();
            continue;
        }

        // ---- this node is done: report upward ----
        if(frame.index >= entries.length || job.aborted || job.exhausted || job.cancelled){
            job.frames.pop();
            if(job.frames.length === 0){
                job.result = {score: frame.best, selection: frame.bestSelection};
                job.done = true;
                break;
            }
            var parent = job.frames[job.frames.length - 1];
            parent.child = frame;
            parent.childActive = true;
            continue;
        }

        // ---- advance this node ----
        visited++;
        job.checks++;
        if((job.checks % 64) === 0 && api.now() > job.deadline){
            job.aborted = true;
            continue;
        }

        var i = frame.index;

        // even at full value, everything left together cannot beat the best so far
        if(frame.score + job.suffix[i] <= frame.best){
            frame.index = entries.length;
            continue;
        }

        var entry = entries[i];
        frame.index = i + 1;

        if(!free(job.occ, entry)) continue;

        if(job.placements >= job.maxTries || job.placements >= job.maxTries * MAX_PLACEMENTS_SAFETY){
            job.exhausted = true;
            continue;
        }
        job.placements++;

        var gain = place(job, entry);
        path.push(entry);

        frame.childEntry = entry;
        job.frames.push(newFrame(i + 1, frame.score + gain));
    }

    return job.done;
}

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
function place(job, entry){
    var i = 0, key = 0, gain = 0;
    var keys = entry.cellKeys;

    for(i = 0; i < keys.length; i++){
        key = keys[i];
        job.occ[key] = (job.occ[key] === undefined ? 0 : job.occ[key]) + 1;
    }

    keys = entry.mineableKeys;
    for(i = 0; i < keys.length; i++){
        key = keys[i];
        var covered = job.covered[key];
        if(covered === undefined || covered === 0) gain++;
        job.covered[key] = (covered === undefined ? 0 : covered) + 1;
    }

    return gain;
}

/** Exact inverse of place(). */
function unplace(job, entry){
    var i = 0, key = 0;
    var keys = entry.cellKeys;

    for(i = 0; i < keys.length; i++){
        key = keys[i];
        job.occ[key] = (job.occ[key] === undefined ? 0 : job.occ[key]) - 1;
    }

    keys = entry.mineableKeys;
    for(i = 0; i < keys.length; i++){
        key = keys[i];
        job.covered[key] = (job.covered[key] === undefined ? 0 : job.covered[key]) - 1;
    }
}

// ---------------------------------------------------------------------------- finish

function finish(job){
    var selection = job.result.selection == null ? [] : job.result.selection;
    var team = job.team;
    var i = 0;

    var allPlans = [];
    for(i = 0; i < selection.length; i++){
        var chosen = selection[i].tile;
        var plan = util.newPlan(api.tx(chosen), api.ty(chosen), 0, job.drill);
        if(util.canPlaceWithoutPlanCollision(plan, team, allPlans)){
            allPlans.push(plan);
        }
    }

    if(job.withSupport && api.settingBool(KEY_SUPPORT, true)){
        placeWaterExtractorsAndPowerNodes(selection, job.drill, team, allPlans);
    }

    var routed = routeOutputs(job, allPlans);

    // ---- feedback ----
    if(job.cancelled){
        api.toast("[AutoDrill] planning cancelled");
    }else{
        if(job.exhausted){
            api.toast("[AutoDrill] quality limit reached (" + job.placements + " layouts explored) - raise Optimization Quality for better results");
        }else if(job.aborted){
            api.toast("[AutoDrill] search stopped after " + SEARCH_BUDGET_MS + " ms - lower Optimization Quality for faster results");
        }

        if(allPlans.length === 0 && job.entries.length > 0){
            api.toast("[AutoDrill] nothing could be placed here - is this inside your build range?");
        }else{
            var covered = 0;
            for(var key in job.covered){
                if(job.covered[key] > 0) covered++;
            }
            if(allPlans.length > 0 && covered < job.targetCells){
                api.toast("[AutoDrill] mined " + covered + " of " + job.targetCells + " ore tiles here"
                    + (routed > 0 ? " (incl. " + routed + " routing tiles)" : ""));
            }
        }
    }

    debugLog("patch=" + job.entries.length + " candidates=" + job.entries.length
        + " selected=" + selection.length + " score=" + job.result.score
        + " placements=" + job.placements + " checks=" + job.checks
        + " plans=" + allPlans.length
        + " stopped=" + (job.cancelled ? "cancel" : (job.aborted ? "time" : (job.exhausted ? "budget" : "no"))));

    util.commitPlans(allPlans);
    return allPlans;
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

        // Among the valid spots, take the one with the most ground water: the extractor's
        // output depends on that attribute, and the original took whatever came first.
        var best = null, bestWater = -1e9;
        for(j = 0; j < nearby.length; j++){
            var plan = util.newPlan(api.tx(nearby[j]), api.ty(nearby[j]), 0, waterExtractor);
            if(!util.canPlaceWithoutPlanCollision(plan, team, allPlans)) continue;
            var water = api.waterAt(nearby[j]);
            if(water > bestWater){
                bestWater = water;
                best = plan;
            }
        }
        if(best != null) allPlans.push(best);
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

/**
 * Optional output routing: a straight run of conveyors (or ducts on Erekir) leading away
 * from every optimised drill, so the player does not have to place transport by hand.
 * Length 0 disables it. The Java mod never placed transport for these drills at all.
 */
function routeOutputs(job, allPlans){
    if(job.direction == null || job.routeLength <= 0) return 0;

    var block = isErekirDrill(job.drill) ? api.block("duct") : api.block("conveyor");
    var half = Math.floor(api.size(job.drill) / 2);
    var placed = 0;
    var i = 0, step = 0;

    for(i = 0; i < allPlans.length; i++){
        var drillPlan = allPlans[i];
        if(api.blockId(drillPlan.block) !== api.blockId(job.drill)) continue;

        var x = drillPlan.x + job.direction.x * (half + 1);
        var y = drillPlan.y + job.direction.y * (half + 1);

        for(step = 0; step < job.routeLength; step++){
            var plan = util.newPlan(x, y, job.direction.r, block);
            if(!util.canPlaceWithoutPlanCollision(plan, job.team, allPlans)) break;
            allPlans.push(plan);
            placed++;
            x += job.direction.x;
            y += job.direction.y;
        }
    }
    return placed;
}

// ---------------------------------------------------------------------------- entry points

/** Synchronous fill (tests, tools, and anything that wants the result immediately). */
function fill(tile, drill, waterExtractorsAndPowerNodes, teamOverride, direction, routeLength){
    var job = prepare(tile, drill, waterExtractorsAndPowerNodes, teamOverride, direction,
        routeLength == null ? api.settingInt(KEY_ROUTE, 0) : routeLength);
    while(!searchStep(job, Infinity)){
        // run to completion
    }
    return finish(job);
}

exports.fill = fill;

/**
 * Chunked fill: runs the search across frames with a progress bar and a cancel button, then
 * calls onDone(plans). Used by the UI so a large patch never freezes the game.
 */
exports.fillAsync = function(tile, drill, waterExtractorsAndPowerNodes, teamOverride, direction, routeLength, onDone){
    var job = prepare(tile, drill, waterExtractorsAndPowerNodes, teamOverride, direction,
        routeLength == null ? api.settingInt(KEY_ROUTE, 0) : routeLength);

    if(job.entries.length === 0 || job.maxTries <= 0){
        onDone(finish(job));
        return;
    }

    api.showProgress("[accent]AutoDrill[] planning...");
    api.setProgressCancel(function(){
        job.cancelled = true;
    });

    function step(){
        var done = searchStep(job, STEP_WORK);
        api.setProgress(Math.min(0.95, job.placements / job.maxTries));

        if(done || job.cancelled){
            api.hideProgress();
            onDone(finish(job));
            return;
        }
        api.postStep(step);
    }

    api.postStep(step);
};
