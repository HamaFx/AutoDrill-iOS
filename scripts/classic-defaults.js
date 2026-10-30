// Build switch for the "classic" package (tools/pack.sh --classic): match the Java AutoDrill
// defaults instead of this port's coverage-first ones.
//
//   classic (the real mod):  mechanical 200 / 1, pneumatic 150 / 2, laser 100 / 5,
//                            airblast 100 / 9, max-tiles ranged 25..500 step 25
//   port default:            all drills 5000 max tiles; min ores 1 / 1 / 2 / 2
//
// With the switch on, the port's extra settings (layout variation, belt lanes, output routing)
// are hidden from the settings page and never read by the engine.
//
// The repo copy is OFF - only the packaged classic zip flips it. The engine reads the table,
// so one build switch changes the shipped defaults, the fallbacks and the settings sliders.
"use strict";

exports.on = true;
