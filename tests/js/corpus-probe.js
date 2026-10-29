// Corpus scoreboard: runs the fillers over every patch of the committed real-map corpus
// (tests/js/fixtures/corpus/) on the fake world and prints one line per patch plus a summary.
//
//   belt      - one bridge.fill per direction; the covered tiles, drills, wired drills (directed
//               flow model, same as realmap-probe) and dumping/stuck/broken bridges of the best
//               direction; beltMin is the worst direction's covered count
//   laserOn   - optimization.fillDetailed, support ON (the shipping default)
//   laserOff  - the same with support OFF: what the layout can do without power reservations
//   route     - laser + support ON + direction.RIGHT + output routing length 4; conveyor tiles
//
// Lines are fixed-format and the summary ends in an FNV-1a hash over the per-patch results
// (times excluded), so an accidental behaviour change cannot pass as "the same numbers".
// Driven by tools/corpus-probe.sh; modes come from the environment (see that script).
"use strict";

var api = require("api");
var bridge = require("bridge");
var optimization = require("optimization");
var direction = require("direction");
var util = require("util");

// reference-pack.js is the shared restarts packer (Task 3). Loaded on first use so the plain
// scoreboard runs without it, and only the teacher modes need the file present.
var refpack = null;
function refPack(){
    if(refpack == null) refpack = require("reference-pack");
    return refpack;
}

function env(name, fallback){
    var value = java.lang.System.getenv(name);
    return (value == null || value.length === 0) ? fallback : String(value);
}

var MODE = env("AUTODRILL_CORPUS_MODE", "full");
var JSON_PATH = env("AUTODRILL_CORPUS_JSON", "");
var LIMIT = parseInt(env("AUTODRILL_CORPUS_LIMIT", "0"), 10);   // dev knob: first N patches
var MAX_TILES = 5001;

function info(text){ java.lang.System.out.println("CORPUS " + text); }
function failLine(text){ java.lang.System.out.println("CORPUS-FAIL " + text); }

var DIRS = [["right", direction.RIGHT], ["down", direction.DOWN], ["up", direction.UP], ["left", direction.LEFT]];

var failures = 0;
function fail(text){
    failures++;
    failLine(text);
}

/** The tapped ore's reachable tiles (the engine's own patch definition). */
function patchTiles(patch){
    var tap = api.tile(patch.tap[0], patch.tap[1]);
    var sourceId = api.itemId(api.drop(tap));
    var reached = util.getConnectedTiles(tap, MAX_TILES, "sharded");
    var set = {};
    var total = 0;
    for(var i = 0; i < reached.length; i++){
        if(api.itemId(api.drop(reached[i])) === sourceId){
            set[api.pos(reached[i])] = true;
            total++;
        }
    }
    return {set: set, total: total, sourceId: sourceId};
}

/** Ore tiles under the drill plans, plus the drill count. */
function coverage(plans, drill, set){
    var size = api.size(drill);
    var off = Math.floor((size - 1) / 2);
    var covered = {};
    var drills = 0;
    for(var i = 0; i < plans.length; i++){
        if(api.blockId(plans[i].block) !== api.blockId(drill)) continue;
        drills++;
        for(var dx = 0; dx < size; dx++){
            for(var dy = 0; dy < size; dy++){
                var key = (plans[i].x - off + dx) + (plans[i].y - off + dy) * api.worldW();
                if(set[key] === true) covered[key] = true;
            }
        }
    }
    var n = 0;
    for(var k in covered) n++;
    return {covered: n, drills: drills};
}

/** Cells two plans both claim; any value > 0 is an engine bug. */
function overlapCells(plans){
    var occ = {};
    var bad = 0;
    for(var i = 0; i < plans.length; i++){
        var p = plans[i];
        var size = api.size(p.block);
        var off = Math.floor((size - 1) / 2);
        for(var dx = 0; dx < size; dx++){
            for(var dy = 0; dy < size; dy++){
                var key = (p.x - off + dx) + (p.y - off + dy) * api.worldW();
                if(occ[key] === true) bad++;
                occ[key] = true;
            }
        }
    }
    return bad;
}

/**
 * Directed flow model of the belt layout, exactly as Mindustry moves items: a drill's item
 * enters an adjacent conveyor or item bridge; a bridge sends to its config target; a bridge
 * with no target dumps onto its neighbours. A drill is "wired" when an adjacent belt reaches
 * such a dump point. (Copied from realmap-probe.js on purpose - the probes stay independent.)
 */
function transport(plans){
    var wW = api.worldW();
    var bridgeAt = {}, belts = {}, drills = [];
    var i = 0;
    for(i = 0; i < plans.length; i++){
        var p = plans[i];
        var name = api.blockName(p.block);
        if(name === "mechanicalDrill" || name === "pneumaticDrill"){ drills.push(p); continue; }
        if(name === "conveyor"){ belts[p.x + p.y * wW] = p; continue; }
        if(name === "itemBridge") bridgeAt[p.x + p.y * wW] = p;
    }

    /** 0 = reaches a dump point, 1 = dead end, 2 = broken (missing target / cycle). */
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
        var d2 = drills[i];
        var ok = false;
        for(var dx = -1; dx <= 2 && !ok; dx++){
            for(var dy = -1; dy <= 2; dy++){
                if(dx >= 0 && dx <= 1 && dy >= 0 && dy <= 1) continue;   // the drill footprint
                var k3 = (d2.x + dx) + (d2.y + dy) * wW;
                if(bridgeAt[k3] != null && flowStart(d2.x + dx, d2.y + dy) === 0){ ok = true; break; }
                if(convUsable[k3] === true){ ok = true; break; }
            }
        }
        if(ok) wired++;
    }

    var dumps = 0, stuck = 0, broken = 0;
    for(var bk3 in bridgeAt){
        var f = flowStart(bridgeAt[bk3].x, bridgeAt[bk3].y);
        if(f === 0) dumps++;
        else if(f === 1) stuck++;
        else broken++;
    }
    var bridges = 0;
    for(var q in bridgeAt) bridges++;
    return {drills: drills.length, wired: wired, bridges: bridges, dumps: dumps, stuck: stuck, broken: broken};
}

/** Does any plan tile sit within 5 tiles of existing transport (a belt, bridge or core)? */
function meetsBuilt(plans, built){
    for(var i = 0; i < built.length; i++){
        var bn = built[i][2];
        if(bn.indexOf("conveyor") < 0 && bn.indexOf("bridge") < 0 && bn.indexOf("core") < 0
            && bn.indexOf("duct") < 0 && bn.indexOf("junction") < 0 && bn.indexOf("router") < 0) continue;
        for(var p = 0; p < plans.length; p++){
            if(Math.abs(plans[p].x - built[i][0]) <= 5 && Math.abs(plans[p].y - built[i][1]) <= 5) return true;
        }
    }
    return false;
}

var FNV_OFFSET = 2166136261;
var FNV_PRIME = 16777619;

/** FNV-1a over one string, with the multiply split so every step stays an exact integer. */
function fnv1a(text, hash){
    var h = hash;
    for(var i = 0; i < text.length; i++){
        h = (h ^ text.charCodeAt(i)) >>> 0;
        h = ((h & 0xffff) * FNV_PRIME + ((((h >>> 16) * FNV_PRIME) & 0xffff) << 16)) >>> 0;
    }
    return h;
}

// ---------------------------------------------------------------- teacher modes

/** The patch's reachable ore cells as [x, y] pairs (row-major key order). */
function cellsOf(ps){
    var cells = [];
    for(var key in ps.set){
        var k = key | 0;
        cells.push([k % api.worldW(), Math.floor(k / api.worldW())]);
    }
    return cells;
}

/** Covered tiles + drill anchors of a plan list for one drill block. */
function engineResult(plans, drill, set){
    var cov = coverage(plans, drill, set);
    var anchors = [];
    for(var i = 0; i < plans.length; i++){
        if(api.blockId(plans[i].block) === api.blockId(drill)){
            anchors.push([plans[i].x, plans[i].y]);
        }
    }
    return {covered: cov.covered, drills: cov.drills, anchors: anchors};
}

var CAND_CAP = 300;   // ILP input cap: bigger patches get an upper-bound reference label

/**
 * --dump-candidates: the exact VEIN-INSTANCE/VEIN-CELL/VEIN-CAND/VEIN-ENGINE dump
 * (tests/js/vein-probe.js format) for tools/vein-solve.py, laser drill, support OFF, so the
 * solver works on the engine's own candidate set. Patches over CAND_CAP get VEIN-SKIP plus a
 * VEIN-REF upper bound from the restarts packer (never called "the optimum").
 */
function dumpCandidates(){
    var laser = api.block("laserDrill");
    var wW = api.worldW();
    for(var i = 0; i < LIST.length; i++){
        var patch = LIST[i];
        var ps = patchTiles(patch);
        if(ps.total === 0){
            fail(patch.name + ": no reachable ore tiles");
            continue;
        }

        util.undoLastCommitted();
        var job = optimization.prepare(api.tile(patch.tap[0], patch.tap[1]), laser, false, "sharded", null, 0);
        while(!optimization.searchStep(job, Infinity)){
            // run to completion
        }
        var plans = optimization.finish(job);
        var res = engineResult(plans, laser, ps.set);
        util.undoLastCommitted();

        if(job.entries.length > CAND_CAP){
            var ref = refPack().packReference({cells: cellsOf(ps)}, laser, job.minOres, 60, true);
            java.lang.System.out.println("VEIN-SKIP " + patch.name + " cands=" + job.entries.length);
            java.lang.System.out.println("VEIN-REF " + patch.name + " ref=" + ref
                + " engine=" + res.covered + " total=" + ps.total + " drill=laser");
            continue;
        }

        // vein-probe's summary line: tools/vein-solve.py attaches the engine coverage to the
        // instance from it (the SOLVE line reports engine= from here)
        java.lang.System.out.println("VEIN shape=" + patch.name + " drill=laser cells=" + ps.total
            + " covered=" + res.covered + " drills=" + res.drills + " cands=" + job.entries.length);
        java.lang.System.out.println("VEIN-INSTANCE " + patch.name + " drill=laser minOres=" + job.minOres
            + " world=" + wW + " total=" + ps.total);
        for(var ck in ps.set){
            var key = ck | 0;
            java.lang.System.out.println("VEIN-CELL " + (key % wW) + " " + Math.floor(key / wW));
        }
        for(var e = 0; e < job.entries.length; e++){
            var ent = job.entries[e];
            var foot = [];
            for(var f = 0; f < ent.cellKeys.length; f++) foot.push(ent.cellKeys[f]);
            var mine = [];
            for(var m = 0; m < ent.mineableKeys.length; m++) mine.push(ent.mineableKeys[m]);
            java.lang.System.out.println("VEIN-CAND " + api.tx(ent.tile) + " " + api.ty(ent.tile)
                + " | " + foot.join(",") + " | " + mine.join(","));
        }
        for(var a = 0; a < res.anchors.length; a++){
            java.lang.System.out.println("VEIN-ENGINE " + res.anchors[a][0] + " " + res.anchors[a][1]);
        }
    }
}

/**
 * --teacher: the belt tool's reference label. `ref` is the restarts packer's best on the same
 * patch with the plain packing rules (drill fits, no overlap), which ignore transport - so it
 * is an upper bound on what the belt tool could ever mine, not the optimum. `engine` is the
 * belt tool's own best-of-four-directions coverage (the scoreboard's number).
 */
function teacherRefs(){
    var mechanical = api.block("mechanicalDrill");
    for(var i = 0; i < LIST.length; i++){
        var patch = LIST[i];
        var ps = patchTiles(patch);
        if(ps.total === 0){
            fail(patch.name + ": no reachable ore tiles");
            continue;
        }

        var engine = 0;
        for(var d = 0; d < DIRS.length; d++){
            util.undoLastCommitted();
            var plans = bridge.fill(api.tile(patch.tap[0], patch.tap[1]), mechanical, DIRS[d][1], "sharded");
            var cov = coverage(plans, mechanical, ps.set);
            if(cov.covered > engine) engine = cov.covered;
        }
        util.undoLastCommitted();

        var ref = refPack().packReference({cells: cellsOf(ps)}, mechanical, 1, 200, true);
        java.lang.System.out.println("BELT-REF " + patch.name + " ref=" + ref
            + "/" + ps.total + " engine=" + engine);
    }
}

// ---------------------------------------------------------------- gap miner (--json)

/** Writes a UTF-8 text file (Rhino: java.nio is available, the fake world has no IO). */
function writeText(path, text){
    var bytes = new java.lang.String(text).getBytes("UTF-8");
    java.nio.file.Files.write(java.nio.file.Paths.get(path), bytes);
}

function jsonString(value){
    var s = String(value);
    s = s.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
    return "\"" + s + "\"";
}
function jsonKeyPair(key, wW){
    return "[" + (key % wW) + "," + Math.floor(key / wW) + "]";
}
function jsonKeyList(keys, wW){
    var parts = [];
    for(var i = 0; i < keys.length; i++) parts.push(jsonKeyPair(keys[i], wW));
    return "[" + parts.join(",") + "]";
}
function jsonPointList(points){
    var parts = [];
    for(var i = 0; i < points.length; i++) parts.push("[" + points[i][0] + "," + points[i][1] + "]");
    return "[" + parts.join(",") + "]";
}
function jsonBlockedList(items, wW){
    var parts = [];
    for(var b = 0; b < items.length; b++){
        var item = items[b];
        var names = [];
        for(var n = 0; n < item[1].length; n++) names.push(jsonString(item[1][n]));
        parts.push("[" + jsonKeyPair(item[0], wW) + ",[" + names.join(",") + "]]");
    }
    return "[" + parts.join(",") + "]";
}
function jsonNumList(values){
    var parts = [];
    for(var i = 0; i < values.length; i++) parts.push("" + values[i]);
    return "[" + parts.join(",") + "]";
}
function jsonBeltPlans(belts){
    var parts = [];
    for(var b = 0; b < belts.length; b++){
        var row = belts[b];
        parts.push("[" + row[0] + "," + row[1] + "," + jsonString(row[2]) + ","
            + row[3] + "," + row[4] + "]");
    }
    return "[" + parts.join(",") + "]";
}

/** Occupancy of a plan list: cell key -> the plans covering it. */
function planOccupancy(plans, wW){
    var occ = {};
    for(var i = 0; i < plans.length; i++){
        var p = plans[i];
        var size = api.size(p.block);
        var off = Math.floor((size - 1) / 2);
        for(var dx = 0; dx < size; dx++){
            for(var dy = 0; dy < size; dy++){
                var key = (p.x - off + dx) + (p.y - off + dy) * wW;
                if(occ[key] === undefined) occ[key] = [];
                occ[key].push(p);
            }
        }
    }
    return occ;
}

function planName(p){
    return api.blockName(p.block) + "@" + p.x + "," + p.y;
}

/** Does any legal placement of `drill` at all cover the cell? (Rules only, no candidate set.) */
function anyPlacementCovers(job, drill, key){
    var wW = job.worldW;
    var ox = key % wW, oy = Math.floor(key / wW);
    var halfLow = Math.floor((api.size(drill) - 1) / 2);
    var halfHigh = Math.floor(api.size(drill) / 2);
    for(var ax = ox - halfHigh; ax <= ox + halfLow; ax++){
        for(var ay = oy - halfHigh; ay <= oy + halfLow; ay++){
            if(util.canPlaceBlock(drill, job.team, ax, ay, 0)) return true;
        }
    }
    return false;
}

/**
 * The engine's own rules applied to a finished layout: every patch tile the layout does not
 * cover gets exactly one cause.
 *
 *   reserved      - the fill held the tile free for a power block or a belt lane
 *   freeAnchor    - a candidate that mines the tile fits the layout untouched: an engine bug
 *   blockedByPlans- every such candidate overlaps a placed plan (named)
 *   foreignOre    - no candidate mines it, but a legal placement covers it and would mine a
 *                   different item (the dominant-ore rule)
 *   unreachable   - no legal placement covers it at all (walls/buildings)
 *
 * The classes partition the uncovered tiles exactly; corpus_gaps.py asserts that.
 */
function classifyRun(job, plans, ps, drill){
    var wW = job.worldW;
    var occ = planOccupancy(plans, wW);
    var i = 0, k = 0, c = 0;

    var covered = {};
    var drills = [];
    for(i = 0; i < plans.length; i++){
        if(api.blockId(plans[i].block) !== api.blockId(drill)) continue;
        drills.push([plans[i].x, plans[i].y]);
        var size = api.size(drill);
        var off = Math.floor((size - 1) / 2);
        for(var dx = 0; dx < size; dx++){
            for(var dy = 0; dy < size; dy++){
                var ck = (plans[i].x - off + dx) + (plans[i].y - off + dy) * wW;
                if(ps.set[ck] === true) covered[ck] = true;
            }
        }
    }

    var cands = [];
    for(i = 0; i < job.entries.length; i++) cands.push(job.entries[i]);
    for(i = 0; i < job.rimCandidates.length; i++) cands.push(job.rimCandidates[i]);
    var candByTile = {};
    for(i = 0; i < cands.length; i++){
        var mineKeys = cands[i].mineableKeys;
        for(k = 0; k < mineKeys.length; k++){
            if(candByTile[mineKeys[k]] === undefined) candByTile[mineKeys[k]] = [];
            candByTile[mineKeys[k]].push(cands[i]);
        }
    }

    var out = {unreachable: [], freeAnchor: [], blockedByPlans: [], reserved: [], foreignOre: []};
    for(var key in ps.set){
        var tileKey = key | 0;
        if(covered[tileKey] === true) continue;
        if(job.reserved[tileKey] === true){ out.reserved.push(tileKey); continue; }

        var list = candByTile[tileKey];
        if(list !== undefined && list.length > 0){
            var free = false;
            var bestBlockers = null;
            for(c = 0; c < list.length; c++){
                var blockers = [];
                var cells = list[c].cellKeys;
                for(k = 0; k < cells.length; k++){
                    var hit = occ[cells[k]];
                    if(hit === undefined) continue;
                    for(var h = 0; h < hit.length; h++){
                        var name = planName(hit[h]);
                        var known = false;
                        for(var b = 0; b < blockers.length; b++){
                            if(blockers[b] === name){ known = true; break; }
                        }
                        if(!known) blockers.push(name);
                    }
                }
                if(blockers.length === 0){ free = true; break; }
                if(bestBlockers == null || blockers.length < bestBlockers.length) bestBlockers = blockers;
            }
            if(free) out.freeAnchor.push(tileKey);
            else out.blockedByPlans.push([tileKey, bestBlockers == null ? [] : bestBlockers]);
        }else if(anyPlacementCovers(job, drill, tileKey)){
            out.foreignOre.push(tileKey);
        }else{
            out.unreachable.push(tileKey);
        }
    }

    var counts = {unreachable: out.unreachable.length, freeAnchor: out.freeAnchor.length,
        blockedByPlans: out.blockedByPlans.length, reserved: out.reserved.length,
        foreignOre: out.foreignOre.length};
    counts.left = counts.unreachable + counts.freeAnchor + counts.blockedByPlans
        + counts.reserved + counts.foreignOre;
    var coveredCount = 0;
    for(var ck2 in covered) coveredCount++;
    return {classes: out, covered: coveredCount, drills: drills, counts: counts};
}

/**
 * The belt tool's side: left tiles of its layout get a cause. `beltTransport` is the class the
 * optimizer cannot see - a mechanical drill placement that could mine the tile exists and fits
 * the drills, but the belt layout (conveyors/bridges) occupies its ground.
 */
function classifyBelt(job, plans, ps){
    var wW = job.worldW;
    var occ = planOccupancy(plans, wW);
    var drillOcc = {};
    var i = 0, k = 0;
    var belts = [];
    for(i = 0; i < plans.length; i++){
        var name = api.blockName(plans[i].block);
        if(name === "mechanicalDrill" || name === "pneumaticDrill"){
            var size = api.size(plans[i].block);
            var off = Math.floor((size - 1) / 2);
            for(var dx = 0; dx < size; dx++){
                for(var dy = 0; dy < size; dy++){
                    drillOcc[(plans[i].x - off + dx) + (plans[i].y - off + dy) * wW] = true;
                }
            }
        }else if(name === "conveyor" || name === "itemBridge"){
            belts.push([plans[i].x, plans[i].y, name,
                plans[i].configX == null ? 0 : plans[i].configX,
                plans[i].configY == null ? 0 : plans[i].configY]);
        }
    }

    var covered = {};
    for(i = 0; i < plans.length; i++){
        if(api.blockName(plans[i].block) !== "mechanicalDrill") continue;
        var dsize = api.size(plans[i].block);
        var doff = Math.floor((dsize - 1) / 2);
        for(var ddx = 0; ddx < dsize; ddx++){
            for(var ddy = 0; ddy < dsize; ddy++){
                var ck = (plans[i].x - doff + ddx) + (plans[i].y - doff + ddy) * wW;
                if(ps.set[ck] === true) covered[ck] = true;
            }
        }
    }

    var cands = [];
    for(i = 0; i < job.entries.length; i++) cands.push(job.entries[i]);
    for(i = 0; i < job.rimCandidates.length; i++) cands.push(job.rimCandidates[i]);
    var candByTile = {};
    for(i = 0; i < cands.length; i++){
        var mineKeys = cands[i].mineableKeys;
        for(k = 0; k < mineKeys.length; k++){
            if(candByTile[mineKeys[k]] === undefined) candByTile[mineKeys[k]] = [];
            candByTile[mineKeys[k]].push(cands[i]);
        }
    }

    var out = {freeAnchor: [], beltTransport: [], blocked: [], unreachable: []};
    for(var key in ps.set){
        var tileKey = key | 0;
        if(covered[tileKey] === true) continue;
        var list = candByTile[tileKey];
        if(list === undefined || list.length === 0){ out.unreachable.push(tileKey); continue; }
        var verdict = "blocked";
        for(var c = 0; c < list.length; c++){
            var inBelts = false, inDrills = false;
            var cells = list[c].cellKeys;
            for(k = 0; k < cells.length; k++){
                if(occ[cells[k]] !== undefined) inBelts = true;
                if(drillOcc[cells[k]] === true) inDrills = true;
            }
            if(!inBelts){ verdict = "freeAnchor"; break; }
            if(!inDrills){ verdict = "beltTransport"; }
        }
        out[verdict].push(tileKey);
    }

    var counts = {freeAnchor: out.freeAnchor.length, beltTransport: out.beltTransport.length,
        blocked: out.blocked.length, unreachable: out.unreachable.length};
    counts.left = counts.freeAnchor + counts.beltTransport + counts.blocked + counts.unreachable;
    var coveredCount = 0;
    for(var kk2 in covered) coveredCount++;
    return {classes: out, covered: coveredCount, belts: belts, counts: counts};
}

/** Runs and serialises the gap-miner data: one JSON object per patch, one line each. */
function runJson(){
    var laser = api.block("laserDrill");
    var mechanical = api.block("mechanicalDrill");
    var wW = api.worldW();
    var lines = [];
    var linesWritten = 0;

    for(var i = 0; i < LIST.length; i++){
        var patch = LIST[i];
        var ps = patchTiles(patch);
        if(ps.total === 0){
            fail(patch.name + ": no reachable ore tiles");
            continue;
        }
        var tap = api.tile(patch.tap[0], patch.tap[1]);

        // optimizer, support OFF (the teacher's run) - candidates come from prepare
        util.undoLastCommitted();
        var offJob = optimization.prepare(tap, laser, false, "sharded", null, 0);
        while(!optimization.searchStep(offJob, Infinity)){
            // run to completion
        }
        var offPlans = optimization.finish(offJob);
        var off = classifyRun(offJob, offPlans, ps, laser);

        // optimizer, support ON (shipping default): reserved tiles only exist here
        util.undoLastCommitted();
        var onJob = optimization.prepare(tap, laser, true, "sharded", null, 0);
        while(!optimization.searchStep(onJob, Infinity)){
            // run to completion
        }
        var onPlans = optimization.finish(onJob);
        var on = classifyRun(onJob, onPlans, ps, laser);

        // belt tool: best of the four directions, classified from the mechanical candidate set
        var beltBest = null;
        for(var d = 0; d < DIRS.length; d++){
            util.undoLastCommitted();
            var beltPlans = bridge.fill(tap, mechanical, DIRS[d][1], "sharded");
            var cov = coverage(beltPlans, mechanical, ps.set);
            if(beltBest == null || cov.covered > beltBest.cov.covered){
                beltBest = {dir: DIRS[d][0], plans: beltPlans, cov: cov};
            }
        }
        util.undoLastCommitted();
        var mechJob = optimization.prepare(tap, mechanical, false, "sharded", null, 0);
        var belt = classifyBelt(mechJob, beltBest.plans, ps);
        util.undoLastCommitted();

        var text = "{"
            + "\"name\":" + jsonString(patch.name)
            + ",\"ore\":" + jsonString(patch.ore)
            + ",\"tiles\":" + ps.total
            + ",\"engine\":{\"drills\":" + jsonPointList(off.drills)
                + ",\"covered\":" + off.covered + "}"
            + ",\"stats\":{\"source\":" + jsonString(offJob.stats.source)
                + ",\"target\":" + offJob.stats.target
                + ",\"coverable\":" + offJob.coverable
                + ",\"candidates\":" + offJob.entries.length
                + ",\"blocked\":" + offJob.stats.blocked
                + ",\"unreachable\":" + offJob.stats.unreachable
                + ",\"search\":" + (offJob.candidateScores.search == null ? 0 : offJob.candidateScores.search)
                + ",\"lattice\":" + (offJob.candidateScores.lattice == null ? 0 : offJob.candidateScores.lattice)
                + ",\"sweeps\":" + jsonNumList(offJob.candidateScores.sweeps == null ? [] : offJob.candidateScores.sweeps)
                + ",\"restarts\":" + jsonNumList(offJob.candidateScores.restarts == null ? [] : offJob.candidateScores.restarts)
            + "}"
            + ",\"classes\":{"
                + "\"unreachable\":" + jsonKeyList(off.classes.unreachable, wW)
                + ",\"freeAnchor\":" + jsonKeyList(off.classes.freeAnchor, wW)
                + ",\"blockedByPlans\":" + jsonBlockedList(off.classes.blockedByPlans, wW)
                + ",\"reserved\":" + jsonKeyList(off.classes.reserved, wW)
                + ",\"foreignOre\":" + jsonKeyList(off.classes.foreignOre, wW)
            + "}"
            + ",\"support\":{\"covered\":" + on.covered
                + ",\"drills\":" + jsonPointList(on.drills)
                + ",\"classes\":{"
                    + "\"unreachable\":" + jsonKeyList(on.classes.unreachable, wW)
                    + ",\"freeAnchor\":" + jsonKeyList(on.classes.freeAnchor, wW)
                    + ",\"blockedByPlans\":" + jsonBlockedList(on.classes.blockedByPlans, wW)
                    + ",\"reserved\":" + jsonKeyList(on.classes.reserved, wW)
                    + ",\"foreignOre\":" + jsonKeyList(on.classes.foreignOre, wW)
                + "}"
            + "}"
            + ",\"belt\":{\"dir\":" + jsonString(beltBest.dir)
                + ",\"covered\":" + belt.covered
                + ",\"belts\":" + jsonBeltPlans(belt.belts)
                + ",\"classes\":{"
                    + "\"freeAnchor\":" + jsonKeyList(belt.classes.freeAnchor, wW)
                    + ",\"beltTransport\":" + jsonKeyList(belt.classes.beltTransport, wW)
                    + ",\"blocked\":" + jsonKeyList(belt.classes.blocked, wW)
                    + ",\"unreachable\":" + jsonKeyList(belt.classes.unreachable, wW)
                + "}"
                + ",\"counts\":{\"left\":" + belt.counts.left
                    + ",\"freeAnchor\":" + belt.counts.freeAnchor
                    + ",\"beltTransport\":" + belt.counts.beltTransport
                    + ",\"blocked\":" + belt.counts.blocked
                    + ",\"unreachable\":" + belt.counts.unreachable + "}"
            + "}"
            + ",\"counts\":{\"left\":" + off.counts.left
                + ",\"freeAnchor\":" + off.counts.freeAnchor
                + ",\"blockedByPlans\":" + off.counts.blockedByPlans
                + ",\"reserved\":" + off.counts.reserved
                + ",\"foreignOre\":" + off.counts.foreignOre
                + ",\"unreachable\":" + off.counts.unreachable
                + ",\"supportLeft\":" + on.counts.left
                + ",\"supportReserved\":" + on.counts.reserved + "}"
            + "}";
        lines.push(text);
        linesWritten++;
    }

    writeText(JSON_PATH, lines.join("\n") + "\n");
    java.lang.System.out.println("CORPUS-JSON wrote " + linesWritten + " patches to " + JSON_PATH);
}

var results = [];

function runPatch(patch, index){
    var t0 = api.now();
    var mechanical = api.block("mechanicalDrill");
    var laser = api.block("laserDrill");
    var tap = api.tile(patch.tap[0], patch.tap[1]);

    var ps = patchTiles(patch);
    if(ps.total === 0){
        fail(patch.name + ": no reachable ore tiles (tap=" + patch.tap[0] + "," + patch.tap[1] + ")");
        return null;
    }

    // ---- belt tool, every direction ----
    var best = null;
    var beltMin = -1;
    for(var d = 0; d < DIRS.length; d++){
        util.undoLastCommitted();
        var plans = bridge.fill(tap, mechanical, DIRS[d][1], "sharded");
        var ov = overlapCells(plans);
        if(ov > 0) fail(patch.name + ": belt/" + DIRS[d][0] + " plan overlap cells=" + ov);
        var cov = coverage(plans, mechanical, ps.set);
        var tr = transport(plans);
        if(beltMin < 0 || cov.covered < beltMin) beltMin = cov.covered;
        if(best == null || cov.covered > best.covered){
            best = {covered: cov.covered, drills: cov.drills, wired: tr.wired,
                dumps: tr.dumps, bridges: tr.bridges, stuck: tr.stuck, broken: tr.broken};
        }
    }
    if(best.covered < beltMin) beltMin = best.covered;

    // ---- optimizer, support ON and OFF ----
    util.undoLastCommitted();
    var on = optimization.fillDetailed(tap, laser, true, "sharded", null, 0);
    var onCov = coverage(on.plans, laser, ps.set);
    var onOv = overlapCells(on.plans);
    if(onOv > 0) fail(patch.name + ": laserOn plan overlap cells=" + onOv);
    if(on.stats.target !== ps.total) fail(patch.name + ": laserOn saw " + on.stats.target + " tiles, probe has " + ps.total);

    util.undoLastCommitted();
    var off = optimization.fillDetailed(tap, laser, false, "sharded", null, 0);
    var offCov = coverage(off.plans, laser, ps.set);
    var offOv = overlapCells(off.plans);
    if(offOv > 0) fail(patch.name + ": laserOff plan overlap cells=" + offOv);
    if(off.stats.target !== ps.total) fail(patch.name + ": laserOff saw " + off.stats.target + " tiles, probe has " + ps.total);

    // ---- output routing (laser, support ON, right, length 4) ----
    util.undoLastCommitted();
    var routed = optimization.fillDetailed(tap, laser, true, "sharded", direction.RIGHT, 4);
    var conveyors = 0;
    for(var rp = 0; rp < routed.plans.length; rp++){
        if(api.blockName(routed.plans[rp].block) === "conveyor") conveyors++;
    }
    var meets = meetsBuilt(routed.plans, patch.built == null ? [] : patch.built) ? 1 : 0;

    var ms = api.now() - t0;
    var core = patch.name
        + " ore=" + patch.ore
        + " tiles=" + ps.total
        + " belt=" + best.covered + "/" + ps.total + "/" + best.drills
        + " wired=" + best.wired + "/" + best.drills
        + " dumps=" + best.dumps + "/" + best.bridges
        + " beltMin=" + beltMin
        + " laserOn=" + onCov.covered + "/" + ps.total
        + " laserOnBlocked=" + on.stats.blocked
        + " laserOnUnreach=" + on.stats.unreachable
        + " laserOff=" + offCov.covered + "/" + ps.total
        + " laserOffBlocked=" + off.stats.blocked
        + " laserOffUnreach=" + off.stats.unreachable
        + " route=" + conveyors
        + " meets=" + meets;
    info(core + " ms=" + ms);

    return {
        core: core,
        name: patch.name, ore: patch.ore, total: ps.total,
        belt: best.covered, beltMin: beltMin, beltDrills: best.drills, wired: best.wired,
        dumps: best.dumps, bridges: best.bridges,
        laserOn: onCov.covered, laserOnBlocked: on.stats.blocked, laserOnUnreach: on.stats.unreachable,
        laserOff: offCov.covered, laserOffBlocked: off.stats.blocked, laserOffUnreach: off.stats.unreachable,
        route: conveyors
    };
}

function medianOf(values){
    if(values.length === 0) return 0;
    var sorted = values.slice();
    sorted.sort(function(a, b){ return a - b; });
    return sorted[Math.floor((sorted.length - 1) / 2)];
}

function tenths(n, d){
    return d === 0 ? 0 : Math.round(n * 1000 / d);
}

function summary(){
    var beltPct = [], laserOnPct = [], laserOffPct = [], routes = [], wiredBad = 0, beltWorst = -1;
    var hash = FNV_OFFSET;
    for(var i = 0; i < results.length; i++){
        var r = results[i];
        beltPct.push(tenths(r.belt, r.total));
        laserOnPct.push(tenths(r.laserOn, r.total));
        laserOffPct.push(tenths(r.laserOff, r.total));
        routes.push(r.route);
        if(r.wired < r.beltDrills) wiredBad++;
        if(beltWorst < 0 || tenths(r.belt, r.total) < beltWorst) beltWorst = tenths(r.belt, r.total);
        hash = fnv1a(r.core, hash);
    }
    var beltMedian = medianOf(beltPct) / 10;
    var laserOnMedian = medianOf(laserOnPct) / 10;
    var laserOffMedian = medianOf(laserOffPct) / 10;
    java.lang.System.out.println("CORPUS-SUMMARY patches=" + results.length
        + " beltMedian=" + beltMedian + "%"
        + " beltWorst=" + (beltWorst / 10) + "%"
        + " wiredBad=" + wiredBad
        + " laserOnMedian=" + laserOnMedian + "%"
        + " laserOffMedian=" + laserOffMedian + "%"
        + " routeMedian=" + medianOf(routes)
        + " hash=0x" + ("00000000" + hash.toString(16)).slice(-8));
}

// ---------------------------------------------------------------- run

var LIST = CORPUS;
if(LIMIT > 0 && LIST.length > LIMIT) LIST = LIST.slice(0, LIMIT);
if(MODE === "quick" && LIST.length > 12) LIST = LIST.slice(0, 12);

if(MODE === "list"){
    for(var li = 0; li < CORPUS.length; li++){
        var lp = CORPUS[li];
        info("PATCH " + li + " name=" + lp.name + " ore=" + lp.ore + " tiles=" + lp.tiles
            + " tap=" + lp.tap[0] + "," + lp.tap[1] + " save=" + lp.save);
    }
}else if(MODE === "dump"){
    dumpCandidates();
}else if(MODE === "teacher"){
    teacherRefs();
}else if(MODE === "json"){
    if(JSON_PATH.length === 0){
        fail("--json needs an output path (AUTODRILL_CORPUS_JSON)");
    }else{
        runJson();
    }
}else{
    for(var pi = 0; pi < LIST.length; pi++){
        var patch = LIST[pi];
        try{
            var result = runPatch(patch, pi);
        }catch(e){
            fail(patch.name + " threw: " + e);
            result = null;
        }
        if(result != null){
            results.push(result);
        }
    }
    summary();
}

java.lang.System.out.println("CORPUS-PROBE-DONE failures=" + failures);
if(failures > 0) failLine("corpus probe had " + failures + " failure(s)");
