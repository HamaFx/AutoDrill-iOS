// Map-dump dev tool (runs in the real game, never shipped - tools/pack.sh packs the repo root
// files only, and tests/ is not one of them). Loads every save/map of a game-data export with
// SaveIO.load and writes every ore patch's surroundings (+-24 tiles: floor, overlay, block,
// building) as text. tools/mapdata/build_corpus.py turns those dumps into the committed
// real-map shape corpus (tests/js/fixtures/corpus/).
//
// Output per patch: one file "<save>_<ore>_<index>.txt". Region rows are
//   x,y floor overlay block[#building]
// with "air" for the block of an open tile. Header lines: save, mapname, wave, world, region,
// component, tap and ore.
//
// Driven by tools/mapdump.sh:
//   SOURCE=/tmp/game-data OUT=/tmp/opencode/dump2 ./tools/mapdump.sh
"use strict";

var Core = Packages.arc.Core;
var Log = Packages.arc.util.Log;
var SaveIO = Packages.mindustry.io.SaveIO;
var Vars = Packages.mindustry.Vars;

function env(name, fallback){
    var value = java.lang.System.getenv(name);
    return (value == null || value.length === 0) ? fallback : String(value);
}

var SOURCE = env("MAPDUMP_SOURCE", "/tmp/game-data");
var OUT = env("MAPDUMP_OUT", "/tmp/opencode/dump2");

var MIN_TILES = 12;             // ignore specks: nothing can be filled there
var MAX_DUMPS_PER_SAVE = 40;    // deterministic cap, largest patches first
var PAD = 24;                   // tiles of context around the patch bbox

// Tie-break order for patches of the same size: this fixed list first, then anything else
// (modded ores) alphabetically, so the cap picks the same patches on every machine.
var ORE_ORDER = ["copper", "lead", "coal", "titanium", "thorium", "scrap", "sand"];

function report(text){
    Log.info("[mapdump] " + text);
}

/** The ore short name of a tile's overlay ("lead" for "ore-lead"), or null when it is not ore. */
function oreShortName(t){
    var overlay = t.overlay();
    if(overlay == null) return null;
    var name = String(overlay.name);
    if(name.indexOf("ore-") !== 0) return null;
    return name.substring(4);
}

function oreRank(shortName){
    for(var i = 0; i < ORE_ORDER.length; i++){
        if(ORE_ORDER[i] === shortName) return i;
    }
    return ORE_ORDER.length;
}

/** Every component of >= MIN_TILES tiles, per ore type, in the deterministic dump order. */
function collectComponents(){
    var world = Vars.world;
    var w = world.width(), h = world.height();
    var byOre = {};
    var names = [];
    var x = 0, y = 0;

    for(x = 0; x < w; x++){
        for(y = 0; y < h; y++){
            var t = world.tile(x, y);
            if(t == null) continue;
            var shortName = oreShortName(t);
            if(shortName == null) continue;
            if(byOre[shortName] === undefined){
                byOre[shortName] = {};
                names.push(shortName);
            }
            byOre[shortName][x + y * w] = true;
        }
    }

    var comps = [];
    for(var n = 0; n < names.length; n++){
        var set = byOre[names[n]];
        var seen = {};
        for(var startKey in set){
            var sk = startKey | 0;
            if(seen[sk] === true) continue;
            seen[sk] = true;
            var queue = [{x: sk % w, y: Math.floor(sk / w)}];
            var cells = [];
            while(queue.length > 0){
                var cur = queue.pop();
                cells.push(cur);
                for(var dx = -1; dx <= 1; dx++){
                    for(var dy = -1; dy <= 1; dy++){
                        if(dx === 0 && dy === 0) continue;
                        var nx = cur.x + dx, ny = cur.y + dy;
                        if(nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                        var nk = nx + ny * w;
                        if(set[nk] !== true || seen[nk] === true) continue;
                        seen[nk] = true;
                        queue.push({x: nx, y: ny});
                    }
                }
            }
            if(cells.length < MIN_TILES) continue;

            // sort the cells (top-left first): the tap must not depend on traversal order
            cells.sort(function(a, b){
                return (a.y * 8192 + a.x) - (b.y * 8192 + b.x);
            });
            var minX = cells[0].x, minY = cells[0].y, maxX = cells[0].x, maxY = cells[0].y;
            for(var c = 0; c < cells.length; c++){
                if(cells[c].x < minX) minX = cells[c].x;
                if(cells[c].y < minY) minY = cells[c].y;
                if(cells[c].x > maxX) maxX = cells[c].x;
                if(cells[c].y > maxY) maxY = cells[c].y;
            }
            comps.push({ore: names[n], cells: cells, minX: minX, minY: minY, maxX: maxX, maxY: maxY});
        }
    }

    comps.sort(function(a, b){
        if(a.cells.length !== b.cells.length) return b.cells.length - a.cells.length;
        var ra = oreRank(a.ore), rb = oreRank(b.ore);
        if(ra !== rb) return ra - rb;
        if(a.ore !== b.ore) return a.ore < b.ore ? -1 : 1;
        if(a.minY !== b.minY) return a.minY - b.minY;
        return a.minX - b.minX;
    });
    return comps;
}

function dumpRegion(saveName, comp, index){
    var world = Vars.world;
    var x0 = Math.max(0, comp.minX - PAD), y0 = Math.max(0, comp.minY - PAD);
    var x1 = Math.min(world.width() - 1, comp.maxX + PAD);
    var y1 = Math.min(world.height() - 1, comp.maxY + PAD);

    var tapTile = comp.cells[Math.floor(comp.cells.length / 2)];
    var lines = [];
    lines.push("save=" + saveName);
    lines.push("mapname=" + String(Vars.state.map == null ? "?" : Vars.state.map.name()));
    lines.push("wave=" + Vars.state.wave + " winWave=" + Vars.state.rules.winWave);
    lines.push("world=" + world.width() + "x" + world.height());
    lines.push("region=" + x0 + "," + y0 + "," + (x1 - x0 + 1) + "," + (y1 - y0 + 1));
    lines.push("component=" + comp.cells.length + " tiles, bbox=" + comp.minX + "," + comp.minY
        + ".." + comp.maxX + "," + comp.maxY);
    lines.push("tap=" + tapTile.x + "," + tapTile.y);
    lines.push("ore=ore-" + comp.ore);

    for(var x = x0; x <= x1; x++){
        lines.push("-- col " + x);
        for(var y = y0; y <= y1; y++){
            var t = world.tile(x, y);
            if(t == null){ lines.push(x + "," + y + " null"); continue; }
            var floor = String(t.floor().name);
            var overlay = String(t.overlay().name);
            var block = String(t.block().name);
            var build = t.build == null ? "" : ("#" + String(t.build.block.name));
            lines.push(x + "," + y + " " + floor + " " + overlay + " " + block + build);
        }
    }
    var path = OUT + "/" + saveName.replace(/[^A-Za-z0-9._-]/g, "_") + "_" + comp.ore + "_" + index + ".txt";
    Core.files.absolute(path).writeString(lines.join("\n"), false, "UTF-8");
    report("dumped " + path + " (" + comp.cells.length + " tiles)");
}

function listSaves(){
    var out = [];
    var dirs = ["saves", "maps"];
    for(var d = 0; d < dirs.length; d++){
        var listing = Core.files.absolute(SOURCE + "/" + dirs[d]).list();
        for(var i = 0; i < listing.length; i++){
            var f = listing[i];
            var name = String(f.name());
            if(name.indexOf("-backup") >= 0) continue;
            if(name.indexOf(".msav") < 0) continue;
            out.push(f);
        }
    }
    return out;
}

function runAll(){
    Core.files.absolute(OUT).mkdirs();
    var files = listSaves();
    report("saves found: " + files.length);

    var totalDumps = 0;
    var oreTotals = {};
    for(var i = 0; i < files.length; i++){
        var file = files[i];
        var name = String(file.name());
        try{
            SaveIO.load(file);
        }catch(e){
            report("LOAD FAILED " + name + ": " + e);
            continue;
        }
        try{
            var comps = collectComponents();
            var size = Vars.world.width() + "x" + Vars.world.height();
            var line = name + " map=" + String(Vars.state.map == null ? "?" : Vars.state.map.name())
                + " wave=" + Vars.state.wave + " world=" + size + " comps=" + comps.length;
            report(line);

            var dumps = 0;
            for(var c = 0; c < comps.length && dumps < MAX_DUMPS_PER_SAVE; c++, dumps++){
                dumpRegion(name, comps[c], dumps);
                totalDumps++;
                oreTotals[comps[c].ore] = (oreTotals[comps[c].ore] === undefined ? 0 : oreTotals[comps[c].ore]) + 1;
            }
            if(comps.length > dumps) report("   (capped at " + MAX_DUMPS_PER_SAVE + " dumps)");
        }catch(e){
            report("SCAN FAILED " + name + ": " + e);
        }
    }

    var summary = [];
    for(var ore in oreTotals) summary.push(ore + "=" + oreTotals[ore]);
    report("dumps total=" + totalDumps + " by ore: " + (summary.length === 0 ? "none" : summary.join(" ")));
    report("MAPDUMP-DONE");
    Core.app.post(function(){
        Core.app.exit();
    });
}

Packages.arc.Events.on(Packages.mindustry.game.EventType.ClientLoadEvent, new Packages.arc.func.Cons({get: function(){
    Packages.arc.Core.app.post(function(){
        try{
            runAll();
        }catch(e){
            report("mapdump crashed: " + e);
            report("MAPDUMP-DONE");
            Core.app.post(function(){ Core.app.exit(); });
        }
    });
}}));
