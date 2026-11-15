// Settings: the order of the layers, an unknown key, a broken file, `config set`, and what the widget says.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { KEYS, resolve, checkValue, checkObject, readFile, setInFile, describeKeys } from "../src/settings.mjs";
import { systemFor, parseSummary } from "../src/triage.mjs";
import { modelLabel, modelTip, settingsProblemLine, refreshMs } from "../surface.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, "..", "triage.mjs");
const FAKE = JSON.stringify(["node", path.join(here, "fake-model.mjs")]);
const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `issues-${name}-`));

/** A project with a board, its own state folder and its own user settings file. */
function sandbox() {
  const root = tmp("project");
  fs.mkdirSync(path.join(root, "tracker"));
  fs.copyFileSync(path.join(here, "fixtures/project/tracker/board.json"), path.join(root, "tracker/board.json"));
  const user = path.join(tmp("user"), "config.json");
  const env = { TRIAGE_STATE: tmp("state"), HERDR_ISSUES_CONFIG: user, TRIAGE_MODEL_CMD: FAKE };
  const cli = (argv, extra = {}) => {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("TRIAGE_")));
    const r = spawnSync("node", ["--disable-warning=ExperimentalWarning", CLI, ...argv, "--root", root], { encoding: "utf8", env: { ...clean, ...env, ...extra } });
    return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr ? JSON.parse(r.stderr.trim().split("\n").pop()) : null };
  };
  return { root, user, project: path.join(root, ".herdr/issues.json"), cli };
}

test("order: default < user file < project file < saved < environment < flag, and each value says where it came from", () => {
  const all = { user: { model: "a/user" }, project: { model: "a/project" }, saved: { model: "a/saved" }, env: { TRIAGE_MODEL: "a/env" }, flags: { model: "a/flag" } };
  const at = (o) => {
    const r = resolve(o);
    return [r.values.model, r.from.model];
  };
  assert.deepEqual(at({}), [KEYS.model.default, "default"]);
  assert.deepEqual(at({ user: all.user }), ["a/user", "user file"]);
  assert.deepEqual(at({ user: all.user, project: all.project }), ["a/project", "project file"]);
  assert.deepEqual(at({ user: all.user, project: all.project, saved: all.saved }), ["a/saved", "saved"]);
  assert.deepEqual(at({ ...all, flags: {} }), ["a/env", "environment"]);
  assert.deepEqual(at(all), ["a/flag", "flag"]);
  // A layer that says nothing about a key leaves the weaker layer's value.
  const mixed = resolve({ user: { model: "a/user", maxPressing: 3 }, project: { maxPressing: 2 } });
  assert.deepEqual([mixed.values.model, mixed.values.maxPressing, mixed.from.maxPressing], ["a/user", 2, "project file"]);
});

test("the older names still work: saved source and rules, and every TRIAGE_ variable", () => {
  const r = resolve({ saved: { source: "github", rules: "my-rules.md", "gather-instruction": "baseline" }, env: { TRIAGE_INSTRUCTION: "baseline", TRIAGE_GATHERERS: "code,history", TRIAGE_REPO: "o/r" } });
  assert.deepEqual([r.values.sources, r.values.rulesFile, r.values.gatherInstruction, r.values.instruction, r.values.gatherers, r.values.repo], ["github", "my-rules.md", "baseline", "baseline", "code,history", "o/r"]);
  assert.deepEqual(r.problems, []);
});

test("an unknown key and a bad value are reported and skipped; the rest of the file still counts", () => {
  const r = checkObject({ model: "anthropic/claude-sonnet-4-6", modle: "x", maxPressing: 99, thinking: "extreme", gatherers: ["code", "nope"] }, "file.json");
  assert.deepEqual(r.values, { model: "anthropic/claude-sonnet-4-6" });
  assert.equal(r.problems.length, 4);
  assert.match(r.problems[0], /file\.json: unknown setting "modle"/);
  assert.match(r.problems.join("\n"), /maxPressing must be a whole number from 1 to 10 \(got 99\)/);
  // Past conversations: a key like the others, on by default, and off wins whatever a stronger layer says.
  assert.deepEqual([checkValue("conversations", "on"), checkValue("conversations", false), checkValue("conversations", "OFF")], [{ value: "on" }, { value: "off" }, { value: "off" }]);
  assert.match(checkValue("conversations", "sometimes").error, /must be on or off/);
  assert.deepEqual([resolve({}).values.conversations, resolve({}).from.conversations], ["on", "default"]);
  const offWins = resolve({ user: { conversations: "off" }, project: { conversations: "on" }, saved: { conversations: "on" }, env: { TRIAGE_CONVERSATIONS: "on" }, flags: { conversations: "on" } });
  assert.deepEqual([offWins.values.conversations, offWins.from.conversations], ["off", "user file"], "a shared project file cannot switch back on what the person switched off");
  assert.deepEqual(resolve({ project: { conversations: "off" }, env: { TRIAGE_CONVERSATIONS: "off" } }).from.conversations, "environment", "the strongest layer that says off is named");
  assert.equal(resolve({ env: { TRIAGE_CONVERSATIONS: "nope" } }).values.conversations, "off", "a value that is neither fails closed");
  assert.deepEqual(checkValue("gatherers", ["code", "history"]), { value: "code,history" });
  assert.deepEqual(checkValue("refreshSeconds", "300"), { value: 300 });
  // A bad value in the environment is a problem, not a crash, and the weaker layer stays.
  const env = resolve({ user: { thinking: "low" }, env: { TRIAGE_THINKING: "max" } });
  assert.deepEqual([env.values.thinking, env.from.thinking], ["low", "user file"]);
  assert.match(env.problems[0], /environment TRIAGE_THINKING: thinking must be one of/);
  // A bad flag is the caller's usage error.
  assert.equal(resolve({ flags: { instruction: "nope" } }).flagErrors.length, 1);
});

test("a broken file is a named problem and the defaults are used; a missing file is no problem", () => {
  const dir = tmp("files");
  const broken = path.join(dir, "broken.json");
  fs.writeFileSync(broken, '{ "model": "a/b", ');
  const b = readFile(broken);
  assert.equal(b.broken, true);
  assert.deepEqual(b.values, {});
  assert.match(b.problems[0], /broken\.json: not valid JSON/);
  assert.deepEqual(readFile(path.join(dir, "none.json")), { file: path.join(dir, "none.json"), exists: false, broken: false, values: {}, problems: [] });
  assert.throws(() => setInFile(broken, "model", "a/c"), { code: "CONFIG_BROKEN" });
  assert.equal(fs.readFileSync(broken, "utf8"), '{ "model": "a/b", ', "a broken file is never overwritten");
});

test("describe lists every key with type, default, meaning and its environment variable", () => {
  const d = describeKeys();
  assert.deepEqual(Object.keys(d).slice(0, 3), ["model", "thinking", "refreshSeconds"], "the same first keys in every widget");
  for (const k of Object.keys(KEYS)) assert.ok(d[k].type && d[k].about && d[k].environment && "default" in d[k], k);
});

test("CLI: config shows where each value came from; config set validates and writes; the project file wins; the environment wins over both", () => {
  const s = sandbox();
  let r = s.cli(["config"]);
  assert.equal(r.code, 0);
  assert.deepEqual(r.out.settings.model, { value: KEYS.model.default, from: "default" });
  assert.deepEqual(r.out.files, { user: s.user, project: s.project });
  assert.deepEqual(s.cli(["config", "path"]).out, { user: s.user, project: s.project, user_exists: false, project_exists: false });

  r = s.cli(["config", "set", "model", "anthropic/claude-sonnet-4-6"]);
  assert.deepEqual([r.out.value, r.out.file, r.out.effective.from], ["anthropic/claude-sonnet-4-6", s.user, "user file"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(s.user, "utf8")), { model: "anthropic/claude-sonnet-4-6" });
  r = s.cli(["config", "set", "maxPressing", "3"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(s.user, "utf8")), { model: "anthropic/claude-sonnet-4-6", maxPressing: 3 }, "the other keys are kept; a number is stored as a number");

  r = s.cli(["config", "set", "model", "anthropic/claude-opus-4-8", "--project"]);
  assert.equal(r.out.file, s.project);
  assert.deepEqual(s.cli(["config"]).out.settings.model, { value: "anthropic/claude-opus-4-8", from: "project file" });
  assert.deepEqual(s.cli(["config"], { TRIAGE_MODEL: "anthropic/claude-haiku-4-5" }).out.settings.model, { value: "anthropic/claude-haiku-4-5", from: "environment" });
  assert.equal(s.cli(["show"]).out.settings.model_from, "project file");

  r = s.cli(["config", "unset", "model", "--project"]);
  assert.equal(r.out.removed, true);
  assert.deepEqual(s.cli(["config"]).out.settings.model, { value: "anthropic/claude-sonnet-4-6", from: "user file" });

  // Nothing invalid is ever written.
  r = s.cli(["config", "set", "modle", "x"]);
  assert.deepEqual([r.code, r.err.error.code], [1, "INVALID"]);
  assert.match(r.err.error.message, /unknown setting "modle"/);
  r = s.cli(["config", "set", "thinking", "extreme"]);
  assert.equal(r.err.error.code, "INVALID");
  assert.deepEqual(JSON.parse(fs.readFileSync(s.user, "utf8")), { model: "anthropic/claude-sonnet-4-6", maxPressing: 3 });
});

test("CLI: an unknown key or a broken file is shown, the widget keeps working on the defaults, and the older config --model still saves", () => {
  const s = sandbox();
  fs.writeFileSync(s.user, JSON.stringify({ modle: "x", maxPressing: 2 }));
  let r = s.cli(["refresh"]);
  assert.equal(r.code, 0);
  assert.equal(r.out.state, "ready");
  assert.match(r.out.settings.problems[0], /unknown setting "modle"/);
  assert.ok(r.out.pressing.length <= 2, "maxPressing from the file is in force");

  fs.writeFileSync(s.user, "{ not json");
  r = s.cli(["show"]);
  assert.equal(r.code, 0);
  assert.equal(r.out.model, KEYS.model.default);
  assert.match(r.out.settings.problems[0], /not valid JSON/);
  assert.equal(s.cli(["config", "set", "model", "a/b"]).err.error.code, "CONFIG_BROKEN");

  fs.rmSync(s.user);
  r = s.cli(["config", "--model", "anthropic/claude-sonnet-4-5"]);
  assert.deepEqual(r.out.settings.model, { value: "anthropic/claude-sonnet-4-5", from: "saved" });
  assert.equal(r.out.config.model, "anthropic/claude-sonnet-4-5");
  assert.equal(fs.existsSync(s.project), false, "the older form never writes into the project");
});

test("CLI: a failed model call names the model and says how to change it", () => {
  const s = sandbox();
  const r = s.cli(["refresh"], { TRIAGE_MODEL_CMD: JSON.stringify(["node", "-e", "process.stderr.write('no such model');process.exit(2)"]) });
  assert.equal(r.out.state, "failed");
  assert.match(r.out.error.message, /no such model\. Model anthropic\/claude-haiku-4-5 \(default\)\. To use another: node triage\.mjs config set model <provider\/id>/);
});

test("maxPressing reaches the instructions and the check of the reply", () => {
  assert.match(systemFor("never-overstate"), /\(at most 5\)/);
  assert.match(systemFor("never-overstate", 3), /\(at most 3\)/);
  const groups = [1, 2, 3].map((n) => ({ id: `t-${n}`, hash: "h", members: [{ id: `t-${n}`, title: `T${n}` }] }));
  const reply = JSON.stringify({ headline: "h", pressing: groups.map((g) => ({ ids: [g.id], title: "t", why: "w" })) });
  assert.equal(parseSummary(reply, /** @type {any} */ (groups), 2).pressing.length, 2);
  assert.equal(parseSummary(reply, /** @type {any} */ (groups)).pressing.length, 3);
});

test("the widget shows the model, where it came from, how to change it, and a settings problem", () => {
  const doc = { model: "anthropic/claude-haiku-4-5", settings: { model_from: "user file", thinking: "off", refreshSeconds: 300, problems: [] } };
  assert.equal(modelLabel(doc), "haiku-4-5");
  assert.equal(modelLabel({ ...doc, settings: { ...doc.settings, thinking: "low" } }), "haiku-4-5 · thinking low");
  assert.equal(modelTip(doc), "Model: anthropic/claude-haiku-4-5 (user file)\nChange it: node triage.mjs config set model <provider/id>");
  assert.equal(settingsProblemLine(doc), null);
  assert.equal(settingsProblemLine({ settings: { problems: ["a.json: not valid JSON", "b"] } }), "Settings: a.json: not valid JSON (and 1 more: run config). The default is used instead.");
  assert.equal(refreshMs(doc), 300_000);
  assert.equal(refreshMs(null), 120_000);
});
