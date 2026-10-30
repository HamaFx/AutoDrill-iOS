// Classic-package checks: tools/classic-check.sh runs this against a staged classic build.
//
// The classic package must ship the original Java AutoDrill's defaults and must not apply the
// port's extra settings (layout variation, belt lanes, output routing) - not even when values
// from an earlier normal install are still stored.
//
// Run by tools/classic-check.sh (staged zip, fake world, seconds, no game). Never ships.

"use strict";

var api = require("api");
var optimization = require("optimization");
var direction = require("direction");
var util = require("util");

var S = AUTODRILL_FAKE_SCENARIO;

var passed = 0, failed = 0;

function check(name, ok, detail){
    if(ok){
        passed++;
        java.lang.System.out.println("CHECK ok   " + name + (detail == null ? "" : "  [" + detail + "]"));
    }else{
        failed++;
        java.lang.System.out.println("CHECK FAIL " + name + (detail == null ? "" : "  [" + detail + "]"));
    }
}

var laser = api.block("laserDrill");

// ---------------------------------------------------------------- the shipped defaults

var d = optimization.settingDefaults;
check("classic: build switch is on", optimization.classicDefaults === true);
check("classic: mechanical defaults 200 tiles / 1 ore",
    d.mechanical.tiles === 200 && d.mechanical.ores === 1,
    d.mechanical.tiles + "/" + d.mechanical.ores);
check("classic: pneumatic defaults 150 tiles / 2 ores",
    d.pneumatic.tiles === 150 && d.pneumatic.ores === 2,
    d.pneumatic.tiles + "/" + d.pneumatic.ores);
check("classic: laser defaults 100 tiles / 5 ores",
    d.laser.tiles === 100 && d.laser.ores === 5,
    d.laser.tiles + "/" + d.laser.ores);
check("classic: airblast defaults 100 tiles / 9 ores",
    d.airblast.tiles === 100 && d.airblast.ores === 9,
    d.airblast.tiles + "/" + d.airblast.ores);

// The table is what the engine actually reads: on a patch bigger than the original's 100-tile
// laser limit the fill must report truncation (the standard build scans 5000 and does not).
var patch = S.patches[0];
var tap = api.tile(Math.floor((patch.oreX0 + patch.x1) / 2), Math.floor((patch.oreY0 + patch.y1) / 2));
var scan = optimization.fillDetailed(tap, laser, false, "sharded", null, 0);
check("classic: the original laser scan limit is in force (big patch reports truncated)",
    scan.stats.truncated === true && scan.stats.target < 500,
    "target=" + scan.stats.target + " truncated=" + scan.stats.truncated);

// ---------------------------------------------------------------- port settings are ignored

// What a normal install can leave behind: the keys hold values, but the classic engine must
// never read them.
var STORED = {
    "auto-drill-ios-layout-variation": 5,
    "auto-drill-ios-build-belt-lanes": true,
    "auto-drill-ios-output-routing-length": 6
};
var realSettingInt = api.settingInt;
var realSettingBool = api.settingBool;
api.settingInt = function(key, def){
    return STORED[key] != null ? STORED[key] : realSettingInt(key, def);
};
api.settingBool = function(key, def){
    return STORED[key] != null ? STORED[key] === true : realSettingBool(key, def);
};

function signature(plans){
    var parts = [];
    for(var i = 0; i < plans.length; i++){
        parts.push(plans[i].x + "," + plans[i].y + "," + api.blockId(plans[i].block));
    }
    parts.sort();
    return parts.join(";");
}

function countBlock(plans, name){
    var n = 0;
    for(var i = 0; i < plans.length; i++){
        if(api.blockName(plans[i].block) === name) n++;
    }
    return n;
}

util.undoLastCommitted();
var stale = optimization.fillDetailed(tap, laser, true, "sharded", direction.RIGHT, null);

util.undoLastCommitted();
STORED = {};
var plain = optimization.fillDetailed(tap, laser, true, "sharded", direction.RIGHT, null);

check("classic: a stored routing length routes nothing",
    countBlock(stale.plans, "conveyor") === 0,
    "conveyors=" + countBlock(stale.plans, "conveyor"));
check("classic: stored variation/lanes/routing do not change the layout",
    stale.plans.length > 0 && signature(stale.plans) === signature(plain.plans),
    "stale plans=" + stale.plans.length + ", plain plans=" + plain.plans.length);

java.lang.System.out.println("CLASSIC-TESTS-RESULT passed=" + passed + " failed=" + failed);
