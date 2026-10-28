// AutoDrill (iOS) in-engine test harness.
// Runs inside the real game: builds a deterministic map, calls the ported fillers and
// checks the resulting build plans. Reads as a report in the game log.
//
// This module is a development tool, not part of the shipped mod.

"use strict";

var api = require("auto-drill-ios/api");
var dir = require("auto-drill-ios/direction");
var util = require("auto-drill-ios/util");
var bridge = require("auto-drill-ios/bridge");
var optimization = require("auto-drill-ios/optimization");
var wall = require("auto-drill-ios/wall");
var ui = require("auto-drill-ios/ui");

var Vars = Packages.mindustry.Vars;
var Blocks = Packages.mindustry.content.Blocks;
var Team = Packages.mindustry.game.Team;

var passed = 0;
var failed = 0;
var failures = [];

function report(text){
    Packages.arc.util.Log.info("[autodrill-test] " + text);
}

function check(name, condition, detail){
    if(condition){
        passed++;
    }else{
        failed++;
        failures.push(name + (detail == null ? "" : " :: " + detail));
        report("FAIL: " + name + (detail == null ? "" : " :: " + detail));
    }
}

function runAll(){
    try{
        buildMap();
    }catch(e){
        report("map construction failed: " + e);
        failed++;
        finish();
        return;
    }

    try{ testUtil(); }catch(e){ failed++; report("testUtil threw: " + e); }
    try{ testBridge(); }catch(e){ failed++; report("testBridge threw: " + e); }
    try{ testOptimization(); }catch(e){ failed++; report("testOptimization threw: " + e); }
    try{ testWall(); }catch(e){ failed++; report("testWall threw: " + e); }
    try{ testEdges(); }catch(e){ failed++; report("testEdges threw: " + e); }
    try{ testUi(); }catch(e){ failed++; report("testUi threw: " + e); }
    try{ testPerformance(); }catch(e){ failed++; report("testPerformance threw: " + e); }

    finish();
}

function finish(){
    report("RESULT passed=" + passed + " failed=" + failed + " | AUTODRILL-TEST-RESULT passed=" + passed + " failed=" + failed);
    for(var i = 0; i < failures.length; i++){
        report("  failure: " + failures[i]);
    }
}

// ------------------------------------------------------------------ test world

var MAP = 160;
var COPPER = {x0: 20, x1: 30, y0: 20, y1: 30};
// A solid wall blob whose LEFT face carries the ore crust - exactly like Erekir's
// surface wall-ore generation (ore only on tiles adjacent to open air).
var WALL = {x0: 10, x1: 24, y0: 40, y1: 54};

function buildMap(){
    Vars.world.loadGenerator(MAP, MAP, function(tiles){
        tiles.fill(); // the container starts empty - our generator creates the tiles
        var x = 0, y = 0, tile = null;
        for(x = 0; x < MAP; x++){
            for(y = 0; y < MAP; y++){
                tile = tiles.get(x, y);
                tile.setBlock(Blocks.air);
                tile.setFloor(Blocks.stone);
                tile.setOverlay(Blocks.air);
            }
        }

        for(x = COPPER.x0; x <= COPPER.x1; x++){
            for(y = COPPER.y0; y <= COPPER.y1; y++){
                tiles.get(x, y).setOverlay(Blocks.oreCopper);
            }
        }

        for(x = WALL.x0; x <= WALL.x1; x++){
            for(y = WALL.y0; y <= WALL.y1; y++){
                tile = tiles.get(x, y);
                tile.setBlock(Blocks.redStoneWall);
            }
        }
        for(y = WALL.y0; y <= WALL.y1; y++){
            // ore crust on the exposed left face
            tiles.get(WALL.x0, y).setOverlay(Blocks.wallOreBeryllium);
        }
    });

    report("map built: " + MAP + "x" + MAP + " stone, copper patch " + (COPPER.x1 - COPPER.x0 + 1)
        + "x" + (COPPER.y1 - COPPER.y0 + 1) + ", wall blob at (" + WALL.x0 + "," + WALL.y0 + ") with ore crust on the left face");
}

// ------------------------------------------------------------------ helpers

function tileCount(plans, block){
    var n = 0;
    for(var i = 0; i < plans.length; i++){
        if(api.blockId(plans[i].block) === api.blockId(block)) n++;
    }
    return n;
}

function allInBounds(plans){
    for(var i = 0; i < plans.length; i++){
        var p = plans[i];
        if(!util.isWithinWorld(p.block, p.x, p.y)) return false;
    }
    return true;
}

function noOverlaps(plans){
    for(var i = 0; i < plans.length; i++){
        for(var j = i + 1; j < plans.length; j++){
            var a = util.blockRect(plans[i].x, plans[i].y, plans[i].block);
            var b = util.blockRect(plans[j].x, plans[j].y, plans[j].block);
            if(util.rectsOverlap(a, b)) return false;
        }
    }
    return true;
}

function allPlaceable(plans, team){
    for(var i = 0; i < plans.length; i++){
        var p = plans[i];
        if(!api.validPlace(p.block, team, p.x, p.y, p.rot)){
            return api.blockName(p.block) + " @ " + p.x + "," + p.y;
        }
    }
    return true;
}

function allBlocksAllowed(plans, allowed){
    for(var i = 0; i < plans.length; i++){
        var id = api.blockId(plans[i].block);
        var ok = false;
        for(var j = 0; j < allowed.length; j++){
            if(id === api.blockId(allowed[j])){ ok = true; break; }
        }
        if(!ok) return api.blockName(plans[i].block) + " @ " + plans[i].x + "," + plans[i].y;
    }
    return true;
}

// ------------------------------------------------------------------ tests

function testUtil(){
    var team = Team.sharded;
    var ore = api.tile(25, 25);

    check("util: tapped tile drops copper", api.itemId(api.drop(ore)) === api.itemId(Packages.mindustry.content.Items.copper),
        "drop=" + (api.drop(ore) == null ? "null" : api.drop(ore).name));

    check("util: mechanical drill can mine tapped tile", api.canMine(Blocks.mechanicalDrill, ore));

    var count = util.countOre(ore, Blocks.mechanicalDrill);
    check("util: countOre finds copper", count != null && api.itemId(count.item) === api.itemId(Packages.mindustry.content.Items.copper),
        "count=" + (count == null ? "null" : count.count));

    var tiles = util.getConnectedTiles(ore, 200, team);
    check("util: flood fill found the whole patch", tiles.length >= 121, "tiles=" + tiles.length);

    var minX = 999, maxX = -1, minY = 999, maxY = -1;
    for(var i = 0; i < tiles.length; i++){
        minX = Math.min(minX, api.tx(tiles[i]));
        maxX = Math.max(maxX, api.tx(tiles[i]));
        minY = Math.min(minY, api.ty(tiles[i]));
        maxY = Math.max(maxY, api.ty(tiles[i]));
    }
    check("util: flood fill bounds", minX >= COPPER.x0 - 1 && maxX <= COPPER.x1 + 1 && minY >= COPPER.y0 - 1 && maxY <= COPPER.y1 + 1,
        "bounds=" + minX + "," + minY + " .. " + maxX + "," + maxY);

    var before = tiles.length;
    util.expandArea(tiles, 1);
    check("util: expandArea adds tiles", tiles.length > before, "before=" + before + " after=" + tiles.length);

    // sort stability and helpers
    var seq = [{x: 0, y: 0, n: 3}, {x: 0, y: 0, n: 1}, {x: 0, y: 0, n: 1}];
    util.sortStable(seq, function(e){ return e.n; });
    check("util: sort is stable", seq[0].n === 1 && seq[1].n === 1 && seq[2].n === 3);

    check("util: argMax takes the last maximum", util.argMax([{v: 1, id: "a"}, {v: 1, id: "b"}], function(e){ return e.v; }).id === "b");
    check("util: argMin takes the last minimum", util.argMin([{v: 1, id: "a"}, {v: 1, id: "b"}], function(e){ return e.v; }).id === "b");
}

function testBridge(){
    var team = Team.sharded;
    var ore = api.tile(25, 25);

    var plans = bridge.fill(ore, Blocks.mechanicalDrill, dir.RIGHT, team);
    check("bridge: produced plans", plans.length > 0, "plans=" + plans.length);
    check("bridge: only drills and bridges", allBlocksAllowed(plans, [Blocks.mechanicalDrill, Blocks.itemBridge]) === true,
        String(allBlocksAllowed(plans, [Blocks.mechanicalDrill, Blocks.itemBridge])));
    check("bridge: no overlapping footprints", noOverlaps(plans));
    check("bridge: every plan placeable", allPlaceable(plans, team) === true, String(allPlaceable(plans, team)));
    check("bridge: all plans in bounds", allInBounds(plans));

    var drills = tileCount(plans, Blocks.mechanicalDrill);
    var bridges = tileCount(plans, Blocks.itemBridge);
    check("bridge: has drills", drills > 0, "drills=" + drills);
    check("bridge: has bridge chain", bridges > 0, "bridges=" + bridges);
    report("bridge: drills=" + drills + " bridges=" + bridges);

    // drThe classic 6-pattern: drills only on drill tiles, bridges only on bridge tiles
    var wrongDrill = null;
    for(var i = 0; i < plans.length; i++){
        if(api.blockId(plans[i].block) === api.blockId(Blocks.mechanicalDrill)
            && !bridge.isDrillTile(api.tile(plans[i].x, plans[i].y))){
            wrongDrill = plans[i].x + "," + plans[i].y;
        }
    }
    check("bridge: drills sit on pattern tiles", wrongDrill == null, "wrong=" + wrongDrill);

    // pneumatic
    var pneu = bridge.fill(ore, Blocks.pneumaticDrill, dir.UP, team);
    check("bridge: pneumatic produces plans", pneu.length > 0, "plans=" + pneu.length);
    check("bridge: pneumatic has drills", tileCount(pneu, Blocks.pneumaticDrill) > 0);

    // edge case: patch corner (bounds handling)
    var corner = api.tile(COPPER.x0, COPPER.y0);
    var cornerPlans = bridge.fill(corner, Blocks.mechanicalDrill, dir.LEFT, team);
    check("bridge: corner tap stays in bounds", allInBounds(cornerPlans));

    // edge case: no ore
    var empty = api.tile(2, 2);
    var emptyPlans = bridge.fill(empty, Blocks.mechanicalDrill, dir.RIGHT, team);
    check("bridge: no-ore tile produces nothing", emptyPlans.length === 0, "plans=" + emptyPlans.length);
}

function testOptimization(){
    var team = Team.sharded;
    var ore = api.tile(25, 25);

    var laser = optimization.fill(ore, Blocks.laserDrill, true, team);
    check("optimization: laser produces plans", laser.length > 0, "plans=" + laser.length);
    check("optimization: laser blocks", allBlocksAllowed(laser, [Blocks.laserDrill, Blocks.waterExtractor, Blocks.powerNode]) === true,
        String(allBlocksAllowed(laser, [Blocks.laserDrill, Blocks.waterExtractor, Blocks.powerNode])));
    check("optimization: laser no overlaps", noOverlaps(laser));
    check("optimization: laser plans placeable", allPlaceable(laser, team) === true, String(allPlaceable(laser, team)));
    var laserDrills = tileCount(laser, Blocks.laserDrill);
    var extractors = tileCount(laser, Blocks.waterExtractor);
    var nodes = tileCount(laser, Blocks.powerNode);
    check("optimization: laser has drills", laserDrills > 0, "drills=" + laserDrills);
    check("optimization: water extractors for laser", extractors > 0, "extractors=" + extractors);
    check("optimization: power nodes for laser", nodes > 0, "nodes=" + nodes);
    report("optimization: laser drills=" + laserDrills + " extractors=" + extractors + " nodes=" + nodes);

    var blast = optimization.fill(ore, Blocks.blastDrill, true, team);
    check("optimization: airblast produces plans", tileCount(blast, Blocks.blastDrill) > 0, "plans=" + blast.length);
    check("optimization: airblast no overlaps", noOverlaps(blast));

    var impact = optimization.fill(ore, Blocks.impactDrill, false, team);
    check("optimization: impact produces plans", tileCount(impact, Blocks.impactDrill) > 0, "plans=" + impact.length);
    check("optimization: impact has no support blocks", tileCount(impact, Blocks.waterExtractor) === 0);

    // min-ores setting is respected
    var minOres = api.settingInt("laser-drill-min-ores", 5);
    var worst = 99;
    for(var i = 0; i < laser.length; i++){
        if(api.blockId(laser[i].block) === api.blockId(Blocks.laserDrill)){
            var c = util.countOre(api.tile(laser[i].x, laser[i].y), Blocks.laserDrill);
            worst = Math.min(worst, c == null ? 0 : c.count);
        }
    }
    check("optimization: every drill meets min ores", worst >= minOres, "worst=" + worst + " min=" + minOres);

    // no ore -> nothing
    var none = optimization.fill(api.tile(2, 2), Blocks.laserDrill, true, team);
    check("optimization: no-ore tile produces nothing", none.length === 0, "plans=" + none.length);
}

function testWall(){
    var team = Team.sharded;
    var ore = api.tile(WALL.x0, 47);

    var wallTiles = wall.getConnectedWallTiles(ore, dir.RIGHT);
    check("wall: found connected wall tiles", wallTiles.length > 0, "tiles=" + wallTiles.length);

    check("wall: tapped tile drops beryllium", api.itemId(api.wallDrop(ore)) === api.itemId(Packages.mindustry.content.Items.beryllium),
        "wallDrop=" + (api.wallDrop(ore) == null ? "null" : api.wallDrop(ore).name));
    check("wall: plasma bore can mine the tile",
        api.wallDrop(ore) != null && api.itemHardness(api.wallDrop(ore)) <= api.beamTier(Blocks.plasmaBore),
        "hardness=" + api.itemHardness(api.wallDrop(ore)) + " tier=" + api.beamTier(Blocks.plasmaBore));

    var plans = wall.fill(ore, Blocks.plasmaBore, dir.RIGHT, team);
    check("wall: produced plans", plans.length > 0, "plans=" + plans.length);
    check("wall: only bores, ducts and beam nodes", allBlocksAllowed(plans, [Blocks.plasmaBore, Blocks.duct, Blocks.beamNode]) === true,
        String(allBlocksAllowed(plans, [Blocks.plasmaBore, Blocks.duct, Blocks.beamNode])));
    check("wall: no overlapping footprints", noOverlaps(plans));
    check("wall: every plan placeable", allPlaceable(plans, team) === true, String(allPlaceable(plans, team)));
    check("wall: all plans in bounds", allInBounds(plans));

    if(plans.length > 0 && plans.length <= 8){
        var listed = [];
        for(var pi = 0; pi < plans.length; pi++){
            listed.push(api.blockName(plans[pi].block) + "@" + plans[pi].x + "," + plans[pi].y);
        }
        report("wall: plans " + listed.join(" "));
    }

    var bores = tileCount(plans, Blocks.plasmaBore);
    var ducts = tileCount(plans, Blocks.duct);
    var nodes = tileCount(plans, Blocks.beamNode);
    check("wall: has bores", bores > 0, "bores=" + bores);
    check("wall: has ducts", ducts > 0, "ducts=" + ducts);
    check("wall: has beam nodes", nodes > 0, "nodes=" + nodes);
    report("wall: bores=" + bores + " ducts=" + ducts + " nodes=" + nodes);

    // every direction must at least not throw
    var dirs = [dir.RIGHT, dir.UP, dir.LEFT, dir.DOWN];
    for(var i = 0; i < dirs.length; i++){
        var p = wall.fill(ore, Blocks.plasmaBore, dirs[i], team);
        check("wall: direction " + i + " in bounds", allInBounds(p), "plans=" + p.length);
    }

    // wall ore that is too hard must be rejected by the button logic, not the filler
    check("wall: tungsten is too hard for the plasma bore", api.itemHardness(Packages.mindustry.content.Items.tungsten) > api.beamTier(Blocks.plasmaBore));
}

function testEdges(){
    var team = Team.sharded;

    // tile at the very edge of the map
    var edge = api.tile(1, 1);
    var plans = bridge.fill(edge, Blocks.mechanicalDrill, dir.RIGHT, team);
    check("edge: map-edge fill in bounds", allInBounds(plans), "plans=" + plans.length);

    // a 1x1 ore tile in the corner
    var t = api.tile(0, 0);
    t.setFloor(Blocks.stone);
    t.setBlock(Blocks.air);
    t.setOverlay(Blocks.oreCopper);
    var corner = optimization.fill(t, Blocks.laserDrill, true, team);
    check("edge: single-tile patch does not throw", corner.length >= 0, "plans=" + corner.length);
    check("edge: single-tile patch in bounds", allInBounds(corner));
    t.setOverlay(Blocks.air);
}

function testUi(){
    var ore = api.tile(25, 25);
    var wallTile = api.tile(WALL.x0, 47);

    // the harness gets its own module instance (different module id than the mod's
    // own 'ui' import), so initialise it here - init() is idempotent
    ui.init();
    ui.setEnabled(true);
    ui.selectTile(ore);
    var info = ui.debugInfo();
    check("ui: toolbar built for ore tile", info.buttons > 0, "buttons=" + info.buttons);
    check("ui: ore tile offers mechanical drill", info.sprites.indexOf("block-mechanical-drill-full") !== -1, info.sprites.join(","));
    check("ui: ore tile offers laser drill", info.sprites.indexOf("block-laser-drill-full") !== -1, info.sprites.join(","));
    check("ui: ore tile does not offer plasma bore", info.sprites.indexOf("block-plasma-bore-full") === -1, info.sprites.join(","));

    ui.selectTile(wallTile);
    info = ui.debugInfo();
    check("ui: wall tile offers plasma bore", info.sprites.indexOf("block-plasma-bore-full") !== -1, info.sprites.join(","));
    check("ui: wall tile does not offer mechanical drill", info.sprites.indexOf("block-mechanical-drill-full") === -1, info.sprites.join(","));

    ui.setEnabled(false);
    check("ui: disabled state has no buttons", ui.debugInfo().buttons === 0 || !ui.debugInfo().enabled);
}

var BIG = {x0: 100, x1: 140, y0: 100, y1: 140};

function testPerformance(){
    // a big patch: how long does the iphone-side algorithm take on the desktop JVM?
    var team = Team.sharded;
    var tiles = Vars.world.tiles;
    var x = 0, y = 0;

    // grow the world so the patch fits
    if(Vars.world.width() < 160){
        report("performance: world too small (" + Vars.world.width() + "), skipping");
        return;
    }

    for(x = BIG.x0; x <= BIG.x1; x++){
        for(y = BIG.y0; y <= BIG.y1; y++){
            var t = tiles.get(x, y);
            t.setBlock(Blocks.air);
            t.setFloor(Blocks.stone);
            t.setOverlay(Blocks.oreCopper);
        }
    }

    var center = api.tile((BIG.x0 + BIG.x1) / 2 | 0, (BIG.y0 + BIG.y1) / 2 | 0);

    var start = api.now();
    var bridgePlans = bridge.fill(center, Blocks.mechanicalDrill, dir.RIGHT, team);
    var bridgeMs = api.now() - start;

    start = api.now();
    var laserPlans = optimization.fill(center, Blocks.laserDrill, true, team);
    var laserMs = api.now() - start;

    report("performance: patch " + (BIG.x1 - BIG.x0 + 1) + "x" + (BIG.y1 - BIG.y0 + 1)
        + " bridge=" + bridgeMs + "ms/" + bridgePlans.length + " plans"
        + " laser=" + laserMs + "ms/" + laserPlans.length + " plans");

    check("performance: bridge under 20s", bridgeMs < 20000, "ms=" + bridgeMs);
    check("performance: optimization under 30s (incl. its 2s search budget)", laserMs < 30000, "ms=" + laserMs);
    check("performance: bridge produced plans", bridgePlans.length > 0);
    check("performance: laser produced plans", laserPlans.length > 0);

    for(x = BIG.x0; x <= BIG.x1; x++){
        for(y = BIG.y0; y <= BIG.y1; y++){
            tiles.get(x, y).setOverlay(Blocks.air);
        }
    }
}

Packages.arc.Events.on(Packages.mindustry.game.EventType.ClientLoadEvent, new Packages.arc.func.Cons({get: function(){
    // defer one frame: the mod under test registers its own ClientLoadEvent handler,
    // and its UI must exist before the UI checks run
    Packages.arc.Core.app.post(function(){
        try{
            runAll();
        }catch(e){
            report("harness crashed: " + e);
        }
    });
}}));
