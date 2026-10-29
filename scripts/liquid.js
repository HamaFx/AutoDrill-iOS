// AutoDrill (iOS) - liquid.js
// Fills for the machines whose output comes from the ground's attribute rather than from ore:
// Erekir's vent condenser (steam vents, makes water) and Serpulo's oil extractor (oil ground).
//
// Both are 3x3, both take power, and the oil extractor also needs water piped to it, so the
// fill is more than a drill pattern: it picks the footprints with the most attribute under
// them, powers them, and runs a conduit line to the nearest water for the extractors.
//
// The routing reuses util.findDuctPath (a bounded BFS over tiles a 1x1 block can sit on) and
// util's occupancy helpers, so nothing here can plan an overlap.

"use strict";

var api = require("api");
var util = require("util");

var DEBUG = false;

exports.setDebug = function(value){
    DEBUG = value;
};

function debugLog(msg){
    if(DEBUG){
        api.log("[liquid] " + msg);
        api.trace("[liquid] " + msg);
    }
}

/** Tiles to look at around the tapped one, bounded by `budget`. */
function collectArea(tile, budget){
    var queue = [tile];
    var queueIndex = 0;
    var seen = {};
    var tiles = [];

    seen[api.pos(tile)] = true;

    while(queueIndex < queue.length && tiles.length < budget){
        var current = queue[queueIndex++];
        tiles.push(current);

        for(var dx = -2; dx <= 2; dx += 2){
            for(var dy = -2; dy <= 2; dy += 2){
                if(dx === 0 && dy === 0) continue;
                var neighbour = api.nearby(current, dx, dy);
                if(neighbour == null) continue;

                var key = api.pos(neighbour);
                if(seen[key] === true) continue;
                seen[key] = true;
                queue.push(neighbour);
            }
        }
    }
    return tiles;
}

/**
 * Greedy layout over the attribute: every tile whose footprint holds at least `minSum` of the
 * attribute is a candidate, the richest first, and a candidate is taken when it fits.
 */
function attributeSelection(tiles, block, attributeName, minSum, team){
    var size = api.size(block);
    var offset = Math.floor((size - 1) / 2);
    var candidates = [];
    var i = 0, dx = 0, dy = 0;

    for(i = 0; i < tiles.length; i++){
        var t = tiles[i];
        var x = api.tx(t), y = api.ty(t);
        var sum = 0;

        for(dx = 0; dx < size; dx++){
            for(dy = 0; dy < size; dy++){
                var cell = api.tile(x - offset + dx, y - offset + dy);
                if(cell == null){
                    sum = -1;
                    dx = size;
                    break;
                }
                sum += api.attributeAt(cell, attributeName);
            }
        }
        if(sum < minSum) continue;
        if(!util.canPlaceBlock(block, team, x, y, 0)) continue;

        candidates.push({x: x, y: y, sum: sum});
    }

    util.sortStable(candidates, function(c){
        return -c.sum;
    });

    var occupied = {};
    var selection = [];
    for(i = 0; i < candidates.length; i++){
        var cand = candidates[i];
        var blocked = false;

        for(dx = 0; dx < size && !blocked; dx++){
            for(dy = 0; dy < size; dy++){
                if(occupied[(cand.x - offset + dx) + (cand.y - offset + dy) * api.worldW()] === true){
                    blocked = true;
                    break;
                }
            }
        }
        if(blocked) continue;

        for(dx = 0; dx < size; dx++){
            for(dy = 0; dy < size; dy++){
                occupied[(cand.x - offset + dx) + (cand.y - offset + dy) * api.worldW()] = true;
            }
        }
        selection.push(cand);
    }
    return selection;
}

/** One power block beside every machine, so the machines are not dead blocks. */
function powerFor(selection, team, allPlans, occupied){
    var info = api.powerSupportInfo();
    if(info == null || selection.length === 0) return {blocks: 0};

    var size = api.size(info.block);
    var placed = 0;
    var i = 0, j = 0;

    for(i = 0; i < selection.length; i++){
        var machine = selection[i];
        var around = util.nearbyTiles(machine.x, machine.y, 3, size);

        for(j = 0; j < around.length; j++){
            var x = api.tx(around[j]), y = api.ty(around[j]);
            var plan = util.newPlan(x, y, 0, info.block);
            if(!util.canPlacePlan(plan, team)) continue;
            if(!util.freeInOccupancy(occupied, info.block, x, y)) continue;
            if(machineBlocks(selection, x, y)) continue;

            allPlans.push(plan);
            util.markOccupancy(occupied, info.block, x, y, true);
            placed++;
            break;
        }
    }
    return {blocks: placed};
}

/** True when the tile is inside one of the machines' footprints (so a block cannot sit there). */
function machineBlocks(selection, x, y){
    var size = 3;
    var offset = Math.floor((size - 1) / 2);

    for(var i = 0; i < selection.length; i++){
        if(x >= selection[i].x - offset && x <= selection[i].x - offset + size - 1
            && y >= selection[i].y - offset && y <= selection[i].y - offset + size - 1){
            return true;
        }
    }
    return false;
}

/**
 * Nearest tile of standing water a pump can actually be built on, searched in rings. Tiles that
 * hold water but are already taken are skipped, so the search does not stop on the first guess.
 */
function findWaterTile(centreX, centreY, team, radius, occupied){
    var pump = api.pumpBlock();
    if(pump == null) return null;

    for(var r = 1; r <= radius; r++){
        for(var dx = -r; dx <= r; dx++){
            for(var dy = -r; dy <= r; dy++){
                if(Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;

                var tile = api.tile(centreX + dx, centreY + dy);
                if(tile == null) continue;
                if(!api.pumpsWaterAt(pump, tile.x, tile.y, team)) continue;

                var plan = util.newPlan(tile.x, tile.y, 0, pump);
                if(!util.canPlacePlan(plan, team)) continue;
                if(occupied != null && !util.freeInOccupancy(occupied, pump, tile.x, tile.y)) continue;
                return tile;
            }
        }
    }
    return null;
}

/** Runs conduits from a source to every consumer along BFS paths. Returns how many were laid. */
function routeConduits(team, allPlans, occupied, source, consumers, budget){
    var conduit = api.liquidConduit();
    if(conduit == null) return 0;

    var laid = 0;
    var trunk = [{x: api.tx(source), y: api.ty(source)}];
    var i = 0, j = 0;

    for(i = 0; i < consumers.length && budget > 0; i++){
        var machine = consumers[i];
        var goals = util.nearbyTiles(machine.x, machine.y, 3);

        // closest trunk tile first: pipes share a trunk instead of running one line each
        var path = null;
        for(j = 0; j < trunk.length && path == null; j++){
            var goal = api.tile(trunk[j].x, trunk[j].y);
            if(goal == null) continue;
            path = util.findDuctPath(goal, goals, conduit, team, budget, occupied);
        }
        if(path == null) continue;

        for(j = 0; j < path.length; j++){
            var tile = path[j];
            var plan = util.newPlan(api.tx(tile), api.ty(tile), 0, conduit);
            if(!util.canPlacePlan(plan, team)) continue;
            if(!util.freeInOccupancy(occupied, conduit, plan.x, plan.y)) continue;

            allPlans.push(plan);
            util.markOccupancy(occupied, conduit, plan.x, plan.y, true);
            trunk.push({x: plan.x, y: plan.y});
            laid++;
            budget--;
        }
    }
    return laid;
}

// ---------------------------------------------------------------------------- tools

/**
 * Vent condensers on an Erekir steam vent. The condenser needs a lot of steam under it (its
 * minimum efficiency is 9), so only the vent tiles themselves qualify.
 */
function fillVent(tile, teamOverride){
    var team = teamOverride != null ? teamOverride : api.team();
    var condenser = api.block("ventCondenser");
    if(condenser == null || !api.environmentBuildable(condenser)){
        api.toast("[AutoDrill] vent condensers are not available here");
        return [];
    }
    if(api.attributeAt(tile, "steam") < 0.9){
        api.toast("[AutoDrill] no steam vent under this tile");
        return [];
    }

    var area = collectArea(tile, 60);
    var selection = attributeSelection(area, condenser, "steam", 9, team);
    if(selection.length === 0){
        api.toast("[AutoDrill] no room for a vent condenser here");
        return [];
    }

    var allPlans = [];
    var occupied = {};
    for(var i = 0; i < selection.length; i++){
        var plan = util.newPlan(selection[i].x, selection[i].y, 0, condenser);
        allPlans.push(plan);
        util.markOccupancy(occupied, condenser, plan.x, plan.y, true);
    }

    var power = powerFor(selection, team, allPlans, occupied);

    util.commitPlans(allPlans);
    util.reportRefused("vent condensers");
    api.toast("[AutoDrill] planned " + selection.length + " vent condenser"
        + (selection.length === 1 ? "" : "s")
        + (power.blocks > 0 ? " + " + power.blocks + " power blocks" : "")
        + " - pipe the water where you need it");
    debugLog("vent: condensers=" + selection.length + " power=" + power.blocks);
    return allPlans;
}

/**
 * Oil extractors over oil ground, powered, with a conduit line run from the nearest water:
 * the extractor consumes water to work, so a fill without one would be dead machines.
 */
function fillOil(tile, teamOverride){
    var team = teamOverride != null ? teamOverride : api.team();
    var extractor = api.block("oilExtractor");
    if(extractor == null || !api.environmentBuildable(extractor)){
        api.toast("[AutoDrill] oil extractors are not available here");
        return [];
    }
    if(api.attributeAt(tile, "oil") <= 0){
        api.toast("[AutoDrill] no oil under this tile");
        return [];
    }

    var area = collectArea(tile, 220);
    var selection = attributeSelection(area, extractor, "oil", 1.5, team);
    if(selection.length === 0){
        api.toast("[AutoDrill] no room for an oil extractor here");
        return [];
    }

    var allPlans = [];
    var occupied = {};
    for(var i = 0; i < selection.length; i++){
        var plan = util.newPlan(selection[i].x, selection[i].y, 0, extractor);
        allPlans.push(plan);
        util.markOccupancy(occupied, extractor, plan.x, plan.y, true);
    }

    var power = powerFor(selection, team, allPlans, occupied);

    // water to the extractors: a pump on the nearest water, then a conduit trunk out to them
    var source = findWaterTile(selection[0].x, selection[0].y, team, 60, occupied);
    var pumped = 0;
    var laid = 0;

    if(source != null){
        var pump = api.pumpBlock();
        if(pump != null){
            var pumpPlan = util.newPlan(api.tx(source), api.ty(source), 0, pump);
            if(util.canPlacePlan(pumpPlan, team)
                && util.freeInOccupancy(occupied, pump, pumpPlan.x, pumpPlan.y)){
                allPlans.push(pumpPlan);
                util.markOccupancy(occupied, pump, pumpPlan.x, pumpPlan.y, true);
                pumped = 1;
                laid = routeConduits(team, allPlans, occupied, source, selection, 400);
            }
        }
    }

    util.commitPlans(allPlans);
    util.reportRefused("oil extractors");

    var summary = selection.length + (selection.length === 1 ? " oil extractor" : " oil extractors");
    if(power.blocks > 0) summary += " + " + power.blocks + " power blocks";
    if(pumped > 0) summary += " + 1 water pump + " + laid + " conduits";
    api.toast("[AutoDrill] planned " + summary
        + (pumped === 0 ? " - no water in reach, feed them or they will not run" : ""));
    debugLog("oil: extractors=" + selection.length + " power=" + power.blocks
        + " pump=" + pumped + " conduits=" + laid);
    return allPlans;
}

exports.fillVent = fillVent;
exports.fillOil = fillOil;
