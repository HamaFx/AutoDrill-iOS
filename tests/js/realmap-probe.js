// Real-map probe: runs the fillers on terrain exported from a real save and reports coverage
// plus belt-network integrity. Run with tools/realmap-probe.sh <fixture>.
//
// The fixture (tests/js/fixtures/*.js) defines AUTODRILL_FAKE_SCENARIO.terrain (the real tile
// grid: ores, walls, built blocks) and a REALMAP object with the tap of the lead patch under
// test. This is how the belting/routing audit measures the engine on player maps instead of
// synthetic shapes.
//
// Reports per direction, for the belt tool:
//   covered - lead tiles under planned drills
//   wired   - drills whose adjacent belt carries items to an outlet (directed flow: bridge ->
//             config target -> ... -> a config 0,0 bridge that dumps)
//   dumps   - bridges that reach a dump point; stuck - bridges chained to a dead end
// and for the optimiser: covered / drills, and conveyor stubs from Output Routing.
"use strict";

var api = require("api");
var bridge = require("bridge");
var optimization = require("optimization");
var direction = require("direction");
var util = require("util");

function info(text){ java.lang.System.out.println("RM " + text); }

function lastToast(){
    var log = AUTODRILL_API_FAKE.__info().log;
    for(var i = log.length - 1; i >= 0; i--){
        if(String(log[i]).indexOf("toast: ") === 0) return String(log[i]);
    }
    return "";
}

var tap = api.tile(REALMAP.tap[0], REALMAP.tap[1]);
info("fixture=" + REALMAP.save + " map=" + REALMAP.mapname
    + " tap=" + REALMAP.tap[0] + "," + REALMAP.tap[1]
    + " drop=" + (api.drop(tap) == null ? "null" : api.drop(tap).name));

// the patch the fill scans: the 8-connected component of the tapped ore
var reached = util.getConnectedTiles(tap, REALMAP.maxTiles == null ? 5001 : REALMAP.maxTiles, "sharded");
var set = {};
for(var i = 0; i < reached.length; i++) set[reached[i].x + reached[i].y * api.worldW()] = true;
info("scan: " + reached.length + " " + api.itemName(api.itemId(api.drop(tap))) + " tiles");

function coverage(plans, drill){
    var size = api.size(drill);
    var off = Math.floor((size - 1) / 2);
    var covered = {}, drills = 0;
    for(var i2 = 0; i2 < plans.length; i2++){
        if(api.blockId(plans[i2].block) !== api.blockId(drill)) continue;
        drills++;
        for(var dx = 0; dx < size; dx++){
            for(var dy = 0; dy < size; dy++){
                var key = (plans[i2].x - off + dx) + (plans[i2].y - off + dy) * api.worldW();
                if(set[key] === true) covered[key] = true;
            }
        }
    }
    var n = 0;
    for(var k2 in covered) n++;
    return {covered: n, drills: drills};
}

/**
 * Directed flow model of the belt layout, exactly as Mindustry moves items: a drill's item
 * enters an adjacent conveyor or item bridge; a bridge sends to its config target; a bridge
 * with no target dumps onto its neighbours (ItemBridgeBuild.updateTile -> doDump when the
 * link is invalid). A drill is "wired" when an adjacent belt reaches such a dump point.
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

    // conveyors are usable when adjacent to a dumping bridge or to another usable conveyor
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

    var wired = 0, unwired = [];
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
        else unwired.push(d2.x + "," + d2.y);
    }

    var dumps = 0, stuck = 0, broken = 0;
    for(var bk3 in bridgeAt){
        var f = flowStart(bridgeAt[bk3].x, bridgeAt[bk3].y);
        if(f === 0) dumps++;
        else if(f === 1) stuck++;
        else broken++;
    }

    return {drills: drills.length, wired: wired, unwired: unwired,
        bridges: (function(){ var n = 0; for(var q in bridgeAt) n++; return n; })(),
        dumps: dumps, stuck: stuck, broken: broken};
}

/** Does any plan tile sit within 5 tiles of existing transport (a belt, bridge or core)? */
function meetsBuilt(plans){
    var built = REALMAP.built == null ? [] : REALMAP.built;
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

var DIRS = [["right", direction.RIGHT], ["down", direction.DOWN], ["up", direction.UP], ["left", direction.LEFT]];
for(var d = 0; d < DIRS.length; d++){
    util.undoLastCommitted();
    var plans = bridge.fill({x: REALMAP.tap[0], y: REALMAP.tap[1]}, api.block("mechanicalDrill"), DIRS[d][1], "sharded");
    var cov = coverage(plans, api.block("mechanicalDrill"));
    var tr = transport(plans);
    info("belt/" + DIRS[d][0] + ": covered=" + cov.covered + "/" + reached.length
        + " drills=" + cov.drills + " wired=" + tr.wired + "/" + tr.drills
        + " dumps=" + tr.dumps + "/" + tr.bridges
        + (tr.stuck > 0 ? " stuck=" + tr.stuck : "")
        + (tr.broken > 0 ? " broken=" + tr.broken : "")
        + (tr.unwired.length > 0 ? " unwired=[" + tr.unwired.slice(0, 6).join(" ") + "]" : "")
        + " meetsExisting=" + meetsBuilt(plans));
}

for(var s = 0; s < 2; s++){
    util.undoLastCommitted();
    var res = optimization.fillDetailed({x: REALMAP.tap[0], y: REALMAP.tap[1]},
        api.block("laserDrill"), s === 0, "sharded", null, 0);
    var cov2 = coverage(res.plans, api.block("laserDrill"));
    info("laser/support=" + (s === 0) + ": covered=" + cov2.covered + "/" + reached.length
        + " drills=" + res.stats.drills + " blocked=" + res.stats.blocked
        + " unreachable=" + res.stats.unreachable + " | " + lastToast());
}

// optimiser output routing (the Output Routing Length setting), one line per direction
for(var rr = 0; rr < DIRS.length; rr++){
    util.undoLastCommitted();
    var rres = optimization.fillDetailed({x: REALMAP.tap[0], y: REALMAP.tap[1]},
        api.block("laserDrill"), true, "sharded", DIRS[rr][1], 4);
    var conv = 0;
    for(var pi2 = 0; pi2 < rres.plans.length; pi2++){
        if(api.blockName(rres.plans[pi2].block) === "conveyor") conv++;
    }
    info("route/" + DIRS[rr][0] + ": conveyors=" + conv
        + " meetsExisting=" + meetsBuilt(rres.plans));
}

info("RM-PROBE-DONE");
