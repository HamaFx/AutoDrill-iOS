// Wall-ore battery for the wall probe (dev tool). Evaluated as tests/js/scenario.js by
// tools/wall-probe.sh.
//
// Shapes are wall *bodies*; the ore is computed the way Erekir's generator makes it
// (BasicGenerator.wallOre + ErekirPlanetGenerator): every wall cell with an axis neighbour of
// air carries the ore overlay, tile by tile. That makes the contour of a body - including the
// inside of slots - the ore set, exactly what a plasma bore faces on Erekir.
//
// Sets AUTODRILL_FAKE_SCENARIO (walls + wall ore) and AUTODRILL_WALL_SHAPES (name, ore cells,
// tap, output direction per shape).

AUTODRILL_WALL_DEFS = (function(){
    var shapes = [];

    function rect(x0, y0, w, h){
        var out = [];
        for(var x = 0; x < w; x++){
            for(var y = 0; y < h; y++) out.push([x0 + x, y0 + y]);
        }
        return out;
    }

    function add(list, more){
        for(var i = 0; i < more.length; i++) list.push(more[i]);
        return list;
    }

    function has(cells, x, y){
        for(var i = 0; i < cells.length; i++){
            if(cells[i][0] === x && cells[i][1] === y) return true;
        }
        return false;
    }

    /** the generator rule: a wall cell with an axis neighbour of air carries the ore */
    function contour(wallCells){
        var out = [];
        for(var i = 0; i < wallCells.length; i++){
            var x = wallCells[i][0], y = wallCells[i][1];
            if(!has(wallCells, x + 1, y) || !has(wallCells, x - 1, y)
                || !has(wallCells, x, y + 1) || !has(wallCells, x, y - 1)){
                out.push([x, y]);
            }
        }
        return out;
    }

    function shape(name, wallCells, tap, dirName){
        var ore = contour(wallCells);
        shapes.push({name: name, wall: wallCells, ore: ore, tap: tap, dir: dirName});
    }

    // a plain block: the contour runs all the way around
    shape("block-11x15", rect(0, 0, 11, 15), [0, 7], "RIGHT");

    // a flat slab, tapped on its top surface
    shape("slab-15x11", rect(0, 0, 15, 11), [7, 10], "UP");

    // an L: the contour turns the corner
    shape("L-shape", add(rect(0, 0, 11, 11), rect(0, 10, 11, 1)), [0, 5], "RIGHT");

    // a body with two slots open to the west: several west-facing tiles per row
    shape("double-slot", (function(){
        var out = [];
        for(var x = 0; x < 22; x++){
            for(var y = 0; y < 15; y++){
                if(x >= 2 && x <= 5 && ((y >= 4 && y <= 6) || (y >= 9 && y <= 11))) continue;
                out.push([x, y]);
            }
        }
        return out;
    })(), [0, 1], "RIGHT");

    // a comb: prongs and the body between them
    shape("comb", (function(){
        var out = rect(4, 0, 17, 15);
        add(out, rect(0, 0, 4, 3));
        add(out, rect(0, 6, 4, 3));
        add(out, rect(0, 12, 4, 3));
        return out;
    })(), [0, 1], "RIGHT");

    // a speckled contour, the way the noise-thresholded generator really leaves it
    shape("speckled", (function(){
        var body = rect(0, 0, 16, 14);
        var out = [];
        for(var i = 0; i < body.length; i++){
            var x = body[i][0], y = body[i][1];
            out.push([x, y]);
        }
        return out;
    })(), [0, 6], "UP");

    return shapes;
})();

(function(){
    var defs = AUTODRILL_WALL_DEFS;
    var MARGIN = 14;
    var WORLD = 260;
    var POWER_TARGET = {x: 20, y: 2};

    var rowY = MARGIN, rowH = 0, x = MARGIN;
    var wallCells = [];
    var oreCells = [];
    var placed = [];

    // the speckled shape keeps only part of its contour, like the noise threshold does
    defs[defs.length - 1].ore = (function(){
        var all = defs[defs.length - 1].ore;
        var out = [];
        for(var i = 0; i < all.length; i++){
            var v = (all[i][0] * 7 + all[i][1] * 13) % 5;
            if(v === 0 || v === 2) continue;      // roughly half the contour keeps ore
            out.push(all[i]);
        }
        return out;
    })();

    for(var i = 0; i < defs.length; i++){
        var s = defs[i];
        var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
        var all = s.wall.concat(s.ore);
        for(var c = 0; c < all.length; c++){
            minX = Math.min(minX, all[c][0]); maxX = Math.max(maxX, all[c][0]);
            minY = Math.min(minY, all[c][1]); maxY = Math.max(maxY, all[c][1]);
        }
        var w = maxX - minX + 1, h = maxY - minY + 1;
        if(x + w + MARGIN > WORLD){
            x = MARGIN;
            rowY += rowH + MARGIN;
            rowH = 0;
        }
        var ox = x - minX, oy = rowY - minY;

        for(c = 0; c < s.wall.length; c++) wallCells.push([s.wall[c][0] + ox, s.wall[c][1] + oy]);
        var absOre = [];
        for(c = 0; c < s.ore.length; c++){
            var ao = [s.ore[c][0] + ox, s.ore[c][1] + oy];
            absOre.push(ao);
            oreCells.push(ao);
        }

        placed.push({name: s.name, ore: absOre, tap: [s.tap[0] + ox, s.tap[1] + oy], dir: s.dir});
        x += w + MARGIN;
        rowH = Math.max(rowH, h);
    }

    AUTODRILL_FAKE_SCENARIO = {
        world: WORLD,
        wallCells: wallCells,
        wallOreCells: oreCells,
        powerTarget: POWER_TARGET
    };
    AUTODRILL_WALLS = {world: WORLD, shapes: placed, powerTarget: POWER_TARGET};
})();
