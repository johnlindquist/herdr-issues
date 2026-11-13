#!/bin/sh
# The Fence: types, syntax and tests behind one command (`npm run check`).
set -e
cd "$(dirname "$0")"
tsc -p jsconfig.json
tsc -p tsconfig.node.json
tsc -p menu/jsconfig.json
for f in triage.mjs src/*.mjs main.js menu/main.js; do node --check "$f"; done
node --check nav.js
node --check surface.js
node --disable-warning=ExperimentalWarning --test test/*.test.mjs
echo "fence: ok"
