// Shape battery for the vein probe (dev tool). Evaluated as tests/js/scenario.js by
// tools/vein-probe.sh, exactly like the coverage probe's scenario: it sets
// AUTODRILL_FAKE_SCENARIO (the world the fake api builds) and AUTODRILL_VEINS (the shapes the
// probe itself will tap and measure).
//
// The point is thin, irregular and awkward ore shapes - veins with one-tile steps, branches,
// tendrils on blobs, rings, combs, and veins beside walls - because those are where a layout
// heuristic can leave ore behind, and where "raise Optimization Quality" may not help.

AUTODRILL_VEIN_DEFS = (function(){
    var shapes = [];
    var WALL_RECT = null;
    var BUILT = [];

    function addCells(list, more){
        for(var i = 0; i < more.length; i++) list.push(more[i]);
        return list;
    }

    function line(x, y, n, dx, dy){
        var out = [];
        for(var i = 0; i < n; i++) out.push([x + i * dx, y + i * dy]);
        return out;
    }

    function rect(x0, y0, w, h){
        var out = [];
        for(var x = 0; x < w; x++){
            for(var y = 0; y < h; y++) out.push([x0 + x, y0 + y]);
        }
        return out;
    }

    function dedupe(cells){
        var seen = {};
        var out = [];
        for(var i = 0; i < cells.length; i++){
            var k = cells[i][0] + "," + cells[i][1];
            if(seen[k] === true) continue;
            seen[k] = true;
            out.push(cells[i]);
        }
        return out;
    }

    function shape(name, cells, drill){
        shapes.push({name: name, cells: dedupe(cells), drill: drill == null ? "laserDrill" : drill});
    }

    function zigzag(rx, ry, turns){
        var out = [];
        var x = 0, y = 0;
        for(var t = 0; t < turns; t++){
            addCells(out, line(x, y, rx, 1, 0)); x += rx;
            addCells(out, line(x, y, ry, 0, 1)); y += ry;
        }
        return out;
    }

    function ring(w, h){
        var out = [];
        for(var x = 0; x < w; x++){ out.push([x, 0]); out.push([x, h - 1]); }
        for(var y = 1; y < h - 1; y++){ out.push([0, y]); out.push([w - 1, y]); }
        return out;
    }

    function comb(len, pitch, tooth){
        var out = line(0, 0, len, 1, 0);
        for(var x = 0; x < len; x += pitch){
            addCells(out, line(x, 1, tooth, 0, 1));
        }
        return out;
    }

    function spiral(turns){
        // 1-wide spiral: a ccw rectangle walk that steps one cell out at each corner
        var out = [];
        var x = 0, y = 0, dx = 1, dy = 0;
        var steps = 5;
        for(var t = 0; t < turns * 4; t++){
            addCells(out, line(x, y, steps, dx, dy));
            x += (steps - 1) * dx;
            y += (steps - 1) * dy;
            var nx = -dy, ny = dx;
            dx = nx; dy = ny;
            if(t % 4 === 3) steps += 2;
        }
        return dedupe(out);
    }

    function blobTendril(w, h, tx, ty, len, dx, dy){
        var out = rect(0, 0, w, h);
        addCells(out, line(tx, ty, len, dx, dy));
        return out;
    }

    function drunkard(seed, steps, turns){
        // deterministic drunkard's-walk vein: the classic shape with branches, steps and
        // self-touching arms that map authors draw by hand
        var out = [];
        var x = 0, y = 0;
        var s = seed | 0;
        var dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];

        addCells(out, [[0, 0]]);
        for(var i = 0; i < steps; i++){
            s = (s * 1103515245 + 12345) & 0x7fffffff;
            var d = (s >> 8) % 4;
            x += dirs[d][0];
            y += dirs[d][1];
            addCells(out, [[x, y]]);
            if(i % turns === turns - 1){
                s = (s * 1103515245 + 12345) & 0x7fffffff;
                var e = (s >> 8) % 4;
                addCells(out, [[x + dirs[e][0], y + dirs[e][1]]]);
            }
        }
        return dedupe(out);
    }

    // ---- 1-wide thin veins ----

    shape("h24", line(0, 0, 24, 1, 0));
    shape("h40", line(0, 0, 40, 1, 0));
    shape("h17", line(0, 0, 17, 1, 0));
    shape("v24", line(0, 0, 24, 0, 1));
    shape("d1-24", line(0, 0, 24, 1, 1));
    shape("ramp2-24", (function(){ var o = []; for(var i = 0; i < 24; i++) o.push([i, Math.floor(i / 2)]); return o; })());
    shape("ramp3-30", (function(){ var o = []; for(var i = 0; i < 30; i++) o.push([i, Math.floor(i / 3)]); return o; })());
    shape("ramp1-5-24", (function(){ var o = []; for(var i = 0; i < 24; i++) o.push([i, Math.floor(i * 2 / 3)]); return o; })());
    shape("jog1", addCells(line(0, 0, 12, 1, 0), line(12, 1, 12, 1, 0)));
    shape("jog2", addCells(addCells(line(0, 0, 8, 1, 0), line(8, 1, 8, 1, 0)), line(16, 2, 8, 1, 0)));
    shape("wobble", (function(){
        var o = [];
        var ys = [0, 1, 0, -1, 0, 1];
        for(var g = 0; g < 6; g++){
            for(var i = 0; i < 4; i++) o.push([g * 4 + i, ys[g]]);
        }
        return o;
    })());
    shape("bump", addCells(line(0, 0, 24, 1, 0), [[5, 1]]));
    shape("zig22", zigzag(2, 2, 8));
    shape("zig33", zigzag(3, 3, 7));
    shape("zig14", zigzag(1, 4, 8));
    shape("zig41", zigzag(4, 1, 8));
    shape("L12", addCells(line(0, 0, 12, 1, 0), line(11, 1, 12, 0, 1)));
    shape("Z12-6-12", addCells(addCells(line(0, 0, 12, 1, 0), line(11, 1, 7, 0, 1)), line(11, 7, 12, 1, 0)));
    shape("T", addCells(line(-5, 7, 11, 1, 0), line(0, 0, 15, 0, 1)));
    shape("plus", addCells(line(-5, 5, 11, 1, 0), line(0, 0, 11, 0, 1)));
    shape("U", addCells(addCells(line(0, 0, 11, 1, 0), line(0, 1, 9, 0, 1)), line(10, 1, 9, 0, 1)));
    shape("ring11", ring(11, 11));
    shape("comb", comb(21, 4, 5));
    shape("saw1", (function(){ var o = []; for(var i = 0; i < 24; i++) o.push([i, i % 2]); return o; })());
    shape("saw2", (function(){ var o = []; for(var i = 0; i < 24; i++) o.push([i, (i >> 1) % 2]); return o; })());
    shape("spiral", spiral(3));
    shape("Y", addCells(addCells(line(0, 0, 9, 0, 1), line(0, 0, 9, 1, 0)), line(0, 0, 9, 1, 1)));

    // ---- blobs with tendrils (the classic "one arm left behind" shape) ----

    shape("blob7+E", blobTendril(7, 7, 6, 3, 11, 1, 0));
    shape("blob7+N", blobTendril(7, 7, 3, 6, 11, 0, 1));
    shape("blob7+W", blobTendril(7, 7, 0, 3, 11, -1, 0));
    shape("blob7+S", blobTendril(7, 7, 3, 0, 11, 0, -1));
    shape("blob7+diag", blobTendril(7, 7, 6, 6, 11, 1, 1));
    shape("blob7+E-row0", blobTendril(7, 7, 6, 0, 11, 1, 0));
    shape("blob7+E-row1", blobTendril(7, 7, 6, 1, 11, 1, 0));
    shape("blob7+E-row2", blobTendril(7, 7, 6, 2, 11, 1, 0));
    shape("blob7+4arms", (function(){
        var o = rect(0, 0, 7, 7);
        addCells(o, line(6, 3, 9, 1, 0));
        addCells(o, line(0, 3, 9, -1, 0));
        addCells(o, line(3, 6, 9, 0, 1));
        addCells(o, line(3, 0, 9, 0, -1));
        return o;
    })());

    // ---- pockets, holes and parallel veins ----

    shape("stripe-band", (function(){
        // the shape sweep's "diagonal band": 2-wide diagonal stripes with period 9 in a 35x35
        // box (it keeps everything below the diagonal, so it is a triangle with a striped rim)
        var o = [];
        for(var i = 0; i < 35; i++){
            for(var j = 0; j < 35; j++){
                var r = j - i;
                if(r % 9 > 1 && r % 9 < 9) continue;
                o.push([i, j]);
            }
        }
        return o;
    })());
    shape("pocket", (function(){
        var o = line(0, 0, 24, 1, 0);
        addCells(o, rect(10, 1, 4, 4));
        return o;
    })());
    shape("parallel2", (function(){
        var o = addCells(line(0, 0, 18, 1, 0), line(0, 2, 18, 1, 0));
        addCells(o, [[17, 1], [0, 1]]);
        return o;
    })());
    shape("frame3", ring(13, 13));

    // ---- thick shapes with awkward rims ----

    shape("w2-h20", rect(0, 0, 20, 2));
    shape("w3-h20", rect(0, 0, 20, 3));
    shape("w4-h20", rect(0, 0, 20, 4));
    shape("d2w2", (function(){
        var o = [];
        for(var i = 0; i < 18; i++){ o.push([i, i]); o.push([i, i + 1]); }
        return o;
    })());
    shape("d2w3", (function(){
        var o = [];
        for(var i = 0; i < 16; i++){ o.push([i, i]); o.push([i, i + 1]); o.push([i, i + 2]); }
        return o;
    })());
    shape("band3", (function(){
        var o = [];
        for(var x = 0; x < 21; x++){
            for(var y = 0; y < 3; y++) o.push([x, x + y]);
        }
        return o;
    })());
    shape("notch", (function(){
        var o = rect(0, 0, 13, 13);
        var drop = rect(0, 0, 6, 6);
        for(var i = 0; i < drop.length; i++){
            for(var k = 0; k < o.length; k++){
                if(o[k][0] === drop[i][0] && o[k][1] === drop[i][1]){ o.splice(k, 1); break; }
            }
        }
        return o;
    })());

    // ---- drunkard's-walk veins (realistic irregular shapes) ----

    var WALK_N = 0;
    var walkEnv = java.lang.System.getenv("AUTODRILL_VEIN_WALKS");
    if(walkEnv != null && walkEnv.length > 0) WALK_N = parseInt(walkEnv, 10);

    if(WALK_N > 0){
        // a large battery of random walks (deterministic seeds) to measure how often a shape
        // is left partly uncovered, instead of hand-picking shapes
        for(var wi = 0; wi < WALK_N; wi++){
            var seed = 101 + wi * 7919;
            var steps = 40 + (wi * 37) % 81;            // 40 .. 120 cells
            var turns = 6 + (wi % 6);
            shape("walk" + wi, drunkard(seed, steps, turns));
        }
    }else{
        shape("walk-a", drunkard(11, 60, 9));
        shape("walk-b", drunkard(29, 60, 9));
        shape("walk-c", drunkard(47, 80, 7));
        shape("walk-d", drunkard(83, 80, 7));
        shape("walk-e", drunkard(131, 100, 11));
        shape("walk-f", drunkard(197, 100, 11));
    }

    return {shapes: shapes, wallRect: WALL_RECT, built: BUILT};
})();

(function(){
    var defs = AUTODRILL_VEIN_DEFS;
    var MARGIN = 14;
    var walkEnv2 = java.lang.System.getenv("AUTODRILL_VEIN_WALKS");
    var walkCount = (walkEnv2 != null && walkEnv2.length > 0) ? parseInt(walkEnv2, 10) : 0;
    var WORLD = walkCount > 0 ? Math.max(640, Math.ceil(Math.sqrt(walkCount) * 110)) : 640;

    // optional global shift: the same shape at a different map position must fill the same way
    var shiftEnv = java.lang.System.getenv("AUTODRILL_VEIN_SHIFT");
    var SHIFT = (shiftEnv != null && shiftEnv.length > 0) ? parseInt(shiftEnv, 10) : 0;
    if(SHIFT !== 0){
        MARGIN += SHIFT;
    }

    // lay the shapes out in a grid of slots, so every fill sees only its own patch
    var rowY = MARGIN;
    var rowH = 0;
    var x = MARGIN;
    var patches = [];
    var placed = [];

    for(var i = 0; i < defs.shapes.length; i++){
        var s = defs.shapes[i];
        var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
        for(var c = 0; c < s.cells.length; c++){
            minX = Math.min(minX, s.cells[c][0]);
            minY = Math.min(minY, s.cells[c][1]);
            maxX = Math.max(maxX, s.cells[c][0]);
            maxY = Math.max(maxY, s.cells[c][1]);
        }
        var w = maxX - minX + 1, h = maxY - minY + 1;

        if(x + w + MARGIN > WORLD){
            x = MARGIN;
            rowY += rowH + MARGIN;
            rowH = 0;
        }

        var ox = x - minX, oy = rowY - minY;
        var abs = [];
        var tapsumX = 0, tapsumY = 0;
        for(c = 0; c < s.cells.length; c++){
            var ax = s.cells[c][0] + ox, ay = s.cells[c][1] + oy;
            abs.push([ax, ay]);
            patches.push({oreX0: ax, oreY0: ay, x1: ax, y1: ay});
            tapsumX += ax; tapsumY += ay;
        }

        // tap the ore cell nearest the shape's centroid (always a real ore tile)
        var cx = tapsumX / abs.length, cy = tapsumY / abs.length;
        var tap = abs[0], tapD = 1e9;
        for(c = 0; c < abs.length; c++){
            var d = (abs[c][0] - cx) * (abs[c][0] - cx) + (abs[c][1] - cy) * (abs[c][1] - cy);
            if(d < tapD){ tapD = d; tap = abs[c]; }
        }

        placed.push({name: s.name, drill: s.drill, cells: abs, tap: [tap[0], tap[1]]});
        x += w + MARGIN;
        rowH = Math.max(rowH, h);
    }

    AUTODRILL_FAKE_SCENARIO = {
        world: WORLD,
        patches: patches,
        wallRect: defs.wallRect
    };
    AUTODRILL_VEINS = {world: WORLD, shapes: placed, built: defs.built};
})();
