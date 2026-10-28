#!/usr/bin/env python3
"""Fails if any script declares a top-level name that Mindustry's global.js already
declares as const/let/function.

Rhino evaluates script-mod files in a scope chained to that global script, so a
declaration like `const ClientLoadEvent = ...` or `var log = ...` is a hard
"redeclaration" error at load time - on every platform, and most visibly on iOS where the
whole mod silently fails. This check catches it statically.

Usage: tools/check-global-collisions.py <global.js> <file-or-dir> [<file-or-dir> ...]
"""

import re
import sys
from pathlib import Path

DECL = re.compile(r'^\s*(?:const|let|var|function)\s+([A-Za-z_$][A-Za-z0-9_$]*)', re.M)


def declared_names(path: Path) -> set[str]:
    """Names declared by global.js that a module must not redeclare."""
    text = path.read_text(errors="replace")
    names = set()
    for match in DECL.finditer(text):
        name = match.group(1)
        # only lexical bindings / functions collide; plain assignments do not
        line = match.group(0).strip()
        if line.startswith(("const", "let", "function")):
            names.add(name)
    return names


def script_files(targets: list[str]) -> list[Path]:
    files = []
    for target in targets:
        p = Path(target)
        if p.is_dir():
            files.extend(sorted(p.rglob("*.js")))
        elif p.suffix == ".js":
            files.append(p)
    return files


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__)
        return 2

    globals_path, *targets = sys.argv[1:]
    reserved = declared_names(Path(globals_path))
    if not reserved:
        print(f"could not read {globals_path}")
        return 2

    failures = []
    for path in script_files(targets):
        for match in DECL.finditer(path.read_text(errors="replace")):
            name = match.group(1)
            line = match.group(0).strip()
            if not line.startswith(("const", "let", "var", "function")):
                continue
            if name in reserved:
                line_no = path.read_text(errors="replace")[: match.start()].count("\n") + 1
                failures.append(f"{path}:{line_no}: '{name}' collides with global.js")

    if failures:
        print("global-name collisions (these throw at load time):")
        for failure in failures:
            print("  " + failure)
        return 1

    print(f"no global-name collisions in {len(script_files(targets))} files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
