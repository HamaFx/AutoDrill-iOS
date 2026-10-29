#!/usr/bin/env python3
"""Exact optimum for a vein-probe instance: maximise the ore tiles mined by a set of
non-overlapping drill placements.

Reads the VEIN-CELL / VEIN-CAND / VEIN-ENGINE dump that tests/js/vein-probe.js prints for every
partial shape and solves it as an integer program with CBC (PuLP):

    maximise   sum(covered tiles)
    s.t.       covered[t] <= sum(candidates mining t)
               candidate[a] + candidate[b] <= 1        for every overlapping pair

so the answer is the true optimum under the engine's own rules (candidate set, min ores,
footprint validity) - the number the layout heuristic is trying to reach.

Run:  uv run --with 'pulp==2.9.0' tools/vein-solve.py probe-output.txt [shape]
"""

import sys
from collections import defaultdict

import pulp


def parse(path):
    instances = {}
    summaries = {}
    current = None
    for line in open(path, encoding="utf-8", errors="replace"):
        if not line.startswith("VEIN"):
            continue
        parts = line.split()
        if parts[0] == "VEIN-INSTANCE":
            current = {
                "name": parts[1],
                "minOres": int([p for p in parts if p.startswith("minOres=")][0].split("=")[1]),
                "world": int([p for p in parts if p.startswith("world=")][0].split("=")[1]),
                "cells": set(),
                "cands": [],
                "engine": [],
                "engine_covered": None,
                "total": None,
            }
            instances[current["name"]] = current
        elif parts[0] == "VEIN-CELL" and current is not None:
            current["cells"].add((int(parts[1]), int(parts[2])))
        elif parts[0] == "VEIN-CAND" and current is not None:
            x, y = int(parts[1]), int(parts[2])
            foot = [int(v) for v in parts[4].split(",")] if parts[4] != "" else []
            mine = [int(v) for v in parts[6].split(",")] if len(parts) > 6 and parts[6] != "" else []
            current["cands"].append({"x": x, "y": y, "foot": set(foot), "mine": set(mine)})
        elif parts[0] == "VEIN-ENGINE" and current is not None:
            current["engine"].append((int(parts[1]), int(parts[2])))
        elif parts[0] == "VEIN" and "shape=" in line and "covered=" in line and "mode=" not in line:
            # the probe's summary line: the instance dump follows it, so remember it aside
            name = [p for p in parts if p.startswith("shape=")][0].split("=")[1]
            covered = int([p for p in parts if p.startswith("covered=")][0].split("=")[1])
            summaries[name] = covered

    for name, covered in summaries.items():
        if name in instances:
            instances[name]["engine_covered"] = covered

    return instances


def solve(inst):
    cands = inst["cands"]
    cells = inst["cells"]

    # footprint key -> list of candidates that occupy it, to build the conflict graph
    bycell = defaultdict(list)
    for i, c in enumerate(cands):
        for k in c["foot"]:
            bycell[k].append(i)

    prob = pulp.LpProblem("vein_" + inst["name"], pulp.LpMaximize)
    use = [pulp.LpVariable(f"c{i}", cat="Binary") for i in range(len(cands))]
    cover = {t: pulp.LpVariable(f"t{t[0]}_{t[1]}", cat="Binary") for t in cells}

    # y_t can only be 1 when some chosen candidate mines t
    for t in cells:
        mining = [use[i] for i, c in enumerate(cands) if t[0] + t[1] * inst["world"] in c["mine"]]
        if mining:
            prob += cover[t] <= pulp.lpSum(mining)
        else:
            prob += cover[t] == 0

    # no two chosen candidates may overlap
    for k, ids in bycell.items():
        for a in range(len(ids)):
            for b in range(a + 1, len(ids)):
                prob += use[ids[a]] + use[ids[b]] <= 1

    prob += pulp.lpSum(cover.values())
    prob.solve(pulp.PULP_CBC_CMD(msg=0))

    chosen = [i for i, v in enumerate(use) if v.value() and v.value() > 0.5]
    covered = {t for t in cells if cover[t].value() and cover[t].value() > 0.5}
    return {
        "status": pulp.LpStatus[prob.status],
        "opt": int(round(pulp.value(prob.objective))),
        "chosen": chosen,
        "covered": covered,
    }


def main():
    path = sys.argv[1]
    only = sys.argv[2] if len(sys.argv) > 2 else None
    instances = parse(path)

    for name, inst in instances.items():
        if only and only not in name:
            continue
        total = len(inst["cells"])
        if total == 0:
            continue
        res = solve(inst)
        engine = inst["engine_covered"] if inst["engine_covered"] is not None else -1
        left_engine = total - engine if engine >= 0 else -1
        left_opt = total - res["opt"]

        print(f"SOLVE {name}: engine={engine}/{total} (left {left_engine})  "
              f"optimum={res['opt']}/{total} (left {left_opt})  status={res['status']}")

        if engine >= 0 and res["opt"] > engine:
            engine_set = set(inst["engine"])
            chosen = set((inst["cands"][i]["x"], inst["cands"][i]["y"]) for i in res["chosen"])
            removed = sorted(engine_set - chosen)
            added = sorted(chosen - engine_set)
            print(f"      engine is suboptimal by {res['opt'] - engine}: "
                  f"drop {removed} add {added}")
        if left_opt > 0:
            # tiles the optimum itself cannot cover (unreachable for every candidate)
            unreachable = sorted(t for t in inst["cells"] if not any(
                t[0] + t[1] * inst["world"] in c["mine"] for c in inst["cands"]))
            if unreachable:
                print(f"      unreachable tiles (no candidate): {unreachable}")
            else:
                print("      optimum leaves tiles for layout reasons (parity/geometry)")


if __name__ == "__main__":
    main()
