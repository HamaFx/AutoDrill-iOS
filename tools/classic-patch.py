#!/usr/bin/env python3
"""Applies the classic build's three edits to a copy of the repository.

Used by tools/pack.sh --classic (staged zip tree) and tools/classic-tag.sh (release tag
tree). The repository itself always stays in standard mode."""

import pathlib
import sys


def sub_once(path, old, new):
    text = path.read_text()
    if old not in text:
        sys.exit("classic-patch: pattern not found in %s: %r" % (path, old))
    path.write_text(text.replace(old, new, 1))


def main():
    if len(sys.argv) != 2:
        sys.exit("usage: classic-patch.py <repo copy>")

    root = pathlib.Path(sys.argv[1])

    # the build switch: the classic package ships the original mod's drill defaults
    sub_once(root / "scripts/classic-defaults.js", "exports.on = false;", "exports.on = true;")

    # the mod list should say which of the two builds is installed
    sub_once(root / "mod.hjson",
             'displayName: "AutoDrill (iOS)"',
             'displayName: "AutoDrill (iOS) Classic"')
    sub_once(root / "mod.hjson",
             'description: "Adds tools',
             "description: \"Classic build: ships the original mod's drill defaults. Adds tools")


if __name__ == "__main__":
    main()
