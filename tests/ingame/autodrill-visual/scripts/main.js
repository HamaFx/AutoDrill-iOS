// AutoDrill (iOS) visual verification driver.
// Builds a small ore patch and puts the mod's own UI on screen so screenshots can be
// checked by eye. Set MODE below to choose what is shown. Development tool only.

"use strict";

var api = require("auto-drill-ios/api");
var dir = require("auto-drill-ios/direction");
var ui = require("auto-drill-ios/ui");

var MODE = "toolbar"; // toolbar | tutorial | settings

var Vars = Packages.mindustry.Vars;
var Blocks = Packages.mindustry.content.Blocks;
var Team = Packages.mindustry.game.Team;
var Core = Packages.arc.Core;

function reportAtlas(){
    var atlas = Core.atlas;
    var regions = atlas.getRegions();
    var hits = [];
    for(var i = 0; i < regions.size; i++){
        var r = regions.get(i);
        if(r.name != null && (r.name.indexOf("auto-drill") !== -1 || r.name.indexOf("tutorial") !== -1)){
            hits.push(r.name + "(" + String(Math.round(r.width)) + "x" + String(Math.round(r.height)) + ")");
        }
    }
    report("atlas regions: " + hits.join(" "));
    var tr = atlas.find("auto-drill-ios-tutorial");
    report("find(auto-drill-ios-tutorial) -> " + (tr == null ? "null" : String(Math.round(tr.width)) + "x" + String(Math.round(tr.height))));
    var tr2 = atlas.find("auto-drill-tutorial");
    report("find(auto-drill-tutorial) -> " + (tr2 == null ? "null" : String(Math.round(tr2.width)) + "x" + String(Math.round(tr2.height))));
}

function report(text){
    Packages.arc.util.Log.info("[autodrill-visual] " + text);
}

function buildMap(){
    Vars.world.loadGenerator(80, 80, function(tiles){
        tiles.fill();
        var x = 0, y = 0, tile = null;
        for(x = 0; x < 80; x++){
            for(y = 0; y < 80; y++){
                tile = tiles.get(x, y);
                tile.setBlock(Blocks.air);
                tile.setFloor(Blocks.stone);
                tile.setOverlay(Blocks.air);
            }
        }
        for(x = 30; x <= 42; x++){
            for(y = 30; y <= 42; y++){
                tiles.get(x, y).setOverlay(Blocks.oreCopper);
            }
        }
    });
}

Packages.arc.Events.on(Packages.mindustry.game.EventType.ClientLoadEvent, new Packages.arc.func.Cons({get: function(){
    Core.app.post(show);
}}));

function show(){
    try{
        report("mode: " + MODE);
        buildMap();

        reportAtlas();

        if(MODE === "tutorial"){
            api.showTutorial();
            report("tutorial dialog shown");
            return;
        }

        if(MODE === "campaign"){
            // play a real campaign sector: this is a genuine in-game frame, so the
            // toolbar, HUD button and tile projections are all meaningful
            var Planets = Packages.mindustry.content.Planets;
            var Items = Packages.mindustry.content.Items;
            Vars.control.playSector(Planets.serpulo.sectors.first());

            var tries = 0;
            var wait = function(){
                tries++;
                if(Vars.world.width() > 10 && Vars.player != null && !Vars.state.isMenu()){
                    // find a copper tile and point the camera at it, so the toolbar the mod
                    // draws above it lands in the middle of the screen
                    var found = null;
                    var tiles = Vars.world.tiles;
                    for(var x = 0; x < Vars.world.width() && found == null; x++){
                        for(var y = 0; y < Vars.world.height() && found == null; y++){
                            var probe = tiles.get(x, y);
                            if(probe != null
                                && api.itemId(api.drop(probe)) === api.itemId(Items.copper)
                                && api.canMine(Blocks.mechanicalDrill, probe)){
                                found = probe;
                            }
                        }
                    }
                    if(found != null){
                        Core.camera.position.set(api.tx(found) * 8, api.ty(found) * 8);
                        report("campaign: camera moved to copper at " + api.tx(found) + "," + api.ty(found));
                    }
                    // keep the unattended core alive in front of the camera
                    Vars.state.rules.waves = false;
                    Vars.state.set(Packages.mindustry.core.GameState.State.paused);
                    api.putSetting("auto-drill-ios-welcome", true); // no tutorial over the shot

                    if(found == null){
                        report("campaign: no copper tile found");
                        return;
                    }
                    ui.init();
                    ui.setEnabled(true);
                    ui.selectTile(found);
                    var coreT = null;
                    var cores = Vars.state.teams.cores(Packages.mindustry.game.Team.sharded);
                    if(cores.size > 0){
                        var cb = cores.first();
                        coreT = Core.camera.project(cb.x * 8, cb.y * 8);
                        report("camera: pos=" + Math.round(Core.camera.position.x) + "," + Math.round(Core.camera.position.y)
                            + " zoom=" + Core.camera.zoom
                            + " coreProjected=" + Math.round(coreT.x) + "," + Math.round(coreT.y)
                            + " coreTile=" + cb.x + "," + cb.y
                            + " paused=" + Vars.state.isPaused());
                    }

                    var info = ui.debugInfo();
                    var table = ui.debugTable();
                    var p2 = Core.camera.project(api.tx(found) * 8, api.ty(found) * 8);
                    var hud = ui.debugHudButton();
                    report("campaign: hud button " + (hud == null ? "none" : "at " + hud.x + "," + hud.y + " size "
                        + hud.w + "x" + hud.h + " visible=" + hud.visible));

                    report("campaign: tapped " + api.tx(found) + "," + api.ty(found)
                        + " buttons=" + info.buttons + " selectVisible=" + info.selectVisible
                        + " screen=" + Core.graphics.getWidth() + "x" + Core.graphics.getHeight()
                        + " table=" + Math.round(table.x) + "," + Math.round(table.y)
                        + " size=" + Math.round(table.getWidth()) + "x" + Math.round(table.getHeight())
                        + " projected=" + Math.round(p2.x) + "," + Math.round(p2.y)
                        + " parent=" + table.parent);
                    return;
                }
                if(tries < 900){
                    Core.app.post(wait);
                }else{
                    report("campaign: world never loaded");
                }
            };
            Core.app.post(wait);
            return;
        }

        if(MODE === "settings"){
            Vars.ui.settings.show();
            report("settings dialog shown");
            return;
        }

        // toolbar: the tool only shows in-game (its update loop hides the tables in the
        // menu), so leave the menu state and put the camera on the patch
        ui.init();
        ui.setEnabled(true);
        ui.selectTile(api.tile(36, 36));

        report("toolbar shown, buttons=" + ui.debugInfo().buttons + " sprites=" + ui.debugInfo().sprites.join("|"));
    }catch(e){
        report("driver failed: " + e);
    }
}
