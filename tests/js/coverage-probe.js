// Coverage probe: how much of an ore patch actually ends up mined?
//
// The engine maximises the ore tiles under the placed drills, which is exactly what Mindustry
// pays out (a drill's progress is scaled by the number of ore tiles of its dominant item). So
// the questions this probe answers are: does the fill see the whole patch, how many drills does
// it place, and how many ore tiles are left unmined.
//
// Coverage is measured from the committed plans, not from the engine's own bookkeeping, so the
// numbers cannot agree by accident. Driven by tools/coverage-probe.sh.

"use strict";

var api = require("api");
var optimization = require("optimization");

var S = AUTODRILL_FAKE_SCENARIO;
var rect = S.ore;
var drill = api.block(S.drill == null ? "laserDrill" : S.drill);

function oreSet(){
    var set = {};
    var i = 0, j = 0;
    var r = 0, cx = 0, cy = 0;
    if(S.round === true){
        cx = (rect.oreX0 + rect.x1) / 2;
        cy = (rect.oreY0 + rect.y1) / 2;
        r = Math.min(rect.x1 - rect.oreX0, rect.y1 - rect.oreY0) / 2;
    }
    for(i = rect.oreX0; i <= rect.x1; i++){
        for(j = rect.oreY0; j <= rect.y1; j++){
            if(S.round === true){
                var d = (i - cx) * (i - cx) + (j - cy) * (j - cy);
                if(d > r * r * 0.8) continue;
            }
            set[i + j * S.world] = true;
        }
    }
    return set;
}

var isOre = oreSet();
var total = 0;
for(var key in isOre) total++;

var start = {x: Math.floor((rect.oreX0 + rect.x1) / 2), y: Math.floor((rect.oreY0 + rect.y1) / 2)};

var t0 = Date.now();
var support = S.support !== false;
var result = optimization.fillDetailed(start, drill, support, "sharded", null, 0);
var elapsed = Date.now() - t0;

// coverage straight off the plans: union of the drill footprints that hold ore
var size = api.size(drill);
var offset = Math.floor((size - 1) / 2);
var coveredSet = {};
var drills = 0;
for(var p = 0; p < result.plans.length; p++){
    var plan = result.plans[p];
    if(api.blockId(plan.block) !== api.blockId(drill)) continue;
    drills++;
    for(var dx = -offset; dx < -offset + size; dx++){
        for(var dy = -offset; dy < -offset + size; dy++){
            var k = (plan.x + dx) + (plan.y + dy) * S.world;
            if(isOre[k] === true) coveredSet[k] = true;
        }
    }
}

var covered = 0;
for(var ck in coveredSet) covered++;

var stats = result.stats;
var pct = total === 0 ? 0 : Math.round(covered * 1000 / total) / 10;

java.lang.System.out.println("COVERAGE drill=" + api.blockName(drill)
    + " patch=" + total
    + " seen=" + stats.target + (stats.truncated ? "+truncated" : "")
    + " candidates=" + stats.candidates
    + " coverable=" + (stats.covered + stats.blocked)
    + " drills=" + drills
    + " covered=" + covered + " (" + pct + "%)"
    + " outOfReach=" + stats.unreachable
    + " blocked=" + stats.blocked
    + " source=" + stats.source
    + " stopped=" + stats.stopped
    + " ms=" + elapsed);
