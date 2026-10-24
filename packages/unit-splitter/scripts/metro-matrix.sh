#!/bin/sh
# Run the full test suite against another Metro version WITHOUT a second node_modules in the repo.
# Usage: scripts/metro-matrix.sh 0.87.1 [/some/tmp/dir]
# Copies packages/unit-splitter + examples/demo-app (sources only) to a temp tree, installs the requested
# metro/metro-config/metro-runtime there (exact versions), and runs `npm test` in the copy.
# Use an absolute node on PATH (nvm shells: `sh` has no nvm).
set -eu
V="${1:?metro version, e.g. 0.87.1}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
T="${2:-$(mktemp -d)}"
mkdir -p "$T/packages/unit-splitter" "$T/examples/demo-app"
for d in src test harness scripts package.json; do cp -R "$HERE/$d" "$T/packages/unit-splitter/"; done
for d in src units.config.json package.json; do cp -R "$REPO/examples/demo-app/$d" "$T/examples/demo-app/"; done
(cd "$T/examples/demo-app" && npm install --no-audit --no-fund --save-exact "metro-runtime@$V" >/dev/null)
(cd "$T/packages/unit-splitter" && npm install --no-audit --no-fund --save-exact "metro@$V" "metro-config@$V" "metro-runtime@$V" >/dev/null && npm test)
echo "matrix tree kept at $T"
