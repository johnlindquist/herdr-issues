#!/bin/sh
# The Fence: types, syntax and tests behind one command (`npm run check`).
set -e
cd "$(dirname "$0")"
PATH="$PWD/node_modules/.bin:$PATH" # tsc comes from `npm install`
tsc -p jsconfig.json
tsc -p tsconfig.node.json
tsc -p menu/jsconfig.json
for f in triage.mjs src/*.mjs main.js menu/main.js; do node --check "$f"; done
node --check nav.js
node --check frame.js
node --check surface.js
# The tests never read your own settings file.
HERDR_ISSUES_CONFIG=/nonexistent/herdr-issues.json node --disable-warning=ExperimentalWarning --test test/*.test.mjs
echo "fence: ok"
