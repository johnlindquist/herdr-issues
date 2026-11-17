// Settings: the one home of what can be configured and what a valid value is. The file reader,
// `config set`, the environment and `describe` all go through KEYS and checkValue().
//
// Where a value comes from, weakest first:
//   default < user file < project file < saved on this machine < environment < command-line flag
//   user file     ~/.config/herdr-issues/config.json (or the path in HERDR_ISSUES_CONFIG)
//   project file  <project>/.herdr/issues.json
//   saved         what `config --model …` (the older form) stored for one project in the state folder
// One key does not follow that order: `conversations` (reading this project's past Pi conversations)
// is on by default and OFF WINS: "off" in any layer turns it off, whatever a stronger layer says, so
// a shared project file can never switch back on what a person switched off.
// An unknown key or a bad value is reported as a problem and skipped; a file that is not JSON is a
// problem too, and the weaker layers (in the end the defaults) are used.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const GATHERER_NAMES = ["code", "history", "github", "packages", "conversations"];
export const SOURCE_NAMES = ["local", "github"];
export const INSTRUCTION_NAMES = ["never-overstate", "baseline"];
export const GATHER_INSTRUCTION_NAMES = ["baseline", "evidence-only", "absence-is-a-question"];

/** A comma list or an array of known names, kept as a comma list. */
const names = (allowed) => (v) => {
  const list = (Array.isArray(v) ? v : String(v).split(",")).map((s) => String(s).trim()).filter(Boolean);
  if (!list.length) return { error: `needs at least one of ${allowed.join(", ")}` };
  const bad = list.filter((n) => !allowed.includes(n));
  if (bad.length) return { error: `unknown name ${bad.join(", ")} (use ${allowed.join(", ")})` };
  return { value: [...new Set(list)].join(",") };
};
const oneOf = (allowed) => (v) => (allowed.includes(String(v)) ? { value: String(v) } : { error: `must be one of ${allowed.join(", ")}` });
const whole = (min, max) => (v) => {
  const n = typeof v === "number" ? v : /^\d+$/.test(String(v).trim()) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? { value: n } : { error: `must be a whole number from ${min} to ${max}` };
};
/** on or off, as people write it (on/off, true/false, yes/no, 1/0). */
const ON_WORDS = ["on", "true", "yes", "1"];
const OFF_WORDS = ["off", "false", "no", "0"];
const onOff = (v) => {
  const s = String(v).trim().toLowerCase();
  return ON_WORDS.includes(s) ? { value: "on" } : OFF_WORDS.includes(s) ? { value: "off" } : { error: "must be on or off" };
};
const text = (pattern, hint) => (v) => (typeof v === "string" && pattern.test(v.trim()) ? { value: v.trim() } : { error: hint });

/**
 * Every setting: its type (for people and agents), default, the environment variable that
 * overrides it, the older flag and saved name it also answers to, and its check.
 * @type {Record<string, { type: string, default: any, env: string, flag: string, about: string, check: (v: any) => { value?: any, error?: string } }>}
 */
export const KEYS = {
  model: { type: "provider/id", default: "anthropic/claude-haiku-4-5", env: "TRIAGE_MODEL", flag: "model", about: "The small model that judges what is pressing, plans the gatherers and writes the brief. `pi --list-models` lists ids", check: text(/^[\w.-]+\/[\w.:@-]+$/, "must look like provider/id, for example anthropic/claude-haiku-4-5") },
  thinking: { type: "off | low | medium | high", default: "off", env: "TRIAGE_THINKING", flag: "thinking", about: "How much the model thinks before it answers (passed to Pi). More is slower and costs more", check: oneOf(["off", "low", "medium", "high"]) },
  refreshSeconds: { type: "whole number, 30 to 86400", default: 120, env: "TRIAGE_REFRESH_SECONDS", flag: "refresh-seconds", about: "How often the widget reads the sources again. The model is asked only when an issue changed", check: whole(30, 86400) },
  sources: { type: "local | github | local,github", default: null, env: "TRIAGE_SOURCE", flag: "source", about: "Where issues come from. Default: the project's own inbox and board when it has them, else GitHub issues", check: names(SOURCE_NAMES) },
  repo: { type: "owner/name", default: null, env: "TRIAGE_REPO", flag: "repo", about: "The GitHub repository to read and search. Default: the project's origin remote", check: text(/^[\w.-]+\/[\w.-]+$/, "must look like owner/name") },
  maxPressing: { type: "whole number, 1 to 10", default: 5, env: "TRIAGE_MAX_PRESSING", flag: "max-pressing", about: "The most issues listed under Most pressing", check: whole(1, 10) },
  gatherers: { type: `comma list of ${GATHERER_NAMES.join(", ")}`, default: null, env: "TRIAGE_GATHERERS", flag: "gatherers", about: "Which gatherers the planner may start. Default: all of them (past conversations too, unless `conversations` is off)", check: names(GATHERER_NAMES) },
  conversations: { type: "on | off", default: "on", env: "TRIAGE_CONVERSATIONS", flag: "conversations", about: "Whether the Past conversations gatherer may read this project's earlier Pi conversations (only sessions started in this project; only what the person and the assistant wrote; redacted before any model, cache, receipt or prompt). Off wins: off in any file, saved for the project, in the environment or on the command line turns it off", check: onOff },
  gatherSeconds: { type: "whole number, 5 to 120", default: 20, env: "TRIAGE_GATHER_SECONDS", flag: "gather-seconds", about: "How long one gatherer may take before it is shown as timed out", check: whole(5, 120) },
  rulesFile: { type: "path", default: null, env: "TRIAGE_RULES", flag: "rules", about: "The rules file sent with every hand-off; a relative path starts at the project. Default: <project>/issues-rules.md, else the widget's rules.md", check: text(/\S/, "must be a path") },
  instruction: { type: INSTRUCTION_NAMES.join(" | "), default: "never-overstate", env: "TRIAGE_INSTRUCTION", flag: "instruction", about: "The instructions the judging model gets. baseline is the original, kept to show the difference", check: oneOf(INSTRUCTION_NAMES) },
  tagsFile: { type: "path", default: "support-tags.jsonl", env: "TRIAGE_TAGS_FILE", flag: "tags-file", about: "The file a project's ticket sorter writes: one line per support ticket with its owner, whether it is about money and whether the sorter was unsure. A relative path starts at the project. When the file is not there, Issues shows no owners and no waiting group", check: text(/\S/, "must be a path") },
  draftsFolder: { type: "path", default: "drafts-out", env: "TRIAGE_DRAFTS_FOLDER", flag: "drafts-folder", about: "The folder a project's drafter writes: drafts.jsonl holds one reply per ticket that waits for a person. A relative path starts at the project. When the folder is not there, Issues shows no drafts. Issues never sends a draft", check: text(/\S/, "must be a path") },
  gatherInstruction: { type: GATHER_INSTRUCTION_NAMES.join(" | "), default: "evidence-only", env: "TRIAGE_GATHER_INSTRUCTION", flag: "gather-instruction", about: "The instructions the brief-writing model gets", check: oneOf(GATHER_INSTRUCTION_NAMES) },
};

export const LAYERS = ["default", "user file", "project file", "saved", "environment", "flag"];

/** One value, checked. @returns {{ value?: any, error?: string }} */
export function checkValue(key, raw) {
  const k = KEYS[key];
  if (!k) return { error: `unknown setting "${key}" (settings are ${Object.keys(KEYS).join(", ")})` };
  if (raw === null || raw === undefined) return { error: `${key} needs a value` };
  const r = k.check(raw);
  return r.error ? { error: `${key} ${r.error} (got ${JSON.stringify(raw)})` } : r;
}

/** A whole object, checked: the values that are fine, and one problem per key that is not. */
export function checkObject(obj, where) {
  /** @type {Record<string, any>} */
  const values = {};
  /** @type {string[]} */
  const problems = [];
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return { values, problems: [`${where}: must hold one JSON object`] };
  for (const [key, raw] of Object.entries(obj)) {
    const r = checkValue(key, raw);
    if (r.error) problems.push(`${where}: ${r.error}`);
    else values[key] = r.value;
  }
  return { values, problems };
}

export const userFile = (env = process.env) => env.HERDR_ISSUES_CONFIG || path.join(os.homedir(), ".config/herdr-issues/config.json");
export const projectFile = (root) => path.join(root, ".herdr/issues.json");

/** A settings file, read and checked. A missing file is no values and no problem; a broken one is a named problem. */
export function readFile(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return { file, exists: false, broken: false, values: {}, problems: [] };
  }
  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (/** @type {any} */ e) {
    return { file, exists: true, broken: true, values: {}, problems: [`${file}: not valid JSON (${String(e.message).slice(0, 80)}); it is ignored`] };
  }
  const r = checkObject(obj, file);
  return { file, exists: true, broken: r.problems.some((p) => p.endsWith("must hold one JSON object")), ...r };
}

/**
 * The effective settings and where each came from. Pure: every layer is handed in.
 * `saved` uses the older names (source, rules, gather-instruction); `flags` too. A bad flag is the caller's usage error.
 * @param {{ user?: Record<string, any>, project?: Record<string, any>, saved?: Record<string, any>, env?: Record<string, string|undefined>, flags?: Record<string, any>, problems?: string[] }} o
 */
export function resolve({ user = {}, project = {}, saved = {}, env = {}, flags = {}, problems = [] }) {
  /** @type {Record<string, any>} */
  const values = {};
  /** @type {Record<string, string>} */
  const from = {};
  const all = [...problems];
  /** @type {string[]} */
  const flagErrors = [];
  for (const [key, k] of Object.entries(KEYS)) {
    values[key] = k.default;
    from[key] = "default";
    const take = (raw, layer, where, errors = all) => {
      if (raw === undefined || raw === null || raw === true || raw === "") return;
      const r = checkValue(key, raw);
      if (r.error) return void errors.push(`${where}: ${r.error}`);
      values[key] = r.value;
      from[key] = layer;
    };
    if (key in user) ((values[key] = user[key]), (from[key] = "user file"));
    if (key in project) ((values[key] = project[key]), (from[key] = "project file"));
    take(saved[k.flag] ?? saved[key], "saved", "saved for this project");
    take(env[k.env], "environment", `environment ${k.env}`);
    take(flags[k.flag], "flag", `--${k.flag}`, flagErrors);
  }
  // Past conversations: off wins. Any layer that says off (or says something that is not on or off:
  // it fails closed) turns reading off; `from` names the strongest layer that did.
  const isOff = (raw) => raw !== undefined && raw !== null && raw !== true && raw !== "" && checkValue("conversations", raw).value !== "on";
  const k = KEYS.conversations;
  const off = [["user file", user.conversations], ["project file", project.conversations], ["saved", saved[k.flag]], ["environment", env[k.env]], ["flag", flags[k.flag]]].filter(([, raw]) => isOff(raw));
  if (off.length) ((values.conversations = "off"), (from.conversations = /** @type {string} */ (off[off.length - 1][0])));
  return { values, from, problems: all, flagErrors };
}

/** `config set`: check, then write one key into a settings file, keeping the others. Refuses to touch a broken file. */
export function setInFile(file, key, raw) {
  const r = checkValue(key, raw);
  if (r.error) throw Object.assign(new Error(r.error), { code: "INVALID" });
  const obj = readObjectForWrite(file);
  obj[key] = r.value;
  writeObject(file, obj);
  return r.value;
}

/** `config unset`: remove one key from a settings file. */
export function unsetInFile(file, key) {
  if (!KEYS[key]) throw Object.assign(new Error(checkValue(key, "x").error), { code: "INVALID" });
  if (!fs.existsSync(file)) return false;
  const obj = readObjectForWrite(file);
  if (!(key in obj)) return false;
  delete obj[key];
  writeObject(file, obj);
  return true;
}

function readObjectForWrite(file) {
  if (!fs.existsSync(file)) return {};
  try {
    const obj = JSON.parse(fs.readFileSync(file, "utf8"));
    if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj;
  } catch {}
  throw Object.assign(new Error(`${file} is not valid JSON; fix or delete it first (nothing was written)`), { code: "CONFIG_BROKEN" });
}

function writeObject(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/** What `describe` lists: every key with its type, default, meaning and environment variable. */
export function describeKeys() {
  return Object.fromEntries(Object.entries(KEYS).map(([key, k]) => [key, { type: k.type, default: k.default, about: k.about, environment: k.env }]));
}
