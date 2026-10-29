// Minimal fake of scripts/api.js for running the placement engine outside the game.
// Install as the global AUTODRILL_API_FAKE before the mod is loaded (see tests/js/run.sh).

var fakeLog = [];

function makeApi(){
    var SCENARIO = (typeof AUTODRILL_FAKE_SCENARIO !== "undefined") ? AUTODRILL_FAKE_SCENARIO : null;
    var OPTS = SCENARIO == null ? {} : SCENARIO;

    var WORLD = OPTS.world == null ? 64 : OPTS.world;
    var WORLD_H = OPTS.worldH == null ? WORLD : OPTS.worldH;
    var TILESIZE = 8;

    var blocks = {};      // name -> block
    var items = {};       // id -> item
    var nextBlockId = 1;
    var nextItemId = 1;

    // Blocks are keyed by the *field* names the mod uses (Blocks.mechanicalDrill, ...),
    // because scripts/api.js resolves them through the game's Blocks class.
    // env: "serpulo", "erekir" or "any" - the fake world is one planet or the other, so the
    // engine's block choice (power nodes vs beam blocks, conduits vs reinforced conduits) can
    // be tested without the game.
    function block(field, size, env){
        var b = {name: field, id: nextBlockId++, size: size, environmentBuildable: true, env: env == null ? "any" : env};
        blocks[field] = b;
        return b;
    }

    var mechanicalDrill = block("mechanicalDrill", 2, "serpulo");
    var pneumaticDrill = block("pneumaticDrill", 2, "serpulo");
    var laserDrill = block("laserDrill", 3, "serpulo");
    var blastDrill = block("blastDrill", 4, "serpulo");
    var impactDrill = block("impactDrill", 4, "erekir");
    var eruptionDrill = block("eruptionDrill", 5, "erekir");
    var plasmaBore = block("plasmaBore", 2, "erekir");
    var largePlasmaBore = block("largePlasmaBore", 3, "erekir");
    var itemBridge = block("itemBridge", 1);
    var duct = block("duct", 1, "erekir");
    var conveyor = block("conveyor", 1, "serpulo");
    var beamNode = block("beamNode", 1, "erekir");
    var beamTower = block("beamTower", 3, "erekir");
    var conduit = block("conduit", 1, "serpulo");
    var reinforcedConduit = block("reinforcedConduit", 1, "erekir");
    var waterExtractor = block("waterExtractor", 2, "serpulo");
    var ventCondenser = block("ventCondenser", 3, "erekir");
    var electrolyzer = block("electrolyzer", 3, "erekir");
    var oilExtractor = block("oilExtractor", 3, "any");
    var mechanicalPump = block("mechanicalPump", 2, "serpulo");
    var impulsePump = block("impulsePump", 3, "erekir");
    var powerNode = block("powerNode", 1, "serpulo");
    // link ranges as the game exposes them (PowerNode: laserRange, BeamNode/BeamTower: range)
    beamNode.range = 10;
    beamTower.range = 23;
    powerNode.laserRange = 6;
    // beam drills: the numbers the game gives them (Blocks.java v160.7)
    plasmaBore.beamRange = 5;
    plasmaBore.tier = 3;
    largePlasmaBore.beamRange = 6;
    largePlasmaBore.tier = 5;

    var copperWall = block("copperWall", 1);
    var berylliumWall = block("berylliumWall", 1);
    var air = block("air", 1);

    var copper = {id: nextItemId++, name: "copper", lowPriority: false, hardness: 1};
    var lead = {id: nextItemId++, name: "lead", lowPriority: false, hardness: 1};
    var beryllium = {id: nextItemId++, name: "beryllium", lowPriority: false, hardness: 2};
    var tungsten = {id: nextItemId++, name: "tungsten", lowPriority: false, hardness: 4};

    // ---- world: floor tiles with a rectangular ore patch ----
    var ore = {};         // pos -> true
    var ORE_LEAD = {};    // pos -> true (a second ore, for mixed-patch tests)
    var BUILT = {};       // pos -> true (something already stands here)
    var walls = {};       // pos -> true (solid)
    var WALL_ORE = {};    // pos -> item (wall ore embedded in a solid tile, never consumed)
    var batch = {oreX0: 20, oreX1: 40, oreY0: 20, oreY1: 40};

    function pos(x, y){ return x + y * WORLD; }
    function inWorld(x, y){ return x >= 0 && y >= 0 && x < WORLD && y < WORLD_H; }

    // solid ground (walls) from the scenario: one rect, a list of rects, and/or single cells
    function markWall(x, y){ walls[pos(x, y)] = true; }
    function markWallRect(wr){
        for(var wx = wr.x0; wx <= wr.x1; wx++){
            for(var wy = wr.y0; wy <= wr.y1; wy++) markWall(wx, wy);
        }
    }
    if(OPTS.wallRect != null) markWallRect(OPTS.wallRect);
    if(OPTS.wallRects != null){
        for(var wi = 0; wi < OPTS.wallRects.length; wi++) markWallRect(OPTS.wallRects[wi]);
    }
    if(OPTS.wallCells != null){
        for(var wc = 0; wc < OPTS.wallCells.length; wc++) markWall(OPTS.wallCells[wc][0], OPTS.wallCells[wc][1]);
    }
    // wall ore: the tile is solid and the ore is never consumed (BeamDrill keeps drilling it),
    // so a bore mines the first solid tile in front of each of its lanes, forever
    if(OPTS.wallOreCells != null){
        for(var wo = 0; wo < OPTS.wallOreCells.length; wo++){
            var wox = OPTS.wallOreCells[wo][0], woy = OPTS.wallOreCells[wo][1];
            markWall(wox, woy);
            WALL_ORE[pos(wox, woy)] = OPTS.wallOreItem === "tungsten" ? tungsten : beryllium;
        }
    }

    var rect = OPTS.ore == null ? batch : OPTS.ore;
    var shapes = OPTS.patches == null
        ? [{oreX0: rect.oreX0, oreY0: rect.oreY0, x1: rect.x1, y1: rect.y1, round: OPTS.round === true}]
        : OPTS.patches;

    // a second ore area, for mixed-patch tests
    if(OPTS.leadRect != null){
        var lr = OPTS.leadRect;
        for(var lx = lr.x0; lx <= lr.x1; lx++){
            for(var ly = lr.y0; ly <= lr.y1; ly++){
                ORE_LEAD[pos(lx, ly)] = true;
            }
        }
    }

    var i = 0, j = 0, si = 0;
    for(si = 0; si < shapes.length; si++){
        var sh = shapes[si];
        var cx = (sh.oreX0 + sh.x1) / 2, cy = (sh.oreY0 + sh.y1) / 2;
        var r = Math.min(sh.x1 - sh.oreX0, sh.y1 - sh.oreY0) / 2;

        for(i = sh.oreX0; i <= sh.x1; i++){
            for(j = sh.oreY0; j <= sh.y1; j++){
                if(sh.round === true){
                    // round blob, like the map generator's patches
                    var d = (i - cx) * (i - cx) + (j - cy) * (j - cy);
                    if(d > r * r * 0.8) continue;
                }
                // the same band/hole filters the shape sweep's own measurement uses - without
                // them the sweep measured filters the world never had (its band/hole cases were
                // silently full rectangles)
                if(sh.band === true){
                    var t = i - sh.oreX0;
                    if(((j - sh.oreY0) - t) % 9 > 1 && ((j - sh.oreY0) - t) % 9 < 9 && i !== sh.oreX0) continue;
                }
                if(sh.hole === true){
                    if(Math.abs(i - cx) < 3 && Math.abs(j - cy) < 3) continue;
                }
                ore[pos(i, j)] = true;
            }
        }
    }

    var api = {};

    api.trace = function(text){
        fakeLog.push(text);
        java.lang.System.out.println("TRACE " + text);
    };
    api.log = function(text){ fakeLog.push(text); };
    api.now = function(){ return Date.now(); };
    api.toast = function(text){ fakeLog.push("toast: " + text); };
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
    api.worldH = function(){ return WORLD_H; };

    api.drop = function(tile){
        var lr = OPTS.leadRect;
        if(lr != null && tile.x >= lr.x0 && tile.x <= lr.x1 && tile.y >= lr.y0 && tile.y <= lr.y1) return lead;
        return ore[pos(tile.x, tile.y)] === true ? copper : null;
    };
    api.modVersion = function(){ return "test"; };
    api.itemName = function(id){
        return id === lead.id ? "Lead" : (id === copper.id ? "Copper"
            : (id === beryllium.id ? "Beryllium" : (id === tungsten.id ? "Tungsten" : null)));
    };
    api.hasBuilding = function(tile){
        return tile != null && BUILT[pos(tile.x, tile.y)] === true;
    };
    /** Test hook: mark a tile as already built, so a second fill sees it as taken. */
    api.__build = function(x, y){ BUILT[pos(x, y)] = true; };
    /** Test hook: add an ore tile (vein fixtures are built at runtime by the checks). */
    api.__ore = function(x, y){ ore[pos(x, y)] = true; };
    api.wallDrop = function(tile){
        if(tile == null) return null;
        var item = WALL_ORE[pos(tile.x, tile.y)];
        return item === undefined ? null : item;
    };
    api.solid = function(tile){ return walls[pos(tile.x, tile.y)] === true; };
    api.blockOf = function(){ return air; };
    api.buildOf = function(){ return null; };
    // Tile.relativeTo: the rotation from `other` to `tile` (0=east, 1=north, 2=west, 3=south),
    // or -1 for the same tile - the wall duct phases need the real thing, not a stub
    api.relativeTo = function(tile, other){
        if(tile == null || other == null) return -1;
        var dx = tile.x - other.x, dy = tile.y - other.y;
        if(Math.abs(dx) > Math.abs(dy)){
            if(dx <= -1) return 0;
            if(dx >= 1) return 2;
        }else{
            if(dy <= -1) return 1;
            if(dy >= 1) return 3;
        }
        return -1;
    };
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
    api.environmentBuildable = function(b){
        if(b == null || b.environmentBuildable !== true) return false;
        if(b.env === "any") return true;
        return (OPTS.erekir === true) ? b.env === "erekir" : b.env === "serpulo";
    };
    api.isErekir = function(){ return OPTS.erekir === true; };
    api.powerRangeOf = function(b){ return Math.floor(b.laserRange != null ? b.laserRange : b.range); };
    api.itemId = function(item){ return item == null ? -1 : item.id; };
    api.itemLowPriority = function(item){ return item != null && item.lowPriority; };
    api.itemHardness = function(item){ return item == null ? -1 : item.hardness; };
    api.canMine = function(drill, tile){ return api.drop(tile) != null && tile.x >= 0 && tile.y >= 0; };
    api.getDrop = function(drill, tile){ return api.drop(tile); };
    api.beamRange = function(drill){ return drill == null || drill.beamRange == null ? 5 : drill.beamRange; };
    api.beamTier = function(drill){ return drill == null || drill.tier == null ? 3 : drill.tier; };
    api.blockItemDrop = function(){ return null; };

    api.validPlace = function(block, team, x, y, rot){
        var size = block.size;
        var half = Math.floor((size - 1) / 2);
        for(var cx = x - half; cx < x - half + size; cx++){
            for(var cy = y - half; cy < y - half + size; cy++){
                if(!inWorld(cx, cy)) return false;
                if(walls[pos(cx, cy)] === true) return false;
                if(BUILT[pos(cx, cy)] === true) return false;    // occupied by a building
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
    api.waterTile = function(){ return false; };   // the fake world has no water
    /**
     * `SolidPump.canPlaceOn` over the whole footprint: base efficiency 1.0 plus the tile's
     * water attribute on every tile (the fake has no liquid floors, so every tile counts).
     * Mirrors scripts/api.js so the optimiser's footprint scoring runs in the fake world too.
     */
    api.waterAtFootprint = function(block, x, y){
        var size = block.size;
        var offset = Math.floor((size - 1) / 2);
        var sum = 0;
        for(var dx = 0; dx < size; dx++){
            for(var dy = 0; dy < size; dy++){
                var t = api.tile(x - offset + dx, y - offset + dy);
                if(t == null) continue;
                sum += 1.0 + api.waterAt(t);
            }
        }
        return sum;
    };
    api.pumpsWaterAt = function(block, x, y){
        // A water extractor is a SolidPump: placeable wherever the footprint's ground-water
        // sum passes (base efficiency is 1.0 per tile), never on a fully liquid footprint.
        // The fake world has no liquid floors, so every 2x2 within the world passes - exactly
        // what the real block does on a Serpulo map with ground water.
        if(api.blockName(block) === "waterExtractor"){
            return api.waterAtFootprint(block, x, y) > 0.00001;
        }
        // standing water, or ground water where the scenario says there is any
        if(OPTS.waterRect != null
            && x >= OPTS.waterRect.x0 && x <= OPTS.waterRect.x1
            && y >= OPTS.waterRect.y0 && y <= OPTS.waterRect.y1){
            return true;
        }
        return api.waterAt({x: x, y: y}) > 0;
    };

    api.attributeAt = function(tile, name){
        var rect = name === "oil" ? OPTS.oilRect : (name === "steam" ? OPTS.steamRect : OPTS.waterRect);
        if(rect == null || tile == null) return 0;
        if(tile.x < rect.x0 || tile.x > rect.x1 || tile.y < rect.y0 || tile.y > rect.y1) return 0;
        return name === "steam" ? 1 : (name === "oil" ? 1.5 : 1);
    };

    api.powerSupportInfo = function(){
        var tower = blocks.beamTower;
        var beam = blocks.beamNode;
        var node = blocks.powerNode;
        if(OPTS.erekir === true){
            if(api.environmentBuildable(tower)) return {block: tower, range: tower.range, size: tower.size, linkBlock: api.environmentBuildable(beam) ? beam : tower};
            if(api.environmentBuildable(beam)) return {block: beam, range: beam.range, size: beam.size, linkBlock: beam};
        }
        return {block: node, range: node.laserRange, size: node.size, linkBlock: node};
    };

    api.liquidConduit = function(){
        return api.environmentBuildable(blocks.reinforcedConduit) ? blocks.reinforcedConduit : blocks.conduit;
    };

    api.pumpBlock = function(){
        if(api.environmentBuildable(blocks.mechanicalPump)) return blocks.mechanicalPump;
        return blocks.impulsePump;
    };
    api.powerLinkRange = function(){ return 6; };
    api.powerTargetNear = function(x, y, radius){
        var target = OPTS.powerTarget;
        if(target == null) return null;
        var dx = target.x - x, dy = target.y - y;
        if(dx * dx + dy * dy > radius * radius) return null;
        return {x: target.x, y: target.y};
    };
    api.bridgeRange = function(){ return 4; };
    api.pointPacked = function(x, y){ return ((x & 0xffff) << 16) | (y & 0xffff); };
    api.bridgeLinkPacked = function(){ return -1; };
    api.removePlan = function(){ return true; };
    api.postStep = function(fn){ fn(); };
    api.showProgress = function(text){ fakeLog.push("progress: " + text); };
    api.setProgress = function(value){
        // the real one takes a number and feeds it to a Floatp; passing a function there threw
        // inside the game's render loop, so the fake is deliberately strict
        if(typeof value !== "number") throw new Error("setProgress takes a number, got " + typeof value);
        if(value < 0 || value > 1) throw new Error("setProgress out of range: " + value);
    };
    api.setProgressCancel = function(){};
    api.hideProgress = function(){};

    api.newPlan = function(x, y, rot, blk, configX, configY){
        return {x: x, y: y, rot: rot, block: blk, configX: configX, configY: configY};
    };
    api.addPlan = function(){ return true; };

    api.settingInt = function(key, def){
        return (OPTS.settings != null && OPTS.settings[key] != null) ? OPTS.settings[key] : def;
    };
    api.settingBool = function(key, def){
        return (OPTS.settings != null && OPTS.settings[key] != null) ? OPTS.settings[key] === true : def;
    };
    api.settingString = function(key, def){ return def; };
    api.putSetting = function(){};

    api.__info = function(){
        return {log: fakeLog, copper: copper, laserDrill: laserDrill, mechanicalDrill: mechanicalDrill,
            waterExtractor: waterExtractor, powerNode: powerNode, blocks: blocks, items: items};
    };

    return api;
}

AUTODRILL_API_FAKE = makeApi();
