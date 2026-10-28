// Engine probe driver: runs the optimiser against the fake world (tests/js/fake-api.js)
// outside the game. Used by tools/engine-probe.sh - it starts in a second, which makes it
// the tool of choice when the placement engine needs debugging.

"use strict";

var api = require("api");
var optimization = require("optimization");

function memory(tag){
    var rt = java.lang.Runtime.getRuntime();
    java.lang.System.out.println("PROBE " + tag + " usedMB=" + Math.round((rt.totalMemory() - rt.freeMemory()) / 1048576));
}

var info = AUTODRILL_API_FAKE.__info();

memory("start");
optimization.setDebug(true);

var start = Date.now();
var plans = optimization.fill({x: 30, y: 30}, info.laserDrill, true, "sharded");
var elapsed = Date.now() - start;

memory("after fill");
java.lang.System.out.println("PROBE result plans=" + plans.length + " ms=" + elapsed);

// the chunked (UI) path must produce exactly the same layout as the synchronous one
var asyncPlans = null;
optimization.fillAsync({x: 30, y: 30}, info.laserDrill, true, "sharded", null, 0, function(result){
    asyncPlans = result;
});

var same = asyncPlans != null && asyncPlans.length === plans.length;
if(same){
    for(var i = 0; i < plans.length; i++){
        if(asyncPlans[i].x !== plans[i].x || asyncPlans[i].y !== plans[i].y
            || api.blockId(asyncPlans[i].block) !== api.blockId(plans[i].block)){
            same = false;
            break;
        }
    }
}
java.lang.System.out.println("PROBE chunked-vs-sync " + (same ? "MATCH" : "MISMATCH")
    + " sync=" + plans.length + " chunked=" + (asyncPlans == null ? "null" : asyncPlans.length));
