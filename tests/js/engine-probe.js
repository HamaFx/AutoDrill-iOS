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
