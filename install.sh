#!/bin/sh
# Copies the Issues widget (mod folder "triage") and its right-click menu ("triage-menu") into the
# Herdr app's mods folder (default ~/.config/herdr-app, or $HERDR_APP_HOME), checks them, and binds
# Command I to "focus Issues" when that key is free. Run it again after a `git pull` to update.
set -e
src="$(cd "$(dirname "$0")" && pwd)"
home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
mods="$home/mods"
for tool in herdr-app node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "install: $tool was not found on your PATH. See Requirements in the README." >&2; exit 1; }
done
mkdir -p "$mods/triage/icons" "$mods/triage/src" "$mods/triage-menu"
cp "$src"/main.js "$src"/nav.js "$src"/surface.js "$src"/triage.mjs "$src"/mod.json "$src"/rules.md "$mods/triage/"
cp "$src"/src/*.mjs "$mods/triage/src/"
cp "$src"/icons/*.svg "$mods/triage/icons/"
cp "$src"/menu/main.js "$src"/menu/mod.json "$mods/triage-menu/"
herdr-app check "$mods/triage"
herdr-app check "$mods/triage-menu"

# Command I. Herdr keeps every key in keys.json; add ours only when the file exists and the key is free.
node - "$home/keys.json" <<'NODE'
const fs = require("node:fs");
const file = process.argv[2];
const line = '"cmd-i": "triage.focus"';
if (!fs.existsSync(file)) {
  console.log(`keys: ${file} does not exist yet. Open Herdr once, then run ./install.sh again to bind Command I (or add ${line} under "global" yourself).`);
  process.exit(0);
}
let keys;
try {
  keys = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (e) {
  console.log(`keys: could not read ${file} (${e.message}). Add ${line} under "global" yourself.`);
  process.exit(0);
}
const global = (keys.global ??= {});
const now = global["cmd-i"];
const action = typeof now === "string" ? now : now?.command;
if (action === "triage.focus") console.log("keys: Command I already focuses Issues.");
else if (now !== undefined) console.log(`keys: Command I is already bound to ${JSON.stringify(now)} and was left alone. To use it for Issues, set ${line} under "global" in ${file}.`);
else {
  fs.copyFileSync(file, `${file}.before-issues`);
  keys.global = { "cmd-i": "triage.focus", ...global };
  fs.writeFileSync(file, JSON.stringify(keys, null, 2) + "\n");
  console.log(`keys: Command I now focuses Issues (previous keys saved as ${file}.before-issues).`);
}
NODE
echo "Installed. Issues docks on the right of the Herdr window; open a project folder in a space to fill it."
