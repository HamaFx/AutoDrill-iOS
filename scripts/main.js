// AutoDrill (iOS) - main.js
// Entry point of the script mod. The game evaluates this while loading content,
// so nothing here may touch the UI - all of that happens on ClientLoadEvent.

"use strict";

var api = require("api");
var ui = require("ui");

api.log("loading (iOS-compatible script edition)");

api.onClientLoad(function(){
    try{
        if(ui.init()){
            api.log("ready - toggle with the button next to the minimap or the activation key");
        }
    }catch(e){
        api.log("initialization FAILED: " + e + (e != null && e.stack != null ? "\n" + e.stack : ""));
    }
});
