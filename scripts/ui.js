// AutoDrill (iOS) - ui.js
// HUD toggle, tap toolbar, direction picker, tutorial and settings category.
// Port of AutoDrill.java. Every Java-facing action goes through api.js.

"use strict";

var api = require("api");
var direction = require("direction");
var bridge = require("bridge");
var optimization = require("optimization");
var wall = require("wall");

var KEY_ACTIVATION = "auto-drill-ios-activation-key";
var KEY_SHOW_BUTTON = "auto-drill-ios-display-toggle-button";
var KEY_WELCOME = "auto-drill-ios-welcome";
var KEY_QUALITY = "auto-drill-ios-optimization-quality";
var KEY_SUPPORT = "auto-drill-ios-place-water-extractor-and-power-nodes";

var enabled = false;
var selectedTile = null;
var directionAction = null;

var selectTable = null;
var directionTable = null;
var toggleButton = null;
var drillButtons = [];
var drillButtonSprites = [];

var initialized = false;
var initResult = false;

/** @return true when the tool was set up, false when it deliberately stood down. */
exports.init = function(){
    if(initialized) return initResult;

    // Two AutoDrills at once would draw two toolbars - stay out of the way.
    if(api.modLoaded("auto-drill")){
        api.log("the desktop/Android AutoDrill mod is installed and enabled - this iOS edition stays inactive");
        initialized = true;
        initResult = false;
        return false;
    }

    initialized = true;
    initResult = true;

    if(!api.settingBool(KEY_WELCOME, false)){
        api.showTutorial();
        api.putSetting(KEY_WELCOME, true);
    }

    selectTable = api.newToolbar();
    directionTable = api.newDirectionTable();

    buildDirectionTable();
    buildSelectTable();
    buildSettings();
    buildHudButton();
    registerInput();
    registerTap();
    return true;
};

// ---------------------------------------------------------------- toolbar handling

function setEnabled(value){
    enabled = value;
    api.elementSetVisible(selectTable, false);
    api.elementSetVisible(directionTable, false);
    if(toggleButton != null) toggleButton.setChecked(enabled);
}

function reposition(element){
    if(selectedTile == null) return;
    var size = api.tilesize();
    var v = api.cameraProject(api.centerXTile(selectedTile) * size, (api.centerYTile(selectedTile) + 1) * size);
    api.elementSetPosition(element, v.x, v.y);
}

function buildSelectTable(){
    api.elementUpdate(selectTable, function(){
        if(api.isMenu() || selectedTile == null){
            api.elementSetVisible(selectTable, false);
            return;
        }
        reposition(selectTable);
    });

    // Outside taps close the toolbar (mirrors the Java mod's InputProcessor).
    api.addInputProcessor({touchDown: function(){
        if(!api.elementHasMouse(selectTable)) api.elementSetVisible(selectTable, false);
        return false;
    }});

    api.elementAttach(selectTable);
}

function clearDrillButtons(){
    for(var i = 0; i < drillButtons.length; i++){
        api.elementRemove(selectTable, drillButtons[i]);
    }
    drillButtons = [];
    drillButtonSprites = [];
}

/** Adds a drill button; pressing it always disables the tool and closes the toolbar first. */
function addDrillButton(spriteName, onClick){
    drillButtonSprites.push(spriteName);
    drillButtons.push(api.toolbarAddButton(selectTable, api.drawable(spriteName), function(){
        setEnabled(false);
        api.elementSetVisible(selectTable, false);
        onClick();
    }));
}

/** Drill buttons that need an output direction: remember the action, show the direction table. */
function requireDirection(action){
    directionAction = action;
    api.elementSetVisible(directionTable, true);
}

function buildDirectionTable(){
    api.elementUpdate(directionTable, function(){
        if(api.isMenu() || selectedTile == null){
            api.elementSetVisible(directionTable, false);
            return;
        }
        reposition(directionTable);
    });

    api.addInputProcessor({touchDown: function(){
        if(!api.elementHasMouse(directionTable)) api.elementSetVisible(directionTable, false);
        return false;
    }});

    api.directionAddButton(directionTable, "up", function(){
        api.elementSetVisible(directionTable, false);
        if(directionAction != null) directionAction(direction.UP);
    });
    api.tableRow(directionTable);

    var row = api.tableCell(directionTable);
    api.directionAddButton(row, "left", function(){
        api.elementSetVisible(directionTable, false);
        if(directionAction != null) directionAction(direction.LEFT);
    });
    api.directionAddButton(row, "cancel", function(){
        api.elementSetVisible(directionTable, false);
    });
    api.directionAddButton(row, "right", function(){
        api.elementSetVisible(directionTable, false);
        if(directionAction != null) directionAction(direction.RIGHT);
    });

    api.tableRow(directionTable);

    api.directionAddButton(directionTable, "down", function(){
        api.elementSetVisible(directionTable, false);
        if(directionAction != null) directionAction(direction.DOWN);
    });

    api.elementAttach(directionTable);
}

/** Java: AutoDrill.updateSelectTable - which drills can mine this tile. */
function updateSelectTable(){
    clearDrillButtons();
    if(selectedTile == null) return;

    var mechanical = api.block("mechanicalDrill");
    var pneumatic = api.block("pneumaticDrill");
    var laser = api.block("laserDrill");
    var blast = api.block("blastDrill");
    var plasmaBore = api.block("plasmaBore");
    var impact = api.block("impactDrill");
    var eruption = api.block("eruptionDrill");

    if(api.environmentBuildable(mechanical) && api.canMine(mechanical, selectedTile)){
        addDrillButton("block-mechanical-drill-full",
            function(){ requireDirection(function(d){ bridge.fill(selectedTile, mechanical, d); }); });
    }

    if(api.environmentBuildable(pneumatic) && api.canMine(pneumatic, selectedTile)){
        addDrillButton("block-pneumatic-drill-full",
            function(){ requireDirection(function(d){ bridge.fill(selectedTile, pneumatic, d); }); });
    }

    if(api.environmentBuildable(laser) && api.canMine(laser, selectedTile)){
        addDrillButton("block-laser-drill-full",
            function(){ optimization.fill(selectedTile, laser); });
    }

    if(api.environmentBuildable(blast) && api.canMine(blast, selectedTile)){
        addDrillButton("block-blast-drill-full",
            function(){ optimization.fill(selectedTile, blast); });
    }

    var wallDrop = api.wallDrop(selectedTile);
    if(api.environmentBuildable(plasmaBore) && wallDrop != null
        && api.itemHardness(wallDrop) <= api.beamTier(plasmaBore)){
        addDrillButton("block-plasma-bore-full",
            function(){ requireDirection(function(d){ wall.fill(selectedTile, plasmaBore, d); }); });
    }

    if(api.environmentBuildable(impact) && api.canMine(impact, selectedTile)){
        addDrillButton("block-impact-drill-full",
            function(){ optimization.fill(selectedTile, impact, false); });
    }

    if(api.environmentBuildable(eruption) && api.canMine(eruption, selectedTile)){
        addDrillButton("block-eruption-drill-full",
            function(){ optimization.fill(selectedTile, eruption, false); });
    }
}

/** Java: AutoDrill.init - HUD toggle button next to the minimap. */
function buildHudButton(){
    toggleButton = api.hudToggleButton(
        api.modDrawable("logo"),
        function(){ return api.settingBool(KEY_SHOW_BUTTON, true); },
        function(){
            enabled = !enabled;
            api.elementSetVisible(selectTable, false);
            api.elementSetVisible(directionTable, false);
        });
}

/** Java: AutoDrill.init - activation key via an input processor. */
function registerInput(){
    api.addInputProcessor({keyDown: function(keyCode){
        if(api.isMenu() || api.uiBlockingShown() || api.sceneHasKeyboard()){
            return false;
        }

        var wanted = api.keyCodeByName(String(api.settingString(KEY_ACTIVATION, "H")).toUpperCase());
        if(api.keyCodeOrdinal(wanted) >= 0 && api.keyCodeOrdinal(wanted) === api.keyCodeOrdinal(keyCode)){
            setEnabled(!enabled);
        }
        return false;
    }});
}

/** Shows the toolbar for a tile. Also used by the test harness. */
function selectTile(tile){
    api.elementSetVisible(selectTable, true);
    selectedTile = tile;
    updateSelectTable();
    reposition(selectTable);
    reposition(directionTable);
    api.tapFx(api.tx(tile), api.ty(tile));
}

/** Java: AutoDrill.init - TapEvent handler. */
function registerTap(){
    api.onTapTile(function(tile){
        if(!enabled) return;
        selectTile(tile);
    });
}

// --- test hooks (used by tests/ingame, harmless in production) ---
exports.setEnabled = function(value){
    setEnabled(value);
};

exports.selectTile = selectTile;

exports.debugTable = function(){
    return selectTable;
};

exports.debugHudButton = function(){
    return toggleButton == null || toggleButton.element == null ? null : api.elementBounds(toggleButton.element);
};

exports.debugDirectionTable = function(){
    return directionTable;
};

exports.debugInfo = function(){
    return {
        enabled: enabled,
        buttons: drillButtons.length,
        sprites: drillButtonSprites.slice(),
        selectVisible: selectTable == null ? false : api.elementIsVisible(selectTable),
        directionVisible: directionTable == null ? false : api.elementIsVisible(directionTable)
    };
};

/** Java: AutoDrill.init - settings category. */
function buildSettings(){
    api.addSettingsCategory(api.bundle("auto-drill.settings.title"), api.modDrawable("logo"), function(st){
        st.text(KEY_ACTIVATION, "H", function(value){
            var key = api.keyCodeByName(String(value).toUpperCase());
            api.putSetting(KEY_ACTIVATION, key == null ? "H" : api.keyCodeName(key));
        });
        st.check(KEY_SHOW_BUTTON, true);

        st.slider("mechanical-drill-max-tiles", 200, 25, 500, 25);
        st.slider("mechanical-drill-min-ores", 1, 1, 4, 1);

        st.slider("pneumatic-drill-max-tiles", 150, 25, 500, 25);
        st.slider("pneumatic-drill-min-ores", 2, 1, 4, 1);

        st.slider("laser-drill-max-tiles", 100, 25, 500, 25);
        st.slider("laser-drill-min-ores", 5, 1, 9, 1);

        st.slider("airblast-drill-max-tiles", 100, 25, 500, 25);
        st.slider("airblast-drill-min-ores", 9, 1, 16, 1);

        st.slider(KEY_QUALITY, 2, 1, 10, 1);
        st.check(KEY_SUPPORT, true);
    });
}
