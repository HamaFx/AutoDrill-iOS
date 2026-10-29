// Wall probe: runs the wall-ore fill (plasma bores + ducts + beam nodes) over wall bodies whose
// surfaces carry ore, then simulates the game's BeamDrill to measure how much of that ore the
// planned bores actually mine.
//
// BeamDrill mechanics (BeamDrill.java, v160.7): a bore has one lane per block side across the
// facing direction; each lane walks up to `range` tiles and mines the FIRST solid tile it finds
// there - the ore tile stays solid, so the beam never advances past it. Coverage therefore means
// "every ore tile is the first solid tile of some planned bore's lane".
//
// Driven by tools/wall-probe.sh; shapes in tests/js/wall-scenarios.js.

"use strict";

var api = require("api");
var util = require("util");
var wall = require("wall");
var dir = require("direction");

var S = AUTODRILL_WALLS;
var WORLD = S.world;

function info(text){
    java.lang.System.out.println("WALL " + text);
}

function keyOf(x, y){ return x + y * WORLD; }

// every ore cell of the whole battery (coverage is measured per shape anyway)
var ALL_ORE = {};
for(var si = 0; si < S.shapes.length; si++){
    var sh = S.shapes[si];
    for(var oi = 0; oi < sh.ore.length; oi++){
        ALL_ORE[keyOf(sh.ore[oi][0], sh.ore[oi][1])] = true;
    }
}

var drill = api.block("plasmaBore");
var size = api.size(drill);
var range = api.beamRange(drill);

/** Block.nearbySide - the tile a lane starts at, just outside the block on that side. */
function laneStart(px, py, rot, index){
    var cornerX = px - Math.floor((size - 1) / 2), cornerY = py - Math.floor((size - 1) / 2);
    if(rot === 0) return {x: cornerX + size, y: cornerY + index};
    if(rot === 1) return {x: cornerX + index, y: cornerY + size};
    if(rot === 2) return {x: cornerX - 1, y: cornerY + index};
    return {x: cornerX + index, y: cornerY - 1};
}

/** The first solid tile a lane sees, or null. Planned bores are solid and block beams. */
function firstSolid(x, y, rot, solidAt){
    var dx = rot === 0 ? 1 : (rot === 2 ? -1 : 0);
    var dy = rot === 1 ? 1 : (rot === 3 ? -1 : 0);
    for(var j = 0; j < range; j++){
        var tx = x + dx * j, ty = y + dy * j;
        if(tx < 0 || ty < 0 || tx >= WORLD || ty >= WORLD) return null;
        var tile = api.tile(tx, ty);
        if(tile == null) return null;
        if(solidAt[keyOf(tx, ty)] === true) return null;
        if(api.solid(tile)) return {x: tx, y: ty};
    }
    return null;
}

function runShape(shape){
    var direction = null;
    if(shape.dir === "RIGHT") direction = dir.RIGHT;
    if(shape.dir === "UP") direction = dir.UP;
    if(shape.dir === "LEFT") direction = dir.LEFT;
    if(shape.dir === "DOWN") direction = dir.DOWN;

    util.undoLastCommitted();
    var t0 = Date.now();
    var plans = wall.fill({x: shape.tap[0], y: shape.tap[1]}, drill, direction, "sharded");
    var ms = Date.now() - t0;

    var bores = [];
    var solidAt = {};
    var nodes = 0;
    var ducts = 0;
    var itemBridge = api.block("beamNode");
    for(var p = 0; p < plans.length; p++){
        if(api.blockId(plans[p].block) === api.blockId(drill)){
            bores.push(plans[p]);
            solidAt[keyOf(plans[p].x, plans[p].y)] = true;
        }else if(api.blockId(plans[p].block) === api.blockId(itemBridge)){
            nodes++;
        }else{
            ducts++;
        }
    }

    var covered = {};
    for(p = 0; p < bores.length; p++){
        for(var i = 0; i < size; i++){
            var lane = laneStart(bores[p].x, bores[p].y, bores[p].rot, i);
            var target = firstSolid(lane.x, lane.y, bores[p].rot, solidAt);
            if(target != null && ALL_ORE[keyOf(target.x, target.y)] === true){
                covered[keyOf(target.x, target.y)] = true;
            }
        }
    }

    var total = shape.ore.length;
    var got = 0;
    for(oi = 0; oi < shape.ore.length; oi++){
        if(covered[keyOf(shape.ore[oi][0], shape.ore[oi][1])] === true) got++;
    }
    var pct = total === 0 ? 0 : Math.round(got * 1000 / total) / 10;

    // is the power network chained to the target? (nodes within link range of it)
    var linkRange = api.powerRangeOf(api.block("beamNode"));
    var linked = 0;
    for(p = 0; p < plans.length; p++){
        if(api.blockId(plans[p].block) !== api.blockId(api.block("beamNode"))) continue;
        var dx = plans[p].x - S.powerTarget.x, dy = plans[p].y - S.powerTarget.y;
        if(dx * dx + dy * dy <= linkRange * linkRange) linked++;
    }

    info("shape=" + pad(shape.name, 14)
        + " dir=" + pad(shape.dir, 5)
        + " ore=" + pad(total, 3)
        + " mined=" + pad(got, 3) + " (" + pct + "%)"
        + " bores=" + pad(bores.length, 3)
        + " ducts=" + pad(ducts, 4)
        + " nodes=" + pad(nodes, 3)
        + " gridNodes=" + linked
        + " ms=" + ms);

    if(got < total){
        var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
        for(oi = 0; oi < shape.ore.length; oi++){
            minX = Math.min(minX, shape.ore[oi][0]); maxX = Math.max(maxX, shape.ore[oi][0]);
            minY = Math.min(minY, shape.ore[oi][1]); maxY = Math.max(maxY, shape.ore[oi][1]);
        }
        minX -= 3; minY -= 3; maxX += 3; maxY += 3;
        for(var y2 = maxY; y2 >= minY; y2--){
            var row = "";
            for(var x2 = minX; x2 <= maxX; x2++){
                var t = api.tile(x2, y2);
                if(t == null){ row += " "; continue; }
                var k = keyOf(x2, y2);
                if(ALL_ORE[k] === true) row += covered[k] === true ? "#" : "o";
                else if(api.solid(t)) row += "|";
                else row += " ";
            }
            java.lang.System.out.println("WALL-MAP " + row);
        }
    }
    return got === total;
}

function pad(text, width){
    text = String(text);
    while(text.length < width) text += " ";
    return text;
}

// ---------------------------------------------------------------- run

var pass = 0, bad = 0;
for(var i = 0; i < S.shapes.length; i++){
    var ok = false;
    try{
        ok = runShape(S.shapes[i]);
    }catch(e){
        java.lang.System.out.println("WALL-FAIL " + S.shapes[i].name + " threw: " + e + "\n" + (e == null ? "" : e.stack));
    }
    if(ok) pass++; else bad++;
}
info("BATTERY RESULT full=" + pass + " partial=" + bad + " of " + S.shapes.length);
