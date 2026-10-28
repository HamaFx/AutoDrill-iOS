// Minimal fake of scripts/api.js for running the placement engine outside the game.
// Install as the global AUTODRILL_API_FAKE before the mod is loaded (see tests/js/run.sh).

var fakeLog = [];

function makeApi(){
    var WORLD = 64;
    var TILESIZE = 8;

    var blocks = {};      // name -> block
    var items = {};       // id -> item
    var nextBlockId = 1;
    var nextItemId = 1;

    // Blocks are keyed by the *field* names the mod uses (Blocks.mechanicalDrill, ...),
    // because scripts/api.js resolves them through the game's Blocks class.
    function block(field, size){
        var b = {name: field, id: nextBlockId++, size: size, environmentBuildable: true};
        blocks[field] = b;
        return b;
    }

    var mechanicalDrill = block("mechanicalDrill", 2);
    var pneumaticDrill = block("pneumaticDrill", 2);
    var laserDrill = block("laserDrill", 3);
    var blastDrill = block("blastDrill", 3);
    var impactDrill = block("impactDrill", 4);
    var eruptionDrill = block("eruptionDrill", 5);
    var plasmaBore = block("plasmaBore", 2);
    var itemBridge = block("itemBridge", 1);
    var duct = block("duct", 1);
    var beamNode = block("beamNode", 1);
    var waterExtractor = block("waterExtractor", 2);
    var powerNode = block("powerNode", 1);
    var copperWall = block("copperWall", 1);
    var berylliumWall = block("berylliumWall", 1);
    var air = block("air", 1);

    var copper = {id: nextItemId++, name: "copper", lowPriority: false, hardness: 1};

    // ---- world: floor tiles with a rectangular ore patch ----
    var ore = {};         // pos -> true
    var walls = {};       // pos -> true (solid)
    var batch = {oreX0: 20, oreX1: 40, oreY0: 20, oreY1: 40};

    function pos(x, y){ return x + y * WORLD; }
    function inWorld(x, y){ return x >= 0 && y >= 0 && x < WORLD && y < WORLD; }

    var i = 0, j = 0;
    for(i = batch.oreX0; i <= batch.oreX1; i++){
        for(j = batch.oreY0; j <= batch.oreY1; j++){
            ore[pos(i, j)] = true;
        }
    }

    var api = {};

    api.trace = function(text){
        fakeLog.push(text);
        java.lang.System.out.println("TRACE " + text);
    };
    api.log = function(text){ fakeLog.push(text); };
    api.now = function(){ return Date.now(); };
    api.toast = function(){};
    api.tilesize = function(){ return TILESIZE; };

    api.tile = function(x, y){ return inWorld(x, y) ? {x: x, y: y} : null; };
    api.nearby = function(tile, dx, dy){
        if(tile == null) return null;
        var x = tile.x + dx, y = tile.y + dy;
        return inWorld(x, y) ? {x: x, y: y} : null;
    };
    api.pos = function(tile){ return pos(tile.x, tile.y); };
    api.tx = function(tile){ return tile.x; };
    api.ty = function(tile){ return tile.y; };
    api.worldW = function(){ return WORLD; };
    api.worldH = function(){ return WORLD; };

    api.drop = function(tile){ return ore[pos(tile.x, tile.y)] === true ? copper : null; };
    api.wallDrop = function(){ return null; };
    api.solid = function(tile){ return walls[pos(tile.x, tile.y)] === true; };
    api.blockOf = function(){ return air; };
    api.buildOf = function(){ return null; };
    api.relativeTo = function(){ return -1; };
    api.centerXTile = function(tile){ return tile.x; };
    api.centerYTile = function(tile){ return tile.y; };
    api.tileWorldX = function(tile){ return tile.x * TILESIZE; };
    api.tileWorldY = function(tile){ return tile.y * TILESIZE; };
    api.dst2ToTile = function(a, b){
        var dx = (a.x - b.x) * TILESIZE, dy = (a.y - b.y) * TILESIZE;
        return dx * dx + dy * dy;
    };
    api.dstToTile = function(a, b){ return Math.sqrt(api.dst2ToTile(a, b)); };
    api.dst2ToPoint = function(tile, px, py){
        var dx = tile.x * TILESIZE - px, dy = tile.y * TILESIZE - py;
        return dx * dx + dy * dy;
    };
    api.dstToPoint = function(tile, px, py){ return Math.sqrt(api.dst2ToPoint(tile, px, py)); };

    api.block = function(name){ return blocks[name]; };
    api.blockId = function(b){ return b == null ? -1 : b.id; };
    api.blockName = function(b){ return b == null ? "null" : b.name; };
    api.size = function(b){ return b.size; };
    api.environmentBuildable = function(b){ return b.environmentBuildable; };
    api.itemId = function(item){ return item == null ? -1 : item.id; };
    api.itemLowPriority = function(item){ return item != null && item.lowPriority; };
    api.itemHardness = function(item){ return item == null ? -1 : item.hardness; };
    api.canMine = function(drill, tile){ return api.drop(tile) != null && tile.x >= 0 && tile.y >= 0; };
    api.getDrop = function(drill, tile){ return api.drop(tile); };
    api.beamRange = function(){ return 5; };
    api.beamTier = function(){ return 3; };
    api.blockItemDrop = function(){ return null; };

    api.validPlace = function(block, team, x, y, rot){
        var size = block.size;
        var half = Math.floor((size - 1) / 2);
        for(var cx = x - half; cx < x - half + size; cx++){
            for(var cy = y - half; cy < y - half + size; cy++){
                if(!inWorld(cx, cy)) return false;
                if(walls[pos(cx, cy)] === true) return false;
            }
        }
        return true;
    };

    api.team = function(){ return "sharded"; };
    api.edges = function(size){
        var offs = [];
        var half = Math.floor((size - 1) / 2);
        for(var k = 0; k < size; k++){
            offs.push({x: k - half, y: -half - 1});
            offs.push({x: k - half, y: size - half});
            offs.push({x: -half - 1, y: k - half});
            offs.push({x: size - half, y: k - half});
        }
        return offs;
    };
    api.linkedTiles = function(block, tile){
        var out = [];
        var half = Math.floor((block.size - 1) / 2);
        for(var cx = tile.x - half; cx < tile.x - half + block.size; cx++){
            for(var cy = tile.y - half; cy < tile.y - half + block.size; cy++){
                if(inWorld(cx, cy)) out.push({x: cx, y: cy});
            }
        }
        return out;
    };

    // ---- pieces the optimiser/reporting paths touch ----
    api.waterAt = function(tile){ return ((tile.x * 7 + tile.y * 13) % 5) / 10; };
    api.bridgeRange = function(){ return 4; };
    api.pointPacked = function(x, y){ return ((x & 0xffff) << 16) | (y & 0xffff); };
    api.bridgeLinkPacked = function(){ return -1; };
    api.removePlan = function(){ return true; };
    api.postStep = function(fn){ fn(); };
    api.showProgress = function(text){ fakeLog.push("progress: " + text); };
    api.setProgress = function(){};
    api.setProgressCancel = function(){};
    api.hideProgress = function(){};

    api.newPlan = function(x, y, rot, blk, configX, configY){
        return {x: x, y: y, rot: rot, block: blk, configX: configX, configY: configY};
    };
    api.addPlan = function(){ return true; };

    api.settingInt = function(key, def){ return def; };
    api.settingBool = function(key, def){ return def; };
    api.settingString = function(key, def){ return def; };
    api.putSetting = function(){};

    api.__info = function(){
        return {log: fakeLog, copper: copper, laserDrill: laserDrill, mechanicalDrill: mechanicalDrill,
            waterExtractor: waterExtractor, powerNode: powerNode, blocks: blocks, items: items};
    };

    return api;
}

AUTODRILL_API_FAKE = makeApi();
