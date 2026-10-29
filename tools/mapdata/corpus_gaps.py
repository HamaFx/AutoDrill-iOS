#!/usr/bin/env python3
"""Turn the corpus probe's classified left tiles + the teacher labels into the committed
gap report (docs/AUDIT-CORPUS-GAPS.md).

    tools/corpus-probe.sh --json /tmp/corpus.json
    python3 tools/mapdata/corpus_gaps.py /tmp/corpus.json \
        tests/js/fixtures/corpus/teacher.json > docs/AUDIT-CORPUS-GAPS.md

The probe already assigned every left tile a cause using the engine's own rules (candidate
set, reserved tiles, occupancy) - Python must not re-implement those rules, so this tool only
aggregates the classes the probe assigned, cross-checks them, and ranks the patches.

Classes (Support OFF run; `left = unreachable + freeAnchor + blockedByPlans + reserved + foreignOre`):

    freeAnchor     - a candidate that mines the tile fits the layout untouched: an engine bug
    blockedByPlans - every such candidate overlaps a placed plan (drills/power)
    reserved       - held free for a power block or a belt lane (Support ON only)
    foreignOre     - a legal placement covers it but would mine a different item
    unreachable    - no legal placement covers it at all (walls/buildings)
    beltTransport  - belt side: a drill fits the patch but the belt layout has its ground

Exit code is non-zero when freeAnchor > 0 anywhere, when the classes do not partition the
left tiles, or when the probe's engine coverage disagrees with the teacher's - those are
engine bugs / nondeterminism, not report cosmetics. The report is printed either way.
"""
import argparse
import datetime
import json
import os
import re
import subprocess
import sys

CLASSES = ("unreachable", "freeAnchor", "blockedByPlans", "reserved", "foreignOre")
BELT_CLASSES = ("freeAnchor", "beltTransport", "blocked", "unreachable")


def load_jsonl(path):
    patches = []
    with open(path, encoding="utf-8", errors="replace") as fh:
        for lineno, line in enumerate(fh, 1):
            line = line.strip()
            if not line.startswith("{"):
                continue
            try:
                patches.append(json.loads(line))
            except json.JSONDecodeError as exc:
                raise SystemExit(f"{path}:{lineno}: not JSON: {exc}")
    return patches


def load_teacher(path):
    if path is None or not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def baseline_hash(teacher_path):
    if teacher_path is None:
        return "unknown"
    baseline = os.path.join(os.path.dirname(os.path.abspath(teacher_path)), "baseline.txt")
    if not os.path.exists(baseline):
        return "unknown"
    with open(baseline, encoding="utf-8") as fh:
        for line in fh:
            if line.startswith("CORPUS-SUMMARY"):
                m = re.search(r"hash=(0x[0-9a-f]+)", line)
                if m:
                    return m.group(1)
    return "unknown"


def git_commit():
    try:
        out = subprocess.run(["git", "rev-parse", "--short", "HEAD"], capture_output=True,
                             text=True, check=True)
        return out.stdout.strip()
    except Exception:
        return "unknown"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("jsonl", help="corpus-probe --json output")
    ap.add_argument("teacher", nargs="?", default=None, help="teacher.json (optional)")
    args = ap.parse_args()

    patches = load_jsonl(args.jsonl)
    teacher = load_teacher(args.teacher)
    if not patches:
        raise SystemExit("no patches in the JSON dump")

    problems = []
    rows = []
    agg = {c: 0 for c in CLASSES}
    belt_agg = {c: 0 for c in BELT_CLASSES}
    support_reserved = 0

    for p in patches:
        name = p["name"]
        counts = p["counts"]
        left = counts["left"]
        parts = {c: counts.get(c, 0) for c in CLASSES}
        total = sum(parts.values())
        if total != left:
            problems.append(f"{name}: classes sum to {total}, left={left}")
        for c in CLASSES:
            agg[c] += parts[c]

        belt = p.get("belt", {}).get("counts", {})
        bleft = belt.get("left", 0)
        bsum = sum(belt.get(c, 0) for c in BELT_CLASSES)
        if bsum != bleft:
            problems.append(f"{name}: belt classes sum to {bsum}, left={bleft}")
        for c in BELT_CLASSES:
            belt_agg[c] += belt.get(c, 0)

        support = p["counts"].get("supportReserved", 0)
        support_reserved += support

        entry = teacher.get(name, {})
        engine = p["engine"]["covered"]
        t_engine = entry.get("engine")
        if t_engine is not None and t_engine != engine:
            problems.append(f"{name}: probe engine={engine} != teacher engine={t_engine}")

        if counts["freeAnchor"] > 0:
            problems.append(f"{name}: freeAnchor={counts['freeAnchor']} (engine bug by definition)")

        rows.append({
            "name": name, "left": left, "parts": parts,
            "beltLeft": bleft, "belt": {c: belt.get(c, 0) for c in BELT_CLASSES},
            "supportReserved": support,
            "engine": engine, "opt": entry.get("opt"), "gap": entry.get("gap"),
            "solver": entry.get("solver"),
        })

    print("# Corpus Gap Audit")
    print()
    print(f"Date: {datetime.date.today().isoformat()} · Commit: {git_commit()} · "
          f"Corpus: {len(patches)} patches · Baseline: {baseline_hash(args.teacher)}")
    print()
    print("Generated by `python3 tools/mapdata/corpus_gaps.py`; classified inside the probe "
          "(tests/js/corpus-probe.js `--json`), so these are the engine's own rules, not a "
          "re-implementation. Left-tile classes per patch: "
          "`unreachable + freeAnchor + blockedByPlans + reserved + foreignOre = left`.")
    print()
    print("## Per patch")
    print()
    for r in rows:
        print(f"GAP {r['name']} left={r['left']} freeAnchor={r['parts']['freeAnchor']} "
              f"blocked={r['parts']['blockedByPlans']} reserved={r['parts']['reserved']} "
              f"beltTransport={r['belt']['beltTransport']} foreign={r['parts']['foreignOre']} "
              f"unreachable={r['parts']['unreachable']} engine={r['engine']} "
              f"opt={r['opt']} gap={r['gap']}")

    print()
    print("## Aggregate by class (Support OFF run)")
    print()
    print("| class | tiles |")
    print("|---|---|")
    for c in CLASSES:
        print(f"| {c} | {agg[c]} |")
    print(f"| belt left total | {sum(r['beltLeft'] for r in rows)} |")
    print()
    print("Belt side (best direction per patch): "
          + ", ".join(f"{c}={belt_agg[c]}" for c in BELT_CLASSES)
          + f", left={sum(r['beltLeft'] for r in rows)}")
    print(f"Support ON: reserved tiles={support_reserved}")
    print()

    def top(key, count=20, positive=True):
        ranked = sorted(rows, key=lambda r: (-key(r), r["name"]))
        ranked = [r for r in ranked if not positive or key(r) > 0]
        return ranked[:count]

    print("## Top 20 patches by freeAnchor (engine bugs)")
    print()
    for r in top(lambda r: r["parts"]["freeAnchor"]):
        print(f"- {r['name']}: freeAnchor={r['parts']['freeAnchor']} left={r['left']}")
    print()
    print("## Top 20 patches by blockedByPlans")
    print()
    for r in top(lambda r: r["parts"]["blockedByPlans"]):
        print(f"- {r['name']}: blocked={r['parts']['blockedByPlans']} left={r['left']} "
              f"freeAnchor={r['parts']['freeAnchor']}")
    print()
    print("## Top 20 patches by beltTransport")
    print()
    for r in top(lambda r: r["belt"]["beltTransport"]):
        print(f"- {r['name']}: beltTransport={r['belt']['beltTransport']} "
              f"beltLeft={r['beltLeft']} freeAnchor={r['belt']['freeAnchor']}")
    print()
    print("## Worklist (teacher gap > 0, ranked)")
    print()
    for r in top(lambda r: r["gap"] if r["gap"] and r["gap"] > 0 else 0):
        print(f"- {r['name']}: gap={r['gap']} engine={r['engine']} opt={r['opt']} "
              f"solver={r['solver']} freeAnchor={r['parts']['freeAnchor']} "
              f"blocked={r['parts']['blockedByPlans']} reserved={r['parts']['reserved']}")
    print()
    print("## Checks")
    print()
    if problems:
        for p in problems:
            print(f"GAP-FAIL {p}")
        print()
        print(f"{len(problems)} problem(s) - see GAP-FAIL above")
    else:
        print("all classes partition the left tiles; probe engine matches the teacher; "
              "freeAnchor=0 across the corpus")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
