// Vein probe: runs a battery of awkward ore shapes through the placement engine on the fake
// world and reports, per shape, exactly which ore tiles were left behind and why.
//
//   * covered      - ore tiles under a committed drill (measured from the plans)
//   * reachable    - tiles some legal candidate could mine (independent of the layout)
//   * unreachable  - tiles no candidate can mine at the current Min Ores / ground
//   * blocked      - reachable but not covered: the layout left them, not the rules
//   * free-gap     - a candidate could still mine a leftover tile without overlapping the
//                    committed layout (must be zero: the gap filler promises this)
//
// For every partial shape it also dumps the engine's *exact* candidate set (centres, footprints
// and mined cells), so tools/vein-solve.py can compute the true optimum offline.
//
// Driven by tools/vein-probe.sh; shape library in tests/js/vein-scenarios.js.
//
// NOTE: no helper that returns a newly built object is called from a loop here. On the
// interpreted engine iOS uses, that pattern corrupts the loop (docs/AUDIT.md, landmine 2), and a
// dev probe must not trip over the very class of bug it is used to find.

"use strict";

var api = require("api");
var util = require("util");
var optimization = require("optimization");
var bridge = require("bridge");
var direction = require("direction");

var V = AUTODRILL_VEINS;
var W = V.world;

// ---- per-run settings override (same trick as engine-tests.js) ----

var OVERRIDE = {};
var realSettingInt = api.settingInt;
api.settingInt = function(key, def){
    return OVERRIDE[key] != null ? OVERRIDE[key] : realSettingInt(key, def);
};

function info(text){
    java.lang.System.out.println("VEIN " + text);
}

function fail(text){
    java.lang.System.out.println("VEIN-FAIL " + text);
}

function keyOf(x, y){ return x + y * W; }

function countKeys(set){
    var n = 0;
    for(var k in set) n++;
    return n;
}

/** 8-connected components of a cell list - a real ore patch is always one of them. */
function components(cells){
    var index = {};
    var i = 0;
    for(i = 0; i < cells.length; i++) index[keyOf(cells[i][0], cells[i][1])] = i;

    var seen = {};
    var count = 0;
    for(i = 0; i < cells.length; i++){
        var start = keyOf(cells[i][0], cells[i][1]);
        if(seen[start] === true) continue;
        count++;
        var queue = [cells[i]];
        seen[start] = true;
        while(queue.length > 0){
            var cur = queue.pop();
            for(var dx = -1; dx <= 1; dx++){
                for(var dy = -1; dy <= 1; dy++){
                    if(dx === 0 && dy === 0) continue;
                    var k = keyOf(cur[0] + dx, cur[1] + dy);
                    if(index[k] === undefined || seen[k] === true) continue;
                    seen[k] = true;
                    queue.push([cur[0] + dx, cur[1] + dy]);
                }
            }
        }
    }
    return count;
}

/** The patch scan's expanded area: every tile in a (2*half+1)^2 box around the ore. */
function dilate(cells, half){
    var set = {};
    var list = [];
    for(var i = 0; i < cells.length; i++){
        var cx = cells[i][0], cy = cells[i][1];
        for(var dx = -half; dx <= half; dx++){
            for(var dy = -half; dy <= half; dy++){
                var k = keyOf(cx + dx, cy + dy);
                if(set[k] === true) continue;
                set[k] = true;
                list.push([cx + dx, cy + dy]);
            }
        }
    }
    return {set: set, list: list};
}

function runShape(shape){
    var drill = api.block(shape.drill);
    var size = api.size(drill);
    var half = Math.floor((size - 1) / 2);
    var cells = {};
    var total = 0;
    for(var c = 0; c < shape.cells.length; c++){
        cells[keyOf(shape.cells[c][0], shape.cells[c][1])] = true;
        total++;
    }

    if(components(shape.cells) > 1){
        fail(shape.name + ": shape is not one 8-connected patch - fix the generator");
        return false;
    }

    util.undoLastCommitted();
    var t0 = Date.now();
    var job = optimization.prepare({x: shape.tap[0], y: shape.tap[1]}, drill, false, "sharded", null, 0);
    while(!optimization.searchStep(job, Infinity)){
        // run to completion
    }
    var result = {plans: optimization.finish(job), stats: job.stats};
    var ms = Date.now() - t0;

    // coverage straight off the plans
    var covered = {};
    var drills = 0;
    var occ = {};
    for(var p = 0; p < result.plans.length; p++){
        var plan = result.plans[p];
        if(api.blockId(plan.block) !== api.blockId(drill)) continue;
        drills++;
        for(var dx = 0; dx < size; dx++){
            for(var dy = 0; dy < size; dy++){
                var k = keyOf(plan.x - half + dx, plan.y - half + dy);
                occ[k] = true;
                if(cells[k] === true) covered[k] = true;
            }
        }
    }
    var coveredCount = countKeys(covered);

    // how many drills have a free tile beside them (a belt or conveyor could live there)?
    var connectable = 0;
    for(p = 0; p < result.plans.length; p++){
        var dplan = result.plans[p];
        if(api.blockId(dplan.block) !== api.blockId(drill)) continue;
        var free = false;
        for(dx = -1; dx <= size && !free; dx++){
            for(dy = -1; dy <= size; dy++){
                var nx = dplan.x - half + dx, ny = dplan.y - half + dy;
                var insideOwn = dx >= 0 && dx < size && dy >= 0 && dy < size;
                if(insideOwn) continue;
                if(nx < 0 || ny < 0 || nx >= W || ny >= V.world) continue;
                if(occ[keyOf(nx, ny)] !== true){ free = true; break; }
            }
        }
        if(free) connectable++;
    }

    // independent reachability: union of every candidate's mined cells
    var reachable = {};
    for(var e = 0; e < job.entries.length; e++){
        var keys = job.entries[e].mineableKeys;
        for(var j = 0; j < keys.length; j++) reachable[keys[j]] = true;
    }
    var reachableCount = countKeys(reachable);

    // free-gap: a candidate that could still mine a leftover tile without overlapping the layout
    var freeGap = 0;
    for(e = 0; e < job.entries.length; e++){
        var entry = job.entries[e];
        var fits = true;
        var fk = 0;
        for(fk = 0; fk < entry.cellKeys.length; fk++){
            if(occ[entry.cellKeys[fk]] === true){ fits = false; break; }
        }
        if(!fits) continue;
        for(fk = 0; fk < entry.mineableKeys.length; fk++){
            if(covered[entry.mineableKeys[fk]] !== true){ freeGap++; break; }
        }
    }

    var pct = total === 0 ? 0 : Math.round(coveredCount * 1000 / total) / 10;
    var line = "shape=" + pad(shape.name, 14)
        + " drill=" + pad(shape.drill.replace("Drill", ""), 12)
        + " cells=" + pad(total, 4)
        + " covered=" + pad(coveredCount, 4) + " (" + pct + "%)"
        + " reachable=" + reachableCount
        + " unreachable=" + (total - reachableCount)
        + " freeGap=" + freeGap
        + " drills=" + drills
        + " connectable=" + connectable + "/" + drills
        + " cands=" + job.entries.length
        + " seen=" + result.stats.target
        + " stats=" + result.stats.covered + "/" + result.stats.unreachable + "/" + result.stats.blocked
        + " repair=" + result.stats.repairGain + "/" + result.stats.repairTrials
        + " source=" + pad(result.stats.source, 8)
        + " stopped=" + result.stats.stopped
        + " ms=" + ms;

    if(coveredCount === total && result.stats.covered === total && result.stats.target === total){
        info(line);
        return true;
    }

    info(line);
    if(result.stats.target !== total){
        fail(shape.name + ": engine saw " + result.stats.target + " ore tiles, the shape has " + total
            + " - shapes overlap in the world");
        return false;
    }
    if(coveredCount !== result.stats.covered){
        fail(shape.name + ": plan coverage " + coveredCount + " != engine's " + result.stats.covered);
    }

    // dump the exact instance for the offline optimum solver
    java.lang.System.out.println("VEIN-INSTANCE " + shape.name + " drill=" + shape.drill
        + " minOres=" + job.minOres + " world=" + W);
    for(var ck in cells){
        java.lang.System.out.println("VEIN-CELL " + (ck % W) + " " + Math.floor(ck / W));
    }
    for(e = 0; e < job.entries.length; e++){
        var ent = job.entries[e];
        var parts = [];
        for(j = 0; j < ent.mineableKeys.length; j++) parts.push(ent.mineableKeys[j]);
        var foot = [];
        for(j = 0; j < ent.cellKeys.length; j++) foot.push(ent.cellKeys[j]);
        java.lang.System.out.println("VEIN-CAND " + api.tx(ent.tile) + " " + api.ty(ent.tile)
            + " | " + foot.join(",") + " | " + parts.join(","));
    }
    for(p = 0; p < result.plans.length; p++){
        if(api.blockId(result.plans[p].block) !== api.blockId(drill)) continue;
        java.lang.System.out.println("VEIN-ENGINE " + result.plans[p].x + " " + result.plans[p].y);
    }

    // ASCII map with a per-tile diagnosis, so the shape itself shows where the layout failed
    var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for(ck in cells){
        var x = ck % W, y = Math.floor(ck / W);
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    minX -= 2; minY -= 2; maxX += 2; maxY += 2;

    for(var y2 = maxY; y2 >= minY; y2--){
        var row = "";
        for(var x2 = minX; x2 <= maxX; x2++){
            var kk = keyOf(x2, y2);
            if(cells[kk] !== true){ row += " "; continue; }
            if(covered[kk] === true) row += "#";
            else if(reachable[kk] === true) row += "x";
            else row += "?";
        }
        java.lang.System.out.println("VEIN-MAP " + row);
    }
    return false;
}

function pad(text, width){
    text = String(text);
    while(text.length < width) text += " ";
    return text;
}

// ---- the belt tool (mechanical/pneumatic): a different code path, measured the same way ----

function runBelt(shape){
    var drill = api.block("mechanicalDrill");
    var size = api.size(drill);
    var half = Math.floor((size - 1) / 2);
    var cells = {};
    var total = 0;
    for(var c = 0; c < shape.cells.length; c++){
        cells[keyOf(shape.cells[c][0], shape.cells[c][1])] = true;
        total++;
    }

    util.undoLastCommitted();
    var t0 = Date.now();
    var plans = bridge.fill({x: shape.tap[0], y: shape.tap[1]}, drill, direction.RIGHT, "sharded");
    var ms = Date.now() - t0;

    var covered = {};
    var drills = 0;
    for(var p = 0; p < plans.length; p++){
        if(api.blockId(plans[p].block) !== api.blockId(drill)) continue;
        drills++;
        for(var dx = 0; dx < size; dx++){
            for(var dy = 0; dy < size; dy++){
                var k = keyOf(plans[p].x - half + dx, plans[p].y - half + dy);
                if(cells[k] === true) covered[k] = true;
            }
        }
    }
    var coveredCount = countKeys(covered);
    var pct = total === 0 ? 0 : Math.round(coveredCount * 1000 / total) / 10;

    info("shape=" + pad(shape.name, 14)
        + " mode=belt       drill=mechanical"
        + " cells=" + pad(total, 4)
        + " covered=" + pad(coveredCount, 4) + " (" + pct + "%)"
        + " drills=" + pad(drills, 3)
        + " plans=" + pad(plans.length, 4)
        + " ms=" + ms);

    if(coveredCount === total) return true;

    var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for(var ck in cells){
        var x = ck % W, y = Math.floor(ck / W);
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    minX -= 2; minY -= 2; maxX += 2; maxY += 2;

    for(var y2 = maxY; y2 >= minY; y2--){
        var row = "";
        for(var x2 = minX; x2 <= maxX; x2++){
            var kk = keyOf(x2, y2);
            if(cells[kk] !== true){ row += " "; continue; }
            row += covered[kk] === true ? "#" : "x";
        }
        java.lang.System.out.println("VEIN-MAP " + row);
    }
    return false;
}

// ---------------------------------------------------------------- run

var filter = java.lang.System.getenv("AUTODRILL_VEIN_FILTER");
var shapes = V.shapes;
var pass = 0, bad = 0;

if(filter === "list"){
    for(var li = 0; li < shapes.length; li++){
        info("SHAPE " + li + " name=" + shapes[li].name + " cells=" + shapes[li].cells.length
            + " tap=" + shapes[li].tap[0] + "," + shapes[li].tap[1]);
    }
}else{
    // optional overrides for budget/limit experiments, e.g.
    //   AUTODRILL_VEIN_QUALITY=10 ./tools/vein-probe.sh walk-a
    var q = java.lang.System.getenv("AUTODRILL_VEIN_QUALITY");
    if(q != null && q.length > 0) OVERRIDE["auto-drill-ios-optimization-quality"] = parseInt(q, 10);
    var mo = java.lang.System.getenv("AUTODRILL_VEIN_MINORES");
    if(mo != null && mo.length > 0){
        OVERRIDE["mechanical-drill-min-ores"] = parseInt(mo, 10);
        OVERRIDE["pneumatic-drill-min-ores"] = parseInt(mo, 10);
        OVERRIDE["laser-drill-min-ores"] = parseInt(mo, 10);
        OVERRIDE["airblast-drill-min-ores"] = parseInt(mo, 10);
    }
    var drillOverride = java.lang.System.getenv("AUTODRILL_VEIN_DRILL");

    for(var i = 0; i < shapes.length; i++){
        var shape = shapes[i];
        if(filter != null && filter.length > 0 && shape.name.indexOf(filter) === -1) continue;
        if(drillOverride != null && drillOverride.length > 0){
            shape = {name: shape.name, drill: drillOverride, cells: shape.cells, tap: shape.tap};
        }
        var ok = false;
        try{
            ok = runShape(shape);
        }catch(e){
            fail(shape.name + " threw: " + e);
        }
        if(ok) pass++; else bad++;

        // the belt tool is a 2x2 tool of its own; skip it when comparing the optimiser with a
        // different drill (the drill override changes what is being measured)
        if(drillOverride == null || drillOverride.length === 0){
            try{
                ok = runBelt(shape);
            }catch(e){
                fail(shape.name + " belt threw: " + e);
                ok = false;
            }
            if(ok) pass++; else bad++;
        }
    }

    info("BATTERY RESULT full=" + pass + " partial=" + bad + " of " + (pass + bad));
}
