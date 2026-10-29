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
    mechanical: {tiles: 5000, ores: 1},
    pneumatic: {tiles: 5000, ores: 1},
    laser: {tiles: 5000, ores: 2},
    airblast: {tiles: 5000, ores: 2}
};

/** Shared with the bridge/wall fillers so the four defaults exist in exactly one place. */
exports.settingDefaults = SETTING_DEFAULTS;

var KEY_QUALITY = "auto-drill-ios-optimization-quality";
var KEY_SUPPORT = "auto-drill-ios-place-water-extractor-and-power-nodes";
var KEY_ROUTE = "auto-drill-ios-output-routing-length";
var KEY_LANES = "auto-drill-ios-build-belt-lanes";
// One lane row (3x3 drills need three rows of their own, so the lane takes the fourth). Every
// fifth row was measured: the drill rows cannot fit in the four rows left, and coverage fell to
// 62%. Four is the tightest that still leaves a full row of drills between two lanes - and it is
// the *minimum*: reserveLaneTiles widens the pitch to size + 1 for any larger drill.
var LANE_PITCH = 4;
var LANE_HOP = 3;        // item bridges link exactly three tiles along an axis

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
        targetCells: 0,
        otherOres: {},
        builtCells: {},         // ore tiles this drill can mine, inside the seen patch
        cellFacts: {},          // key(x,y) -> {canMine, dropId, mineable}
        lowPriority: {},        // dropId -> boolean
        candidates: [],
        rimCandidates: [],       // placements whose footprint holds only one ore tile
        coverable: 0,           // ore tiles at least one candidate could mine
        lanes: false,           // belt lanes: tiles kept free for belts, power and water
        reserved: {},           // tiles kept free for the lanes or the power lattice
        reservedNodes: [],
        laneTiles: [],
        reservedCost: 0,        // candidates dropped to keep them free

        // ---- search ----
        entries: [],
        suffix: [],
        occ: {},                // footprint cell -> placed count
        covered: {},            // mined cell -> placed count (search scratch only)
        path: [],
        frames: [],
        result: {score: 0, selection: null},
        sweepOrders: [],
        restartOrders: [],
        deepOrders: [],
        plannedBlocked: {},
        powerRemovedDrills: 0,
        powerRemovedOre: 0,
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
    var tiles = util.getConnectedTiles(job.startTile, job.maxTiles + 1, job.team, job.otherOres,
        job.builtCells);

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
        if(winner !== sourceDropId) continue;
        if(counts[winner].count < minOres){
            // A rim tip pinched between the patch edge and a wall can leave a footprint that
            // physically holds only one ore tile of this patch: at Min Ores 2 every placement
            // that mines it is filtered out and the tile is lost for good, even though the
            // drill would fit once the layout is final. Keep those aside for finish()'s rim
            // gap-fill instead of dropping the tile.
            if(minOres <= 2 && counts[winner].count >= 1
                && util.canPlaceBlock(job.drill, job.team, api.tx(cand), api.ty(cand), 0)){
                job.rimCandidates.push({
                    tile: cand,
                    cellKeys: cellKeys,
                    mineableKeys: mineableKeys,
                    winnerCount: counts[winner].count
                });
            }
            continue;
        }
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
    job.entries = entries;

    // Power blocks need free tiles, and a dense fill leaves none: the drills tile the patch
    // edge to edge, so a node cannot be placed anywhere inside it and the whole patch runs
    // unpowered. Reserve the node lattice *before* the layout, so the drills leave room for
    // it; the reserved tiles cost a drill each, which is why this only happens when the
    // water-extractor/power-node support is on.
    if(job.withSupport && api.settingBool(KEY_SUPPORT, true)){
        if(api.settingBool(KEY_LANES, false)) reserveLaneTiles(job);
        else reservePowerTiles(job);
    }

    if(entries.length > 0) filterPlanned(job);

    // The rim candidates go through the same filter: a rim placement sitting on a reserved
    // lane/power tile or on a plan from the last fill is not worth keeping either.
    if(entries.length > 0 && job.rimCandidates.length > 0){
        var keptRim = [];
        for(var rc = 0; rc < job.rimCandidates.length; rc++){
            var rimEntry = job.rimCandidates[rc];
            var rimBlocked = false;
            for(var rk = 0; rk < rimEntry.cellKeys.length; rk++){
                var rimCell = rimEntry.cellKeys[rk];
                if(job.reserved[rimCell] === true || job.plannedBlocked[rimCell] === true){
                    rimBlocked = true;
                    break;
                }
            }
            if(!rimBlocked) keptRim.push(rimEntry);
        }
        job.rimCandidates = keptRim;
    }

    // Everything below is built from the candidates that survived the reservation: the bound,
    // the coverage, and the layouts all have to agree on what may be placed.
    entries = job.entries;

    var suffix = new Array(entries.length + 1);
    suffix[entries.length] = 0;
    for(var i = entries.length - 1; i >= 0; i--){
        suffix[i] = suffix[i + 1] + entries[i].winnerCount;
    }
    job.suffix = suffix;

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

    // seed the search's occupancy with the reserved tiles and the last fill's plans: no drill
    // may sit on one
    for(var key in job.reserved) job.occ[key] = 1;
    for(var pkey in job.plannedBlocked) job.occ[pkey] = 1;

    // Ordering passes: greedy runs over the same candidates in different spatial orders. They
    // are what makes the quality setting mean something - each one is a different legal
    // layout, the best wins, and how many are tried is what the setting buys.
    job.sweepOrders = buildSweepOrders(entries);

    // Restart orders: shuffled candidate orders, a few every fill regardless of the quality
    // setting (they are the cheapest family that closes irregular shapes; see
    // buildRestartOrders). More of them at higher quality.
    job.restartOrders = buildRestartOrders(entries, Math.max(4, Math.min(8, job.quality)));

    // Order set for the deep repair (ruin-and-recreate): the entry order plus the spatial
    // sweeps plus the first restart orders - the different insertion styles the repair tries.
    job.deepOrders = [];
    var identity = [];
    for(var e = 0; e < entries.length; e++) identity.push(e);
    job.deepOrders.push(identity);
    for(var d = 0; d < job.sweepOrders.length; d++) job.deepOrders.push(job.sweepOrders[d]);
    for(d = 0; d < 3 && d < job.restartOrders.length; d++) job.deepOrders.push(job.restartOrders[d]);

    // why tiles are unreachable (ground vs Min Ores), for the fill's report
    classifyUnreachable(job);

    job.phase = PHASE_READY;

    debugLog("stage: candidates=" + entries.length + " coverable=" + coverable + "/" + job.targetCells
        + " budget=" + job.maxTries + " truncated=" + job.truncated);
}

/**
 * Places what the lanes carry: an item bridge on every lane tile - a chain that hops three tiles,
 * pushing the ore out of the patch - and the power blocks on every other lane tile, which puts a
 * block within reach of the drills on both sides and keeps the whole network linked.
 */
function placeLaneSupplies(job, team, allPlans, occupied, info){
    var itemBridge = api.block("itemBridge");
    var belts = 0;
    var nodes = 0;
    var i = 0;

    for(i = 0; i < job.laneTiles.length; i++){
        var lane = job.laneTiles[i];
        var next = i + 1 < job.laneTiles.length ? job.laneTiles[i + 1] : null;

        var plan = util.newPlan(lane.x, lane.y, 0, itemBridge);
        if(!util.canPlaceWithoutPlanCollision(plan, team, allPlans)) continue;

        if(next != null){
            plan.configX = next.x - lane.x;
            plan.configY = next.y - lane.y;
        }
        allPlans.push(plan);
        util.markOccupancy(occupied, itemBridge, lane.x, lane.y, true);
        belts++;
    }

    // power on the lanes: one block every other lane tile reaches the drills on both sides, and
    // the blocks sit well inside link range of each other along the lane
    for(i = 0; i < job.laneTiles.length; i += 2){
        var laneSpot = job.laneTiles[i];
        var placedBlock = null;

        for(var d = 0; d < 5 && placedBlock == null; d++){
            var dx = d === 0 ? 1 : (d === 1 ? -1 : 0);
            var dy = d === 2 ? 1 : (d === 3 ? -1 : 0);
            var bx = laneSpot.x + dx;
            var by = laneSpot.y + dy;

            if(d === 4){
                bx = laneSpot.x;    // last resort: the lane tile itself
                by = laneSpot.y;
            }else if(job.reserved[bx + by * job.worldW] === true){
                continue;
            }

            var candidate = util.newPlan(bx, by, 0, info.block);
            if(!util.canPlacePlan(candidate, team)) continue;
            if(!util.freeInOccupancy(occupied, info.block, bx, by)) continue;

            placedBlock = candidate;
        }

        if(placedBlock == null) continue;
        allPlans.push(placedBlock);
        util.markOccupancy(occupied, info.block, placedBlock.x, placedBlock.y, true);
        nodes++;
    }

    debugLog("lanes: belts=" + belts + " power=" + nodes);
    return {belts: belts, nodes: nodes};
}

/**
 * The power block this environment uses, with the numbers the game actually gives it.
 *
 * Serpulo wires a patch with power nodes (1x1, link range 6), Erekir with beam nodes (1x1,
 * range 5-10 depending on the version) or - far better - beam towers (3x3, range 23, storing
 * 40000 power), which reach a whole patch from one or two spots. The link block is the small
 * one, used to reach the player's grid when the big one cannot.
 *
 * Returns null when nothing power-related can be built here, in which case the fill leaves
 * power to the player.
 */
function powerSupport(){
    return api.powerSupportInfo();
}

function linkRange(info, block){
    if(block === info.block) return info.range;
    return api.powerRangeOf(block);
}

/** Friendly plural for the summary toast ("power nodes" / "beam towers"). */
function powerName(info){
    var name = api.blockName(info.block);
    if(name === "power-node") return "power nodes";
    if(name === "beam-node") return "beam nodes";
    if(name === "beam-tower") return "beam towers";
    return name.replace("-", " ") + "s";
}

/**
 * The tile a power block should take: the one within `radius` that costs the fewest ore tiles
 * to hold free. A tile no drill can use is free (cost 0); otherwise the cost is how much ore
 * the drill sitting there would have mined, so a rim drill is dropped before a full one.
 */
function cheapestSpot(job, candidateAt, x, y, radius){
    var bestX = x, bestY = y;
    var bestCost = spotCost(job, candidateAt, x, y);
    var i = 0, j = 0;

    for(i = 1; i <= radius && bestCost > 0; i++){
        for(j = -i; j <= i; j++){
            var spots = [
                {x: x + j, y: y - i}, {x: x + j, y: y + i},
                {x: x - i, y: y + j}, {x: x + i, y: y + j}
            ];
            for(var k = 0; k < 4; k++){
                var cost = spotCost(job, candidateAt, spots[k].x, spots[k].y);
                if(cost < bestCost){
                    bestCost = cost;
                    bestX = spots[k].x;
                    bestY = spots[k].y;
                }
            }
        }
    }
    return {x: bestX, y: bestY, cost: bestCost};
}

function spotCost(job, candidateAt, x, y){
    var entry = candidateAt[x + y * job.worldW];
    return entry === undefined ? 0 : entry.winnerCount;
}

/**
 * Reserves a belt lane grid: one lane row every LANE_PITCH rows, and on each lane a tile every
 * LANE_HOP (item bridges link exactly three tiles along an axis, so three-spaced tiles form a
 * chain). Everything else stays free for drills, which makes the lanes cheap - about one tile in
 * fifteen - and they carry what otherwise costs its own tiles:
 *
 *   the belts   - the lane is a bridge chain, so the drills beside it can hand their ore over;
 *   the power   - nodes on the lane are within link range of the drills on both sides, and the
 *                 chain is connected by construction, so the whole patch is one grid;
 *   the water   - extractors fit in the lanes and the gaps the lanes open up.
 *
 * Lanes run along the patch's longer side so the belts leave by the shorter one.
 */
function reserveLaneTiles(job){
    var lanes = [];
    var i = 0;
    var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;

    for(i = 0; i < job.candidates.length; i++){
        var t = job.candidates[i].tile;
        var tx = api.tx(t), ty = api.ty(t);
        if(tx < minX) minX = tx;
        if(ty < minY) minY = ty;
        if(tx > maxX) maxX = tx;
        if(ty > maxY) maxY = ty;
    }
    if(job.candidates.length === 0) return;

    var half = job.half;
    minX -= half; minY -= half; maxX += half; maxY += half;

    // The lane row takes one row of the patch; the drills need job.size rows of their own, so
    // the pitch is size + 1. With the fixed four-row pitch a 4x4 drill (airblast) has no room
    // between two lanes: every 4x4 footprint spans four consecutive rows and four consecutive
    // columns, so it always contains a reserved lane tile and none can be placed at all.
    var lanePitch = Math.max(LANE_PITCH, job.size + 1);

    // lanes along the longer side, and the chain pushes ore towards the far end of it
    var alongX = (maxX - minX) >= (maxY - minY);

    if(alongX){
        for(var y = minY; y <= maxY; y += lanePitch){
            for(var x = minX; x <= maxX; x += LANE_HOP){
                if(job.cellFacts[x + y * job.worldW] === undefined) continue;
                lanes.push({x: x, y: y});
            }
        }
    }else{
        for(var x2 = minX; x2 <= maxX; x2 += lanePitch){
            for(var y2 = minY; y2 <= maxY; y2 += LANE_HOP){
                if(job.cellFacts[x2 + y2 * job.worldW] === undefined) continue;
                lanes.push({x: x2, y: y2});
            }
        }
    }

    if(lanes.length === 0) return;

    // keep the chain in order so each bridge can point at the next one
    util.sortStable(lanes, function(p){
        return alongX ? (p.y * 4096 + p.x) : (p.x * 4096 + p.y);
    });

    job.lanes = true;
    job.laneTiles = lanes;
    job.reservedNodes = lanes;

    for(i = 0; i < lanes.length; i++){
        job.reserved[lanes[i].x + lanes[i].y * job.worldW] = true;
    }

    debugLog("stage: lanes=" + lanes.length + " (" + (alongX ? "along x" : "along y")
        + ", pitch=" + lanePitch + ")");
}

/**
 * Marks the tiles the power lattice will need, and drops the candidates that would sit on
 * them.
 *
 * The spacing has to satisfy two things at once: every drill within link range of a node
 * (<= range * sqrt(2)) and every node within link range of its neighbours (<= range), so the
 * network is one piece the player only has to attach once. That means one node per (range - 1)²
 * tiles - about one reserved tile per four 3x3 drills - which is the real price of powering a
 * packed patch. The search then packs the drills around the reserved tiles.
 */
function reservePowerTiles(job){
    var info = powerSupport();
    if(info == null) return;

    var range = info.range;
    var size = info.size;
    if(range < 3) return;

    // Close enough that every drill is inside link range and neighbouring blocks link to each
    // other, and no denser than that: every held tile costs a drill.
    var step = Math.max(2, range - size);
    // the outermost blocks are pushed outside the drill area: those tiles are free
    var pad = Math.ceil(range / 2);

    // What each tile holds, so a block can be given the cheapest one nearby: a tile no drill
    // wanted costs nothing, and a tile under a poor drill (a rim drill covering two ore tiles)
    // costs far less than one under a full 3x3 drill.
    var candidateAt = {};
    for(i = 0; i < job.candidates.length; i++){
        var candTile = job.candidates[i].tile;
        candidateAt[api.tx(candTile) + api.ty(candTile) * job.worldW] = job.candidates[i];
    }
    job.candidateAt = candidateAt;
    var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    var i = 0;

    for(i = 0; i < job.candidates.length; i++){
        var t = job.candidates[i].tile;
        var tx = api.tx(t), ty = api.ty(t);
        if(tx < minX) minX = tx;
        if(ty < minY) minY = ty;
        if(tx > maxX) maxX = tx;
        if(ty > maxY) maxY = ty;
    }
    if(job.candidates.length === 0) return;

    minX -= job.half;
    minY -= job.half;
    maxX += job.half;
    maxY += job.half;

    // Centred on the patch, so a small patch needs one node rather than a corner of a grid,
    // and only inside the scanned area - a tile outside it would cost nothing but reserve nothing.
    var cx = Math.round((minX + maxX) / 2);
    var cy = Math.round((minY + maxY) / 2);
    var kx = Math.ceil((maxX - minX) / 2 / step);
    var ky = Math.ceil((maxY - minY) / 2 / step);
    var reserved = {};
    var positions = [];

    for(var gi = -kx - 1; gi <= kx + 1; gi++){
        for(var gj = -ky - 1; gj <= ky + 1; gj++){
            var x = cx + gi * step, y = cy + gj * step;
            if(x < minX - pad || x > maxX + pad || y < minY - pad || y > maxY + pad) continue;

            // give the block the cheapest tile within reach of where it belongs
            var spot = cheapestSpot(job, candidateAt, x, y, 2);
            positions.push(spot);

            if(spot.cost === 0) continue;    // nothing wanted that tile: no drill loses its place

            // the whole footprint is held, not just the centre
            var offset = Math.floor((size - 1) / 2);
            for(var hx = 0; hx < size; hx++){
                for(var hy = 0; hy < size; hy++){
                    reserved[(spot.x - offset + hx) + (spot.y - offset + hy) * job.worldW] = true;
                }
            }
        }
    }
    if(positions.length === 0) return;

    job.reserved = reserved;
    job.reservedNodes = positions;

    // candidates may not cover a reserved tile
    var kept = [];
    for(i = 0; i < job.candidates.length; i++){
        var entry = job.candidates[i];
        var blocked = false;
        for(var k = 0; k < entry.cellKeys.length; k++){
            if(reserved[entry.cellKeys[k]] === true){
                blocked = true;
                break;
            }
        }
        if(!blocked) kept.push(entry);
        else job.reservedCost++;
    }
    job.candidates = kept;
    job.entries = kept;      // the layouts iterate entries: filtering one and not the other
                             // let a drill sit on a reserved tile and overlap its power block

    // coverable is about the tiles a drill can still reach, so it is counted again here
    var reachable = {};
    var coverable = 0;
    for(i = 0; i < kept.length; i++){
        var keys = kept[i].mineableKeys;
        for(var m = 0; m < keys.length; m++){
            if(reachable[keys[m]] !== true){
                reachable[keys[m]] = true;
                coverable++;
            }
        }
    }
    job.coverable = coverable;

    debugLog("stage: reserved " + positions.length + " power tiles (step=" + step + ")");
}

/**
 * Drops the candidates the previous fill already planned: those plans are not built yet, so the
 * game would accept a second set right on top of them and a second tap would queue everything
 * twice. What is left is the ground that is genuinely still free.
 */
function filterPlanned(job){
    var lastPlans = util.lastCommitted();
    if(lastPlans.length === 0) return;

    var planned = {};
    var i = 0, k = 0;

    for(i = 0; i < lastPlans.length; i++){
        var rect = util.blockRect(lastPlans[i].x, lastPlans[i].y, lastPlans[i].block);
        for(var x = rect.x; x < rect.x + rect.w; x++){
            for(var y = rect.y; y < rect.y + rect.h; y++){
                planned[x + y * job.worldW] = true;
            }
        }
    }
    job.plannedBlocked = planned;

    var kept = [];
    for(i = 0; i < job.entries.length; i++){
        var entry = job.entries[i];
        var blocked = false;

        for(k = 0; k < entry.cellKeys.length; k++){
            if(planned[entry.cellKeys[k]] === true){
                blocked = true;
                break;
            }
        }
        if(!blocked) kept.push(entry);
    }

    job.entries = kept;
    job.candidates = kept;
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

/**
 * The same candidate list in eight spatial orders (rows and columns, both ways, and both
 * diagonals). A greedy pass over one of these packs the patch in a different pattern, which is
 * what recovers the holes an irregular patch or a reserved power tile leaves behind.
 */
function buildSweepOrders(entries){
    var orders = [];
    var keys = [
        function(e){ return api.tx(e.tile) * 4096 + api.ty(e.tile); },
        function(e){ return -api.tx(e.tile) * 4096 + api.ty(e.tile); },
        function(e){ return api.ty(e.tile) * 4096 + api.tx(e.tile); },
        function(e){ return -api.ty(e.tile) * 4096 + api.tx(e.tile); },
        function(e){ return (api.tx(e.tile) + api.ty(e.tile)) * 4096 + api.tx(e.tile); },
        function(e){ return -(api.tx(e.tile) + api.ty(e.tile)) * 4096 + api.tx(e.tile); },
        function(e){ return (api.tx(e.tile) - api.ty(e.tile)) * 4096 + api.tx(e.tile); },
        function(e){ return -(api.tx(e.tile) - api.ty(e.tile)) * 4096 + api.tx(e.tile); }
    ];

    for(var k = 0; k < keys.length; k++){
        var order = [];
        for(var i = 0; i < entries.length; i++) order.push(i);
        var keyFn = keys[k];
        order.sort(function(a, b){
            return keyFn(entries[a]) - keyFn(entries[b]);
        });
        orders.push(order);
    }
    return orders;
}

/** Greedy pass over one sweep order: take every candidate that still fits. */
function greedySweep(job, order){
    var entries = job.entries;
    var occ = {};
    var selection = [];
    var i = 0, k = 0, keys = null;

    for(var r in job.reserved) occ[r] = true;
    for(var p in job.plannedBlocked) occ[p] = true;

    for(i = 0; i < order.length; i++){
        var entry = entries[order[i]];

        var blocked = false;
        keys = entry.cellKeys;
        for(k = 0; k < keys.length; k++){
            if(occ[keys[k]] === true){
                blocked = true;
                break;
            }
        }
        if(blocked) continue;

        for(k = 0; k < keys.length; k++) occ[keys[k]] = true;
        selection.push(entry);
    }

    return selection;
}

/**
 * Greedy insert on top of an existing selection: walk the order and take every candidate that
 * still fits, keeping what is already there. Used by the deep repair (ruin-and-recreate).
 */
function greedyInsert(job, order, base){
    var entries = job.entries;
    var occ = {};
    var selection = base.slice();
    var i = 0, k = 0, keys = null;

    for(var r in job.reserved) occ[r] = true;
    for(var p in job.plannedBlocked) occ[p] = true;

    for(i = 0; i < selection.length; i++){
        keys = selection[i].cellKeys;
        for(k = 0; k < keys.length; k++) occ[keys[k]] = true;
    }

    for(i = 0; i < order.length; i++){
        var entry = entries[order[i]];

        var blocked = false;
        keys = entry.cellKeys;
        for(k = 0; k < keys.length; k++){
            if(occ[keys[k]] === true){ blocked = true; break; }
        }
        if(blocked) continue;

        for(k = 0; k < keys.length; k++) occ[keys[k]] = true;
        selection.push(entry);
    }

    return selection;
}

// Fixed seed for the restart orders: the sequence must be identical on every device, so the
// same patch fills the same way everywhere.
var RESTART_SEED = 20261029;

/**
 * Deterministic pseudo-random candidate orders ("restarts"). The eight spatial sweeps are axis
 * orders and miss the packing some irregular shapes want; a shuffled order often finds it.
 * Measured on the 13 shapes where the families still ended one tile short: one seeded restart
 * closed every one of them, and the extra cost is one greedy pass each (a few ms on a big
 * patch). Bounded and deterministic, so it behaves like an extra family, not like a random mod.
 */
function buildRestartOrders(entries, count){
    var orders = [];
    var seed = RESTART_SEED;

    for(var r = 0; r < count; r++){
        var order = [];
        for(var i = 0; i < entries.length; i++) order.push(i);
        for(i = order.length - 1; i > 0; i--){
            seed = (seed * 1103515245 + 12345) % 2147483648;
            var j = seed % (i + 1);
            var tmp = order[i];
            order[i] = order[j];
            order[j] = tmp;
        }
        orders.push(order);
    }
    return orders;
}

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
                if(!free(job.reserved, entry)) continue;            // never sit on a power block
                if(!free(job.plannedBlocked, entry)) continue;      // nor on a plan from last time
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

    for(var r in job.reserved) occ[r] = true;

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

/**
 * The final layout: the best of the branch-and-bound search, the lattice translations and the
 * quality-many greedy sweeps, each finished with the gap filler.
 *
 * The three families fail in different places. The search explores placements it would not
 * greedily pick; the lattice has the tidy alignments a regular patch wants; the sweeps pack
 * around holes - an irregular rim, a reserved power tile - where the other two leave ore.
 */
function chooseSelection(job){
    var searched = job.result.selection == null ? [] : job.result.selection;
    var bestFilled = fillGaps(job, searched);
    var best = {selection: bestFilled, score: selectionScore(bestFilled)};
    var source = "search";

    job.candidateScores = {search: best.score};

    var lattice = bestLattice(job);
    job.candidateScores.lattice = lattice.score;
    if(lattice.score > best.score){
        best = lattice;
        source = "lattice";
    }

    var sweeps = Math.max(1, Math.min(job.sweepOrders.length, job.quality));
    job.candidateScores.sweeps = [];
    for(var s = 0; s < sweeps; s++){
        var swept = fillGaps(job, greedySweep(job, job.sweepOrders[s]));
        var sweptScore = selectionScore(swept);
        job.candidateScores.sweeps.push(sweptScore);
        if(sweptScore > best.score){
            best = {selection: swept, score: sweptScore};
            source = "sweep" + s;
        }
    }

    // Deterministic restarts: shuffled candidate orders - the packing style that closes the
    // irregular shapes the axis sweeps and the lattice miss (see buildRestartOrders).
    job.candidateScores.restarts = [];
    for(var r = 0; r < job.restartOrders.length; r++){
        var restarted = fillGaps(job, greedySweep(job, job.restartOrders[r]));
        var restartScore = selectionScore(restarted);
        job.candidateScores.restarts.push(restartScore);
        if(restartScore > best.score){
            best = {selection: restarted, score: restartScore};
            source = "restart" + r;
        }
    }

    return {selection: best.selection, score: best.score, source: source};
}

// ---------------------------------------------------------------------------- diagnostics

/**
 * Why are tiles unreachable? Two causes: no placement fits there at all (solid ground, cliffs,
 * buildings) or the Min Ores / winner-item rule filters every placement out. The toast used to
 * always blame Min Ores, which is wrong on walled-in patches and sent players tuning the wrong
 * setting. Checks up to 60 tiles, only when something is unreachable.
 */
function classifyUnreachable(job){
    if(job.coverable >= job.targetCells) return;

    var entries = job.entries;
    var reachable = {};
    var i = 0, k = 0;
    for(i = 0; i < entries.length; i++){
        var keys = entries[i].mineableKeys;
        for(k = 0; k < keys.length; k++) reachable[keys[k]] = true;
    }

    var size = job.size, half = job.half;
    var lo = -(size - 1 - half), hi = half;
    var checked = 0;
    var ground = 0, minOres = 0;

    for(var key in job.cellFacts){
        if(checked >= 60) break;
        var fact = job.cellFacts[key];
        if(fact === undefined || fact.mineable !== true || reachable[key] === true) continue;
        checked++;

        var cx = key % job.worldW, cy = Math.floor(key / job.worldW);
        var possible = false;
        for(i = lo; i <= hi && !possible; i++){
            for(k = lo; k <= hi; k++){
                if(util.canPlaceBlock(job.drill, job.team, cx + i, cy + k, 0)){
                    possible = true;
                    break;
                }
            }
        }
        if(possible) minOres++; else ground++;
    }

    job.groundBlocked = ground;
    job.minOresBlocked = minOres;
}

// A bounded local repair. The layout families are global constructions, and on irregular vein
// shapes they can end one tile short: the leftover tile is reachable, but every candidate that
// mines it overlaps a placed drill, so the add-only gap filler cannot help and the toast says
// "blocked". Measured on 200 random vein shapes: 15.5% ended exactly one tile short at first,
// every one of them with the cheapest covering candidate blocked by ONE placed drill, and an
// exact solver (tools/vein-solve.py) proved a perfect layout exists. Raising the quality budget
// did not fix most of them (25/200 remained at quality 10), because the miss is a local minimum.
//
// Two moves, both strictly improving, determinstic and bounded:
//   1. swapRepair  - drop the drills blocking a candidate near an uncovered tile, take it, refill
//   2. the deep phase - ruin-and-recreate the neighbourhood, then the swap pass again
var REPAIR_PASSES = 3;
var REPAIR_TRIAL_CAP = 24;
var REPAIR_MAX_BLOCKERS = 3;

// Deep repair: some shapes need their whole neighbourhood rebuilt, not one drill moved. It is
// only worth its cost on the small/medium patches where one tile is visible: on a big patch the
// refills are expensive and a single leftover is noise (measured: an unbounded deep phase made a
// 1,209-tile lane fill take 14 s), so the phase is bounded by size and by total refill work.
var DEEP_REPAIR_MOVES = 2;
var DEEP_REPAIR_RADIUS = 4;
var DEEP_REPAIR_MAX_RUIN = 12;
var DEEP_REPAIR_LEFTOVERS = 3;
var DEEP_REPAIR_SWAP_CAP = 8;
var DEEP_REPAIR_MAX_ENTRIES = 320;
var DEEP_REPAIR_WORK_CAP = 100;

/** The 1-swap pass: candidates ranked by distance to the nearest uncovered tile. */
function swapRepair(job, selection, trialCap){
    var entries = job.entries;
    var best = selection;
    var bestScore = selectionScore(best);
    var trials = 0;

    for(var pass = 0; pass < REPAIR_PASSES && trials < trialCap; pass++){
        // occupancy of the current layout, as a cell -> entry map (a layout never overlaps)
        var placedAt = {};
        var covered = {};
        var i = 0, k = 0, m = 0;
        for(i = 0; i < best.length; i++){
            var entry = best[i];
            for(k = 0; k < entry.cellKeys.length; k++) placedAt[entry.cellKeys[k]] = entry;
            for(k = 0; k < entry.mineableKeys.length; k++) covered[entry.mineableKeys[k]] = true;
        }

        // uncovered tiles, in key order so the pass cannot depend on iteration order
        var leftovers = [];
        var seenLeft = {};
        for(i = 0; i < entries.length; i++){
            var keys = entries[i].mineableKeys;
            for(k = 0; k < keys.length; k++){
                if(covered[keys[k]] === true || seenLeft[keys[k]] === true) continue;
                seenLeft[keys[k]] = true;
                leftovers.push(keys[k]);
            }
        }
        if(leftovers.length === 0) break;
        // insertion sort, no comparator callback: functions that pass nested callbacks into
        // loops are the interpreter's weak spot (see the note above scanCandidates)
        for(i = 1; i < leftovers.length; i++){
            var lv = leftovers[i];
            var lj = i - 1;
            while(lj >= 0 && leftovers[lj] > lv){
                leftovers[lj + 1] = leftovers[lj];
                lj--;
            }
            leftovers[lj + 1] = lv;
        }

        // Rank candidates by their Chebyshev distance to the nearest uncovered tile (drill centre
        // to tile): the one-drill fixes cluster within a few tiles of the hole, so the trial
        // budget is spent on candidates that can reach it instead of walking the patch order.
        var ranked = [];
        for(i = 0; i < entries.length; i++){
            var rankCand = entries[i];
            if(placedAt[api.pos(rankCand.tile)] === rankCand) continue;   // already in the layout
            var cx = api.tx(rankCand.tile), cy = api.ty(rankCand.tile);
            var nearest = -1;
            for(k = 0; k < leftovers.length; k++){
                var lx = leftovers[k] % job.worldW, ly = Math.floor(leftovers[k] / job.worldW);
                var dist = Math.max(cx > lx ? cx - lx : lx - cx, cy > ly ? cy - ly : ly - cy);
                if(nearest < 0 || dist < nearest) nearest = dist;
            }
            ranked.push({d: nearest, entry: rankCand});
        }
        // counting sort by distance (stable, no comparator callback - see the note above)
        var maxD = 0;
        for(i = 0; i < ranked.length; i++){
            if(ranked[i].d > maxD) maxD = ranked[i].d;
        }
        var buckets = [];
        for(i = 0; i <= maxD; i++) buckets.push([]);
        for(i = 0; i < ranked.length; i++) buckets[ranked[i].d].push(ranked[i]);
        ranked = [];
        for(i = 0; i <= maxD; i++){
            for(k = 0; k < buckets[i].length; k++) ranked.push(buckets[i][k]);
        }

        var bestTrial = null;

        for(i = 0; i < ranked.length && trials < trialCap; i++){
            var cand = ranked[i].entry;

            // every placed drill whose footprint blocks this candidate
            var blockers = [];
            var tooMany = false;
            for(m = 0; m < cand.cellKeys.length; m++){
                var placed = placedAt[cand.cellKeys[m]];
                if(placed === undefined) continue;
                var known = false;
                for(var b = 0; b < blockers.length; b++){
                    if(blockers[b] === placed){ known = true; break; }
                }
                if(known) continue;
                blockers.push(placed);
                if(blockers.length > REPAIR_MAX_BLOCKERS){ tooMany = true; break; }
            }
            if(tooMany) continue;

            // trial: drop the blockers, take the candidate, refill the rest of the patch
            var trial = [];
            for(m = 0; m < best.length; m++){
                var keep = true;
                for(b = 0; b < blockers.length; b++){
                    if(best[m] === blockers[b]){ keep = false; break; }
                }
                if(keep) trial.push(best[m]);
            }
            trial.push(cand);
            trial = fillGaps(job, trial);

            trials++;
            var score = selectionScore(trial);
            if(bestTrial == null || score > bestTrial.score){
                bestTrial = {selection: trial, score: score};
            }
        }

        if(bestTrial == null || bestTrial.score <= bestScore) break;
        best = bestTrial.selection;
        bestScore = bestTrial.score;
    }

    return {selection: best, score: bestScore, trials: trials};
}

/**
 * The very last layout pass: placements the Min Ores filter rejected because their footprint
 * can only hold a single ore tile of this patch. A 4x4 (or 3x3) drill at the rim - a tile at
 * the patch edge with the surrounding ground cut off - has no other placement, so at Min Ores 2
 * those tiles are lost even though a drill would physically fit once the layout is final.
 *
 * Nothing else wants the space at this point (the layout is complete), so the candidates are
 * taken greedily: any that still fits the final occupancy and mines at least one ore tile that
 * nothing mines. Strictly add-only and deterministic.
 */
function fillRimGaps(job, selection){
    var occ = {};
    var covered = {};
    var i = 0, k = 0;

    for(var key in job.reserved) occ[key] = true;
    for(key in job.plannedBlocked) occ[key] = true;
    for(i = 0; i < selection.length; i++){
        var cells = selection[i].cellKeys;
        for(k = 0; k < cells.length; k++) occ[cells[k]] = true;
        var mine = selection[i].mineableKeys;
        for(k = 0; k < mine.length; k++) covered[mine[k]] = true;
    }

    var added = [];
    var addedOre = 0;
    for(i = 0; i < job.rimCandidates.length; i++){
        var entry = job.rimCandidates[i];
        var blocked = false;
        var rimCells = entry.cellKeys;
        for(k = 0; k < rimCells.length; k++){
            if(occ[rimCells[k]] === true){
                blocked = true;
                break;
            }
        }
        if(blocked) continue;

        var gain = 0;
        var rimMine = entry.mineableKeys;
        for(k = 0; k < rimMine.length; k++){
            if(covered[rimMine[k]] !== true) gain++;
        }
        if(gain === 0) continue;

        added.push(entry);
        addedOre += gain;
        for(k = 0; k < rimCells.length; k++) occ[rimCells[k]] = true;
        for(k = 0; k < rimMine.length; k++) covered[rimMine[k]] = true;
    }

    if(added.length === 0) return null;

    var out = selection.slice();
    for(i = 0; i < added.length; i++) out.push(added[i]);
    return {selection: out, score: selectionScore(out), drills: added.length, ore: addedOre};
}

/**
 * The full repair: the 1-swap pass, then the deep phase for the shapes that need their whole
 * neighbourhood rebuilt. Deterministic, bounded, strictly improving only.
 */
function repairSelection(job, selection){
    var entries = job.entries;
    var swap = swapRepair(job, selection, REPAIR_TRIAL_CAP);
    var best = swap.selection;
    var bestScore = swap.score;
    var trials = swap.trials;
    var deepMoves = 0;

    // ---- deep repair: rebuild the neighbourhood around a leftover (ruin-and-recreate) ----
    // Skipped on big patches: the refills cost more than the tile is worth there.
    var deepWork = 0;
    for(var move = 0; move < DEEP_REPAIR_MOVES && entries.length <= DEEP_REPAIR_MAX_ENTRIES; move++){
        var dcovered = {};
        var di = 0, dk = 0;
        for(di = 0; di < best.length; di++){
            var dkeys = best[di].mineableKeys;
            for(dk = 0; dk < dkeys.length; dk++) dcovered[dkeys[dk]] = true;
        }

        var dleft = [];
        var dseen = {};
        for(di = 0; di < entries.length; di++){
            dkeys = entries[di].mineableKeys;
            for(dk = 0; dk < dkeys.length; dk++){
                if(dcovered[dkeys[dk]] === true || dseen[dkeys[dk]] === true) continue;
                dseen[dkeys[dk]] = true;
                dleft.push(dkeys[dk]);
            }
        }
        if(dleft.length === 0) break;
        dleft.sort(function(a, b){ return a - b; });
        debugLog("deep repair: leftovers=" + dleft.length + " bestScore=" + bestScore);

        var deepTrial = null;
        for(di = 0; di < dleft.length && di < DEEP_REPAIR_LEFTOVERS && deepWork < DEEP_REPAIR_WORK_CAP; di++){
            var tile = dleft[di];
            var tileX = tile % job.worldW, tileY = Math.floor(tile / job.worldW);

            // the ruin window: every placed drill whose footprint touches the area around it
            var window = {};
            for(var wdx = -DEEP_REPAIR_RADIUS - 2; wdx <= DEEP_REPAIR_RADIUS + 2; wdx++){
                for(var wdy = -DEEP_REPAIR_RADIUS - 2; wdy <= DEEP_REPAIR_RADIUS + 2; wdy++){
                    window[(tileX + wdx) + (tileY + wdy) * job.worldW] = true;
                }
            }
            var doomed = [];
            var tooMany = false;
            for(dk = 0; dk < best.length; dk++){
                var bkeys = best[dk].cellKeys;
                var touches = false;
                for(var bk = 0; bk < bkeys.length; bk++){
                    if(window[bkeys[bk]] === true){ touches = true; break; }
                }
                if(!touches) continue;
                doomed.push(best[dk]);
                if(doomed.length > DEEP_REPAIR_MAX_RUIN){ tooMany = true; break; }
            }
            if(tooMany || doomed.length === 0) continue;
            debugLog("deep repair: tile=" + tileX + "," + tileY + " doomed=" + doomed.length);

            var base = [];
            for(dk = 0; dk < best.length; dk++){
                var dropIt = false;
                for(bk = 0; bk < doomed.length; bk++){
                    if(best[dk] === doomed[bk]){ dropIt = true; break; }
                }
                if(!dropIt) base.push(best[dk]);
            }

            for(var oi = 0; oi < job.deepOrders.length && deepWork < DEEP_REPAIR_WORK_CAP; oi++){
                var dtrial = greedyInsert(job, job.deepOrders[oi], base);
                dtrial = fillGaps(job, dtrial);
                deepWork += 2;               // the refill above, plus the trial's inserts

                // the swap pass again over the rebuilt neighbourhood: the plain recreate packs
                // the window but can still leave the one tile; measured, this step is what
                // closes the stubborn shapes
                var dtrialSwap = swapRepair(job, dtrial, DEEP_REPAIR_SWAP_CAP);
                deepWork += dtrialSwap.trials;
                trials += dtrialSwap.trials;
                if(deepTrial == null || dtrialSwap.score > deepTrial.score){
                    deepTrial = {selection: dtrialSwap.selection, score: dtrialSwap.score};
                }
            }
        }

        debugLog("deep repair: trial=" + (deepTrial == null ? "none" : deepTrial.score) + " best=" + bestScore);
        if(deepTrial == null || deepTrial.score <= bestScore) break;
        best = deepTrial.selection;
        bestScore = deepTrial.score;
        deepMoves++;
        debugLog("deep repair: move " + deepMoves + " bestScore=" + bestScore);
    }

    job.repairDeep = deepMoves;
    job.repairTrials = trials;
    return {selection: best, score: bestScore};
}

// ---------------------------------------------------------------------------- finish

function finish(job){
    var selection = [];
    var score = 0;
    var source = "none";
    var covered = 0, unreachable = 0, blocked = 0;

    if(prepareDone(job) && !job.cancelled){
        var chosen = chooseSelection(job);

        // local repair: the families are global constructions and can end one tile short on
        // awkward shapes; this swaps the single blocking drill out (see repairSelection)
        var repaired = repairSelection(job, chosen.selection);
        if(repaired.score > chosen.score){
            job.repairGain = repaired.score - chosen.score;
            chosen = {selection: repaired.selection, score: repaired.score, source: chosen.source + "+repair"};
        }

        // Rim fallback: a rim tile whose only placement holds a single ore tile was dropped by
        // the Min Ores filter, so no layout family can ever cover it (see fillRimGaps). Take
        // those placements now that the layout is final - the drill fits, nothing else wants
        // the space, and the tile would otherwise never be mined.
        if(chosen.score < job.targetCells && job.rimCandidates.length > 0){
            var rimmed = fillRimGaps(job, chosen.selection);
            if(rimmed != null && rimmed.score > chosen.score){
                job.rimGain = rimmed.score - chosen.score;
                job.rimDrills = rimmed.drills;
                // those tiles were reachable after all - through a placement Min Ores hides
                job.coverable += job.rimGain;
                chosen = {selection: rimmed.selection, score: rimmed.score, source: chosen.source + "+rim"};
            }
        }

        selection = chosen.selection;
        score = chosen.score;
        source = chosen.source;

        covered = score;
        unreachable = Math.max(0, job.targetCells - job.coverable);
        blocked = Math.max(0, job.coverable - covered);
    }

    // What is already on the patch: buildings (a drill that was built since the last fill, a
    // node a player placed) and the plans of our own last fill. Either is why a second fill
    // covers "only a few ores" - it is filling the gaps, not the patch.
    var alreadyBuilt = 0;
    var i = 0;
    for(i in job.builtCells) alreadyBuilt++;

    var alreadyPlanned = 0;
    for(i in job.plannedBlocked){
        var plannedTile = api.tile(i % job.worldW, Math.floor(i / job.worldW));
        if(plannedTile != null && api.itemId(api.drop(plannedTile)) === job.sourceDropId) alreadyPlanned++;
    }

    var team = job.team;
    var allPlans = [];
    var occupied = {};

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

    var support = job.withSupport && api.settingBool(KEY_SUPPORT, true);

    // The player's grid is looked up first: the node network is aligned to it, so the two
    // link up instead of needing a chain bolted on afterwards.
    var powerTarget = null;
    if(support && selection.length > 0){
        var centreTile = selection[Math.floor(selection.length / 2)].tile;
        powerTarget = api.powerTargetNear(api.tx(centreTile), api.ty(centreTile), POWER_LINK_RADIUS);
    }

    var info = support ? powerSupport() : null;
    var counts = support
        ? placeWaterExtractorsAndPowerNodes(job, selection, job.drill, team, allPlans, occupied, powerTarget)
        : null;

    if(support && job.lanes && info != null){
        var laneResult = placeLaneSupplies(job, team, allPlans, occupied, info);
        counts.lanes = laneResult.belts;
        counts.nodes = (counts.nodes === undefined ? 0 : counts.nodes) + laneResult.nodes;
    }
    var linked = 0;
    if(support && !job.lanes){
        linked += stitchPowerNetwork(job, allPlans, occupied, info);
        linked += linkPowerGrid(job, allPlans, occupied, selection, powerTarget, info);
    }else if(support && info != null){
        // lanes: the network on the lanes is connected by construction, but it used to stop
        // there - the patch never reached the player's grid. Chain it the same way.
        linked += linkPowerGrid(job, allPlans, occupied, selection, powerTarget, info);
    }

    var routed = routeOutputs(job, allPlans, occupied);

    var extractorCount = counts == null ? 0 : counts.extractors;
    var nodeCount = counts == null ? 0 : counts.nodes;
    var laneCount = counts == null || counts.lanes === undefined ? 0 : counts.lanes;

    // a drill dropped for a power bridge is no longer mined, so the coverage report is honest
    covered = Math.max(0, covered - job.powerRemovedOre);
    var drillCount = Math.max(0, selection.length - job.powerRemovedDrills);
    var oreWord = api.itemName(job.sourceDropId);
    if(oreWord == null) oreWord = "ore";

    job.stats = {
        source: source,
        candidateScores: job.candidateScores,
        repairGain: job.repairGain == null ? 0 : job.repairGain,
        rimGain: job.rimGain == null ? 0 : job.rimGain,
        repairTrials: job.repairTrials == null ? 0 : job.repairTrials,
        repairDeep: job.repairDeep == null ? 0 : job.repairDeep,
        extractors: extractorCount,
        nodes: nodeCount,
        powerName: counts == null || counts.powerName == null ? "power nodes" : counts.powerName,
        linkNodes: linked,
        reserved: job.reservedNodes.length,
        covered: covered,
        target: job.targetCells,
        unreachable: unreachable,
        blocked: blocked,
        drills: drillCount,
        alreadyBuilt: alreadyBuilt,
        alreadyPlanned: alreadyPlanned,
        otherOres: job.otherOres,
        plans: allPlans.length,
        candidates: job.entries.length,
        truncated: job.truncated === true,
        stopped: job.cancelled ? "cancel" : (job.aborted ? "time" : (job.exhausted ? "budget" : "no"))
    };

    // ---- feedback ----
    if(job.cancelled){
        api.toast("[AutoDrill v" + api.modVersion() + "] planning cancelled");
    }else{
        if(job.exhausted){
            api.toast("[AutoDrill v" + api.modVersion() + "] quality limit reached (" + job.placements + " layouts explored) - raise Optimization Quality for better results");
        }else if(job.aborted){
            api.toast("[AutoDrill v" + api.modVersion() + "] search stopped after " + SEARCH_BUDGET_MS + " ms - lower Optimization Quality for faster results");
        }

        if(selection.length > 0){
            // What was planned, in one line: the fill is otherwise only visible as build
            // ghosts, which is how "does the mod do water and power?" gets asked.
            var summary = drillCount + (drillCount === 1 ? " drill" : " drills");
            if(extractorCount > 0) summary += " + " + extractorCount + " water extractors";
            if(nodeCount > 0) summary += " + " + nodeCount + " " + job.stats.powerName;
            if(laneCount > 0) summary += " + " + laneCount + " belt tiles";
            if(linked > 0) summary += " (" + linked + " more wiring them to your grid)";
            api.toast("[AutoDrill v" + api.modVersion() + "] planned " + summary);
        }

        if(allPlans.length === 0 && alreadyPlanned > 0){
            api.toast("[AutoDrill v" + api.modVersion() + "] the patch is already planned from your last fill ("
                + alreadyPlanned + " ore tiles) - nothing to add");
        }else if(allPlans.length === 0 && job.entries.length === 0 && job.targetCells > 0){
            // nothing fits at all: say which reason, because "lower Min Ores" and "walls in the
            // way" ask for opposite actions
            var groundReason = job.groundBlocked == null ? 0 : job.groundBlocked;
            var oresReason = job.minOresBlocked == null ? 0 : job.minOresBlocked;
            api.toast("[AutoDrill v" + api.modVersion() + "] no room for a " + api.blockName(job.drill)
                + " here - " + (oresReason > 0 && groundReason === 0
                    ? "no placement reaches Min Ores, lower it to fill"
                    : "every placement is blocked (walls or buildings)"));
        }else if(allPlans.length === 0 && job.entries.length > 0){
            api.toast("[AutoDrill v" + api.modVersion() + "] nothing could be placed here - is this inside your build range?");
        }else if(drillCount > 0){
            // Always say what the fill did. A patch that looks half filled is usually a patch
            // that already has buildings on it (a second tap fills the gaps), or a mixed patch
            // where only the tapped ore is covered - both are worth stating outright.
            if(covered < job.targetCells && alreadyBuilt > 0){
                api.toast("[AutoDrill v" + api.modVersion() + "] mined " + covered + " of " + job.targetCells + " free "
                    + oreWord + " tiles - " + alreadyBuilt + " tiles already have buildings on them");
            }else if(covered < job.targetCells){
                var why = null;
                if(job.truncated){
                    why = "the patch is larger than Max Tiles (" + job.maxTiles
                        + ") - the fill covers the part nearest your tap, raise Max Tiles for the rest";
                }else if(job.lanes){
                    why = "the rest is the belt lanes that carry the belts, power and water"
                        + " (turn off Build Belt Lanes to fill every tile instead)";
                }else if(job.reservedNodes.length > 0){
                    why = "the rest is kept free for the power blocks (turn off Water & Power Support to fill every tile)";
                }else if(alreadyPlanned > 0){
                    why = alreadyPlanned + " tiles are already planned from your last fill";
                }else if(unreachable > 0){
                    var unreachGround = job.groundBlocked == null ? 0 : job.groundBlocked;
                    var unreachOres = job.minOresBlocked == null ? 0 : job.minOresBlocked;
                    if(unreachGround > 0 && unreachOres === 0){
                        why = unreachable + " tiles have no room for a drill (walls or buildings in the way)";
                    }else if(unreachOres > 0 && unreachGround === 0){
                        why = unreachable + " out of reach (lower Min Ores)";
                    }else if(unreachGround > 0 && unreachOres > 0){
                        why = unreachable + " out of reach (" + unreachOres + " need a lower Min Ores, "
                            + unreachGround + " have no room for a drill)";
                    }else{
                        why = unreachable + " out of reach (lower Min Ores)";
                    }
                }else{
                    why = blocked + " blocked (raise Optimization Quality)";
                }

                api.toast("[AutoDrill v" + api.modVersion() + "] mined " + covered + " of " + job.targetCells + " " + oreWord
                    + " tiles - " + why);
            }else{
                api.toast("[AutoDrill v" + api.modVersion() + "] mined all " + covered + " " + oreWord + " tiles here"
                    + (job.truncated
                        ? " - but the patch is larger than Max Tiles (" + job.maxTiles
                            + "), so only the part nearest your tap was filled"
                        : "")
                    + (routed > 0 ? " (+" + routed + " routing tiles)" : ""));
            }

            // other ore under the same patch, which this fill does not cover by design
            var otherName = null, otherCount = 0;
            for(var otherId in job.otherOres){
                if(job.otherOres[otherId] > otherCount){
                    otherCount = job.otherOres[otherId];
                    otherName = api.itemName(otherId | 0);
                }
            }
            if(otherName != null && otherCount >= 5){
                api.toast("[AutoDrill v" + api.modVersion() + "] note: this patch also has " + otherName + " (" + otherCount
                    + " tiles) - a fill only covers the ore you tap, so tap a " + otherName
                    + " tile for those");
            }
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
 * A water extractor for the liquid boost of every optimised drill that can have one - on water
 * or ground water, never on dry land where it would do nothing - and the power network the
 * patch needs. Everything is placed through the occupancy map, so nothing overlaps and the pass
 * stays linear in the number of drills.
 */
function placeWaterExtractorsAndPowerNodes(job, selection, drill, team, allPlans, occupied, powerTarget){
    var waterExtractor = api.block("waterExtractor");
    var drillSize = api.size(drill);
    var info = powerSupport();
    var i = 0, j = 0;
    var extractors = 0;

    // Hold the reserved tiles first: nothing else may take the spots the power blocks need.
    // A separate map of where the drills are is kept too, because the occupancy map holds one
    // flag per cell: releasing a reserved tile would release a drill's tile with it.
    var drillCells = {};
    for(i = 0; i < allPlans.length; i++){
        var planBlock = allPlans[i].block;
        if(planBlock === drill || api.size(planBlock) > 1){
            util.markOccupancy(drillCells, planBlock, allPlans[i].x, allPlans[i].y, true);
        }
    }

    if(info != null){
        for(i = 0; i < job.reservedNodes.length; i++){
            var spot = job.reservedNodes[i];
            util.markOccupancy(occupied, info.block, spot.x, spot.y, true);
        }
    }

    // Water extractors are Serpulo's liquid boost; Erekir's liquids are handled by their own
    // pass (vent condensers and conduits).
    if(!api.isErekir()) for(i = 0; i < selection.length; i++){
        var tile = selection[i].tile;
        var nearby = util.nearbyTiles(api.tx(tile), api.ty(tile), drillSize, api.size(waterExtractor));

        // Among the valid spots, take the one with the most ground water: the extractor's
        // output depends on that attribute, and the original took whatever came first.
        var best = null, bestWater = -1e9;
        for(j = 0; j < nearby.length; j++){
            var plan = util.newPlan(api.tx(nearby[j]), api.ty(nearby[j]), 0, waterExtractor);
            if(!util.canPlacePlan(plan, team)) continue;
            if(!util.freeInOccupancy(occupied, waterExtractor, plan.x, plan.y)) continue;

            // Only where it would actually pump: standing water under it, or ground water.
            // (The original placed one next to every drill whenever the tile was free, dry or
            // not, which is why filled patches ended up with useless extractors on stone.)
            if(!api.pumpsWaterAt(waterExtractor, plan.x, plan.y, team)) continue;

            var water = api.waterAt(nearby[j]);
            if(water > bestWater){
                bestWater = water;
                best = plan;
            }
        }
        if(best != null){
            allPlans.push(best);
            util.markOccupancy(occupied, waterExtractor, best.x, best.y, true);
            extractors++;
        }
    }

    // With lanes on, the power rides the lanes (placeLaneSupplies does that afterwards); the
    // lattice of nodes beside the drills would only take the very tiles the belts need.
    var nodes = job.lanes
        ? 0
        : placePowerNodes(job, selection, drill, team, allPlans, occupied, powerTarget, info, drillCells);

    return {extractors: extractors, nodes: nodes, powerName: info == null ? null : powerName(info)};
}

/**
 * The power network over the fill: nodes on the lattice reserved before the layout, so the
 * drills left room for them.
 *
 * Nodes link wirelessly within `powerNode.laserRange`, and the lattice is spaced `range/sqrt(2)`
 * apart, so every tile of the patch - and therefore every drill on it - is within reach of a
 * node, and every node is within reach of its neighbours. A reserved tile that something else
 * ended up on is shifted a tile or two, because dropping it would leave a hole wider than link
 * range and split the network.
 *
 * The original placed one node per drill whenever a free ring tile was left over. In a dense
 * fill those rings are shared, so most drills got no node at all and the few that did ended up
 * isolated - the patch looked wired but nothing was powered.
 *
 * A drill the lattice still misses - a shifted node that moved away, say - gets a node next to
 * it, preferring a spot that is already inside the network.
 */
function placePowerNodes(job, selection, drill, team, allPlans, occupied, powerTarget, info, drillCells){
    var powerNode = info == null ? null : info.block;
    var range = info == null ? 0 : info.range;
    var drillSize = api.size(drill);
    var i = 0, j = 0;
    var placed = [];

    if(powerNode == null || range < 2 || selection.length === 0) return 0;

    var held = 0;
    for(i = 0; i < job.reservedNodes.length; i++){
        var want = job.reservedNodes[i];

        // the tile is held for this block; release it so the block itself can take it, unless a
        // drill ended up covering it (then the mark is the drill's, not the reservation's)
        if(drillCells != null && drillCells[want.x + want.y * job.worldW] === true){
            held++;
            continue;
        }
        util.markOccupancy(occupied, powerNode, want.x, want.y, false);
        var spot = findNodeSpot(want.x, want.y, team, powerNode, occupied);

        // the spot found may be a tile another reservation holds: leave it alone
        if(spot != null && job.reserved[spot.x + spot.y * job.worldW] === true
            && (spot.x !== want.x || spot.y !== want.y)) spot = null;
        if(spot == null){
            held++;
            continue;
        }

        var plan = util.newPlan(spot.x, spot.y, 0, powerNode);
        allPlans.push(plan);
        util.markOccupancy(occupied, powerNode, spot.x, spot.y, true);
        placed.push({x: spot.x, y: spot.y});
    }

    if(held > 0) debugLog("power: " + held + " reserved tiles could not take a block");

    // repair: a drill out of reach of every node gets one on its ring
    for(i = 0; i < selection.length; i++){
        var drillTile = selection[i].tile;
        var dx = api.tx(drillTile), dy = api.ty(drillTile);
        var covered = false;

        if(powerTarget != null && inRange(dx, dy, api.tx(powerTarget), api.ty(powerTarget), range)) covered = true;

        for(j = 0; j < placed.length && !covered; j++){
            if(inRange(dx, dy, placed[j].x, placed[j].y, range)) covered = true;
        }
        if(covered) continue;

        // Prefer a ring tile that is already inside the network: a repair node placed out of
        // reach would power its drill but dangle off the grid.
        var nearby = util.nearbyTiles(dx, dy, drillSize, api.size(powerNode));
        var chosen = null;

        for(j = 0; j < nearby.length && chosen == null; j++){
            var fixX = api.tx(nearby[j]), fixY = api.ty(nearby[j]);
            var fix = util.newPlan(fixX, fixY, 0, powerNode);
            if(!util.canPlacePlan(fix, team)) continue;
            if(!util.freeInOccupancy(occupied, powerNode, fixX, fixY)) continue;

            var joined = powerTarget != null && inRange(fixX, fixY, api.tx(powerTarget), api.ty(powerTarget), range);
            for(var k = 0; k < placed.length && !joined; k++){
                if(inRange(fixX, fixY, placed[k].x, placed[k].y, range)) joined = true;
            }
            if(joined) chosen = {x: fixX, y: fixY};
        }

        if(chosen == null){
            // nothing that could join the network: power the drill anyway
            for(j = 0; j < nearby.length; j++){
                var fallback = util.newPlan(api.tx(nearby[j]), api.ty(nearby[j]), 0, powerNode);
                if(!util.canPlacePlan(fallback, team)) continue;
                if(!util.freeInOccupancy(occupied, powerNode, fallback.x, fallback.y)) continue;
                chosen = {x: fallback.x, y: fallback.y};
                break;
            }
        }

        if(chosen != null){
            allPlans.push(util.newPlan(chosen.x, chosen.y, 0, powerNode));
            util.markOccupancy(occupied, powerNode, chosen.x, chosen.y, true);
            placed.push({x: chosen.x, y: chosen.y});
        }
    }

    return placed.length;
}

/** Nearest free, placeable tile to (x, y), searched in rings. Null when there is none nearby. */
function findNodeSpot(x, y, team, powerNode, occupied){
    var direct = util.newPlan(x, y, 0, powerNode);
    if(util.canPlacePlan(direct, team) && util.freeInOccupancy(occupied, powerNode, x, y)) return {x: x, y: y};

    for(var r = 1; r <= 2; r++){
        for(var dx = -r; dx <= r; dx++){
            for(var dy = -r; dy <= r; dy++){
                if(Math.max(dx < 0 ? -dx : dx, dy < 0 ? -dy : dy) !== r) continue;
                var plan = util.newPlan(x + dx, y + dy, 0, powerNode);
                if(util.canPlacePlan(plan, team)
                    && util.freeInOccupancy(occupied, powerNode, x + dx, y + dy)){
                    return {x: x + dx, y: y + dy};
                }
            }
        }
    }
    return null;
}

/** Tile-centre distance test - power links are wireless and measured between block centres. */
function inRange(ax, ay, bx, by, range){
    var dx = ax - bx, dy = ay - by;
    return dx * dx + dy * dy <= range * range;
}

var POWER_LINK_RADIUS = 90;      // how far away something on a power grid is still worth wiring to

/**
 * Places a chain of link blocks from (fromX, fromY) to (toX, toY) over tiles a block can
 * actually sit on, spaced so every hop stays inside link range. Returns how many were placed.
 */
function chainBetween(job, allPlans, occupied, fromX, fromY, toX, toY, info, centrePlans){
    var block = info.linkBlock;
    var range = Math.floor(linkRange(info, block));
    if(range < 2) return 0;

    var step = Math.max(2, range - 2);
    var distance = Math.abs(toX - fromX) + Math.abs(toY - fromY);
    var budget = 400 + distance * 8;

    // First look for a route that avoids our own plans; if there is none (the drill field can
    // be solid), look again ignoring them, because the placer below may clear a drill or two.
    var path = util.findDuctPath(api.tile(fromX, fromY), [api.tile(toX, toY)], block, job.team,
        budget, occupied);
    if(path == null){
        path = util.findDuctPath(api.tile(fromX, fromY), [api.tile(toX, toY)], block, job.team,
            budget, null);
    }
    if(path == null) return 0;

    var placed = 0;
    var lastX = fromX, lastY = fromY;
    var i = 0;

    for(i = 0; i < path.length; i++){
        var t = path[i];

        var toTargetX = toX - lastX, toTargetY = toY - lastY;
        if(toTargetX * toTargetX + toTargetY * toTargetY <= range * range) break;

        var fromLastX = t.x - lastX, fromLastY = t.y - lastY;
        if(fromLastX * fromLastX + fromLastY * fromLastY < step * step && i < path.length - 1) continue;

        var plan = util.newPlan(t.x, t.y, 0, block);
        if(!util.canPlacePlan(plan, job.team)) continue;

        if(!util.freeInOccupancy(occupied, block, t.x, t.y)){
            // The only way through can run across our own drills, because the tile that has to
            // carry the link block is exactly where a drill would have gone. A bridge through
            // the power network is worth one drill there; anything else is not touched.
            if(centrePlans == null) continue;
            var blocker = centrePlans[t.x + t.y * job.worldW];
            if(blocker == null) continue;

            removePlan(allPlans, occupied, blocker);
            centrePlans[t.x + t.y * job.worldW] = null;
            job.powerRemovedDrills++;
            if(job.candidateAt != null){
                var dropped = job.candidateAt[t.x + t.y * job.worldW];
                if(dropped != null) job.powerRemovedOre += dropped.mineableKeys.length;
            }
        }

        allPlans.push(plan);
        util.markOccupancy(occupied, block, t.x, t.y, true);
        lastX = t.x;
        lastY = t.y;
        placed++;
    }

    return placed;
}

/** Drops a planned block again (used when the power network has to cross it). */
function removePlan(allPlans, occupied, plan){
    for(var i = 0; i < allPlans.length; i++){
        if(allPlans[i] === plan){
            allPlans.splice(i, 1);
            break;
        }
    }
    util.markOccupancy(occupied, plan.block, plan.x, plan.y, false);
}

/** True when a plan is one of the power blocks this fill uses. */
function isPowerPlan(plan, info){
    return plan.block === info.block || plan.block === info.linkBlock;
}

/** Every power block the fill planned, as plain {x, y} pairs. */
function powerBlocks(allPlans, info){
    var blocks = [];
    for(var i = 0; i < allPlans.length; i++){
        if(isPowerPlan(allPlans[i], info)) blocks.push({x: allPlans[i].x, y: allPlans[i].y});
    }
    return blocks;
}

/** Groups blocks into networks: two are in the same network when one links to the other. */
function powerNetworks(blocks, range){
    var label = new Array(blocks.length);
    var count = 0;
    var i = 0, k = 0;

    for(i = 0; i < blocks.length; i++){
        if(label[i] !== undefined) continue;

        var queue = [i];
        label[i] = count;
        while(queue.length > 0){
            var current = queue.pop();
            for(k = 0; k < blocks.length; k++){
                if(label[k] !== undefined) continue;
                if(inRange(blocks[current].x, blocks[current].y, blocks[k].x, blocks[k].y, range)){
                    label[k] = count;
                    queue.push(k);
                }
            }
        }
        count++;
    }
    return {labels: label, count: count};
}

/**
 * The biggest network, which everything else gets bridged to.
 *
 * NOTE: counted with plain comparisons rather than a counts array. `counts[labels[i]]++` over
 * an array sized at runtime makes Rhino's optimizer emit invalid bytecode for the whole module
 * ("Stack underflow: -1"), which breaks the mod on desktop/Android while running fine on iOS.
 * tools/compile-check.sh catches that class of breakage.
 */
function largestNetwork(labels, count){
    var trunk = 0;
    var i = 0, k = 0;

    for(i = 0; i < count; i++){
        var mine = 0;
        var other = 0;
        for(k = 0; k < labels.length; k++){
            if(labels[k] === i) mine++;
            if(labels[k] === trunk) other++;
        }
        if(mine > other) trunk = i;
    }
    return trunk;
}

/** The closest pair of blocks between the trunk network and anything outside it. */
function closestNetworkPair(blocks, labels, trunk){
    var from = -1, to = -1, best = 0;
    var i = 0, k = 0;

    for(i = 0; i < blocks.length; i++){
        if(labels[i] === trunk) continue;
        for(k = 0; k < blocks.length; k++){
            if(labels[k] !== trunk) continue;

            var dx = blocks[i].x - blocks[k].x, dy = blocks[i].y - blocks[k].y;
            var d = dx * dx + dy * dy;
            if(from < 0 || d < best){
                best = d;
                from = i;
                to = k;
            }
        }
    }
    return {from: from, to: to};
}

/** tile key -> the plan whose centre is on it, for finding what a bridge has to cross. */
function centrePlansOf(allPlans, worldW){
    var centrePlans = {};
    for(var i = 0; i < allPlans.length; i++){
        centrePlans[allPlans[i].x + allPlans[i].y * worldW] = allPlans[i];
    }
    return centrePlans;
}

/**
 * Makes the power blocks one network. Shifting a block a tile or two to take a cheaper tile -
 * and skipping the ones whose tile became unavailable - can leave groups of blocks further
 * apart than link range, which would silently split the patch into separate grids.
 *
 * Groups are merged by placing one block between the two closest blocks of the two groups,
 * which is inside link range of both. If the tile that has to carry it is one of our own
 * drills, the drill goes: a bridge through the power network is worth a drill, and the report
 * counts what that cost.
 */
function stitchPowerNetwork(job, allPlans, occupied, info){
    var range = info.range;
    var block = info.linkBlock;
    var bridged = 0;

    for(var pass = 0; pass < 8; pass++){
        var blocks = powerBlocks(allPlans, info);
        if(blocks.length < 2) break;

        var networks = powerNetworks(blocks, range);
        if(networks.count < 2) break;

        var trunk = largestNetwork(networks.labels, networks.count);
        var pair = closestNetworkPair(blocks, networks.labels, trunk);
        if(pair.from < 0) break;

        var midX = Math.round((blocks[pair.from].x + blocks[pair.to].x) / 2);
        var midY = Math.round((blocks[pair.from].y + blocks[pair.to].y) / 2);

        if(!placeBridge(job, allPlans, occupied, centrePlansOf(allPlans, job.worldW), block, range,
            midX, midY, blocks[pair.from], blocks[pair.to])){
            break;      // nowhere to put it: leave the rest to the player rather than loop
        }
        bridged++;
    }

    if(bridged > 0){
        debugLog("power: bridged " + bridged + " gaps, removed " + job.powerRemovedDrills + " drills");
    }
    return bridged;
}

/** Places a link block near (x, y) - searching rings, clearing a drill if needed. */
function placeBridge(job, allPlans, occupied, centrePlans, block, range, x, y, from, to){
    for(var r = 0; r <= 3; r++){
        for(var dx = -r; dx <= r; dx++){
            for(var dy = -r; dy <= r; dy++){
                if(Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;

                var px = x + dx, py = y + dy;
                var plan = util.newPlan(px, py, 0, block);
                if(!util.canPlacePlan(plan, job.team)) continue;

                // keep the bridge in range of both ends it is joining
                if(!inRange(px, py, from.x, from.y, range)) continue;
                if(to != null && !inRange(px, py, to.x, to.y, range)) continue;

                if(!util.freeInOccupancy(occupied, block, px, py)){
                    var blocker = centrePlans[px + py * job.worldW];
                    if(blocker == null) continue;
                    removePlan(allPlans, occupied, blocker);
                    centrePlans[px + py * job.worldW] = null;
                    job.powerRemovedDrills++;
                    if(job.candidateAt != null){
                        var dropped = job.candidateAt[px + py * job.worldW];
                        if(dropped != null) job.powerRemovedOre += dropped.mineableKeys.length;
                    }
                }

                allPlans.push(plan);
                util.markOccupancy(occupied, block, px, py, true);
                centrePlans[px + py * job.worldW] = plan;
                return true;
            }
        }
    }
    return false;
}

/**
 * Wires the fill into the player's power grid: a chain of power nodes from the nodes the fill
 * already placed to the nearest building that carries power. Links are wireless within
 * `powerNode.laserRange`, so the chain only needs a node every few tiles.
 *
 * Without this the drills are powered from each other and from nothing else - which is why a
 * freshly filled patch sat dead until it was wired by hand. Stops silently when there is no
 * power anywhere near the patch (an early-game base has none), leaving that to the player.
 *
 * Returns the number of extra nodes placed.
 */
function linkPowerGrid(job, allPlans, occupied, selection, target, info){
    if(selection.length === 0 || target == null || info == null) return 0;

    var i = 0;

    var own = [];
    var powerIds = {};
    powerIds[api.blockId(info.block)] = true;
    powerIds[api.blockId(info.linkBlock)] = true;

    for(i = 0; i < allPlans.length; i++){
        if(powerIds[api.blockId(allPlans[i].block)] === true) own.push(allPlans[i]);
    }
    if(own.length === 0) return 0;

    var range = Math.floor(linkRange(info, info.linkBlock));
    if(range < 2) return 0;

    var targetX = api.tx(target), targetY = api.ty(target);

    // start from the fill's own node closest to the grid
    var start = null, startDist = 0;
    for(i = 0; i < own.length; i++){
        var dx = own[i].x - targetX, dy = own[i].y - targetY;
        var d = dx * dx + dy * dy;
        if(start == null || d < startDist){
            start = own[i];
            startDist = d;
        }
    }
    if(start == null) return 0;
    if(startDist <= range * range) return 0;    // already inside the grid's reach

    return chainBetween(job, allPlans, occupied, start.x, start.y, targetX, targetY, info);
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
