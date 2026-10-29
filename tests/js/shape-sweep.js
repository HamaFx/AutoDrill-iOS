// Shape sweep: how good is the placement engine across patch shapes, and how much headroom is
// left? For every shape it reports the fill's coverage, the number of tiles left as one-tile
// holes inside the mined area, and a reference from a randomised multi-restart greedy packer.
//
// The gap to the reference is the honest "what is still on the table" number: it is the
// difference between what the engine plans and what a much slower solver reaches on the same
// candidates and the same placement rules.
//
// Driven by tools/shape-sweep.sh.

"use strict";

var api = require("api");
var optimization = require("optimization");
var bridge = require("bridge");
var direction = require("direction");
var refpack = require("reference-pack");

var S = AUTODRILL_FAKE_SCENARIO;
var W = S.world;

function info(text){
    java.lang.System.out.println("SWEEP " + text);
}

// ---------------------------------------------------------------- world helpers

// the patch shape and the reference packer share one ore-cell model (reference-pack.js)
var oreCells = refpack.oreCells;

function centreOf(shape){
    var cx = Math.floor((shape.oreX0 + shape.x1) / 2), cy = Math.floor((shape.oreY0 + shape.y1) / 2);

    // the centre of a holed patch is not ore: tap the ore cell nearest to it instead, or the
    // fill starts on an empty tile and plans nothing at all
    var ore = oreCells(shape);
    if(ore[cx + cy * W] === true) return {x: cx, y: cy};

    var best = null, bestD = 0;
    for(var key in ore){
        var x = key % W, y = Math.floor(key / W);
        var d = (x - cx) * (x - cx) + (y - cy) * (y - cy);
        if(best == null || d < bestD){
            best = {x: x, y: y};
            bestD = d;
        }
    }
    return best == null ? {x: cx, y: cy} : best;
}

/** Ore tiles a drill mines that nothing mines, and how many of those sit inside the mined area. */
function measure(shape, plans, drill){
    var ore = oreCells(shape);
    var size = api.size(drill);
    var offset = Math.floor((size - 1) / 2);
    var covered = {};
    var drills = 0;

    for(var i = 0; i < plans.length; i++){
        if(api.blockId(plans[i].block) !== api.blockId(drill)) continue;
        drills++;
        for(var dx = 0; dx < size; dx++){
            for(var dy = 0; dy < size; dy++){
                var key = (plans[i].x - offset + dx) + (plans[i].y - offset + dy) * W;
                if(ore[key] === true) covered[key] = true;
            }
        }
    }

    var total = 0;
    for(var o in ore) total++;

    var n = 0;
    for(var c in covered) n++;

    // "holes": uncovered ore tiles with mined tiles on all four sides - gaps *inside* the layout
    var holes = 0;
    for(var key2 in ore){
        if(covered[key2] === true) continue;
        var hx = key2 % W, hy = Math.floor(key2 / W);
        if(covered[(hx + 1) + hy * W] === true && covered[(hx - 1) + hy * W] === true
            && covered[hx + (hy + 1) * W] === true && covered[hx + (hy - 1) * W] === true){
            holes++;
        }
    }

    return {covered: n, total: total, drills: drills, holes: holes};
}

// ---------------------------------------------------------------- the sweep

var failures = 0;

var laser = api.block("laserDrill");
var mechanical = api.block("mechanicalDrill");

var cases = [
    {name: "square 24x24", shape: S.patches[0], drill: laser, mode: "optimizer", minOres: 2},
    {name: "round 45x45", shape: S.patches[1], drill: laser, mode: "optimizer", minOres: 2},
    {name: "round squashed", shape: S.patches[2], drill: laser, mode: "optimizer", minOres: 2},
    {name: "small 10x10", shape: S.patches[3], drill: laser, mode: "optimizer", minOres: 2},
    {name: "1-wide vein", shape: S.patches[4], drill: laser, mode: "optimizer", minOres: 2},
    {name: "diagonal band", shape: S.patches[5], drill: laser, mode: "optimizer", minOres: 2},
    {name: "patch with a hole", shape: S.patches[6], drill: laser, mode: "optimizer", minOres: 2},
    {name: "square + power", shape: S.patches[0], drill: laser, mode: "optimizer", minOres: 2, support: true},
    {name: "round + power", shape: S.patches[1], drill: laser, mode: "optimizer", minOres: 2, support: true},
    {name: "vein + power", shape: S.patches[4], drill: laser, mode: "optimizer", minOres: 2, support: true},
    {name: "band + power", shape: S.patches[5], drill: laser, mode: "optimizer", minOres: 2, support: true},
    {name: "square + lanes", shape: S.patches[0], drill: laser, mode: "optimizer", minOres: 2, support: true, lanes: true},
    {name: "round + lanes", shape: S.patches[1], drill: laser, mode: "optimizer", minOres: 2, support: true, lanes: true},
    {name: "2-wide vein + belts", shape: S.patches[7], drill: mechanical, mode: "belt", minOres: 1},
    {name: "small square + belts", shape: S.patches[8], drill: mechanical, mode: "belt", minOres: 1}
];

for(var c = 0; c < cases.length; c++){
    var test = cases[c];
    var centre = centreOf(test.shape);
    var support = test.support === true;

    if(S.settings == null) S.settings = {};
    S.settings["auto-drill-ios-build-belt-lanes"] = test.lanes === true;
    var plans = null;
    var started = Date.now();

    if(test.mode === "optimizer"){
        // one call only: a second fill treats the first one's plans as taken (by design)
        plans = optimization.fill(centre, test.drill, support, "sharded", null, 0);
    }else{
        plans = bridge.fill(centre, test.drill, direction.RIGHT, "sharded");
    }
    var ms = Date.now() - started;

    var got = measure(test.shape, plans, test.drill);
    var ref = refpack.packReference(test.shape, test.drill, test.minOres, 60);
    var pct = got.total === 0 ? 0 : Math.round(got.covered * 1000 / got.total) / 10;
    var refPct = got.total === 0 ? 0 : Math.round(ref * 1000 / got.total) / 10;

    // floors are the promises the engine makes: every tile with the support off, and the
    // measured support cost (the power blocks need tiles) with it on
    var floor = test.lanes === true ? 70 : (test.support === true ? 80 : (test.mode === "belt" ? 85 : 99));
    if(pct < floor){
        java.lang.System.out.println("SWEEP FAIL " + test.name + ": " + pct + "% < " + floor + "%");
        failures++;
    }

    info(pad(test.name, 20)
        + " engine=" + pad(pct + "%", 7)
        + " reference=" + pad(refPct + "%", 7)
        + " headroom=" + pad(Math.round((refPct - pct) * 10) / 10 + "%", 8)
        + " holes=" + pad(got.holes, 4)
        + " drills=" + pad(got.drills, 4)
        + " ms=" + ms);
}

java.lang.System.out.println("SWEEP RESULT failures=" + failures);

function pad(text, width){
    text = String(text);
    while(text.length < width) text += " ";
    return text;
}
