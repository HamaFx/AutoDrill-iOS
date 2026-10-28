// AutoDrill (iOS) - direction.js
// Plain-JS replacement for the Java Direction enum. Pure data, no Java access.
//
// Directions are identified by their rotation index `r` (0=right, 1=up, 2=left,
// 3=down) - never by object identity, because a script mod's modules can be
// instantiated more than once and then hold different objects for the same direction.

"use strict";

var RIGHT = {x: 1, y: 0, r: 0};
var UP = {x: 0, y: 1, r: 1};
var LEFT = {x: -1, y: 0, r: 2};
var DOWN = {x: 0, y: -1, r: 3};

var ALL = [RIGHT, UP, LEFT, DOWN];

exports.RIGHT = RIGHT;
exports.UP = UP;
exports.LEFT = LEFT;
exports.DOWN = DOWN;
exports.all = ALL;

/** Java: Direction.getOpposite - by value, so foreign direction objects work too. */
exports.opposite = function(direction){
    return ALL[(direction.r + 2) % 4];
};

/** Java: direction.primaryAxis(p) = p.x * this.x + p.y * this.y */
exports.primary = function(direction, x, y){
    return x * direction.x + y * direction.y;
};

/** Java: direction.secondaryAxis(p) = p.x * this.y + p.y * this.x */
exports.secondary = function(direction, x, y){
    return x * direction.y + y * direction.x;
};
