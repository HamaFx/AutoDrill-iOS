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

function fillAt(shape, drill, overrides){
    withSettings(overrides);
    var c = centreOf(shape);
    var t0 = Date.now();
    var result = optimization.fillDetailed(c, drill, true, "sharded", null, 0);
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

var r1 = fillAt(round, laser, null);
var roundTiles = 0;
for(var rt in oreCells(round)) roundTiles++;

check("patch is seen whole (no truncation at the default limit)",
    r1.stats.truncated === false && r1.stats.target >= roundTiles,
    "target=" + r1.stats.target + "/" + roundTiles + " truncated=" + r1.stats.truncated);

// ---------------------------------------------------------------- 2. full coverage

var c1 = coverageOf(round, r1.plans, laser);
check("round patch: every reachable ore tile is mined",
    c1.covered === c1.total && r1.stats.unreachable === 0,
    "covered=" + c1.covered + "/" + c1.total + " outOfReach=" + r1.stats.unreachable
        + " blocked=" + r1.stats.blocked + " drills=" + c1.drills + " source=" + r1.stats.source);

check("round patch: enough drills for the patch",
    c1.drills >= Math.floor(c1.total / 9) * 0.9,
    "drills=" + c1.drills + " (9-tile drills would need ~" + Math.floor(c1.total / 9) + ")");

var c2 = coverageOf(square, fillAt(square, laser, null).plans, laser);
check("dense square: exactly covered by the lattice",
    c2.covered === c2.total && c2.drills === c2.total / 9,
    "covered=" + c2.covered + "/" + c2.total + " drills=" + c2.drills);

var r3 = fillAt(small, laser, null);
var c3 = coverageOf(small, r3.plans, laser);
check("small patch: fully mined", c3.covered === c3.total,
    "covered=" + c3.covered + "/" + c3.total + " drills=" + c3.drills);

var r4 = fillAt(squashed, laser, null);
var c4 = coverageOf(squashed, r4.plans, laser);
check("irregular blob: fully mined", c4.covered === c4.total,
    "covered=" + c4.covered + "/" + c4.total + " drills=" + c4.drills + " source=" + r4.stats.source);

var r5 = fillAt(round, mechanical, null);
var c5 = coverageOf(round, r5.plans, mechanical);
check("2x2 drills: fully mined", c5.covered === c5.total,
    "covered=" + c5.covered + "/" + c5.total + " drills=" + c5.drills);

var r6 = fillAt(round, blast, null);
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

var r7 = fillAt(round, laser, {"laser-drill-max-tiles": 200});
check("a patch bigger than Max Tiles is reported, not silently half-filled",
    r7.stats.truncated === true, "truncated=" + r7.stats.truncated + " target=" + r7.stats.target);

// ---------------------------------------------------------------- 6. Min Ores, old vs new

// A one-tile-wide vein is where Min Ores decides what is reachable at all: a 3x3 drill on the
// vein holds 3 ore tiles, so a minimum of 5 leaves the thin parts of a patch unmined forever.
var oldMin = fillAt(vein, laser, {"laser-drill-min-ores": 5});
var newMin = fillAt(vein, laser, {"laser-drill-min-ores": 2});
var cOld = coverageOf(vein, oldMin.plans, laser);
var cNew = coverageOf(vein, newMin.plans, laser);

check("the old Min Ores default leaves a thin vein partly out of reach",
    oldMin.stats.unreachable > 0 || cOld.covered < cOld.total,
    "covered=" + cOld.covered + "/" + cOld.total + " outOfReach=" + oldMin.stats.unreachable);
check("the new Min Ores default mines the vein end to end",
    cNew.covered === cNew.total && newMin.stats.unreachable === 0,
    "covered=" + cNew.covered + "/" + cNew.total + " outOfReach=" + newMin.stats.unreachable);

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
