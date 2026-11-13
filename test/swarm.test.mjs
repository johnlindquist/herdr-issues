// Contract tests for the planner and the swarm: the plan is checked by code; a failed or slow
// gatherer never blocks; a line that cites nothing code fetched is dropped; past conversations are
// this project's only, text only, redacted, read-only, and can be turned off; the prompt's order.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { GATHERERS, validatePlan, planSystem, runSwarm, parseFindings, swarmText, availableGatherers, sessionsDirFor, sessionTexts, redact, fetchConversations, COST_CAP_USD, SWARM_LIMITS } from "../src/gatherers.mjs";
import { assemblePrompt } from "../src/handoff.mjs";
import { progressLines, rowStatusLines, gathererLine, briefViewLines, costLine } from "../surface.js";

const here = path.dirname(new URL(import.meta.url).pathname);
const CLI = path.join(here, "..", "triage.mjs");
const FAKE = JSON.stringify(["node", path.join(here, "fake-model.mjs")]);
const FAKE_REPLY = JSON.stringify({ headline: "h", pressing: [{ ids: ["card:closed-home", "ticket-0003"], title: "Closed home bookable", why: "Booking: 2 guests say checkout opens" }] });

function project() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "swarm-proj-")));
  const w = (f, s) => (fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }), fs.writeFileSync(path.join(root, f), s));
  w("tracker/board.json", JSON.stringify({ cards: [{ id: "closed-home", title: "Closed home still bookable", column: "todo", owner: "Reservations", description: "Checkout opens for a closed home.", labels: ["bug"], files: ["src/bookings.ts"] }] }));
  w("src/bookings.ts", 'export function createBooking(listing) {\n  if (listing.status === "closed") return null;\n  return { id: 1 };\n}\n');
  w("test/bookings.test.ts", 'import { createBooking } from "../src/bookings";\ntest("a closed listing cannot be booked", () => {});\n');
  fs.mkdirSync(path.join(root, "data"));
  const db = new DatabaseSync(path.join(root, "data/rentaplace.db"));
  db.exec("CREATE TABLE support_tickets (id TEXT, name TEXT, subject TEXT, message TEXT, category TEXT, status TEXT, created_at TEXT); CREATE TABLE feedback (id TEXT, page TEXT, rating TEXT, text TEXT, created_at TEXT);");
  db.prepare("INSERT INTO support_tickets VALUES (?,?,?,?,?,?,?)").run("ticket-0003", "Cy", "Closed listing still available", "Beach House checkout opens.", "uncategorized", "open", "2026-10-25T09:00:00Z");
  db.close();
  const git = (...a) => spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" });
  git("init", "-q");
  fs.writeFileSync(path.join(root, ".gitignore"), "data/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "Checkout refuses closed listings");
  return root;
}
function cli(argv, env = {}) {
  const state = env.TRIAGE_STATE ?? fs.mkdtempSync(path.join(os.tmpdir(), "swarm-state-"));
  const r = spawnSync("node", ["--disable-warning=ExperimentalWarning", CLI, ...argv], { encoding: "utf8", env: { ...process.env, TRIAGE_MODEL_CMD: FAKE, FAKE_REPLY, TRIAGE_STATE: state, PI_CODING_AGENT_DIR: path.join(state, "no-agent"), ...env } });
  let out = null;
  let err = null;
  try { out = r.stdout ? JSON.parse(r.stdout) : null; } catch {}
  try { err = r.stderr ? JSON.parse(r.stderr.trim().split("\n").pop()) : null; } catch {}
  return { code: r.status, out, err, state, raw: r.stdout + r.stderr };
}
/** A sessions folder with one conversation: text, thinking, a tool call, a tool result, a system message, and secrets. */
function sessions() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swarm-sessions-"));
  const m = (role, content) => JSON.stringify({ type: "message", id: "x", timestamp: "2026-11-01T10:00:00Z", message: { role, content } });
  const lines = [
    JSON.stringify({ type: "session", version: 3, id: "s1", cwd: "/Users/someone/dev/app" }),
    m("system", "SYSTEM closed checkout"),
    m("user", [{ type: "text", text: "Closed homes must refuse checkout. My key is sk-ant-abcdefghijklmnop1234 and the file is /Users/someone/dev/app/src/bookings.ts" }]),
    m("assistant", [{ type: "thinking", thinking: "THINKING closed checkout secret-thought" }, { type: "toolCall", name: "bash", arguments: { command: "TOOLCALL closed checkout" } }, { type: "text", text: "Decision: a closed home refuses new checkout but keeps existing reservations." }]),
    m("toolResult", [{ type: "text", text: "TOOLOUTPUT closed checkout password=hunter2222" }]),
    m("user", "We talked about lunch."),
  ];
  fs.writeFileSync(path.join(dir, "2026-11-01T10-00-00-000Z_s1.jsonl"), lines.join("\n") + "\n");
  return dir;
}

test("the plan is checked by code: an unknown name is dropped, a repeat is merged, Code always runs, an empty or unreadable plan is Code only", () => {
  const p = validatePlan(JSON.stringify({ gatherers: [{ name: "history", look_for: "x".repeat(500), reason: "earlier cards" }, { name: "web-search", reason: "y" }, { name: "history", look_for: "and blame", reason: "again" }, { name: "GitHub", reason: "" }] }), GATHERERS);
  assert.deepEqual(p.gatherers.map((g) => g.name), ["code", "history", "github"]);
  assert.deepEqual(p.dropped, [{ name: "web-search", reason: "not a gatherer that can start here" }]);
  assert.ok(p.gatherers[1].look_for.length <= 320 && p.gatherers[1].look_for.endsWith("; and blame"), "a gatherer named twice runs once, with both instructions");
  assert.equal(p.gatherers[2].reason, "no reason given");
  for (const bad of ["", "not json", "{}", '{"gatherers": []}', '{"gatherers": [{"name": "nope"}]}', '{"gatherers": "all"}']) assert.deepEqual(validatePlan(bad, GATHERERS).gatherers.map((g) => g.name), ["code"], bad);
  assert.match(validatePlan("not json", GATHERERS).note, /only Code ran/);
  // A gatherer a setting turned off cannot be planned.
  const { on, off } = availableGatherers({ conversations: "off" });
  assert.deepEqual(off.map((g) => [g.label, g.why]), [["Past conversations", "off (project setting)"]]);
  assert.deepEqual(validatePlan('{"gatherers": [{"name": "conversations", "reason": "r"}]}', on).gatherers.map((g) => g.name), ["code"]);
  assert.deepEqual(availableGatherers({ only: "history" }).on.map((g) => g.name), ["code", "history"]);
  assert.deepEqual(GATHERERS.map((g) => g.name), ["code", "history", "github", "packages", "conversations"]);
  for (const g of GATHERERS) assert.ok(planSystem(GATHERERS).includes(`- ${g.name}: `));
  assert.ok(COST_CAP_USD > 0 && SWARM_LIMITS.timeoutMs === 20_000);
});

test("a failed or timed-out gatherer never blocks: each ends in a named state, and the others' findings are kept", async () => {
  const g = (name, fetch) => ({ name, label: name, outside: false, about: name, fetch });
  const seen = [];
  const t0 = Date.now();
  const results = await runSwarm({
    root: os.tmpdir(), issue: { title: "Closed home", reports: [] }, candidates: { terms: ["closed"], files: [], tests: [], commits: [], reports: [] }, model: "m", timeoutMs: 300,
    gatherers: [g("slow", () => new Promise((r) => setTimeout(r, 3000).unref())), g("boom", async () => { throw new Error("gh is not installed"); }), g("empty", async () => ({ items: [], searched: ["3 commits"] }))],
    onState: (s) => seen.push(s.map((x) => x.state).join(",")),
  });
  assert.ok(Date.now() - t0 < 2000, "the slow one did not hold the others up");
  assert.deepEqual(results.map((r) => [r.name, r.state]), [["slow", "timeout"], ["boom", "error"], ["empty", "nothing"]]);
  assert.match(results[0].error, /no answer in/);
  assert.equal(results[1].error, "gh is not installed");
  assert.equal(seen[0], "searching,searching,searching");
  const text = swarmText(results);
  assert.match(text, /slow.*: timed out/i);
  assert.match(text, /boom.*: failed \(gh is not installed\)/i);
  assert.match(text, /empty.*: nothing relevant found\. Looked at: 3 commits\./i);
});

test("a finding is kept only when every citation is something code fetched", () => {
  const items = [{ cite: "commit:abc1234", text: "x" }, { cite: "https://github.com/o/r/issues/7", text: "y" }, { cite: "session:2026-11-01T10:00#2", text: "z" }];
  const r = parseFindings(JSON.stringify({ findings: [{ text: "real", cites: ["[commit:abc1234]"] }, { text: "url", cites: ["https://github.com/o/r/issues/7"] }, { text: "invented url", cites: ["https://github.com/o/r/issues/8"] }, { text: "no cite", cites: [] }, { text: "half real", cites: ["commit:abc1234", "commit:fffffff"] }, { text: "talk", cites: ["session:2026-11-01T10:00#2"] }] }), items);
  assert.deepEqual(r.findings.map((f) => f.text), ["real", "url", "talk"]);
  assert.deepEqual(r.dropped.map((d) => d.reason), ["not something that was fetched: https://github.com/o/r/issues/8", "no citation", "not something that was fetched: commit:fffffff"]);
});

test("past conversations: this project's folder only; text only; redacted before a model sees it; read-only; not found is a named state", async () => {
  assert.equal(sessionsDirFor("/Users/x/dev/rentaplace", "/a"), "/a/sessions/--Users-x-dev-rentaplace--");
  const dir = sessions();
  const file = path.join(dir, fs.readdirSync(dir)[0]);
  const before = [fs.readFileSync(file, "utf8"), fs.statSync(file).mtimeMs];
  const texts = sessionTexts(before[0].split("\n"));
  assert.deepEqual(texts.map((t) => [t.entry, t.role]), [[2, "user"], [3, "assistant"], [5, "user"]]);
  assert.doesNotMatch(JSON.stringify(texts), /THINKING|TOOLCALL|TOOLOUTPUT|SYSTEM/);
  const got = await fetchConversations({ root: "/nowhere", terms: ["closed", "checkout"], conversations: { mode: "on", dir } });
  assert.deepEqual(got.read, { sessions: 1, entries: 3, found: true });
  assert.deepEqual(got.items.map((i) => i.cite).sort(), ["session:2026-11-01T10:00#2", "session:2026-11-01T10:00#3"]);
  const all = JSON.stringify(got);
  assert.doesNotMatch(all, /sk-ant|hunter2|\/Users\/someone|THINKING|TOOLCALL|TOOLOUTPUT|SYSTEM|lunch/);
  assert.match(all, /\[redacted\]/);
  assert.match(all, /~\/dev\/app\/src\/bookings\.ts/);
  assert.deepEqual([fs.readFileSync(file, "utf8"), fs.statSync(file).mtimeMs], before, "the session file was not written");
  assert.deepEqual(fs.readdirSync(dir).length, 1, "nothing was added to the sessions folder");
  const none = await fetchConversations({ root: "/nowhere/at/all", terms: ["closed"], conversations: { mode: "on", dir: path.join(dir, "missing") } });
  assert.deepEqual([none.items, none.read.found, none.searched], [[], false, ["no past Pi conversations found for this project"]]);
  // Redaction on its own.
  const r = redact("token: ghp_abcdefghijklmnopqrstuvwx1234 API_KEY=abcd1234efgh Bearer abcdefghijklmnop.qrstu mail me at jo@example.com AKIAABCDEFGHIJKLMNOP /home/jo/x.txt keep src/domain/bookings.ts and createBookingForListing");
  assert.doesNotMatch(r, /ghp_|abcd1234efgh|abcdefghijklmnop\.|jo@example|AKIA|\/home\/jo/);
  assert.match(r, /keep src\/domain\/bookings\.ts and createBookingForListing/);
});

test("CLI: the planner's plan runs as a swarm; a failed gatherer is shown and does not block; the brief is grouped; the prompt is issue, brief, cited code, rules", () => {
  const root = project();
  const dir = sessions();
  const first = cli(["refresh", "--root", root]);
  assert.equal(first.code, 0, first.raw);
  const log = path.join(first.state, "model.log");
  const env = {
    TRIAGE_STATE: first.state, FAKE_LOG: log, TRIAGE_CONVERSATIONS_DIR: dir, FAKE_FAIL_HISTORY: "1",
    FAKE_PLAN: JSON.stringify({ gatherers: [{ name: "code", look_for: "the closed check", reason: "reports name checkout" }, { name: "history", look_for: "earlier closed-home work", reason: "a commit names closed listings" }, { name: "conversations", look_for: "closed checkout decisions", reason: "the card asks for the expected behavior" }, { name: "bogus", reason: "x" }] }),
    FAKE_FINDINGS_CONVERSATIONS: JSON.stringify({ findings: [{ text: "The assistant recorded a decision: a closed home refuses new checkout; may matter because the card asks for the expected behavior.", cites: ["session:2026-11-01T10:00#3"] }, { text: "Invented talk.", cites: ["session:2026-11-01T10:00#99"] }] }),
  };
  const g = cli(["gather", "card:closed-home", "--root", root], env);
  assert.equal(g.code, 0, g.raw);
  assert.deepEqual(g.out.plan.gatherers.map((p) => [p.name, p.reason]), [["code", "reports name checkout"], ["history", "a commit names closed listings"], ["conversations", "the card asks for the expected behavior"]]);
  assert.deepEqual(g.out.plan.dropped.map((d) => d.name), ["bogus"]);
  assert.deepEqual(g.out.plan.not_started.map((n) => n.name), ["github", "packages"]);
  assert.deepEqual(g.out.states.map((s) => [s.name, s.state]), [["code", "findings"], ["history", "error"], ["conversations", "findings"]]);
  assert.deepEqual(g.out.conversations, { mode: "on", read: { sessions: 1, entries: 3, found: true } });
  assert.ok(g.out.brief.dropped.some((d) => d.gatherer === "Past conversations" && /not something that was fetched/.test(d.reason)));
  const t = g.out.text;
  assert.ok(t.indexOf("CODE (") >= 0 && t.indexOf("CODE (") < t.indexOf("HISTORY (") && t.indexOf("HISTORY (") < t.indexOf("PAST CONVERSATIONS ("), t);
  assert.match(t, /HISTORY \(.*\): failed \(model down\)\. Nothing from this gatherer\./);
  assert.match(t, /\[session:2026-11-01T10:00#3\]/);
  assert.doesNotMatch(t, /Invented talk/);
  // What each model was sent: the planner first; no gatherer saw tool output, thinking or a secret.
  const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.match(calls[0].system, /^PLANNER/);
  assert.equal(calls.length, 4);
  const conv = calls.find((c) => /^GATHERER: conversations/.test(c.system));
  assert.match(conv.input, /LOOK FOR \(from the planner\): closed checkout decisions/);
  assert.doesNotMatch(JSON.stringify(calls), /sk-ant|hunter2|\/Users\/someone|THINKING|TOOLCALL|TOOLOUTPUT/);
  // The sidebar's view of it.
  const prog = cli(["progress", "card:closed-home", "--root", root], env).out;
  assert.equal(prog.phase, "gathering");
  assert.deepEqual(progressLines(prog).map((l) => l.replace(/ · [\d.]+ s/, "")), ["Code: 3 findings — reports name checkout", "History: failed — a commit names closed listings", "Past conversations: 1 finding · read 1 conversation — the card asks for the expected behavior", "Not started: GitHub, Packages"]);
  const item = cli(["show", "--root", root], env).out.pressing[0];
  assert.equal(rowStatusLines(item, false).pop(), "Brief ready · B to view");
  assert.equal(rowStatusLines(item, false).length, 5);
  const view = briefViewLines(g.out, 400).map((l) => l.text).join("\n");
  assert.match(view, /The plan \(one small model chose the gatherers\):/);
  assert.match(view, /Read 1 past conversation in this project \(3 messages; text only, redacted, nothing written\)\./);
  assert.match(view, /GitHub: not started — the planner did not choose it for this issue/);
  assert.match(view, /"bogus" dropped from the plan/);
  assert.match(costLine(g.out), /small-model calls/);
  // The hand-off.
  const p = cli(["prompt", "card:closed-home", "--root", root], env).out.prompt;
  const at = ["The Issues widget passed you this issue.", "Context gathered by Issues before handing over.", "CODE (", "PAST CONVERSATIONS (", "The cited code (copied from the files by a script", "src/bookings.ts:2| ", "Rules for this hand-off"].map((s) => p.indexOf(s));
  assert.ok(at.every((n, i) => n >= 0 && (i === 0 || n > at[i - 1])), JSON.stringify(at));
  assert.match(p, /Start from this brief; open files only for what is missing/);
  assert.doesNotMatch(p + t + view, /fixer/i);
  // Off switch: saved for the project; the gatherer cannot start even when the planner names it, and nothing is read.
  assert.equal(cli(["config", "--root", root, "--conversations", "off"], env).code, 0);
  const off = cli(["gather", "card:closed-home", "--root", root], env);
  assert.deepEqual(off.out.plan.gatherers.map((x) => x.name), ["code", "history"]);
  assert.deepEqual(off.out.plan.not_started.find((n) => n.name === "conversations").why, "off (project setting)");
  assert.deepEqual(off.out.conversations, { mode: "off", read: null });
  assert.match(briefViewLines(off.out, 400).map((l) => l.text).join("\n"), /Past conversations were not read \(off for this project\)\./);
});

test("CLI: with no sessions folder for the project, past conversations says so and the hand-off goes on; a failed planner means Code only", () => {
  const root = project();
  const first = cli(["refresh", "--root", root]);
  const env = { TRIAGE_STATE: first.state, FAKE_PLAN: JSON.stringify({ gatherers: [{ name: "conversations", look_for: "x", reason: "r" }] }) };
  const g = cli(["gather", "card:closed-home", "--root", root], env);
  assert.equal(g.code, 0, g.raw);
  assert.deepEqual(g.out.states.map((s) => [s.name, s.state]), [["code", "findings"], ["conversations", "nothing"]]);
  assert.match(g.out.text, /PAST CONVERSATIONS \(.*\): nothing relevant found\. Looked at: no past Pi conversations found for this project\./);
  const f = cli(["gather", "card:closed-home", "--root", root, "--force"], { TRIAGE_STATE: first.state, FAKE_FAIL_PLAN: "1" });
  assert.equal(f.code, 0, f.raw);
  assert.deepEqual(f.out.plan.gatherers.map((x) => x.name), ["code"]);
  assert.match(f.out.plan.note, /the planner failed \(model down\); only Code ran/);
});

test("on screen: Planning…, then one line per chosen gatherer with the planner's reason, then each state", () => {
  assert.deepEqual(progressLines(null), ["Planning…"]);
  assert.deepEqual(progressLines({ phase: "planning", plan: [], states: [] }), ["Planning…"]);
  const plan = [{ name: "code", label: "Code", reason: "reports name checkout" }, { name: "github", label: "GitHub", reason: "next is imported" }];
  assert.deepEqual(progressLines({ phase: "gathering", plan, states: [{ name: "code", label: "Code", state: "searching" }, { name: "github", label: "GitHub", state: "timeout", ms: 20000 }], not_started: [{ label: "Packages" }] }), ["Code: searching… — reports name checkout", "GitHub: timed out · 20.0 s — next is imported", "Not started: Packages"]);
  assert.equal(gathererLine({ label: "History", state: "nothing", ms: 1200 }), "History: nothing relevant · 1.2 s");
  assert.deepEqual(rowStatusLines({ context: { state: "none" } }, true, null), ["Planning…"]);
  assert.deepEqual(rowStatusLines({ context: { state: "ready" } }, false), ["Brief ready · B to view"]);
  assert.deepEqual(rowStatusLines({ context: { state: "none" } }, false), []);
  assert.doesNotMatch(assemblePrompt({ issue: "i", brief: "b", excerpts: "e", rules: { path: "/r", text: "t" } }), /fixer/i);
});
