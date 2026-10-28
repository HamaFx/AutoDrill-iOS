// Real-game reproduction driver: plays a campaign sector, then runs the fills exactly the way
// the UI does and reports what got planned. Development tool.

"use strict";

var api = require("auto-drill-ios/api");
var dir = require("auto-drill-ios/direction");
var bridge = require("auto-drill-ios/bridge");
var optimization = require("auto-drill-ios/optimization");
var wall = require("auto-drill-ios/wall");
var ui = require("auto-drill-ios/ui");

var Vars = Packages.mindustry.Vars;
var Blocks = Packages.mindustry.content.Blocks;
var Items = Packages.mindustry.content.Items;
var Core = Packages.arc.Core;
var Cons = Packages.arc.func.Cons;

function report(text){
    Packages.arc.util.Log.info("[autodrill-repro] " + text);
    api.trace("[repro] " + text);
}

function summarize(name, plans){
    var counts = {};
    var i = 0;
    for(i = 0; i < plans.length; i++){
        var key = api.blockName(plans[i].block);
        counts[key] = (counts[key] === undefined ? 0 : counts[key]) + 1;
    }
    var parts = [];
    for(var k in counts) parts.push(k + "=" + counts[k]);
    report(name + ": " + plans.length + " plans [" + parts.join(" ") + "]");
    return counts;
}

function loadSector(sectorIndex){
    var Planets = Packages.mindustry.content.Planets;
    Vars.control.playSector(Planets.serpulo.sectors.get(sectorIndex));

    var tries = 0;
    var wait = function(){
        tries++;
        if(Vars.world.width() > 10 && Vars.player != null && Vars.player.unit() != null && !Vars.state.isMenu()){
            Vars.state.set(Packages.mindustry.core.GameState.State.paused);
            Vars.state.rules.waves = false;
            runTests();
            return;
        }
        if(tries < 900){ Core.app.post(wait); }else{ report("world never loaded"); }
    };
    Core.app.post(wait);
}

/** The mined tile of `item` that is closest to the player's core (i.e. inside build range). */
function findTile(item){
    var cores = Vars.state.teams.cores(Vars.player.team());
    if(cores.size == 0) return null;
    var core = cores.first();

    var best = null;
    var bestDst2 = Number.MAX_VALUE;
    var tiles = Vars.world.tiles;
    for(var x = 0; x < Vars.world.width(); x++){
        for(var y = 0; y < Vars.world.height(); y++){
            var t = tiles.get(x, y);
            if(t == null) continue;
            if(api.itemId(api.drop(t)) !== api.itemId(item)) continue;
            if(!api.canMine(Blocks.mechanicalDrill, t)) continue;

            var dx = x - core.x, dy = y - core.y;
            var dst2 = dx * dx + dy * dy;
            if(dst2 < bestDst2){
                bestDst2 = dst2;
                best = t;
            }
        }
    }
    return best;
}

/** Builds a copper patch next to the core, inside the build radius, like a real patch would be. */
function makePatchNearCore(){
    var cores = Vars.state.teams.cores(Vars.player.team());
    if(cores.size == 0) return null;
    var core = cores.first();

    // anchor on the player's unit (it starts at the core, so this is inside build range)
    var unit = Vars.player.unit();
    var cx = Math.floor(unit.x / 8) + 10;
    var cy = Math.floor(unit.y / 8);
    report("world=" + Vars.world.width() + "x" + Vars.world.height()
        + " unit=" + Math.round(unit.x) + "," + Math.round(unit.y) + " anchor=" + cx + "," + cy);
    var made = 0;
    for(var x = cx - 6; x <= cx + 6; x++){
        for(var y = cy - 6; y <= cy + 6; y++){
            if(x < 0 || y < 0 || x >= Vars.world.width() || y >= Vars.world.height()) continue;
            var t = Vars.world.tile(x, y);
            if(t == null) continue;
            t.setBlock(Blocks.air);
            t.setOverlay(Blocks.oreCopper);
            made++;
        }
    }
    report("patch tiles written: " + made + " around " + cx + "," + cy);
    return made > 100 ? Vars.world.tile(cx, cy) : null;
}

function runTests(){
    bridge.setDebug(true);
    var copper = makePatchNearCore() || findTile(Items.copper);
    if(copper == null){
        report("no copper found in this sector");
        return;
    }
    var cores = Vars.state.teams.cores(Vars.player.team());
    var core = cores.size > 0 ? cores.first() : null;
    report("test tile at " + api.tx(copper) + "," + api.ty(copper)
        + " core=" + (core == null ? "none" : core.x + "," + core.y)
        + " playerUnit=" + (Vars.player.unit() == null ? "none" : Math.round(Vars.player.unit().x) + "," + Math.round(Vars.player.unit().y)));

    // 1) mechanical drills, exactly like the UI does (no team override, player's team)
    summarize("mechanical", bridge.fill(copper, Blocks.mechanicalDrill, dir.RIGHT));

    // 2) pneumatic
    summarize("pneumatic", bridge.fill(copper, Blocks.pneumaticDrill, dir.RIGHT));

    // 3) optimised drill, routing off (the default setting)
    summarize("laser(route=0)", optimization.fill(copper, Blocks.laserDrill, true, null, null, 0));

    // 4) optimised drill with routing on
    summarize("laser(route=4)", optimization.fill(copper, Blocks.laserDrill, true, null, dir.RIGHT, 4));

    bridge.setDebug(false);
    report("done");
    Core.app.post(function(){
        Core.app.exit();
    });
}


Packages.arc.Events.on(Packages.mindustry.game.EventType.ClientLoadEvent, new Cons({get: function(){
    Core.app.post(function(){
        loadSector(0);
    });
}}));
