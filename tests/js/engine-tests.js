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
var bridge = require("bridge");
var direction = require("direction");
var liquid = require("liquid");
var util = require("util");

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

/**
 * Directed flow model of a belt layout: a drill is wired when an adjacent conveyor or bridge
 * reaches a dumping bridge (config 0,0) - the same model tests/js/corpus-probe.js reports.
 * Trimmed copy on purpose: the engine checks must not depend on the probe rig.
 */
function beltWiring(plans){
    var wW = api.worldW();
    var bridgeAt = {}, belts = {}, drills = [];
    for(var i = 0; i < plans.length; i++){
        var name = api.blockName(plans[i].block);
        if(name === "mechanicalDrill" || name === "pneumaticDrill"){ drills.push(plans[i]); continue; }
        if(name === "conveyor"){ belts[plans[i].x + plans[i].y * wW] = plans[i]; continue; }
        if(name === "itemBridge") bridgeAt[plans[i].x + plans[i].y * wW] = plans[i];
    }

    function flowStart(x, y){
        var seen = {};
        var cur = {x: x, y: y};
        var hops = 0;
        for(;;){
            var b = bridgeAt[cur.x + cur.y * wW];
            if(b == null) return 1;
            var cx = b.configX == null ? 0 : b.configX;
            var cy = b.configY == null ? 0 : b.configY;
            if(cx === 0 && cy === 0) return 0;
            var key = cur.x + "," + cur.y;
            if(seen[key] === true) return 2;
            seen[key] = true;
            cur = {x: b.x + cx, y: b.y + cy};
            if(++hops > 64) return 2;
        }
    }

    var convUsable = {};
    var changed = true;
    while(changed){
        changed = false;
        for(var ck in belts){
            if(convUsable[ck] === true) continue;
            var c = belts[ck];
            var usable = false;
            for(var ddx = -1; ddx <= 1 && !usable; ddx++){
                for(var ddy = -1; ddy <= 1; ddy++){
                    if(Math.abs(ddx) + Math.abs(ddy) !== 1) continue;
                    var nk = (c.x + ddx) + (c.y + ddy) * wW;
                    if(bridgeAt[nk] != null && flowStart(bridgeAt[nk].x, bridgeAt[nk].y) === 0){ usable = true; break; }
                    if(convUsable[nk] === true){ usable = true; break; }
                }
            }
            if(usable){ convUsable[ck] = true; changed = true; }
        }
    }

    var wired = 0;
    for(i = 0; i < drills.length; i++){
        var d = drills[i];
        var ok = false;
        for(var dx = -1; dx <= 2 && !ok; dx++){
            for(var dy = -1; dy <= 2; dy++){
                if(dx >= 0 && dx <= 1 && dy >= 0 && dy <= 1) continue;
                var k3 = (d.x + dx) + (d.y + dy) * wW;
                if(bridgeAt[k3] != null && flowStart(d.x + dx, d.y + dy) === 0){ ok = true; break; }
                if(convUsable[k3] === true){ ok = true; break; }
            }
        }
        if(ok) wired++;
    }
    return {drills: drills.length, wired: wired, bridges: bridgeAt, conveyors: belts};
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

function fillAt(shape, drill, overrides, withSupport, keepPlans){
    withSettings(overrides);
    // a fill now treats the plans of the previous fill as taken (so tapping twice cannot queue
    // every drill twice), so checks that want a fresh patch drop them first
    if(keepPlans !== true) util.undoLastCommitted();
    var c = centreOf(shape);
    var t0 = Date.now();
    var result = optimization.fillDetailed(c, drill, withSupport !== false, "sharded", null, 0);
    result.ms = Date.now() - t0;
    return result;
}

/**
 * Rebuilds the fake world (so ore added by an earlier fixture, or buildings stood up on it,
 * are gone) at the current scenario, and re-installs the settings wrapper the copy replaces.
 */
function resetWorld(){
    var freshApi = makeApi();
    for(var k in freshApi) api[k] = freshApi[k];
    api.settingInt = function(key, def){
        return SETTING_OVERRIDE[key] != null ? SETTING_OVERRIDE[key] : realSettingInt(key, def);
    };
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
util.undoLastCommitted();
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
    c1.covered >= c1.total * 0.82,
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
check("4x4 airblast: fully mined", c6.covered === c6.total,
    "covered=" + c6.covered + "/" + c6.total + " drills=" + c6.drills);

// A thin vein is the case where power support used to cost ore: the lattice point at the
// patch centre sits on the vein, and the node reservation held that ore tile - plus its
// whole footprint - against every drill that could reach it. Nodes reach six tiles, so they
// belong on the empty ground beside a vein up to six tiles wide, where their footprint
// overlaps no candidate at all and the reservation costs nothing.
var rVeinPow = fillAt(vein, laser, null, true);
var cVeinPow = coverageOf(vein, rVeinPow.plans, laser);
check("1-wide vein with power support ON: 100% of ore tiles are mined (power nodes sit outside the vein)",
    cVeinPow.covered === cVeinPow.total,
    "covered=" + cVeinPow.covered + "/" + cVeinPow.total + " drills=" + cVeinPow.drills
        + " reserved=" + rVeinPow.stats.reserved + " nodes=" + rVeinPow.stats.nodes);

// ---------------------------------------------------------------- 2b. vein shapes

// Thin, irregular vein shapes are the hard case for the three layout families: over 200 random
// walks, 15.5% ended exactly one tile short at the default quality, with the gap filler unable
// to help because every candidate mining the last tile overlapped a placed drill (measured with
// tools/vein-probe.sh; the optimum was proven full with tools/vein-solve.py). The repair pass
// in optimization.js exists for exactly that: it drops the blocking drill, takes the candidate
// and refills. The walk fixture below stops one tile short without the repair, so the first
// check fails if the pass regresses and the last check demands the repair is what closed it.
(function(){
    // the vein probe's deterministic walk (tests/js/vein-scenarios.js), inlined so the fixture
    // is self-contained
    function walkVein(seed, steps, turns){
        var out = [];
        var seen = {};
        var x = 0, y = 0;
        var dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
        var s = seed | 0;
        out.push([0, 0]);
        seen["0,0"] = true;
        for(var i = 0; i < steps; i++){
            s = (s * 1103515245 + 12345) & 0x7fffffff;
            var d = (s >> 8) % 4;
            x += dirs[d][0];
            y += dirs[d][1];
            if(seen[x + "," + y] !== true){ seen[x + "," + y] = true; out.push([x, y]); }
            if(i % turns === turns - 1){
                s = (s * 1103515245 + 12345) & 0x7fffffff;
                var e = (s >> 8) % 4;
                var bx = x + dirs[e][0], by = y + dirs[e][1];
                if(seen[bx + "," + by] !== true){ seen[bx + "," + by] = true; out.push([bx, by]); }
            }
        }
        return out;
    }

    function blob4(){
        var out = [];
        for(var x = 0; x < 7; x++){
            for(var y = 0; y < 7; y++) out.push([x, y]);
        }
        for(var i = 1; i <= 9; i++){
            out.push([6 + i, 3]); out.push([3, 6 + i]);
            out.push([-i, 3]); out.push([3, -i]);
        }
        return out;
    }

    function place(cells, ox, oy){
        var minX = 1e9, minY = 1e9;
        for(var i = 0; i < cells.length; i++){
            minX = Math.min(minX, cells[i][0]);
            minY = Math.min(minY, cells[i][1]);
        }
        var out = [];
        for(i = 0; i < cells.length; i++) out.push([cells[i][0] - minX + ox, cells[i][1] - minY + oy]);
        return out;
    }

    function tapOf(cells){
        var sx = 0, sy = 0;
        for(var i = 0; i < cells.length; i++){ sx += cells[i][0]; sy += cells[i][1]; }
        var cx = sx / cells.length, cy = sy / cells.length;
        var best = cells[0], bestD = 1e9;
        for(i = 0; i < cells.length; i++){
            var d = (cells[i][0] - cx) * (cells[i][0] - cx) + (cells[i][1] - cy) * (cells[i][1] - cy);
            if(d < bestD){ bestD = d; best = cells[i]; }
        }
        return best;
    }

    function veinCoverage(cells){
        var set = {};
        for(var i = 0; i < cells.length; i++){
            set[cells[i][0] + cells[i][1] * W] = true;
            api.__ore(cells[i][0], cells[i][1]);
        }

        var tap = tapOf(cells);
        util.undoLastCommitted();
        var res = optimization.fillDetailed({x: tap[0], y: tap[1]}, laser, false, "sharded", null, 0);

        var size = api.size(laser);
        var half = Math.floor((size - 1) / 2);
        var covered = {};
        var drills = 0;
        for(var p = 0; p < res.plans.length; p++){
            if(api.blockId(res.plans[p].block) !== api.blockId(laser)) continue;
            drills++;
            for(var dx = 0; dx < size; dx++){
                for(var dy = 0; dy < size; dy++){
                    var key = (res.plans[p].x - half + dx) + (res.plans[p].y - half + dy) * W;
                    if(set[key] === true) covered[key] = true;
                }
            }
        }
        var count = 0;
        for(var c in covered) count++;
        return {covered: count, total: cells.length, drills: drills,
            repairGain: res.stats.repairGain, stats: res.stats};
    }

    var fixtures = [
        {name: "walk vein", cells: place(walkVein(158481, 51, 8), 10, 108)},
        {name: "blob with four arms", cells: place(blob4(), 100, 108)}
    ];
    var repaired = 0;
    var repairSane = true;

    for(var f = 0; f < fixtures.length; f++){
        var got = veinCoverage(fixtures[f].cells);
        check("vein shape (" + fixtures[f].name + "): covered whole at the default quality",
            got.covered === got.total && got.total > 0,
            "covered=" + got.covered + "/" + got.total + " drills=" + got.drills
                + " repairGain=" + got.repairGain);
        if(got.repairGain > 0) repaired++;
        if(!(got.repairGain >= 0 && got.repairGain <= got.total)) repairSane = false;
    }

    // Repair is a fallback now: the bottleneck-first orders and the translation-invariant
    // lattice usually close these fixtures before it runs. What must never happen is a repair
    // that reports a loss (every accepted move is strictly improving).
    check("vein shapes: local repair never loses coverage",
        repairSane, "shapes repaired=" + repaired + "/" + fixtures.length);

    // ---- Phase 2: bottleneck-first orders (degree-1 forced tiles go first) ----
    (function(){
        var entries = [
            {mineableKeys: ["a", "b", "c"], winnerCount: 9},
            {mineableKeys: ["a", "b", "d"], winnerCount: 9},
            {mineableKeys: ["c", "d", "e"], winnerCount: 1}
        ];
        var orders = optimization.buildBottleneckOrders(entries);
        check("bottleneck order: the only candidate holding a degree-1 tile leads both orders",
            orders.length === 2 && orders[0][0] === 2 && orders[1][0] === 2,
            "forcedFirst=" + orders[0][0] + " rarityFirst=" + orders[1][0]);
    })();

    // ---- Phase 2: translation invariance (same vein, shifted world coordinates) ----
    (function(){
        var baseCells = walkVein(101 + 72 * 7919, 40 + (72 * 37) % 81, 6 + (72 % 6));
        var shifts = [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1]];
        var shiftMisses = 0;
        var shiftDetail = "";
        for(var si = 0; si < shifts.length; si++){
            resetWorld();
            var placed = place(baseCells, 10 + shifts[si][0], 108 + shifts[si][1]);
            var shifted = veinCoverage(placed);
            if(shifted.covered < shifted.total) shiftMisses++;
            shiftDetail += " " + shifts[si].join(",") + "=" + shifted.covered + "/" + shifted.total;
        }
        check("vein shapes: coverage is 100% across all map coordinate shifts modulo drill size",
            shiftMisses === 0, "shiftMisses=" + shiftMisses + "/" + shifts.length + shiftDetail);
    })();

    // ---- Phase 2: 1-tile walled tip at the default minOres=2 (rim fallback) ----
    (function(){
        S.wallCells = [
            [40, 118], [41, 118], [42, 118],
            [40, 122], [41, 122], [42, 122]
        ];
        resetWorld();

        var cells = [
            [37, 119], [38, 119], [39, 119],
            [37, 120], [38, 120], [39, 120], [40, 120],
            [37, 121], [38, 121], [39, 121]
        ];
        var tipped = veinCoverage(cells);

        S.wallCells = null;
        resetWorld();

        check("vein shapes: 1-tile walled tip is covered at default minOres=2 via rim fallback",
            tipped.covered === tipped.total,
            "covered=" + tipped.covered + "/" + tipped.total
                + " rimGain=" + tipped.stats.rimGain);
    })();

    // ---- Phase 2: window-local deep repair on a large patch (>320 candidates) ----
    (function(){
        resetWorld();
        // seed 9001 walk: 270 cells / 541 candidates, and the lattice family leaves exactly
        // one reachable tile. Before Phase 2 the deep repair skipped this patch because
        // entries.length > 320, so repairWindows would be 0.
        var big = place(walkVein(9001, 320, 5), 10, 95);
        var wide = veinCoverage(big);
        check("vein shapes: large patch (>320 candidates) still gets the window-local deep repair",
            wide.covered === wide.total && wide.stats.repairWindows > 0
                && wide.stats.repairWork > 0,
            "covered=" + wide.covered + "/" + wide.total
                + " cands=" + wide.stats.candidates
                + " windows=" + wide.stats.repairWindows
                + " work=" + wide.stats.repairWork
                + " deepMs=" + wide.stats.repairDeepMs);
    })();

    // The resets above replaced the fake world's block objects. The power checks further down
    // inspect the plans of the first reference fill (r1), so rebuild that fill on the restored
    // world before leaving this section.
    resetWorld();
    r1 = fillAt(round, laser, null);
})();

// ---------------------------------------------------------------- 3. nothing overlaps

check("no two plans claim the same tile (drills, extractors, nodes, routes)",
    overlapCells(r1.plans) === 0 && overlapCells(r5.plans) === 0,
    "laser=" + overlapCells(r1.plans) + " mechanical=" + overlapCells(r5.plans));

// ---------------------------------------------------------------- 4. the gap filler

(function(){
    withSettings(null);
    var c = centreOf(round);
    util.undoLastCommitted();
    var job = optimization.prepare(c, laser, true, "sharded", null, 0);
    while(!optimization.searchStep(job, Infinity)){
        // run to completion
    }
    var plans = optimization.finish(job);

    // occupancy of every plan - drills, extractors, bridges, power blocks - and the ore the
    // drills mine. The support passes place their blocks first, and a free candidate has to
    // respect all of them, not just the drills.
    var occ = {}, covered = {}, k = 0;
    for(var i = 0; i < plans.length; i++){
        var size = api.size(plans[i].block), offset = Math.floor((size - 1) / 2);
        var isDrill = api.blockId(plans[i].block) === api.blockId(laser);
        for(var dx = 0; dx < size; dx++){
            for(var dy = 0; dy < size; dy++){
                var key = (plans[i].x - offset + dx) + (plans[i].y - offset + dy) * W;
                occ[key] = true;
                if(isDrill) covered[key] = true;
            }
        }
    }

    // the reserved power tiles count as taken too: no drill may sit on one
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

    check("no free drill could mine one more ore tile (gap filler, after power stitching and grid linking)",
        freeWithGain === 0, "candidates with leftover ore=" + freeWithGain
            + " removedDrills=" + job.powerRemovedDrills + " refilled=" + job.stats.refilled);

    // When the only route for a link block ran across a drill, the drill is gone - but the
    // ground it freed can usually take a neighbouring candidate that avoids the new 1x1 block
    // (measured on this patch: the dropped drill left three ore tiles, and the candidate one
    // tile over still fits). The refill pass must take it rather than report the loss.
    check("a drill dropped for the power network is replaced by a candidate on the freed ground",
        job.powerRemovedDrills === 0 || job.stats.refilled > 0,
        "removedDrills=" + job.powerRemovedDrills + " refilled=" + job.stats.refilled);
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

// ---------------------------------------------------------------- 6a. water extractors

// One 2x2 water extractor produces 6.6 water/s, enough to boost two laser drills (4.8/s)
// or airblast drills (6.0/s) when touching both. A packed patch must share extractors
// across adjacent drills rather than placing 1 per drill.
(function(){
    var extCount = r1.stats.extractors;
    var drillCount = r1.stats.drills;
    check("water extractors are shared across adjacent drills (fewer extractors than drills)",
        extCount > 0 && extCount <= Math.ceil(drillCount * 0.75),
        "extractors=" + extCount + " drills=" + drillCount);
})();

// ---------------------------------------------------------------- 6b. power wiring

// Two promises: a patch next to the player's grid gets wired into it (nodes are placed within
// link range of the grid), and a patch with no power anywhere near it is left alone.
var linkRange = api.powerLinkRange();
var target = S.powerTarget;
// a beam tower or beam node reaches further than a power node; the checks use the block's own
// range, exactly like the fill does
function rangeOf(plans){
    var best = linkRange;
    for(var i = 0; i < plans.length; i++){
        if(isPowerBlock(plans[i].block)) best = Math.max(best, api.powerRangeOf(plans[i].block));
    }
    return best;
}

function isPowerBlock(block){
    // object identity: the fake world names blocks the way the scripts call them, the game
    // uses its own names, but the block objects are the same ones either way
    return block === api.block("powerNode") || block === api.block("beamNode")
        || block === api.block("beamTower");
}

function plannedNodes(plans){
    var out = [];
    for(var i = 0; i < plans.length; i++){
        if(isPowerBlock(plans[i].block)) out.push(plans[i]);
    }
    return out;
}

function withinRange(a, b){
    var dx = api.tx(a) - api.tx(b), dy = api.ty(a) - api.ty(b);
    return dx * dx + dy * dy <= linkRange * linkRange;
}

var nodes = plannedNodes(r1.plans);
var linkRange = rangeOf(nodes);
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

    // what the leftovers look like, so a failure says more than a count
    var isolated = [];
    for(var n2 = 0; n2 < squareNodes.length && isolated.length < 5; n2++){
        if(seen[n2] === true) continue;
        isolated.push(api.tx(squareNodes[n2]) + "," + api.ty(squareNodes[n2]));
    }

    check("with no grid nearby the network is still one piece",
        connected === squareNodes.length,
        "connected=" + connected + "/" + squareNodes.length + " isolated=" + isolated.join(" "));
})();

// the quality setting must change how many layouts are tried: it used to do nothing at all
(function(){
    var low = fillAt(round, laser, {"auto-drill-ios-optimization-quality": 1}, false);
    var high = fillAt(round, laser, {"auto-drill-ios-optimization-quality": 10}, false);
    var lowTried = low.stats.candidateScores.sweeps.length;
    var highTried = high.stats.candidateScores.sweeps.length;
    check("quality 10 tries more layouts than quality 1",
        highTried > lowTried, "sweeps=" + lowTried + " vs " + highTried);
})();

// "Layout Variation": a deterministic re-roll among equally-good arrangements. Same number must
// give the same layout on every device, and it must not cost coverage where everything is
// coverable. (0, the default, keeps the standard layout - the corpus hash is the guard for that.)
(function(){
    var v1 = fillAt(round, laser, {"auto-drill-ios-layout-variation": 1}, false);
    var v1again = fillAt(round, laser, {"auto-drill-ios-layout-variation": 1}, false);
    check("layout variation is deterministic per value",
        signature(v1.plans) === signature(v1again.plans) && v1.plans.length > 0,
        "plans=" + v1.plans.length);

    util.undoLastCommitted();
    withSettings({"auto-drill-ios-layout-variation": 2});
    var b1 = bridge.fill(centreOf(round), mechanical, direction.RIGHT, "sharded");
    util.undoLastCommitted();
    withSettings({"auto-drill-ios-layout-variation": 2});
    var b2 = bridge.fill(centreOf(round), mechanical, direction.RIGHT, "sharded");
    withSettings(null);
    check("belt tool: the same variation fills the same way twice",
        signature(b1) === signature(b2) && b1.length > 0, "plans=" + b1.length);
})();

// A drill beside an already-built belt can hand its ore over: the fill plans it instead of
// refusing the placement for lack of transport. Before this, a re-tap over a built base placed
// almost nothing - a built conveyor or bridge beside a free ore pocket was invisible to the
// fill's transport checks (which only knew its own plans).
(function(){
    withSettings(null);
    for(var ox = 120; ox <= 121; ox++){
        for(var oy = 60; oy <= 61; oy++) api.__ore(ox, oy);
    }
    // a ring of built conveyors around the pocket: the only transport a drill can use there
    for(var x = 118; x <= 123; x++){
        for(var y = 58; y <= 63; y++){
            if(x >= 120 && x <= 121 && y >= 60 && y <= 61) continue;
            api.__buildBlock(x, y, "conveyor");
        }
    }
    util.undoLastCommitted();
    var plans = bridge.fill(api.tile(120, 60), mechanical, direction.RIGHT, "sharded");
    var cov = coverageOf({oreX0: 120, oreY0: 60, x1: 121, y1: 61}, plans, mechanical);
    check("a drill beside an already-built belt is planned (built-base re-tap)",
        cov.drills >= 1 && cov.covered === cov.total,
        "drills=" + cov.drills + " covered=" + cov.covered + "/" + cov.total);
})();

// ---------------------------------------------------------------- 6c. Erekir support

// On Erekir the drills need beam blocks (power nodes do not exist there), and the fill must
// pick them without being told which planet it is on.
(function(){
    S.erekir = true;

    util.undoLastCommitted();
    var ere = optimization.fillDetailed(centreOf(round), laser, true, "sharded", null, 0);
    var ereNodes = plannedNodes(ere.plans);
    var serpuloNodes = 0;
    for(var i = 0; i < ere.plans.length; i++){
        if(ere.plans[i].block === api.block("powerNode")) serpuloNodes++;
    }
    var ereRange = rangeOf(ereNodes);

    var drills = [];
    for(i = 0; i < ere.plans.length; i++){
        if(api.blockId(ere.plans[i].block) === api.blockId(laser)) drills.push(ere.plans[i]);
    }
    var unpowered = 0;
    for(i = 0; i < drills.length; i++){
        var covered = false;
        for(var k = 0; k < ereNodes.length && !covered; k++){
            var dx = api.tx(drills[i]) - api.tx(ereNodes[k]);
            var dy = api.ty(drills[i]) - api.ty(ereNodes[k]);
            if(dx * dx + dy * dy <= ereRange * ereRange) covered = true;
        }
        if(!covered) unpowered++;
    }

    check("Erekir: beam blocks are used instead of power nodes",
        ereNodes.length > 0 && serpuloNodes === 0,
        "beam blocks=" + ereNodes.length + " power nodes=" + serpuloNodes
            + " first=" + (ereNodes.length === 0 ? "-" : api.blockName(ereNodes[0].block)));
    check("Erekir: every drill is in reach of a beam block",
        unpowered === 0, "unpowered=" + unpowered + "/" + drills.length + " range=" + ereRange);

    S.erekir = false;
})();

// ---------------------------------------------------------------- 6d. vents and oil

// Erekir steam vents hold a steam attribute; the vent condenser only fits where a 3x3 holds
// enough of it. Serpulo oil ground is the same idea with the oil extractor, which also needs
// water piped to it - so the fill has to find water and run conduits.
(function(){
    S.erekir = true;                     // vents are Erekir ground
    S.steamRect = {x0: 70, y0: 120, x1: 74, y1: 124};
    var ventPlans = liquid.fillVent({x: 72, y: 122}, "sharded");
    S.steamRect = null;
    S.erekir = false;

    var condensers = 0, ventPower = 0;
    for(var i = 0; i < ventPlans.length; i++){
        if(ventPlans[i].block === api.block("ventCondenser")) condensers++;
        if(isPowerBlock(ventPlans[i].block) || ventPlans[i].block === api.block("mechanicalPump")) ventPower++;
    }
    check("vent: a condenser is placed on the vent", condensers >= 1,
        "condensers=" + condensers + " plans=" + ventPlans.length);
    check("vent: the condensers get power", ventPower > 0, "power blocks=" + ventPower);
    check("vent: nothing overlaps", overlapCells(ventPlans) === 0, "overlap=" + overlapCells(ventPlans));

    S.oilRect = {x0: 10, y0: 90, x1: 16, y1: 96};
    S.waterRect = {x0: 22, y0: 90, x1: 28, y1: 96};
    var oilPlans = liquid.fillOil({x: 13, y: 93}, "sharded");
    S.oilRect = null;
    S.waterRect = null;

    var extractors = 0, pumps = 0, conduits = 0;
    for(i = 0; i < oilPlans.length; i++){
        var name = api.blockName(oilPlans[i].block);
        if(name === "oilExtractor") extractors++;
        if(name === "mechanicalPump" || name === "impulsePump") pumps++;
        if(name === "conduit" || name === "reinforcedConduit") conduits++;
    }
    check("oil: extractors are placed on the oil", extractors >= 1,
        "extractors=" + extractors + " plans=" + oilPlans.length);
    check("oil: a pump and a conduit line are run to them", pumps >= 1 && conduits > 0,
        "pumps=" + pumps + " conduits=" + conduits);
    check("oil: nothing overlaps", overlapCells(oilPlans) === 0, "overlap=" + overlapCells(oilPlans));
})();

// ---------------------------------------------------------------- 6e. patches that are already busy

// A second tap on a patch that already has drills covers only the gaps. That looked like the
// fill "not covering the ores", so the engine has to count what was already there.
(function(){
    var fresh = fillAt(small, laser, null, false);
    check("a fresh patch is covered whole", coverageOf(small, fresh.plans, laser).covered === 100,
        "covered=" + coverageOf(small, fresh.plans, laser).covered);

    // stand the drills up, then fill again
    for(var i = 0; i < fresh.plans.length; i++){
        var plan = fresh.plans[i];
        var size = api.size(plan.block), offset = Math.floor((size - 1) / 2);
        for(var dx = 0; dx < size; dx++){
            for(var dy = 0; dy < size; dy++){
                api.__build(plan.x - offset + dx, plan.y - offset + dy);
            }
        }
    }

    var again = fillAt(small, laser, null, false, true);
    check("a second fill reports what is already built", again.stats.alreadyBuilt > 0,
        "alreadyBuilt=" + again.stats.alreadyBuilt + " drills=" + again.stats.drills);
    check("a second fill only plans the gaps", again.stats.drills < fresh.stats.drills,
        "first=" + fresh.stats.drills + " second=" + again.stats.drills);
})();

// Tapping twice without waiting for the first fill to be built must not queue everything twice
(function(){
    util.undoLastCommitted();
    var first = fillAt(round, laser, null, false);
    var second = fillAt(round, laser, null, false, true);

    check("a second tap does not plan the same drills again",
        second.stats.plans === 0 || second.stats.drills < first.stats.drills / 4,
        "first=" + first.stats.drills + " second=" + second.stats.drills
            + " planned=" + second.stats.alreadyPlanned);
    util.undoLastCommitted();
})();

// A patch with a second ore in it only gets the tapped ore, which is worth saying outright.
(function(){
    S.leadRect = {x0: 70, y0: 25, x1: 80, y1: 35};      // a lead blob inside the round patch
    var mixed = fillAt(round, laser, null, false);
    S.leadRect = null;

    var leadTiles = 0;
    for(var id in mixed.stats.otherOres) leadTiles += mixed.stats.otherOres[id];
    check("other ore under the patch is counted", leadTiles > 0, "other ore tiles=" + leadTiles);
})();

// Foreign ore just outside the tapped patch: an overhanging 4x4 drill reaches into it, and
// when the foreign ore wins Drill.countOre the placement mines the wrong resource in-game.
// The flood fill only walks the tapped ore, so the outer ring of an overhanging footprint has
// no facts when the candidate pass runs - the scan has to complete them on demand instead of
// ignoring every cell the patch expansion does not cover (which hid the lead column below).
(function(){
    // the lead band starts three tiles right of the small patch: the cells three and four tiles
    // out are beyond the two-tile expansion, and a drill covering the patch's last column sees
    // the same amount of lead as copper there - the tie goes to the higher item id, i.e. lead.
    S.leadRect = {x0: 82, y0: 70, x1: 89, y1: 79};
    resetWorld();

    util.undoLastCommitted();
    var job = optimization.prepare(centreOf(small), blast, false, "sharded", null, 0);

    var copperId = api.itemId(AUTODRILL_API_FAKE.__info().copper);
    var wrong = 0;
    for(var i = 0; i < job.entries.length; i++){
        var t = job.entries[i].tile;
        var realOre = util.countOre(api.tile(api.tx(t), api.ty(t)), blast);
        if(realOre == null || api.itemId(realOre.item) !== copperId) wrong++;
    }

    check("mixed border: every candidate drill mines the tapped ore (foreign ore is seen)",
        wrong === 0, "foreign-dominant candidates=" + wrong + "/" + job.entries.length);

    S.leadRect = null;
    resetWorld();
})();

// ---------------------------------------------------------------- 6f. what the fill says

// Every fill ends with a plain statement of what it did and why, because "it only covered a
// few ores" is impossible to diagnose from the map alone. These checks pin the wording.
(function(){
    function lastToast(){
        var log = AUTODRILL_API_FAKE.__info().log;
        for(var i = log.length - 1; i >= 0; i--){
            if(String(log[i]).indexOf("toast: ") === 0) return String(log[i]);
        }
        return "";
    }

    fillAt(square, laser, null, false);
    var full = lastToast();
    check("a fully filled patch says so", full.indexOf("mined all") >= 0, full);

    fillAt(round, laser, {"laser-drill-max-tiles": 300}, false);
    var cut = lastToast();
    check("a truncated patch names Max Tiles", cut.indexOf("Max Tiles") >= 0, cut);

    fillAt(round, laser, null, true);
    var power = lastToast();
    check("kept-free tiles name the power support", power.indexOf("power blocks") >= 0, power);

    S.leadRect = {x0: 70, y0: 25, x1: 80, y1: 35};
    fillAt(round, laser, null, false);
    var mixed = lastToast();
    S.leadRect = null;
    check("a second ore is called out by name", mixed.indexOf("also has") >= 0, mixed);

    // and the messages themselves, so the report can quote them
    info("toast (full patch): " + full);
    info("toast (truncated):  " + cut);
    info("toast (with power): " + power);
    info("toast (mixed ore):  " + mixed);
})();

// ---------------------------------------------------------------- 6g. the belt tool says what it did

// The mechanical/pneumatic fill plans drills *and* belts, so its coverage is its own thing -
// and it planned in silence, which made a cut-short patch look like a broken fill.
(function(){
    function lastToast(){
        var log = AUTODRILL_API_FAKE.__info().log;
        for(var i = log.length - 1; i >= 0; i--){
            if(String(log[i]).indexOf("toast: ") === 0) return String(log[i]);
        }
        return "";
    }

    var plans = bridge.fill(centreOf(square), api.block("mechanicalDrill"), direction.RIGHT, "sharded");
    var full = lastToast();
    check("belt tool: reports its coverage", full.indexOf("of") > 0 && full.indexOf("Copper") > 0, full);

    var drills = 0;
    for(var i = 0; i < plans.length; i++){
        if(api.blockId(plans[i].block) === api.blockId(api.block("mechanicalDrill"))) drills++;
    }
    check("belt tool: plans drills and belts", drills > 0 && plans.length > drills,
        "drills=" + drills + " plans=" + plans.length);

    // a patch cut short by Max Tiles has to be named as such
    withSettings({"mechanical-drill-max-tiles": 120});
    bridge.fill(centreOf(square), api.block("mechanicalDrill"), direction.RIGHT, "sharded");
    var cut = lastToast();
    check("belt tool: a cut-short patch names Max Tiles", cut.indexOf("Max Tiles") >= 0, cut);
    info("toast (belt tool, full patch): " + full);
    info("toast (belt tool, cut short): " + cut);
    withSettings(null);
})();

// ---------------------------------------------------------------- 6h. belt tool on thin and walled veins

// The 2x2 belt-tool drill covers [x, x+1] x [y, y+1]. A vein one tile wide with a wall on its
// +y side can only be mined by anchoring on the non-ore tile below it (y - 1) - anchoring on
// the vein row itself puts the wall in the footprint. `leftovers` used to keep ore tiles only
// and discarded those anchors, which left up to two thirds of a walled vein unmined.
(function(){
    var wallRow = [];
    for(var wx = 70; wx <= 109; wx++) wallRow.push([wx, 101]);
    S.wallCells = wallRow;
    resetWorld();

    util.undoLastCommitted();
    var plans = bridge.fill({x: 85, y: 100}, api.block("mechanicalDrill"), direction.DOWN, "sharded");
    var cov = coverageOf(vein, plans, api.block("mechanicalDrill"));

    S.wallCells = null;
    resetWorld();

    check("belt tool: 1-wide vein with wall on +y is mined via y-1 overhang anchors",
        cov.covered >= 36, "covered=" + cov.covered + "/" + cov.total + " drills=" + cov.drills);
})();

// A patch in a walled pocket makes the belt tool plan belts and conveyors around the walls.
// The grid used to keep wall tiles in its list - the chain planned them, the dry run refused
// them ("7 buildings could not be placed") - and neither the conveyors it laid nor the drills
// that needed them were marked as taken, so a later candidate could overlap them. Nothing may
// be refused in the dry run and nothing may overlap.
(function(){
    var pocketWalls = [];
    for(var py = 60; py <= 80; py++) pocketWalls.push([69, py]);
    for(var px = 69; px <= 80; px++) pocketWalls.push([px, 80]);
    S.wallCells = pocketWalls;
    resetWorld();

    var fakeMessages = AUTODRILL_API_FAKE.__info().log;
    var logBefore = fakeMessages.length;
    util.undoLastCommitted();
    var plans = bridge.fill({x: 74, y: 74}, api.block("mechanicalDrill"), direction.RIGHT, "sharded");
    var cov = coverageOf(small, plans, api.block("mechanicalDrill"));

    var refused = "";
    for(var mi = logBefore; mi < fakeMessages.length; mi++){
        if(String(fakeMessages[mi]).indexOf("could not be placed") >= 0) refused = String(fakeMessages[mi]);
    }

    S.wallCells = null;
    resetWorld();

    // How far the belt grid lets the pocket be mined: the grid keeps a tile every three rows
    // and columns and those tiles are not mined - measured, the 6x6 pattern reaches 84 of the
    // 100 ore tiles here, and no phase or layout family does better (the shape sweep measures
    // the same ~11% loss on the unwalled square). What this check pins is that the fill now
    // refuses nothing: no conveyor, bridge or drill plan collides with another.
    check("belt tool: walled pocket plans without refused or overlapping belts",
        refused === "" && overlapCells(plans) === 0 && cov.covered >= 84,
        "covered=" + cov.covered + "/" + cov.total + " overlaps=" + overlapCells(plans)
            + (refused === "" ? "" : " refused=[" + refused + "]"));
})();

// ---------------------------------------------------------------- 6h2. belt tool bridge chains

// Item bridges link along an axis at distance 1..4, and the game forbids a pair pointing at
// each other (ItemBridge.checkDouble). The chain links each belt tile to the first partner it
// finds in the list, which used to be one *further* from the outlet when no closer tile sat
// exactly three away: two such bridges point at each other (a 2-cycle), and a bridge whose
// partner did not survive validation kept a config pointing at nothing. Both leave belts that
// move items nowhere.
(function(){
    util.undoLastCommitted();
    var plans = bridge.fill(centreOf(round), api.block("mechanicalDrill"), direction.RIGHT, "sharded");
    // the fill's plans stay in the queue for the next tap; this check only inspects them
    util.undoLastCommitted();

    var itemBridgeId = api.blockId(api.block("itemBridge"));
    var bridgeMap = {};
    var bridgeCount = 0;
    var bi = 0;
    for(bi = 0; bi < plans.length; bi++){
        if(api.blockId(plans[bi].block) === itemBridgeId){
            bridgeMap[plans[bi].x + "," + plans[bi].y] = plans[bi];
            bridgeCount++;
        }
    }

    var cycles = 0, dangling = 0;
    for(var bk in bridgeMap){
        var b = bridgeMap[bk];
        if(b.configX === 0 && b.configY === 0) continue;
        var tx = b.x + b.configX, ty = b.y + b.configY;
        var target = bridgeMap[tx + "," + ty];
        if(target == null){
            dangling++;
        }else if(target.x + target.configX === b.x && target.y + target.configY === b.y){
            cycles++;
        }
    }

    check("belt tool: no 2-cycle or dangling itemBridge links",
        cycles === 0 && dangling === 0,
        "cycles=" + cycles + " dangling=" + dangling + " bridges=" + bridgeCount);
})();

// The belting audit found drills whose transport went nowhere: a conveyor pushed into a belt
// tile whose bridge was never planned (an orphan, or a tile a drill ended up covering), so the
// drill's ore never left it. Every planned conveyor must push into a planned bridge - or into
// another conveyor - and every drill must sit beside something that carries.
(function(){
    util.undoLastCommitted();
    var plans = bridge.fill(centreOf(round), api.block("mechanicalDrill"), direction.RIGHT, "sharded");
    util.undoLastCommitted();

    var beltAt = {};
    var conveyors = [];
    var drills = [];
    for(var i = 0; i < plans.length; i++){
        var name = api.blockName(plans[i].block);
        if(name === "itemBridge") beltAt[plans[i].x + "," + plans[i].y] = "bridge";
        if(name === "conveyor"){
            beltAt[plans[i].x + "," + plans[i].y] = "conveyor";
            conveyors.push(plans[i]);
        }
        if(name === "mechanicalDrill") drills.push(plans[i]);
    }

    var dead = 0;
    for(i = 0; i < conveyors.length; i++){
        var c = conveyors[i];
        var dx = c.rot === 0 ? 1 : (c.rot === 2 ? -1 : 0);
        var dy = c.rot === 1 ? 1 : (c.rot === 3 ? -1 : 0);
        if(beltAt[(c.x + dx) + "," + (c.y + dy)] == null) dead++;
    }

    var unconnected = 0;
    for(i = 0; i < drills.length; i++){
        var d = drills[i];
        var ok = false;
        for(var bx = -1; bx <= 2 && !ok; bx++){
            for(var by = -1; by <= 2; by++){
                if(bx >= 0 && bx <= 1 && by >= 0 && by <= 1) continue;
                if(beltAt[(d.x + bx) + "," + (d.y + by)] != null){ ok = true; break; }
            }
        }
        if(!ok) unconnected++;
    }

    check("belt tool: no conveyor pushes into an empty tile (no dead belts)",
        dead === 0, "dead conveyors=" + dead + "/" + conveyors.length);
    check("belt tool: every drill sits beside a belt", unconnected === 0,
        "drills without a belt=" + unconnected + "/" + drills.length);
})();

// ---------------------------------------------------------------- 6i. belt lanes

// The lane mode is a different support path: belts, power and water share the lane rows, and the
// drills beside a lane have to end up in reach of a power block.
(function(){
    S.settings = {"auto-drill-ios-build-belt-lanes": true};
    var laneFill = optimization.fillDetailed(centreOf(round), laser, true, "sharded", null, 0);
    S.settings = null;

    var belts = 0, power = 0, drills = 0;
    for(var i = 0; i < laneFill.plans.length; i++){
        var name = api.blockName(laneFill.plans[i].block);
        if(name === "itemBridge") belts++;
        if(isPowerBlock(laneFill.plans[i].block)) power++;
        if(api.blockId(laneFill.plans[i].block) === api.blockId(laser)) drills++;
    }

    check("lanes: belts are planned on the lanes", belts > 10, "belts=" + belts);
    check("lanes: power blocks ride the lanes", power > 5, "power=" + power);
    check("lanes: coverage stays in the range the lanes allow",
        laneFill.stats.covered >= laneFill.stats.target * 0.7,
        "covered=" + laneFill.stats.covered + "/" + laneFill.stats.target);
    check("lanes: nothing overlaps", overlapCells(laneFill.plans) === 0);

    var nodes = plannedNodes(laneFill.plans);
    var linkRange2 = rangeOf(nodes);
    var unpowered = 0;
    for(i = 0; i < laneFill.plans.length; i++){
        if(api.blockId(laneFill.plans[i].block) !== api.blockId(laser)) continue;

        var ok = false;
        for(var k = 0; k < nodes.length && !ok; k++){
            var dx = api.tx(laneFill.plans[i]) - api.tx(nodes[k]);
            var dy = api.ty(laneFill.plans[i]) - api.ty(nodes[k]);
            if(dx * dx + dy * dy <= linkRange2 * linkRange2) ok = true;
        }
        if(!ok) unpowered++;
    }
    check("lanes: every drill is in reach of a lane power block", unpowered === 0,
        "unpowered=" + unpowered + "/" + drills + " blocks=" + power);
})();

// The Airblast Drill is 4x4 in the game (Blocks.blastDrill, v160.7): the lane grid has to open
// a lane every job.size + 1 rows, or every 4x4 placement collides with a reserved lane tile
// (the four-row pitch of the 3x3 drills leaves no room for a 4x4 drill between two lanes).
(function(){
    check("fake-api: blastDrill is 4x4 like Mindustry Blocks.blastDrill",
        api.size(blast) === 4, "size=" + api.size(blast));

    S.settings = {"auto-drill-ios-build-belt-lanes": true};
    util.undoLastCommitted();
    var blastLaneFill = optimization.fillDetailed(centreOf(round), blast, true, "sharded", null, 0);
    S.settings = null;
    check("lanes: 4x4 airblast drill places drills and lanes without being blocked by 4-row pitch",
        blastLaneFill.stats.drills >= 25 && blastLaneFill.stats.covered >= blastLaneFill.stats.target * 0.60
            && overlapCells(blastLaneFill.plans) === 0,
        "drills=" + blastLaneFill.stats.drills + " covered=" + blastLaneFill.stats.covered
            + "/" + blastLaneFill.stats.target + " overlap=" + overlapCells(blastLaneFill.plans));
})();

// ---------------------------------------------------------------- 6j. output routing

// Output routing plans a straight conveyor (duct) run away from every drill. With support
// blocks on, the routing has to happen before the extractors and power blocks: those are
// placed through the occupancy map and used to claim the ring tiles on the requested output
// side, leaving the conveyors truncated ("+11 routing tiles" instead of one run per drill).
(function(){
    util.undoLastCommitted();
    var routedRes = optimization.fillDetailed(centreOf(small), laser, true, "sharded", direction.RIGHT, 4);
    var convCount = 0;
    for(var i = 0; i < routedRes.plans.length; i++){
        if(api.blockName(routedRes.plans[i].block) === "conveyor") convCount++;
    }
    check("output routing with support ON: conveyors are placed before extractors/nodes can block them",
        convCount >= 8 && overlapCells(routedRes.plans) === 0,
        "conveyors=" + convCount + " drills=" + routedRes.stats.drills
            + " extractors=" + routedRes.stats.extractors + " nodes=" + routedRes.stats.nodes);
})();

// ---------------------------------------------------------------- 6e. the corpus regression

// The real-map corpus found one patch (17.msav_scrap_0) where the final layout still had two
// free candidates that mined uncovered tiles: the deep repair rebuilds a window-local
// neighbourhood, and its ruin can free a candidate *outside* that window, which the window-local
// refill never sees. finish() now runs the gap filler once more over the final layout. Fixture
// extracted from the corpus patch with tools/mapdata/extract_regression.py (run of 2026-10-29,
// baseline hash 0x849e0629; the patch covered 123/129 before the fix).
(function(){
    withSettings(null);
    util.undoLastCommitted();
    var tap = api.tile(S.terrainTap1[0], S.terrainTap1[1]);
    if(api.drop(tap) == null){
        check("corpus regression fixture loads (17.msav_scrap_0)", false, "tap has no ore");
        return;
    }
    var job = optimization.prepare(tap, laser, false, "sharded", null, 0);
    while(!optimization.searchStep(job, Infinity)){
        // run to completion
    }
    var plans = optimization.finish(job);

    var occ = {}, covered = {};
    var i = 0, k = 0;
    for(i = 0; i < plans.length; i++){
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
            if(occ[cells[k]] === true){ blocked = true; break; }
        }
        if(blocked) continue;
        var mine = entry.mineableKeys;
        for(k = 0; k < mine.length; k++){
            if(covered[mine[k]] !== true){ freeWithGain++; break; }
        }
    }

    // the patch's own ore tiles under the drills
    var reached = util.getConnectedTiles(tap, 5001, "sharded");
    var sourceId = api.itemId(api.drop(tap));
    var ore = {};
    var total = 0;
    for(i = 0; i < reached.length; i++){
        if(api.itemId(api.drop(reached[i])) === sourceId){
            ore[api.pos(reached[i])] = true;
            total++;
        }
    }
    var patchCovered = 0;
    for(var ok in ore){
        if(covered[ok] === true) patchCovered++;
    }

    check("corpus patch 17.msav_scrap_0: the final gap fill closes the repair's free anchors",
        total === 129 && freeWithGain === 0 && patchCovered >= 125,
        "covered=" + patchCovered + "/" + total + " freeWithGain=" + freeWithGain
            + " repairGain=" + job.stats.repairGain + " source=" + job.stats.source);
})();

// The second corpus regression: a drill whose conveyor line to the belt grid was longer than the
// packing pass's path cap stayed unwired on 12.msav_titanium_23. The final repair pass now
// searches farther (240 nodes / 24 tiles); this patch went from 3 to 4 wired drills of 5, so the
// check pins the improvement, not perfection (the fifth drill has no reachable belt ground).
(function(){
    withSettings(null);
    util.undoLastCommitted();
    var tap = api.tile(S.terrainTap2[0], S.terrainTap2[1]);
    var plans = bridge.fill(tap, api.block("mechanicalDrill"), direction.RIGHT, "sharded");
    var wiring = beltWiring(plans);
    check("corpus patch 12.msav_titanium_23: the final belt repair wires the long-path drill",
        wiring.drills >= 5 && wiring.wired >= 4,
        "wired=" + wiring.wired + "/" + wiring.drills + " plans=" + plans.length);
})();

// The third corpus regression: the worst patch of the 2026-10-29 belt scoreboard. Its alignment
// needed a drill-pattern phase outside the old 3x3 search, and one-tile sandwiches between
// pattern drills kept the add-only passes from closing the rest. The 6x6 phase candidates plus
// the layout competition lifted it from 6/14 to 11/14 (baseline hash 0x849e0629 -> 0x405311df).
(function(){
    withSettings(null);
    var tap = api.tile(S.terrainTap3[0], S.terrainTap3[1]);
    var reached = util.getConnectedTiles(tap, 5001, "sharded");
    var sourceId = api.itemId(api.drop(tap));
    var ore = {};
    var total = 0;
    for(var i = 0; i < reached.length; i++){
        if(api.itemId(api.drop(reached[i])) === sourceId){
            ore[api.pos(reached[i])] = true;
            total++;
        }
    }
    var mechanical = api.block("mechanicalDrill");
    var dirs = [direction.RIGHT, direction.DOWN, direction.UP, direction.LEFT];
    var best = 0;
    for(var d = 0; d < dirs.length; d++){
        util.undoLastCommitted();
        var plans = bridge.fill(tap, mechanical, dirs[d], "sharded");
        var size = api.size(mechanical), offset = Math.floor((size - 1) / 2);
        var covered = {};
        for(i = 0; i < plans.length; i++){
            if(api.blockId(plans[i].block) !== api.blockId(mechanical)) continue;
            for(var dx = 0; dx < size; dx++){
                for(var dy = 0; dy < size; dy++){
                    var key = (plans[i].x - offset + dx) + (plans[i].y - offset + dy) * W;
                    if(ore[key] === true) covered[key] = true;
                }
            }
        }
        var n = 0;
        for(var ck in covered) n++;
        if(n > best) best = n;
    }
    check("corpus patch sector-serpulo-165.msav_coal_38: the worst belt patch stays above its fixed floor",
        total === 14 && best >= 11,
        "covered=" + best + "/" + total + " (was 6/14 before the phase competition)");
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
