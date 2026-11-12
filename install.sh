#!/bin/sh
# Copies the Triage mod and its right-click menu into the Herdr app's mods folder
# (default ~/.config/herdr-app, or $HERDR_APP_HOME) and checks them.
set -e
src="$(cd "$(dirname "$0")" && pwd)"
mods="${HERDR_APP_HOME:-$HOME/.config/herdr-app}/mods"
mkdir -p "$mods/triage/icons" "$mods/triage/src" "$mods/triage-menu"
cp "$src"/main.js "$src"/nav.js "$src"/triage.mjs "$src"/mod.json "$mods/triage/"
cp "$src"/src/*.mjs "$mods/triage/src/"
cp "$src"/icons/*.svg "$mods/triage/icons/"
cp "$src"/menu/main.js "$src"/menu/mod.json "$mods/triage-menu/"
herdr-app check "$mods/triage"
herdr-app check "$mods/triage-menu"
