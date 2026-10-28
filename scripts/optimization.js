// AutoDrill (iOS) - optimization.js
// Port of autodrill/filler/OptimizationDrill.java: laser/airblast/impact/eruption layouts.
//
// What is maximised: the ore actually mined. Mindustry pays a drill out in proportion to the
// ore tiles of its dominant item under it (Drill.DrillBuild.updateTile scales progress by
// `dominantItems`), so "ore tiles covered" is throughput - and covering one tile with two
// drills is impossible anyway, because footprints may not overlap.
//
// Three layouts compete, the best score wins:
//   1. lattice seed - candidates whose centre is congruent modulo the drill size never
//      overlap each other, so each of the size*size translations is a perfect tiling. The
//      best translation is usually a near-perfect cover of a round patch, and it costs one
//      pass over the candidates.
//   2. branch-and-bound search - canonical order, marginal-gain scoring, optimistic bound,
//      quality budget, wall-clock backstop. Wins on irregular patches, where a free-form
//      layout beats a lattice.
//   3. gap filler - after either layout, keep adding any still-free candidate that mines an
//      ore tile nothing mines yet. This is what guarantees "no ore tile is left behind that
//      one more drill could reach", and it repairs a layout whose search ran out of budget.
//
// Both the patch scan and the search are resumable, so the UI can run them across frames
// with a progress bar and a cancel button; `fill` runs them in one go for tests and tools.
//
// Placement rules (which ore a drill must cover, minimum ores, footprint validity) are
// unchanged from the Java original. Counting reproduces the original winner-item rule
// (including its low-priority tie-break) but computes it in plain JavaScript.

"use strict";

var api = require("api");
var util = require("util");

var SEARCH_BUDGET_MS = 3000;
var STEP_WORK = 12000;           // candidate visits per frame in the chunked path
var SCAN_WORK = 3000;            // patch tiles per frame while scanning in the chunked path
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

// Patch-size defaults are safety limits, not "how much ore to bother with": ore patches are
// routinely several hundred tiles, and a limit below that silently fills only the part nearest
// the tap. The search itself is bounded by the quality budget and the wall clock instead.
var SETTING_DEFAULTS = {
    mechanical: {tiles: 2500, ores: 1},
    pneumatic: {tiles: 2500, ores: 1},
    laser: {tiles: 2500, ores: 2},
    airblast: {tiles: 2500, ores: 2}
};

/** Shared with the bridge/wall fillers so the four defaults exist in exactly one place. */
exports.settingDefaults = SETTING_DEFAULTS;

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

// ---------------------------------------------------------------------------- job

var PHASE_TILES = 0, PHASE_FACTS = 1, PHASE_CANDIDATES = 2, PHASE_SETUP = 3, PHASE_READY = 4;

/** Everything that needs the world, collected across as many calls as the caller wants. */
function newJob(tile, drill, withSupport, teamOverride, direction, routeLength){
    var team = teamOverride != null ? teamOverride : api.team();
    var prefix = settingsPrefix(drill);
    var size = api.size(drill);

    return {
        // ---- inputs ----
        startTile: tile,
        drill: drill,
        team: team,
        withSupport: withSupport !== false,
        direction: direction == null ? null : direction,
        routeLength: routeLength == null ? 0 : routeLength,

        // ---- settings, read once ----
        prefix: prefix,
        size: size,
        half: Math.floor((size - 1) / 2),
        worldW: api.worldW(),
        maxTiles: api.settingInt(prefix + "-drill-max-tiles", SETTING_DEFAULTS[prefix].tiles),
        minOres: api.settingInt(prefix + "-drill-min-ores", SETTING_DEFAULTS[prefix].ores),
        quality: api.settingInt(KEY_QUALITY, 2),

        // ---- patch scan (resumable) ----
        phase: PHASE_TILES,
        tiles: null,
        tileIndex: 0,
        truncated: false,       // flood fill hit Max Tiles: part of the patch is unseen
        sourceDropId: -1,
        targetCells: 0,         // ore tiles this drill can mine, inside the seen patch
        cellFacts: {},          // key(x,y) -> {canMine, dropId, mineable}
        lowPriority: {},        // dropId -> boolean
        candidates: [],
        coverable: 0,           // ore tiles at least one candidate could mine

        // ---- search ----
        entries: [],
        suffix: [],
        occ: {},                // footprint cell -> placed count
        covered: {},            // mined cell -> placed count (search scratch only)
        path: [],
        frames: [],
        result: {score: 0, selection: null},
        done: false,
        maxTries: 0,
        placements: 0,
        checks: 0,
        exhausted: false,
        aborted: false,
        cancelled: false,
        deadline: 0,

        // ---- outcome, filled in by finish() ----
        stats: {source: "none", covered: 0, target: 0, unreachable: 0, blocked: 0, drills: 0, plans: 0,
            candidates: 0, truncated: false, stopped: "no"}
    };
}

/** Phase 0: the flood fill (one tile past the limit, so truncation is detectable). */
function scanTiles(job){
    var tiles = util.getConnectedTiles(job.startTile, job.maxTiles + 1, job.team);

    job.truncated = tiles.length > job.maxTiles;
    if(job.truncated) tiles.length = job.maxTiles;
    util.expandArea(tiles, Math.floor(job.size / 2));

    job.tiles = tiles;
    job.sourceDropId = api.itemId(api.drop(job.startTile));
    job.tileIndex = 0;
    job.phase = PHASE_FACTS;

    debugLog("stage: patch tiles=" + tiles.length + " size=" + job.size
        + " truncated=" + job.truncated + " sourceDrop=" + job.sourceDropId);
}

/** Phase 1: per-tile facts (what this drill can mine there). */
function scanFacts(job, work){
    var tiles = job.tiles;
    var worldW = job.worldW;
    var drill = job.drill;
    var lowPriority = job.lowPriority;
    var cellFacts = job.cellFacts;
    var i = job.tileIndex;
    var visited = 0;

    for(; i < tiles.length && visited < work; i++, visited++){
        var t = tiles[i];
        var item = api.getDrop(drill, t);
        var itemId = api.itemId(item);
        if(lowPriority[itemId] === undefined) lowPriority[itemId] = api.itemLowPriority(item);

        var canMine = api.canMine(drill, t);
        var mineable = canMine && itemId === job.sourceDropId;
        if(mineable) job.targetCells++;
        cellFacts[api.tx(t) + api.ty(t) * worldW] = {
            canMine: canMine,
            dropId: itemId,
            mineable: mineable
        };
    }

    job.tileIndex = i;
    if(i >= tiles.length){
        job.tileIndex = 0;
        job.phase = PHASE_CANDIDATES;
    }
}

/**
 * Phase 2: the candidate pass - every patch tile whose footprint can be mined and whose
 * winner item is the patch ore with at least Min Ores cells.
 *
 * NOTE: this pass is deliberately inlined instead of calling a helper that returns an
 * object. The interpreted Rhino engine iOS uses does not return from such a helper when
 * it is called in this loop (reproduced: the loop never advances and the heap grows
 * until OutOfMemory). Inlining also removes a pass over the patch.
 */
function scanCandidates(job, work){
    var tiles = job.tiles;
    var worldW = job.worldW;
    var size = job.size;
    var half = job.half;
    var cellFacts = job.cellFacts;
    var lowPriority = job.lowPriority;
    var candidates = job.candidates;
    var minOres = job.minOres;
    var sourceDropId = job.sourceDropId;
    var i = job.tileIndex;
    var visited = 0;

    for(; i < tiles.length && visited < work; i++, visited++){
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
        if(winner !== sourceDropId || counts[winner].count < minOres) continue;
        if(!util.canPlaceBlock(job.drill, job.team, api.tx(cand), api.ty(cand), 0)) continue;

        candidates.push({
            tile: cand,
            cellKeys: cellKeys,
            mineableKeys: mineableKeys,
            winnerCount: counts[winner].count
        });
    }

    job.tileIndex = i;
    if(i >= tiles.length){
        job.tileIndex = 0;
        job.phase = PHASE_SETUP;
    }
}

/** Phase 3: order the candidates, build the pruning bound, size the budget. */
function setupSearch(job){
    var entries = job.candidates;
    util.sortStable(entries, function(e){
        return -e.winnerCount;
    });

    var suffix = new Array(entries.length + 1);
    suffix[entries.length] = 0;
    for(var i = entries.length - 1; i >= 0; i--){
        suffix[i] = suffix[i + 1] + entries[i].winnerCount;
    }
    job.suffix = suffix;
    job.entries = entries;

    // how much ore is reachable at all: the rest is out of reach at the current Min Ores
    var reachable = {};
    var coverable = 0;
    for(i = 0; i < entries.length; i++){
        var keys = entries[i].mineableKeys;
        for(var k = 0; k < keys.length; k++){
            if(reachable[keys[k]] !== true){
                reachable[keys[k]] = true;
                coverable++;
            }
        }
    }
    job.coverable = coverable;

    // The quality setting buys *exploration*. A complete greedy descent must always fit: with
    // candidates.length as the ceiling for a layout, a few multiples of that is enough to walk
    // down once per branch order and still have budget for alternatives.
    job.maxTries = Math.max(job.quality * 1000, entries.length * 3);
    job.deadline = api.now() + SEARCH_BUDGET_MS;

    job.phase = PHASE_READY;

    debugLog("stage: candidates=" + entries.length + " coverable=" + coverable + "/" + job.targetCells
        + " budget=" + job.maxTries + " truncated=" + job.truncated);
}

/** Advances the patch scan. `work` bounds the api-heavy loops per call. */
function prepareStep(job, work){
    if(job.phase === PHASE_TILES) scanTiles(job);
    if(job.phase === PHASE_FACTS) scanFacts(job, work);
    if(job.phase === PHASE_CANDIDATES) scanCandidates(job, work);
    if(job.phase === PHASE_SETUP) setupSearch(job);
}

function prepareDone(job){
    return job.phase >= PHASE_READY;
}

/** Synchronous scan (tests, tools, and any caller that wants the job immediately). */
function prepare(tile, drill, withSupport, teamOverride, direction, routeLength){
    var job = newJob(tile, drill, withSupport, teamOverride, direction, routeLength);
    while(!prepareDone(job)) prepareStep(job, Infinity);
    return job;
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

        if(job.placements >= job.maxTries){
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

// ---------------------------------------------------------------------------- layout choice

/** Ore cells of a selection that nothing else in it mines. */
function selectionScore(selection){
    var covered = {};
    var count = 0;
    for(var i = 0; i < selection.length; i++){
        var keys = selection[i].mineableKeys;
        for(var k = 0; k < keys.length; k++){
            if(covered[keys[k]] !== true){
                covered[keys[k]] = true;
                count++;
            }
        }
    }
    return count;
}

/**
 * The best translation of the lattice, gap-filled. Candidates congruent to (ax, ay) modulo the
 * drill size cannot overlap each other (their centres differ by whole block widths), so every
 * translation is a legal, perfectly tiled layout without a single overlap test - and the filler
 * then patches whatever the tiling missed at the rim.
 *
 * All size*size translations are tried because the winner depends on how the patch happens to
 * line up: on a one-tile-wide vein, for instance, only the translation that matches the vein's
 * start covers it end to end, while the others leave the last two tiles with nowhere to go.
 */
function bestLattice(job){
    var size = job.size;
    var entries = job.entries;
    var best = null;

    for(var ax = 0; ax < size; ax++){
        for(var ay = 0; ay < size; ay++){
            var selection = [];

            for(var i = 0; i < entries.length; i++){
                var entry = entries[i];
                if((api.tx(entry.tile) - ax) % size !== 0) continue;
                if((api.ty(entry.tile) - ay) % size !== 0) continue;
                selection.push(entry);
            }

            var filled = fillGaps(job, selection);
            var score = selectionScore(filled);
            if(best == null || score > best.score) best = {selection: filled, score: score};
        }
    }
    return best;
}

/**
 * Keeps adding drills while any still-free candidate mines an ore tile that nothing mines yet.
 * Terminates because every added drill covers at least one new tile and a blocked candidate
 * stays blocked (placing only ever fills space). One pass is therefore enough.
 */
function fillGaps(job, selection){
    var entries = job.entries;
    var occ = {};
    var covered = {};
    var i = 0, k = 0, keys = null;

    for(i = 0; i < selection.length; i++){
        keys = selection[i].cellKeys;
        for(k = 0; k < keys.length; k++) occ[keys[k]] = true;
        keys = selection[i].mineableKeys;
        for(k = 0; k < keys.length; k++) covered[keys[k]] = true;
    }

    var added = [];
    for(i = 0; i < entries.length; i++){
        var entry = entries[i];

        var blocked = false;
        var cells = entry.cellKeys;
        for(k = 0; k < cells.length; k++){
            if(occ[cells[k]] === true){
                blocked = true;
                break;
            }
        }
        if(blocked) continue;

        var gain = 0;
        var mine = entry.mineableKeys;
        for(k = 0; k < mine.length; k++){
            if(covered[mine[k]] !== true) gain++;
        }
        if(gain === 0) continue;

        added.push(entry);
        for(k = 0; k < cells.length; k++) occ[cells[k]] = true;
        for(k = 0; k < mine.length; k++) covered[mine[k]] = true;
    }

    if(added.length === 0) return selection;

    var out = selection.slice();
    for(i = 0; i < added.length; i++) out.push(added[i]);
    return out;
}

/** The final layout: the better of the lattice seed and the search, both gap-filled. */
function chooseSelection(job){
    var lattice = bestLattice(job);

    var searched = job.result.selection == null ? [] : job.result.selection;
    var searchFilled = fillGaps(job, searched);
    var searchScore = selectionScore(searchFilled);

    if(lattice.score > searchScore){
        return {selection: lattice.selection, score: lattice.score, source: "lattice"};
    }
    return {selection: searchFilled, score: searchScore, source: "search"};
}

// ---------------------------------------------------------------------------- finish

function finish(job){
    var selection = [];
    var score = 0;
    var source = "none";
    var covered = 0, unreachable = 0, blocked = 0;

    if(prepareDone(job) && !job.cancelled){
        var chosen = chooseSelection(job);
        selection = chosen.selection;
        score = chosen.score;
        source = chosen.source;

        covered = score;
        unreachable = Math.max(0, job.targetCells - job.coverable);
        blocked = Math.max(0, job.coverable - covered);
    }

    var team = job.team;
    var allPlans = [];
    var occupied = {};
    var i = 0;

    for(i = 0; i < selection.length; i++){
        var chosenTile = selection[i].tile;
        var plan = util.newPlan(api.tx(chosenTile), api.ty(chosenTile), 0, job.drill);
        if(util.canPlacePlan(plan, team) && util.freeInOccupancy(occupied, plan.block, plan.x, plan.y)){
            allPlans.push(plan);
            util.markOccupancy(occupied, plan.block, plan.x, plan.y, true);
        }else{
            util.markRefused();
        }
    }

    if(job.withSupport && api.settingBool(KEY_SUPPORT, true)){
        placeWaterExtractorsAndPowerNodes(selection, job.drill, team, allPlans, occupied);
    }

    var routed = routeOutputs(job, allPlans, occupied);

    job.stats = {
        source: source,
        covered: covered,
        target: job.targetCells,
        unreachable: unreachable,
        blocked: blocked,
        drills: selection.length,
        plans: allPlans.length,
        candidates: job.entries.length,
        truncated: job.truncated === true,
        stopped: job.cancelled ? "cancel" : (job.aborted ? "time" : (job.exhausted ? "budget" : "no"))
    };

    // ---- feedback ----
    if(job.cancelled){
        api.toast("[AutoDrill] planning cancelled");
    }else{
        if(job.truncated){
            api.toast("[AutoDrill] patch is larger than Max Tiles (" + job.maxTiles
                + ") - raise it in settings to cover the rest");
        }
        if(job.exhausted){
            api.toast("[AutoDrill] quality limit reached (" + job.placements + " layouts explored) - raise Optimization Quality for better results");
        }else if(job.aborted){
            api.toast("[AutoDrill] search stopped after " + SEARCH_BUDGET_MS + " ms - lower Optimization Quality for faster results");
        }

        if(allPlans.length === 0 && job.entries.length > 0){
            api.toast("[AutoDrill] nothing could be placed here - is this inside your build range?");
        }else if(selection.length > 0 && covered < job.targetCells){
            var why = unreachable > 0
                ? unreachable + " out of reach (lower Min Ores)"
                : blocked + " blocked (raise Optimization Quality)";
            api.toast("[AutoDrill] mined " + covered + " of " + job.targetCells + " ore tiles - " + why
                + (routed > 0 ? ", incl. " + routed + " routing tiles" : ""));
        }
    }

    debugLog("patch=" + job.targetCells + " coverable=" + job.coverable
        + " candidates=" + job.entries.length + " selected=" + selection.length + " drills"
        + " score=" + score + " source=" + source
        + " placements=" + job.placements + " checks=" + job.checks
        + " plans=" + allPlans.length + " truncated=" + job.truncated
        + " stopped=" + job.stats.stopped);

    util.commitPlans(allPlans);
    util.reportRefused("planned buildings");
    return allPlans;
}

/**
 * Java: OptimizationDrill.placeWaterExtractorsAndPowerNodes
 *
 * One water extractor (for the drill's liquid boost) and one power node per drill. Uses the
 * occupancy map built from the drill plans instead of rescanning every plan, which is what
 * keeps a several-hundred-drill fill quick.
 */
function placeWaterExtractorsAndPowerNodes(selection, drill, team, allPlans, occupied){
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
            if(!util.canPlacePlan(plan, team)) continue;
            if(!util.freeInOccupancy(occupied, waterExtractor, plan.x, plan.y)) continue;
            var water = api.waterAt(nearby[j]);
            if(water > bestWater){
                bestWater = water;
                best = plan;
            }
        }
        if(best != null){
            allPlans.push(best);
            util.markOccupancy(occupied, waterExtractor, best.x, best.y, true);
        }
    }

    for(i = 0; i < selection.length; i++){
        var tile2 = selection[i].tile;
        var nearby2 = util.nearbyTiles(api.tx(tile2), api.ty(tile2), drillSize, api.size(powerNode));
        for(j = 0; j < nearby2.length; j++){
            var plan2 = util.newPlan(api.tx(nearby2[j]), api.ty(nearby2[j]), 0, powerNode);
            if(util.canPlacePlan(plan2, team) && util.freeInOccupancy(occupied, powerNode, plan2.x, plan2.y)){
                allPlans.push(plan2);
                util.markOccupancy(occupied, powerNode, plan2.x, plan2.y, true);
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
function routeOutputs(job, allPlans, occupied){
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
            if(!util.canPlacePlan(plan, job.team) || !util.freeInOccupancy(occupied, block, x, y)){
                util.markRefused();
                break;
            }
            allPlans.push(plan);
            util.markOccupancy(occupied, block, x, y, true);
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

/** Same as fill, plus the layout statistics (used by the engine checks). */
exports.fillDetailed = function(tile, drill, waterExtractorsAndPowerNodes, teamOverride, direction, routeLength){
    var job = prepare(tile, drill, waterExtractorsAndPowerNodes, teamOverride, direction,
        routeLength == null ? api.settingInt(KEY_ROUTE, 0) : routeLength);
    while(!searchStep(job, Infinity)){
        // run to completion
    }
    return {plans: finish(job), stats: job.stats};
};

/**
 * How far the patch scan has got, 0..1. The chunked path shows this first and the search
 * progress after it, so a huge patch reports progress instead of freezing the game.
 */
function prepareProgress(job){
    if(job.phase === PHASE_TILES) return 0;
    if(job.tiles == null || job.tiles.length === 0) return 1;
    var part = job.tileIndex / job.tiles.length;
    if(job.phase === PHASE_FACTS) return 0.5 * part;
    if(job.phase === PHASE_CANDIDATES) return 0.5 + 0.5 * part;
    return 1;
}

/**
 * Chunked fill: runs the patch scan and the search across frames with a progress bar and a
 * cancel button, then calls onDone(plans). Used by the UI so a big patch never freezes.
 */
exports.fillAsync = function(tile, drill, waterExtractorsAndPowerNodes, teamOverride, direction, routeLength, onDone){
    var job = newJob(tile, drill, waterExtractorsAndPowerNodes, teamOverride, direction,
        routeLength == null ? api.settingInt(KEY_ROUTE, 0) : routeLength);

    api.showProgress("[accent]AutoDrill[] planning...");
    api.setProgressCancel(function(){
        job.cancelled = true;
    });

    function step(){
        if(!prepareDone(job)){
            prepareStep(job, SCAN_WORK);
            api.setProgress(0.35 * prepareProgress(job));

            if(job.cancelled){
                api.hideProgress();
                onDone(finish(job));
                return;
            }
            api.postStep(step);
            return;
        }

        var done = searchStep(job, STEP_WORK);
        api.setProgress(0.35 + 0.6 * Math.min(1, job.placements / job.maxTries));

        if(done || job.cancelled){
            api.hideProgress();
            onDone(finish(job));
            return;
        }
        api.postStep(step);
    }

    api.postStep(step);
};

// Exposed for the test rigs: prepare + searchStep let a probe or test inspect the search
// (patch size, candidate count, coverage) without going through the game, and let the guard
// checks assert coverage guarantees directly. Not used by the UI.
exports.prepare = prepare;
exports.prepareStep = prepareStep;
exports.prepareDone = prepareDone;
exports.searchStep = searchStep;
exports.finish = finish;
