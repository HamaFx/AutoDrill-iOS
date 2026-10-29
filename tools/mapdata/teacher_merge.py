#!/usr/bin/env python3
"""Merge the offline teacher's labels into tests/js/fixtures/corpus/teacher.json.

Inputs (all produced by the corpus probe; see tools/mapdata/README.md):

    tools/corpus-probe.sh --dump-candidates > /tmp/corpus-cands.txt
    uv run --with 'pulp==2.9.0' tools/vein-solve.py /tmp/corpus-cands.txt > /tmp/corpus-opt.txt
    tools/corpus-probe.sh --teacher > /tmp/corpus-beltref.txt

    python3 tools/mapdata/teacher_merge.py /tmp/corpus-opt.txt \
        tests/js/fixtures/corpus/teacher.json \
        --classes /tmp/corpus-cands.txt --belt /tmp/corpus-beltref.txt

Every patch gets:

    {"solver": "pulp:optimal" | "reference",
     "status": "Optimal" | "UpperBound",
     "opt": <int>, "engine": <int>, "gap": <opt - engine>,
     "beltRef": <int>, "beltEngine": <int>, "beltGap": <beltRef - beltEngine>,
     "unreachable": <int|null>}

* pulp rows are the exact ILP optimum under the engine's own candidate set (Support OFF,
  laser drill) - `opt >= engine` always, and `unreachable` is the solver's count of cells no
  candidate can mine.
* patches over the ILP candidate cap get a `reference` row instead: the randomised restarts
  packer's best - an upper bound on what packing can reach, never called "the optimum".
* `beltRef` is the same packer for the belt tool (mechanical, min ores 1); `beltEngine` is the
  belt tool's own best-of-four-directions coverage. The packer ignores transport, so
  `beltRef >= beltEngine` is expected but both are reported as measured.

The tool also prints the worklist: every patch with gap > 0 or beltGap > 0, ranked by gap.
"""
import argparse
import json
import re
import sys

SOLVE_RE = re.compile(
    r"^SOLVE (\S+): engine=(-?\d+)/(\d+) \(left -?\d+\)\s+optimum=(\d+)/(\d+) \(left \d+\)\s+status=(\w+)")
UNREACHABLE_RE = re.compile(r"unreachable tiles \(no candidate\)")
REF_RE = re.compile(r"^VEIN-REF (\S+) ref=(\d+) engine=(\d+) total=(\d+) drill=(\S+)")
BELT_RE = re.compile(r"^BELT-REF (\S+) ref=(\d+)/(\d+) engine=(\d+)")


def parse_solve(path):
    """name -> {status, opt, total, engine, unreachable}"""
    rows = {}
    current = None
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            line = line.rstrip("\n")
            m = SOLVE_RE.match(line.strip())
            if m:
                name = m.group(1)
                current = {
                    "status": m.group(6),
                    "opt": int(m.group(4)),
                    "total": int(m.group(5)),
                    "engine": int(m.group(2)),
                    "unreachable": 0,
                }
                rows[name] = current
                continue
            if current is not None and UNREACHABLE_RE.search(line):
                # "[(x, y), (x, y)]" - one "(" per tile plus the phrase's own "(no candidate)"
                current["unreachable"] = line.count("(") - 1
                continue
    for row in rows.values():
        if row["engine"] < 0:
            raise SystemExit(f"solver output has engine=-1 for a patch ({row}) - "
                             "was the candidate dump piped through the probe?")
    return rows


def parse_refs(path):
    refs = {}
    if path is None:
        return refs
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            m = REF_RE.match(line.rstrip("\n"))
            if m:
                refs[m.group(1)] = {"ref": int(m.group(2)), "engine": int(m.group(3)),
                                    "total": int(m.group(4))}
    return refs


def parse_belt(path):
    belts = {}
    if path is None:
        return belts
    with open(path, encoding="utf-8", errors="replace") as fh:
        for line in fh:
            m = BELT_RE.match(line.rstrip("\n"))
            if m:
                belts[m.group(1)] = {"ref": int(m.group(2)), "total": int(m.group(3)),
                                     "engine": int(m.group(4))}
    return belts


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("solve", help="tools/vein-solve.py output")
    ap.add_argument("out", help="teacher.json to write")
    ap.add_argument("--classes", default=None,
                    help="corpus-probe --dump-candidates output (reference labels for big patches)")
    ap.add_argument("--belt", default=None,
                    help="corpus-probe --teacher output (BELT-REF lines)")
    args = ap.parse_args()

    solved = parse_solve(args.solve)
    refs = parse_refs(args.classes)
    belts = parse_belt(args.belt)

    teacher = {}
    for name, row in solved.items():
        entry = {
            "solver": "pulp:optimal",
            "status": row["status"],
            "opt": row["opt"],
            "engine": row["engine"],
            "gap": row["opt"] - row["engine"],
            "unreachable": row["unreachable"],
        }
        teacher[name] = entry
    for name, row in refs.items():
        if name in teacher:
            continue
        entry = {
            "solver": "reference",
            "status": "UpperBound",
            "opt": row["ref"],
            "engine": row["engine"],
            "gap": row["ref"] - row["engine"],
            "unreachable": None,
        }
        teacher[name] = entry

    if not teacher:
        raise SystemExit("no labels at all: check the solver output")

    missing_belt = 0
    for name, belt in belts.items():
        entry = teacher.setdefault(name, {"solver": "missing", "status": "missing",
                                          "opt": None, "engine": None, "gap": None,
                                          "unreachable": None})
        entry["beltEngine"] = belt["engine"]
        entry["beltRef"] = belt["ref"]
        entry["beltGap"] = belt["ref"] - belt["engine"]
    for name, entry in teacher.items():
        if "beltRef" not in entry:
            missing_belt += 1
            entry["beltEngine"] = None
            entry["beltRef"] = None
            entry["beltGap"] = None

    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(teacher, fh, indent=1, sort_keys=True)
        fh.write("\n")

    by_solver = {}
    for entry in teacher.values():
        by_solver[entry["solver"]] = by_solver.get(entry["solver"], 0) + 1
    opt_gap = sum(e["gap"] for e in teacher.values() if e["gap"] and e["gap"] > 0)
    belt_gap = sum(e["beltGap"] for e in teacher.values() if e["beltGap"] and e["beltGap"] > 0)
    print(f"teacher: {len(teacher)} patches  " + " ".join(f"{k}={v}" for k, v in sorted(by_solver.items())))
    print(f"  optimizer gap sum={opt_gap}  belt gap sum={belt_gap}"
          + (f"  ({missing_belt} patches without belt labels - pass --belt)" if missing_belt else ""))

    # the worklist: everything the engine is short of its label on
    work = []
    for name, entry in teacher.items():
        if entry["gap"] is None:
            continue
        rank = (entry["gap"] or 0) + max(0, entry["beltGap"] or 0)
        if rank > 0:
            work.append((rank, name, entry))
    work.sort(key=lambda w: (-w[0], w[1]))
    print(f"worklist: {len(work)} patches with a gap > 0")
    for rank, name, entry in work:
        print(f"  WORK {name} rank={rank} gap={entry['gap']} opt={entry['opt']} engine={entry['engine']}"
              f" beltGap={entry['beltGap']} beltRef={entry['beltRef']} beltEngine={entry['beltEngine']}"
              f" solver={entry['solver']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
