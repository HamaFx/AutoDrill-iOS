// Guard check: with another mod named "auto-drill" installed and enabled, the iOS edition
// must do nothing (no toolbar, no HUD button, no input handling).
//
// Run through tools/guard-check.sh, which also installs a dummy "auto-drill" mod.

"use strict";

var api = require("auto-drill-ios/api");
var ui = require("auto-drill-ios/ui");

var Core = Packages.arc.Core;
var Cons = Packages.arc.func.Cons;

function report(text){
    Packages.arc.util.Log.info("[autodrill-guard] " + text);
}

Packages.arc.Events.on(Packages.mindustry.game.EventType.ClientLoadEvent, new Cons({get: function(){
    Core.app.post(function(){
        var passed = 0;
        var failed = 0;

        function check(name, condition){
            if(condition){
                passed++;
            }else{
                failed++;
                report("FAIL: " + name);
            }
        }

        check("other AutoDrill detected", api.modLoaded("auto-drill"));

        // our own module instance must refuse to initialise
        var didInit = ui.init();
        check("mod refused to initialise", didInit === false);
        var info = ui.debugInfo();
        check("no drill buttons were built", info.buttons === 0);
        check("mod is not enabled", info.enabled === false);
        check("toolbar stays hidden", info.selectVisible === false);

        report("RESULT passed=" + passed + " failed=" + failed
            + " | AUTODRILL-GUARD-RESULT passed=" + passed + " failed=" + failed);
    });
}}));
