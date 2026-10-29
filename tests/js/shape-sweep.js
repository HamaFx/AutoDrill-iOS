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

var S = AUTODRILL_FAKE_SCENARIO;
var W = S.world;

function info(text){
    java.lang.System.out.println("SWEEP " + text);
}

// ---------------------------------------------------------------- world helpers

function oreCells(shape){
    var set = {};
    var i = 0, j = 0;

    for(i = shape.oreX0; i <= shape.x1; i++){
        for(j = shape.oreY0; j <= shape.y1; j++){
            var key = i + j * W;
            if(shape.round === true){
                var cx = (shape.oreX0 + shape.x1) / 2, cy = (shape.oreY0 + shape.y1) / 2;
                var d = (i - cx) * (i - cx) + (j - cy) * (j - cy);
                if(d > Math.min(shape.x1 - shape.oreX0, shape.y1 - shape.oreY0) * Math.min(shape.x1 - shape.oreX0, shape.y1 - shape.oreY0) / 4 * 0.8) continue;
            }
            if(shape.band === true){
                var t = i - shape.oreX0;
                if(((j - shape.oreY0) - t) % 9 > 1 && ((j - shape.oreY0) - t) % 9 < 9) continue;
            }
            if(shape.hole === true){
                var hx = (shape.oreX0 + shape.x1) / 2, hy = (shape.oreY0 + shape.y1) / 2;
                if(Math.abs(i - hx) < 3 && Math.abs(j - hy) < 3) continue;
            }
            set[key] = true;
        }
    }
    return set;
}

function centreOf(shape){
    return {x: Math.floor((shape.oreX0 + shape.x1) / 2), y: Math.floor((shape.oreY0 + shape.y1) / 2)};
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

/**
 * Reference: randomised greedy packing over the same patch, many restarts, best kept. It uses
 * the plain rules (a drill fits when its footprint has enough of the ore and does not overlap),
 * so it says how much of the patch *can* be covered rather than how much the engine does cover.
 */
function reference(shape, drill, minOres, restarts){
    var ore = oreCells(shape);
    var size = api.size(drill);
    var offset = Math.floor((size - 1) / 2);

    var candidates = [];
    var i = 0, x = 0, y = 0;
    for(var key in ore){
        x = key % W;
        y = Math.floor(key / W);
        // centre the drill anywhere its footprint touches the patch (the ring included)
        for(var cx = x - offset; cx <= x + offset; cx++){
            for(var cy = y - offset; cy <= y + offset; cy++){
                candidates.push({x: cx, y: cy});
            }
        }
    }
    // de-duplicate
    var seen = {};
    var uniq = [];
    for(i = 0; i < candidates.length; i++){
        var ck = candidates[i].x + candidates[i].y * W;
        if(seen[ck] === true) continue;
        seen[ck] = true;
        uniq.push(candidates[i]);
    }

    // a lattice pass first: the engine's own strongest family, so the reference never
    // "under-performs" it and the headroom stays honest
    var best = 0;
    for(var ax = 0; ax < size; ax++){
        for(var ay = 0; ay < size; ay++){
            var occupied2 = {};
            var covered2 = {};
            var count2 = 0;

            for(i = 0; i < uniq.length; i++){
                var lc = uniq[i];
                if(((lc.x - ax) % size + size) % size !== 0) continue;
                if(((lc.y - ay) % size + size) % size !== 0) continue;

                var fits3 = true;
                var mined3 = [];
                for(var dx3 = 0; dx3 < size && fits3; dx3++){
                    for(var dy3 = 0; dy3 < size; dy3++){
                        var cell3 = (lc.x - offset + dx3) + (lc.y - offset + dy3) * W;
                        if(occupied2[cell3] === true){
                            fits3 = false;
                            break;
                        }
                        occupied2[cell3] = true;
                        if(ore[cell3] === true) mined3.push(cell3);
                    }
                }
                if(!fits3 || mined3.length < minOres) continue;
                for(var m3 = 0; m3 < mined3.length; m3++){
                    if(covered2[mined3[m3]] !== true){
                        covered2[mined3[m3]] = true;
                        count2++;
                    }
                }
            }
            if(count2 > best) best = count2;
        }
    }

    for(var r = 0; r < restarts; r++){
        var occupied = {};
        var covered = {};
        var count = 0;

        // a different order every restart: this is the whole point of the reference
        var order = uniq.slice();
        var seed = r * 2654435761 % 2147483647;
        for(i = order.length - 1; i > 0; i--){
            seed = (seed * 1103515245 + 12345) % 2147483648;
            var j = seed % (i + 1);
            var tmp = order[i];
            order[i] = order[j];
            order[j] = tmp;
        }

        for(i = 0; i < order.length; i++){
            var cand = order[i];
            var fits = true;
            var gain = 0;
            var cells = [];
            var mined = [];

            for(var dx = 0; dx < size && fits; dx++){
                for(var dy = 0; dy < size; dy++){
                    var cell = (cand.x - offset + dx) + (cand.y - offset + dy) * W;
                    if(occupied[cell] === true){
                        fits = false;
                        break;
                    }
                    cells.push(cell);
                    if(ore[cell] === true) mined.push(cell);
                }
            }
            if(!fits || mined.length < minOres) continue;

            for(var k = 0; k < cells.length; k++) occupied[cells[k]] = true;
            for(k = 0; k < mined.length; k++){
                if(covered[mined[k]] !== true){
                    covered[mined[k]] = true;
                    count++;
                }
            }
        }
        if(count > best) best = count;
    }
    return best;
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
    {name: "2-wide vein + belts", shape: S.patches[7], drill: mechanical, mode: "belt", minOres: 1},
    {name: "small square + belts", shape: S.patches[8], drill: mechanical, mode: "belt", minOres: 1}
];

for(var c = 0; c < cases.length; c++){
    var test = cases[c];
    var centre = centreOf(test.shape);
    var support = test.support === true;
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
    var ref = reference(test.shape, test.drill, test.minOres, 60);
    var pct = got.total === 0 ? 0 : Math.round(got.covered * 1000 / got.total) / 10;
    var refPct = got.total === 0 ? 0 : Math.round(ref * 1000 / got.total) / 10;

    // floors are the promises the engine makes: every tile with the support off, and the
    // measured support cost (the power blocks need tiles) with it on
    var floor = test.support === true ? 80 : (test.mode === "belt" ? 85 : 99);
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
