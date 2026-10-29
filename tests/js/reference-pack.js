// Randomised multi-restart reference packer, shared by the shape sweep, the corpus scoreboard
// and the offline teacher. It packs drills greedily over a patch's own ore cells in many
// different orders and keeps the best result, on the plain rules only (a drill fits when its
// footprint has enough of the ore and does not overlap), so it says how much of a patch *can*
// be covered - not how much the engine does cover.
//
// `shape` is either a sweep shape ({oreX0, oreY0, x1, y1, round, band, hole}) or
// {cells: [[x, y], ...]} for real-map patches. Behaviour on sweep shapes is unchanged from
// the original function in tests/js/shape-sweep.js.
//
// `fullAnchors` widens the candidate set to every legal anchor of the drill size. The original
// candidate model (default, used by the sweep) only centres the drill on the ore cell for even
// sizes, which is a *subset* of the legal anchors - fine for the sweep's own measurement, but
// a corpus reference must not sit below the engine. For odd sizes both are identical.
"use strict";

var api = require("api");

var S = AUTODRILL_FAKE_SCENARIO;
var W = S.world;

function oreCells(shape){
    var set = {};
    var i = 0, j = 0;

    if(shape.cells != null){
        for(i = 0; i < shape.cells.length; i++){
            set[shape.cells[i][0] + shape.cells[i][1] * W] = true;
        }
        return set;
    }

    for(i = shape.oreX0; i <= shape.x1; i++){
        for(j = shape.oreY0; j <= shape.y1; j++){
            var key = i + j * W;
            if(shape.round === true){
                var cx = (shape.oreX0 + shape.x1) / 2, cy = (shape.oreY0 + shape.y1) / 2;
                var d = (i - cx) * (i - cx) + (j - cy) * (j - cy);
                if(d > Math.min(shape.x1 - shape.oreX0, shape.y1 - shape.oreY0) * Math.min(shape.x1 - shape.oreX0, shape.y1 - shape.oreY0) / 4 * 0.8) continue;
            }
            if(shape.band === true){
                // 2-wide diagonal stripes with period 9, held together by the left column:
                // without the spine the stripes are separate patches and only the tapped one
                // could ever be filled (the sweep used to measure all of them anyway)
                var t = i - shape.oreX0;
                if(((j - shape.oreY0) - t) % 9 > 1 && ((j - shape.oreY0) - t) % 9 < 9 && i !== shape.oreX0) continue;
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

function packReference(shape, drill, minOres, restarts, fullAnchors){
    var ore = oreCells(shape);
    var size = api.size(drill);
    var offset = Math.floor((size - 1) / 2);

    // anchors covering an ore cell at (ox, oy): [ox - halfHigh, ox + halfLow]; the original
    // model uses the centre anchor only for even sizes (a subset of the legal anchors)
    var halfLow = Math.floor((size - 1) / 2);
    var halfHigh = Math.floor(size / 2);
    var anchorLow = fullAnchors === true ? halfHigh : halfLow;
    var anchorHigh = halfLow;

    var candidates = [];
    var i = 0, x = 0, y = 0;
    for(var key in ore){
        x = key % W;
        y = Math.floor(key / W);
        // centre the drill anywhere its footprint touches the patch (the ring included)
        for(var cx = x - anchorLow; cx <= x + anchorHigh; cx++){
            for(var cy = y - anchorLow; cy <= y + anchorHigh; cy++){
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

exports.oreCells = oreCells;
exports.packReference = packReference;
