import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { groupIssues, parseIssue, issueText, SchemaError } from "../src/issue.mjs";
import { parseSummary, modelInput, others } from "../src/triage.mjs";
import { githubSource, localSource, pickSources, SourceUnavailable } from "../src/sources.mjs";
import { availability, newMainCommand, ACTIONS } from "../src/actions.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
const CLI = path.join(here, "..", "triage.mjs");
const FAKE = JSON.stringify(["node", path.join(here, "fake-model.mjs")]);

const issue = (id, title, body = "", extra = {}) => parseIssue({ id, kind: "inbox", title, body, where: `db ${id}`, ...extra });

/** A throwaway project: the fixture board plus a database with duplicate tickets. */
function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "triage-proj-"));
  fs.cpSync(path.join(here, "fixtures/project"), root, { recursive: true });
  fs.mkdirSync(path.join(root, "data"));
  const db = new DatabaseSync(path.join(root, "data/rentaplace.db"));
  db.exec("CREATE TABLE support_tickets (id TEXT, name TEXT, subject TEXT, message TEXT, category TEXT, status TEXT, created_at TEXT); CREATE TABLE feedback (id TEXT, page TEXT, rating TEXT, text TEXT, created_at TEXT);");
  const t = db.prepare("INSERT INTO support_tickets VALUES (?,?,?,?,?,?,?)");
  t.run("ticket-0001", "Ana", "Refund timing", "When will my refund show?", "uncategorized", "open", "2026-10-23T09:00:00Z");
  t.run("ticket-0002", "Bo", "Refund timing", "When will my refund show?", "uncategorized", "open", "2026-10-24T09:00:00Z");
  t.run("ticket-0003", "Cy", "Closed listing still available", "Beach House checkout opens.", "uncategorized", "open", "2026-10-25T09:00:00Z");
  t.run("ticket-0004", "Di", "Solved", "x", "uncategorized", "closed", "2026-10-25T09:00:00Z");
  db.prepare("INSERT INTO feedback VALUES (?,?,?,?,?)").run("feedback-1", "/search", "good", "Nice", "2026-11-01T00:00:00Z");
  db.close();
  return root;
}

function cli(argv, env = {}) {
  const state = env.TRIAGE_STATE ?? fs.mkdtempSync(path.join(os.tmpdir(), "triage-state-"));
  const r = spawnSync("node", [CLI, ...argv], { encoding: "utf8", env: { ...process.env, TRIAGE_MODEL_CMD: FAKE, TRIAGE_STATE: state, ...env } });
  return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr ? JSON.parse(r.stderr.trim().split("\n").pop()) : null, state };
}

test("word-for-word duplicates become one group, ordered by id; different text stays apart", () => {
  const g = groupIssues([issue("ticket-0010", "Refund timing", "When?"), issue("ticket-0002", "Refund  timing!", "when"), issue("ticket-0003", "Refund timing", "Other text")]);
  assert.deepEqual(g.map((x) => x.id), ["ticket-0002", "ticket-0003"]);
  assert.deepEqual(g[0].members.map((m) => m.id), ["ticket-0002", "ticket-0010"]);
});

test("the issue schema rejects what a source must not hand back", () => {
  assert.throws(() => parseIssue({ id: "x", kind: "email", title: "t", where: "w" }), SchemaError);
  assert.throws(() => parseIssue({ id: "", kind: "inbox", title: "t", where: "w" }), SchemaError);
  assert.equal(parseIssue({ id: "a", kind: "github", title: "t", where: "w", url: "javascript:alert(1)" }).url, null);
});

test("model claims keep only real ids, each group once; invented items are dropped", () => {
  const groups = groupIssues([issue("ticket-0001", "A"), issue("ticket-0002", "A"), issue("card:b", "B")]);
  const s = parseSummary('```json\n{"headline":"h","pressing":[{"ids":["ticket-0002","card:b"],"title":"A","why":"money"},{"ids":["card:b"],"title":"again"},{"ids":["gh#404"],"title":"made up"}]}\n```', groups);
  assert.deepEqual(s.pressing, [{ id: "ticket-0001", ids: ["ticket-0001", "card:b"], title: "A", why: "money" }]);
  assert.throws(() => parseSummary("sorry", groups));
});

test("only changed groups are sent in full", () => {
  const groups = groupIssues([issue("a", "Same", "body one"), issue("b", "New", "body two")]);
  const m = modelInput(groups, { hashes: { a: groups[0].hash, b: "old" }, why: { a: "still money" } });
  const rows = JSON.parse(m.text.split("\n")[1]);
  assert.deepEqual([m.read, m.reused], [1, 1]);
  assert.equal(rows[0].body, undefined);
  assert.equal(rows[0].last_why, "still money");
  assert.equal(rows[1].body, "body two");
});

test("others: most reported first, then newest, then id", () => {
  const groups = groupIssues([issue("x1", "X", "", { created_at: "2026-01-01" }), issue("x2", "X", "", { created_at: "2026-01-02" }), issue("y", "Y", "", { created_at: "2026-02-01" }), issue("z", "Z", "", { created_at: "2026-03-01" })]);
  assert.deepEqual(others(groups, new Set()).map((g) => g.id), ["x1", "z", "y"]);
});

test("local source reads open tickets, non-good feedback and cards not done; get finds one", async () => {
  const s = localSource({ root: project() });
  const ids = (await s.list()).map((i) => i.id);
  assert.deepEqual(ids, ["ticket-0001", "ticket-0002", "ticket-0003", "card:closed-home", "card:slow-search"]);
  assert.equal((await s.get("card:slow-search")).title, "Listings page is slow");
  assert.equal(await s.get("ticket-0004"), null);
  await assert.rejects(localSource({ root: os.tmpdir() + "/nowhere" }).list(), SourceUnavailable);
});

test("github source maps gh issues and reports gh failure as unavailable", async () => {
  const gh = githubSource({ repo: "o/r", run: () => ({ status: 0, stderr: "", stdout: JSON.stringify([{ number: 7, title: "Bug", body: "b", url: "https://github.com/o/r/issues/7", createdAt: "2026-01-01", labels: [{ name: "bug" }], author: { login: "ann" } }]) }) });
  assert.deepEqual(await gh.get("gh#7"), { id: "gh#7", kind: "github", title: "Bug", body: "b", url: "https://github.com/o/r/issues/7", where: "o/r#7", created_at: "2026-01-01", labels: ["bug"], author: "ann" });
  await assert.rejects(githubSource({ repo: "o/r", run: () => ({ status: 1, stdout: "", stderr: "gh: not logged in" }) }).list(), /not logged in/);
  assert.throws(() => pickSources({ source: "jira", root: "/" }), SourceUnavailable);
});

test("actions: Send to Main is disabled with a reason when the space has no Main", () => {
  const [g] = groupIssues([issue("ticket-1", "T")]);
  assert.deepEqual(availability("send-main", g, {}), { enabled: false, reason: "No Main conversation in this space", code: "NO_MAIN" });
  assert.equal(availability("send-main", g, { main: "t3" }).enabled, true);
  assert.equal(availability("open", g).enabled, false);
  assert.equal(newMainCommand("T", "prompt", "/p").args.folder, "/p");
  assert.deepEqual(new Set(ACTIONS.map((a) => a.key)).size, ACTIONS.length);
});

test("CLI: missing, then ready with a cached second refresh, then act and dismiss", () => {
  const root = project();
  const first = cli(["show", "--root", root]);
  assert.equal(first.out.state, "missing");
  const log = path.join(first.state, "model.log");
  const env = { TRIAGE_STATE: first.state, FAKE_LOG: log };
  const r = cli(["refresh", "--root", root], env);
  assert.equal(r.code, 0, JSON.stringify(r.err));
  assert.equal(r.out.state, "ready");
  assert.deepEqual(r.out.pressing.map((p) => [p.id, p.why]), [["card:closed-home", "Blocks booking"]]);
  assert.deepEqual(r.out.others.map((o) => o.id), ["ticket-0001", "ticket-0003", "card:slow-search"]);
  assert.equal(r.out.counts.issues, 5);
  const again = cli(["refresh", "--root", root], env);
  assert.equal(again.out.refresh.cached, true);
  assert.equal(fs.readFileSync(log, "utf8").trim().split("\n").length, 1, "unchanged issues are not sent to the model again");

  const copy = cli(["act", "ticket-0002", "copy", "--root", root, "--no-clipboard"], env);
  assert.match(copy.out.text, /^Refund timing {2}\[ticket-0001\]\nReported 2 times: ticket-0001, ticket-0002/);
  const send = cli(["act", "card:closed-home", "send-main", "--root", root, "--terminal", "t9", "--dry-run"], env);
  assert.deepEqual(send.out.command.slice(0, 3), ["hc", "send", "t9"]);
  assert.match(send.out.prompt, /Why it's pressing \(Issues\): Blocks booking/);
  assert.match(send.out.prompt, /Rules for this hand-off \(.*rules\.md\):\n- Find the cause before changing anything/);
  const nm = cli(["act", "card:closed-home", "new-main", "--root", root], env);
  assert.equal(nm.out.command.name, "space.new");
  cli(["act", "card:closed-home", "dismiss", "--root", root], env);
  const after = cli(["show", "--root", root], env);
  assert.deepEqual([after.out.pressing.length, after.out.dismissed], [0, ["card:closed-home"]]);
  const receipts = fs.readFileSync(path.join(first.state, "projects", fs.readdirSync(path.join(first.state, "projects"))[0], "receipts.jsonl"), "utf8").trim().split("\n");
  assert.equal(receipts.length, 4);
  assert.equal(cli(["act", "nope", "copy", "--root", root], env).err.error.code, "NOT_FOUND");
});

test("CLI: a failed model keeps the last summary and says failed; no source says unavailable", () => {
  const root = project();
  const ok = cli(["refresh", "--root", root]);
  const env = { TRIAGE_STATE: ok.state, FAKE_FAIL: "1" };
  const failed = cli(["refresh", "--root", root, "--force"], env);
  assert.equal(failed.out.state, "failed");
  assert.equal(failed.out.pressing.length, 1);
  assert.match(failed.out.error.message, /model down/);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "triage-none-"));
  assert.equal(cli(["refresh", "--root", empty]).out.state, "unavailable");
});

test("issue text names every merged report and the source", () => {
  const [g] = groupIssues([issue("t1", "Refund", "When?"), issue("t2", "Refund", "When?")]);
  assert.equal(issueText(g, "money"), "Refund  [t1]\nReported 2 times: t1, t2\nWhy it's pressing (Issues): money\nSource: db t1\n\nWhen?");
});

test("the hill-climbed instruction is the default; the original stays selectable by name", async () => {
  const { systemFor, INSTRUCTIONS, DEFAULT_INSTRUCTION, SYSTEM } = await import("../src/triage.mjs");
  assert.equal(DEFAULT_INSTRUCTION, "never-overstate");
  assert.equal(SYSTEM, systemFor());
  assert.ok(systemFor().startsWith(systemFor("baseline")));
  assert.match(systemFor(), /Never overstate what a ticket says/);
  assert.doesNotMatch(systemFor("baseline"), /Never overstate/);
  assert.throws(() => systemFor("nope"), /unknown instruction/);
  assert.deepEqual(Object.keys(INSTRUCTIONS).sort(), ["baseline", "never-overstate"]);
  const root = project();
  const r = cli(["refresh", "--root", root, "--instruction", "baseline"]);
  assert.equal(r.out.instruction, "baseline");
  const log = path.join(r.state, "m.log");
  cli(["refresh", "--root", root, "--force", "--instruction", "never-overstate"], { TRIAGE_STATE: r.state, FAKE_LOG: log });
  assert.match(JSON.parse(fs.readFileSync(log, "utf8")).system, /Never overstate/);
  assert.equal(cli(["refresh", "--root", root, "--instruction", "nope"], { TRIAGE_STATE: r.state }).err.error.code, "INVALID");
});
