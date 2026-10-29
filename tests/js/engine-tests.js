// Engine checks: the guarantees the fill is supposed to give, asserted outside the game.
//
// These are not smoke tests - each one encodes a promise the fill makes to the player:
//   * the whole patch is seen (no silent truncation, and truncation is reported),
//   * every ore tile that a drill can reach is actually mined,
//   * no free candidate is left that could mine one more ore tile (the gap filler),
//   * nothing overlaps anything,
//   * the same patch fills the same way twice.
//
// Run by tools/engine-tests.sh (fake world, seconds, no game).

"use strict";

var api = require("api");
var optimization = require("optimization");

var S = AUTODRILL_FAKE_SCENARIO;
var W = S.world;

var passed = 0, failed = 0;

function check(name, ok, detail){
    if(ok){
        passed++;
        java.lang.System.out.println("CHECK ok   " + name + (detail == null ? "" : "  [" + detail + "]"));
    }else{
        failed++;
        java.lang.System.out.println("CHECK FAIL " + name + (detail == null ? "" : "  [" + detail + "]"));
    }
}

function info(text){
    java.lang.System.out.println("INFO " + text);
}

// ---------------------------------------------------------------- world helpers

function oreCells(shape){
    var set = {};
    var cx = (shape.oreX0 + shape.x1) / 2, cy = (shape.oreY0 + shape.y1) / 2;
    var r = Math.min(shape.x1 - shape.oreX0, shape.y1 - shape.oreY0) / 2;
    for(var i = shape.oreX0; i <= shape.x1; i++){
        for(var j = shape.oreY0; j <= shape.y1; j++){
            if(shape.round === true){
                var d = (i - cx) * (i - cx) + (j - cy) * (j - cy);
                if(d > r * r * 0.8) continue;
            }
            set[i + j * W] = true;
        }
    }
    return set;
}

function centreOf(shape){
    return {x: Math.floor((shape.oreX0 + shape.x1) / 2), y: Math.floor((shape.oreY0 + shape.y1) / 2)};
}

/** Ore cells under the drill plans, plus the drill count. */
function coverageOf(shape, plans, drill){
    var ore = oreCells(shape);
    var total = 0;
    for(var o in ore) total++;

    var size = api.size(drill);
    var offset = Math.floor((size - 1) / 2);
    var seen = {};
    var drills = 0;

    for(var i = 0; i < plans.length; i++){
        var p = plans[i];
        if(api.blockId(p.block) !== api.blockId(drill)) continue;
        drills++;
        for(var dx = 0; dx < size; dx++){
            for(var dy = 0; dy < size; dy++){
                var key = (p.x - offset + dx) + (p.y - offset + dy) * W;
                if(ore[key] === true) seen[key] = true;
            }
        }
    }

    var covered = 0;
    for(var k in seen) covered++;
    return {covered: covered, total: total, drills: drills};
}

/** Number of plan cells that two plans both claim. Zero means nothing overlaps. */
function overlapCells(plans){
    var occ = {};
    var bad = 0;
    for(var i = 0; i < plans.length; i++){
        var p = plans[i];
        var size = api.size(p.block);
        var offset = Math.floor((size - 1) / 2);
        for(var dx = 0; dx < size; dx++){
            for(var dy = 0; dy < size; dy++){
                var key = (p.x - offset + dx) + (p.y - offset + dy) * W;
                if(occ[key] === true) bad++;
                occ[key] = true;
            }
        }
    }
    return bad;
}

function signature(plans){
    var parts = [];
    for(var i = 0; i < plans.length; i++){
        var p = plans[i];
        parts.push(p.x + "," + p.y + "," + api.blockId(p.block));
    }
    parts.sort();
    return parts.join(";");
}

/** Runs a fill with the given per-key settings, leaving everything else at its default. */
var SETTING_OVERRIDE = {};
function withSettings(overrides){
    SETTING_OVERRIDE = overrides == null ? {} : overrides;
}

var realSettingInt = api.settingInt;
api.settingInt = function(key, def){
    return SETTING_OVERRIDE[key] != null ? SETTING_OVERRIDE[key] : realSettingInt(key, def);
};

function fillAt(shape, drill, overrides, withSupport){
    withSettings(overrides);
    var c = centreOf(shape);
    var t0 = Date.now();
    var result = optimization.fillDetailed(c, drill, withSupport !== false, "sharded", null, 0);
    result.ms = Date.now() - t0;
    return result;
}

// ---------------------------------------------------------------- the patch set

var laser = api.block("laserDrill");
var mechanical = api.block("mechanicalDrill");
var blast = api.block("blastDrill");

var square = S.patches[0];       // 24x24 dense square (576)
var round = S.patches[1];        // 45x45 round blob (~1200)
var squashed = S.patches[2];     // 50x26 round blob (irregular)
var small = S.patches[3];        // 10x10 (100)
var vein = S.patches[4];         // 40x1 vein: one tile wide

// ---------------------------------------------------------------- 1. whole patch is seen

// Power support reserves tiles for the node network, so coverage and power are measured
// separately: full coverage with the support off, and "every drill powered" with it on.
var r1 = fillAt(round, laser, null);            // support on: the shipping default
var r1free = optimization.fillDetailed(centreOf(round), laser, false, "sharded", null, 0);
var roundTiles = 0;
for(var rt in oreCells(round)) roundTiles++;

check("patch is seen whole (no truncation at the default limit)",
    r1.stats.truncated === false && r1.stats.target >= roundTiles,
    "target=" + r1.stats.target + "/" + roundTiles + " truncated=" + r1.stats.truncated);

// ---------------------------------------------------------------- 2. full coverage

var c1 = coverageOf(round, r1.plans, laser);
var c1free = coverageOf(round, r1free.plans, laser);
check("round patch: every ore tile is mined when power is not asked for",
    c1free.covered === c1free.total && r1free.stats.unreachable === 0,
    "covered=" + c1free.covered + "/" + c1free.total + " outOfReach=" + r1free.stats.unreachable
        + " drills=" + c1free.drills);

check("round patch: with power, most of the patch is still mined",
    c1.covered >= c1.total * 0.7,
    "covered=" + c1.covered + "/" + c1.total + " (" + Math.round(c1.covered * 1000 / c1.total) / 10
        + "%) drills=" + c1.drills);

check("round patch: enough drills for the patch",
    c1free.drills >= Math.floor(c1free.total / 9) * 0.9,
    "drills=" + c1free.drills + " (9-tile drills would need ~" + Math.floor(c1free.total / 9) + ")");

var c2 = coverageOf(square, fillAt(square, laser, null, false).plans, laser);
check("dense square: exactly covered by the lattice (no power) ",
    c2.covered === c2.total && c2.drills === c2.total / 9,
    "covered=" + c2.covered + "/" + c2.total + " drills=" + c2.drills);

var r3 = fillAt(small, laser, null, false);
var c3 = coverageOf(small, r3.plans, laser);
check("small patch: fully mined", c3.covered === c3.total,
    "covered=" + c3.covered + "/" + c3.total + " drills=" + c3.drills);

var r4 = fillAt(squashed, laser, null, false);
var c4 = coverageOf(squashed, r4.plans, laser);
check("irregular blob: fully mined", c4.covered === c4.total,
    "covered=" + c4.covered + "/" + c4.total + " drills=" + c4.drills + " source=" + r4.stats.source);

var r5 = fillAt(round, mechanical, null, false);
var c5 = coverageOf(round, r5.plans, mechanical);
check("2x2 drills: fully mined", c5.covered === c5.total,
    "covered=" + c5.covered + "/" + c5.total + " drills=" + c5.drills);

var r6 = fillAt(round, blast, null, false);
var c6 = coverageOf(round, r6.plans, blast);
check("3x3 airblast: fully mined", c6.covered === c6.total,
    "covered=" + c6.covered + "/" + c6.total + " drills=" + c6.drills);

// ---------------------------------------------------------------- 3. nothing overlaps

check("no two plans claim the same tile (drills, extractors, nodes, routes)",
    overlapCells(r1.plans) === 0 && overlapCells(r5.plans) === 0,
    "laser=" + overlapCells(r1.plans) + " mechanical=" + overlapCells(r5.plans));

// ---------------------------------------------------------------- 4. the gap filler

(function(){
    withSettings(null);
    var c = centreOf(round);
    var job = optimization.prepare(c, laser, true, "sharded", null, 0);
    while(!optimization.searchStep(job, Infinity)){
        // run to completion
    }
    var plans = optimization.finish(job);

    // occupancy of the committed drills
    var occ = {}, covered = {}, k = 0;
    for(var i = 0; i < plans.length; i++){
        if(api.blockId(plans[i].block) !== api.blockId(laser)) continue;
        var size = api.size(laser), offset = Math.floor((size - 1) / 2);
        for(var dx = 0; dx < size; dx++){
            for(var dy = 0; dy < size; dy++){
                var key = (plans[i].x - offset + dx) + (plans[i].y - offset + dy) * W;
                occ[key] = true;
                covered[key] = true;
            }
        }
    }

    // the reserved power tiles count as taken: no drill may sit on one
    for(i = 0; i < job.reservedNodes.length; i++){
        occ[job.reservedNodes[i].x + job.reservedNodes[i].y * W] = true;
    }

    var freeWithGain = 0;
    for(i = 0; i < job.entries.length; i++){
        var entry = job.entries[i];
        var blocked = false;
        var cells = entry.cellKeys;
        for(k = 0; k < cells.length; k++){
            if(occ[cells[k]] === true){
                blocked = true;
                break;
            }
        }
        if(blocked) continue;

        var mine = entry.mineableKeys;
        for(k = 0; k < mine.length; k++){
            if(covered[mine[k]] !== true){
                freeWithGain++;
                break;
            }
        }
    }

    check("no free drill could mine one more ore tile (gap filler)",
        freeWithGain === 0, "candidates with leftover ore=" + freeWithGain);
})();

// ---------------------------------------------------------------- 5. truncation is reported

var r7 = fillAt(round, laser, {"laser-drill-max-tiles": 200}, false);
check("a patch bigger than Max Tiles is reported, not silently half-filled",
    r7.stats.truncated === true, "truncated=" + r7.stats.truncated + " target=" + r7.stats.target);

// ---------------------------------------------------------------- 6. Min Ores, old vs new

// A one-tile-wide vein is where Min Ores decides what is reachable at all: a 3x3 drill on the
// vein holds 3 ore tiles, so a minimum of 5 leaves the thin parts of a patch unmined forever.
var oldMin = fillAt(vein, laser, {"laser-drill-min-ores": 5}, false);
var newMin = fillAt(vein, laser, {"laser-drill-min-ores": 2}, false);
var cOld = coverageOf(vein, oldMin.plans, laser);
var cNew = coverageOf(vein, newMin.plans, laser);

check("the old Min Ores default leaves a thin vein partly out of reach",
    oldMin.stats.unreachable > 0 || cOld.covered < cOld.total,
    "covered=" + cOld.covered + "/" + cOld.total + " outOfReach=" + oldMin.stats.unreachable);
check("the new Min Ores default mines the vein end to end",
    cNew.covered === cNew.total && newMin.stats.unreachable === 0,
    "covered=" + cNew.covered + "/" + cNew.total + " outOfReach=" + newMin.stats.unreachable);

// extractors may only be planned where the ground actually holds water: the original placed
// one next to every drill whenever a free tile happened to be nearby, dry or not
(function(){
    var dry = 0, total = 0;
    for(var i = 0; i < r1.plans.length; i++){
        if(api.blockId(r1.plans[i].block) !== api.blockId(api.block("waterExtractor"))) continue;
        total++;
        var tile = api.tile(r1.plans[i].x, r1.plans[i].y);
        if(!api.pumpsWaterAt(api.block("waterExtractor"), tile.x, tile.y, "sharded")) dry++;
    }
    check("water extractors only on ground that holds water", dry === 0,
        "dry=" + dry + "/" + total);
})();

// ---------------------------------------------------------------- 6b. power wiring

// Two promises: a patch next to the player's grid gets wired into it (nodes are placed within
// link range of the grid), and a patch with no power anywhere near it is left alone.
var linkRange = api.powerLinkRange();
var target = S.powerTarget;

function plannedNodes(plans){
    var out = [];
    for(var i = 0; i < plans.length; i++){
        if(api.blockId(plans[i].block) === api.blockId(api.block("powerNode"))) out.push(plans[i]);
    }
    return out;
}

function withinRange(a, b){
    var dx = api.tx(a) - api.tx(b), dy = api.ty(a) - api.ty(b);
    return dx * dx + dy * dy <= linkRange * linkRange;
}

var nodes = plannedNodes(r1.plans);
var touchedGrid = 0;
for(var n = 0; n < nodes.length; n++){
    if(withinRange(nodes[n], target)) touchedGrid++;
}
check("a patch beside the grid is wired into it",
    r1.stats.linkNodes > 0 && touchedGrid > 0,
    "linkNodes=" + r1.stats.linkNodes + " nodes in range of the grid=" + touchedGrid);

// every planned node must reach the grid through other nodes (no island of dead drills)
(function(){
    var reached = {};
    var queue = [target];
    while(queue.length > 0){
        var current = queue.pop();
        for(var i = 0; i < nodes.length; i++){
            if(reached[i] === true) continue;
            if(withinRange(nodes[i], current)){
                reached[i] = true;
                queue.push(nodes[i]);
            }
        }
    }
    var connected = 0;
    for(var k in reached) connected++;
    check("every planned node is connected to the grid",
        connected === nodes.length,
        "connected=" + connected + "/" + nodes.length);
})();

var farNodes = plannedNodes(fillAt(square, laser, null).plans);
var farInRange = 0;
for(var f = 0; f < farNodes.length; f++){
    var ddx = api.tx(farNodes[f]) - target.x, ddy = api.ty(farNodes[f]) - target.y;
    if(ddx * ddx + ddy * ddy <= linkRange * linkRange) farInRange++;
}
check("a patch with no power nearby is not wired to anything",
    farInRange === 0, "nodes in range of a far grid=" + farInRange);

// every drill must be within reach of a node (or the grid): that is what "powered" means
(function(){
    var drills = [];
    for(var i = 0; i < r1.plans.length; i++){
        if(api.blockId(r1.plans[i].block) === api.blockId(laser)) drills.push(r1.plans[i]);
    }
    var unpowered = 0;
    for(i = 0; i < drills.length; i++){
        var covered = withinRange(drills[i], target);
        for(var k = 0; k < nodes.length && !covered; k++){
            if(withinRange(drills[i], nodes[k])) covered = true;
        }
        if(!covered) unpowered++;
    }
    check("every drill is in reach of a power node",
        unpowered === 0, "unpowered drills=" + unpowered + "/" + drills.length + " nodes=" + nodes.length);
})();

// without a grid to attach to, the network must still be one piece: the player then only has to
// attach a single node to their own power
(function(){
    var squareNodes = plannedNodes(fillAt(square, laser, null).plans);
    var seen = {};
    var queue = [0];
    seen[0] = true;
    while(queue.length > 0){
        var i = queue.pop();
        for(var k = 0; k < squareNodes.length; k++){
            if(seen[k] === true) continue;
            if(withinRange(squareNodes[i], squareNodes[k])){
                seen[k] = true;
                queue.push(k);
            }
        }
    }
    var connected = 0;
    for(var key in seen) connected++;
    check("with no grid nearby the network is still one piece",
        connected === squareNodes.length,
        "connected=" + connected + "/" + squareNodes.length);
})();

// ---------------------------------------------------------------- 7. same patch, same layout

var first = fillAt(round, laser, null);
var second = fillAt(round, laser, null);
check("the same patch fills the same way twice",
    signature(first.plans) === signature(second.plans),
    "plans=" + first.plans.length);

// ---------------------------------------------------------------- 8. cost

info("round patch (1280 ore tiles): " + r1.ms + " ms, " + r1.plans.length + " plans, "
    + r1.stats.drills + " drills, source=" + r1.stats.source);
info("mechanical 2x2 on the same patch: " + r5.ms + " ms, " + r5.plans.length + " plans");

check("a full patch plans in a sane time", r1.ms < 12000, "ms=" + r1.ms);

java.lang.System.out.println("AUTODRILL-ENGINE-RESULT passed=" + passed + " failed=" + failed);
