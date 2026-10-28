#!/bin/bash
# Runs the placement engine against a fake world - no game needed, seconds per run.
# Use this when the engine misbehaves: it is the fastest way to see what it does.
set -euo pipefail
cd "$(dirname "$0")/.."

MINDUSTRY_JAR="${MINDUSTRY_JAR:-/tmp/opencode/libs/Mindustry.jar}"
RHINO_JAR="${RHINO_JAR:-/tmp/opencode/rhino.jar}"
RHINO_COMMIT=32395f942976a6d1d21ec9877664554cd5762306
STAGE=/tmp/opencode/autodrill-engine-probe

[ -f "$MINDUSTRY_JAR" ] || { echo "missing $MINDUSTRY_JAR (see tools/ios-mode-check.sh)"; exit 1; }
[ -f "$RHINO_JAR" ] || curl -sL -o "$RHINO_JAR" "https://jitpack.io/com/github/Anuken/rhino/$RHINO_COMMIT/rhino-$RHINO_COMMIT.jar"
[ -f tests/harness/global.js ] || ./tools/ios-mode-check.sh >/dev/null
[ -f tests/build/ScriptHarness.class ] || javac -cp "$MINDUSTRY_JAR:$RHINO_JAR" -d tests/build tests/harness/ScriptHarness.java

rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -r scripts "$STAGE/scripts"
cp tests/js/engine-probe.js "$STAGE/scripts/main.js"

java -Xmx256m -cp "$MINDUSTRY_JAR:$RHINO_JAR:tests/build" ScriptHarness "$STAGE" tests/js/prescript.js tests/harness/global.js
