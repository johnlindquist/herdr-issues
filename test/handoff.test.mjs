// Gather, then hand over: the brief's boundary check, prompt assembly, rules, cache and the CLI
// contract. No model and no app: the model seam is the recorded fake, the app is --dry-run.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { groupIssues, parseIssue } from "../src/issue.mjs";
import { collect, parseBrief, briefText, resolveCite, resolverFor, gatherInput, GatherFailed, LIMITS } from "../src/gather.mjs";
import { issueFor, assemblePrompt, loadRules, RulesMissing, PROJECT_RULES, DEFAULT_RULES_FILE, BRIEF_INTRO, DATA_INTRO, RULES_INTRO } from "../src/handoff.mjs";
import { ACTIONS, newMainCommand } from "../src/actions.mjs";
import { legendEntries, menuItems, rowStatus, wrap, briefViewLines } from "../surface.js";

const here = path.dirname(new URL(import.meta.url).pathname);
const repo = path.join(here, "..");
const CLI = path.join(repo, "triage.mjs");
const FAKE = JSON.stringify(["node", path.join(here, "fake-model.mjs")]);
// The inbox read used here: the model merges the tracker card with the tickets that say the same thing.
const FAKE_REPLY = JSON.stringify({ headline: "h", pressing: [{ ids: ["card:closed-home", "ticket-0003"], title: "Closed home bookable", why: "Booking: 2 guests say checkout opens" }] });
const issue = (id, title, body = "", extra = {}) => parseIssue({ id, kind: "inbox", title, body, where: `db ${id}`, ...extra });

/** A throwaway git project: a board whose card names a real and a missing file, tickets, code and a test. */
function project() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "handoff-proj-")));
  const w = (f, s) => (fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }), fs.writeFileSync(path.join(root, f), s));
  w("tracker/board.json", JSON.stringify({ cards: [{ id: "closed-home", title: "Closed home still bookable", column: "todo", owner: "Reservations", description: "Checkout opens for a closed home.", labels: ["bug"], files: ["src/bookings.ts", "src/pages/guest.ts"] }] }));
  w("src/bookings.ts", 'export function createBooking(listing) {\n  if (listing.status === "closed") return null;\n  return { id: 1 };\n}\n');
  w("src/checkout.ts", "// opens the checkout page for a listing\nexport const checkout = (l) => l;\n");
  w("test/bookings.test.ts", 'import { createBooking } from "../src/bookings";\ntest("a closed listing cannot be booked", () => {});\n');
  fs.mkdirSync(path.join(root, "data"));
  const db = new DatabaseSync(path.join(root, "data/rentaplace.db"));
  db.exec("CREATE TABLE support_tickets (id TEXT, name TEXT, subject TEXT, message TEXT, category TEXT, status TEXT, created_at TEXT); CREATE TABLE feedback (id TEXT, page TEXT, rating TEXT, text TEXT, created_at TEXT);");
  const t = db.prepare("INSERT INTO support_tickets VALUES (?,?,?,?,?,?,?)");
  t.run("ticket-0003", "Cy", "Closed listing still available", "Beach House checkout opens.", "uncategorized", "open", "2026-10-25T09:00:00Z");
  t.run("ticket-0005", "Di", "Closed listing still available", "Beach House checkout opens.", "uncategorized", "open", "2026-10-26T09:00:00Z");
  db.close();
  const git = (...a) => spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" });
  git("init", "-q");
  fs.writeFileSync(path.join(root, ".gitignore"), "data/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "Booking refuses closed listings");
  return root;
}

function cli(argv, env = {}) {
  const state = env.TRIAGE_STATE ?? fs.mkdtempSync(path.join(os.tmpdir(), "handoff-state-"));
  const r = spawnSync("node", ["--disable-warning=ExperimentalWarning", CLI, ...argv], { encoding: "utf8", env: { ...process.env, TRIAGE_MODEL_CMD: FAKE, FAKE_REPLY, TRIAGE_STATE: state, ...env } });
  let out = null;
  let err = null;
  try { out = r.stdout ? JSON.parse(r.stdout) : null; } catch {}
  try { err = r.stderr ? JSON.parse(r.stderr.trim().split("\n").pop()) : null; } catch {}
  return { code: r.status, out, err, state, raw: r.stdout + r.stderr };
}
const receiptsOf = (state) => {
  const d = path.join(state, "projects");
  const f = path.join(d, fs.readdirSync(d)[0], "receipts.jsonl");
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
};

const CANDIDATES = {
  reports: [{ id: "ticket-0003", kind: "inbox", title: "t", body: "Beach House checkout opens.", author: "Cy", created_at: null }, { id: "card:closed-home", kind: "board", title: "c", body: "b", author: null, created_at: null }],
  terms: ["closed"],
  files: [{ path: "src/bookings.ts", lines: 40, why: ["named in card:closed-home"], shown: [{ n: 2, text: "if (closed) return null" }, { n: 3, text: "x" }] }],
  tests: [{ path: "test/bookings.test.ts", lines: 9, why: ["mentions bookings"], shown: [{ n: 2, text: 'test("a closed listing cannot be booked")' }] }],
  missing: ["src/pages/guest.ts"],
  commits: [{ sha: "abc1234", date: "2026-11-01", subject: "s", files: ["src/bookings.ts"] }],
  notes: [],
  ms: 1,
};

test("a citation resolves only to a real report id, a line the model was shown, or a gathered commit", () => {
  const r = resolverFor(CANDIDATES);
  assert.equal(resolveCite("ticket-0003", r).kind, "report");
  assert.equal(resolveCite("src/bookings.ts:2", r).kind, "line");
  assert.equal(resolveCite("src/bookings.ts:2-3", r).ok, true);
  assert.equal(resolveCite("commit:abc1234", r).kind, "commit");
  assert.match(resolveCite("src/bookings.ts:9", r).reason, /not shown/);
  assert.match(resolveCite("src/pages/guest.ts:1", r).reason, /not gathered/);
  assert.equal(resolveCite("ticket-9999", r).ok, false);
  assert.equal(resolveCite("commit:fffffff", r).ok, false);
  assert.equal(resolveCite("", r).ok, false);
});

test("brief: uncited and unresolvable claims are dropped, each with its reason; a cause stated as fact is dropped", () => {
  const reply = JSON.stringify({
    reported: [{ text: 'A guest says "Beach House checkout opens."', cites: ["ticket-0003"] }, { text: "People are upset.", cites: [] }, { text: "Reported by ticket 99.", cites: ["ticket-0099"] }, { text: "The code says so.", cites: ["src/bookings.ts:2"] }],
    where: [{ text: "Likely createBooking: the cited line returns null for a closed listing.", cites: ["src/bookings.ts:2"] }, { text: "Likely the guest page.", cites: ["src/pages/guest.ts:10"] }, { text: "The cause is the missing status check.", cites: ["src/bookings.ts:3"] }, { text: "Likely line 30.", cites: ["src/bookings.ts:2", "src/bookings.ts:30"] }],
    tests: [{ text: 'A test named "a closed listing cannot be booked" exists.', cites: ["test/bookings.test.ts:2"] }],
    unknown: [{ text: "Which listing page lets the guest in is not shown.", cites: ["card:closed-home"] }],
  });
  const b = parseBrief("```json\n" + reply + "\n```", CANDIDATES);
  assert.deepEqual([b.reported.length, b.where.length, b.tests.length, b.unknown.length], [1, 1, 1, 1]);
  assert.deepEqual(b.dropped.map((d) => d.reason), ["no citation", "not a report id, path:line or commit: ticket-0099", "a reported claim must cite a report id", "file was not gathered: src/pages/guest.ts", "states a cause as fact", "line was not shown to the model: src/bookings.ts:30"]);
  assert.equal(briefText(b), 'What is reported:\n- A guest says "Beach House checkout opens." [ticket-0003]\nWhere it likely lives:\n- Likely createBooking: the cited line returns null for a closed listing. [src/bookings.ts:2]\nTests near it:\n- A test named "a closed listing cannot be booked" exists. [test/bookings.test.ts:2]\nNot known yet:\n- Which listing page lets the guest in is not shown. [card:closed-home]');
  assert.throws(() => parseBrief("sorry", CANDIDATES), GatherFailed);
  assert.throws(() => parseBrief('{"reported":[{"text":"x","cites":["nope"]}]}', CANDIDATES), /no claim survived/);
});

test("prompt assembly: the issue, then the brief, then the rules, and nothing else", () => {
  const rules = { path: "/p/issues-rules.md", text: "- Ask before touching money." };
  const p = assemblePrompt({ issue: "ISSUE TEXT", brief: "BRIEF TEXT", rules, nonce: "n1" });
  // What the data is; the fenced data (issue, then brief); the rules, outside the fence and last.
  assert.equal(p, `The Issues widget passed you this issue. ${DATA_INTRO}\n\n${BRIEF_INTRO}\n\n<<<DATA n1\nISSUE TEXT\n\nCONTEXT BRIEF:\nBRIEF TEXT\n<<<END DATA n1\n\nRules for this hand-off (/p/issues-rules.md). ${RULES_INTRO}\n- Ask before touching money.`);
  assert.match(BRIEF_INTRO, /Start from this brief; open files only for what is missing/);
  assert.match(BRIEF_INTRO, /leads to verify, not as facts/);
  assert.ok(p.indexOf("ISSUE TEXT") < p.indexOf("BRIEF TEXT") && p.indexOf("BRIEF TEXT") < p.indexOf("- Ask before"));
  assert.equal(assemblePrompt({ issue: "ISSUE TEXT", brief: null, rules, nonce: "n1" }), `The Issues widget passed you this issue. ${DATA_INTRO}\n\n<<<DATA n1\nISSUE TEXT\n<<<END DATA n1\n\nRules for this hand-off (/p/issues-rules.md). ${RULES_INTRO}\n- Ask before touching money.`);
  assert.throws(() => assemblePrompt({ issue: "", brief: null, rules }), /issue/);
  assert.throws(() => assemblePrompt({ issue: "x", brief: null, rules: { path: "", text: "" } }), RulesMissing);
});

test("every merged report is in the issue text: word-for-word duplicates and reports the model merged", () => {
  const groups = groupIssues([issue("ticket-0003", "Closed listing still available", "Beach House checkout opens.", { author: "Cy" }), issue("ticket-0005", "Closed listing still available", "Beach House checkout opens.", { author: "Di" }), parseIssue({ id: "card:closed-home", kind: "board", title: "Closed home still bookable", body: "Checkout opens for a closed home.\nFiles: src/bookings.ts", where: "board card closed-home" })]);
  const it = issueFor([groups[1], groups[0]], "Booking: 2 guests say checkout opens", "Closed home bookable");
  assert.deepEqual(it.ids, ["ticket-0003", "ticket-0005", "card:closed-home"]);
  assert.equal(it.reports.length, 3);
  for (const part of ["Closed home bookable  [ticket-0003]", "Reports (3): ticket-0003, ticket-0005, card:closed-home", "Why it's pressing (Issues): Booking: 2 guests say checkout opens", "[ticket-0003] Cy", "[ticket-0005] Di", "Beach House checkout opens.", "[card:closed-home]", "Files: src/bookings.ts"]) assert.ok(it.text.includes(part), `${part}\n---\n${it.text}`);
  assert.equal(it.text.split("Beach House checkout opens.").length - 1, 2, "each duplicate's text is there, not only the first");
  assert.notEqual(issueFor([groups[1]], null, null).hash, it.hash);
});

test("collect: named files that exist, the missing one named as missing, term matches, the test near them, commits; bounded", () => {
  const root = project();
  const c = collect({ root, title: "Closed home still bookable", reports: [{ id: "card:closed-home", kind: "board", title: "Closed home still bookable", body: "Checkout opens for a closed home.\nFiles: src/bookings.ts, src/pages/guest.ts, ../../etc/passwd.md", author: null, created_at: null }] });
  assert.deepEqual(c.files.map((f) => f.path).sort(), ["src/bookings.ts", "src/checkout.ts"]);
  assert.ok(c.missing.includes("src/pages/guest.ts"));
  assert.ok(!c.files.some((f) => f.path.includes("passwd")));
  assert.deepEqual(c.tests.map((f) => f.path), ["test/bookings.test.ts"]);
  assert.ok(c.files.find((f) => f.path === "src/bookings.ts").shown.some((l) => l.n === 2 && /closed/.test(l.text)));
  assert.equal(c.commits[0].subject, "Booking refuses closed listings");
  assert.ok(c.ms < LIMITS.ms);
  const input = gatherInput({ title: "Closed home still bookable", why: "w" }, c);
  assert.match(input, /src\/bookings\.ts:2\| {3}if \(listing\.status === "closed"\)/);
  assert.match(input, /NOT IN THE PROJECT \(do not cite\): .*src\/pages\/guest\.ts/);
  assert.ok(input.length <= LIMITS.inputChars + 80);
  const none = collect({ root: fs.mkdtempSync(path.join(os.tmpdir(), "nogit-")), title: "x", reports: [] });
  assert.match(none.notes.join(" "), /not a git repository/);
});

test("rules: one file, the project's own when it has one, else the shipped default; missing is a named error", () => {
  const root = project();
  const d = loadRules({ root });
  assert.equal(d.path, DEFAULT_RULES_FILE);
  assert.equal(d.source, "default");
  for (const rule of [/find the cause before changing anything/i, /failing test/i, /plan and (your )?questions first/i, /ask before touching money/i, /what you changed and how you checked/i]) assert.match(d.text, rule);
  fs.writeFileSync(path.join(root, PROJECT_RULES), "- Only this rule.\n");
  assert.deepEqual(loadRules({ root }), { path: path.join(root, PROJECT_RULES), source: "project", text: "- Only this rule." });
  assert.throws(() => loadRules({ root, explicit: path.join(root, "nope.md") }), RulesMissing);
  fs.writeFileSync(path.join(root, PROJECT_RULES), "  \n");
  assert.throws(() => loadRules({ root }), /empty/);
});

test("CLI: gather returns a cited brief with what was dropped; a second gather reuses it without the model", () => {
  const root = project();
  const first = cli(["refresh", "--root", root]);
  assert.equal(first.code, 0, first.raw);
  const log = path.join(first.state, "model.log");
  const env = { TRIAGE_STATE: first.state, FAKE_LOG: log };
  const g = cli(["gather", "card:closed-home", "--root", root], env);
  assert.equal(g.code, 0, g.raw);
  assert.equal(g.out.cached, false);
  assert.deepEqual(g.out.ids, ["card:closed-home", "ticket-0003", "ticket-0005"]);
  assert.deepEqual(g.out.brief.reported, [{ text: 'One guest says "Beach House checkout opens."', cites: ["ticket-0003"] }]);
  assert.deepEqual(g.out.brief.where.map((c) => c.cites), [["src/bookings.ts:2"]]);
  assert.deepEqual(g.out.brief.dropped.map((d) => d.reason), ["no citation", "file was not gathered: src/payments.ts"]);
  assert.ok(g.out.ms.total >= 0 && "cost_usd" in g.out);
  assert.equal(g.out.rules.source, "default");
  const sent = JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n").pop());
  for (const id of ["[ticket-0003]", "[ticket-0005]", "[card:closed-home]"]) assert.ok(sent.input.includes(id), id);
  const again = cli(["gather", "ticket-0005", "--root", root], env);
  assert.equal(again.out.cached, true);
  assert.equal(fs.readFileSync(log, "utf8").trim().split("\n").length, 2, "the brief is cached by content: the planner and Code were asked once, and not again");
  const shown = cli(["show", "--root", root], env).out.pressing[0];
  assert.equal(shown.context.state, "ready");
  const forced = cli(["gather", "card:closed-home", "--root", root, "--force"], env);
  assert.equal(forced.out.cached, false);
});

test("CLI: prompt shows exactly what would be sent; send-main and new-main send issue + brief + rules and say whether the brief was reused", () => {
  const root = project();
  const first = cli(["refresh", "--root", root]);
  const env = { TRIAGE_STATE: first.state };
  const p = cli(["prompt", "card:closed-home", "--root", root], env);
  assert.equal(p.code, 0, p.raw);
  assert.equal(p.out.context.state, "gathered");
  const parts = ["The Issues widget passed you this issue.", "Context gathered by Issues", "\n<<<DATA ", "Closed home bookable  [card:closed-home]", "[ticket-0005] Di", "CONTEXT BRIEF:", "Where it likely lives:", "[src/bookings.ts:2]", "Rules for this hand-off (", "Find the cause before changing anything"];
  let at = -1;
  for (const part of parts) {
    const i = p.out.prompt.indexOf(part);
    assert.ok(i > at, `${part} in order`);
    at = i;
  }
  assert.doesNotMatch(p.out.prompt, /src\/payments\.ts|Everyone is angry/);
  const send = cli(["act", "card:closed-home", "send-main", "--root", root, "--terminal", "t9", "--dry-run"], env);
  assert.equal(send.code, 0, send.raw);
  const same = (x) => x.replace(/^<<<(END )?DATA \w+$/gm, "<<<$1DATA *"); // each prompt has its own fresh fence word; everything else is identical
  assert.notEqual(send.out.prompt, p.out.prompt, "a fresh fence word per prompt");
  assert.equal(same(send.out.prompt), same(p.out.prompt));
  assert.deepEqual(send.out.command.slice(0, 3), ["hc", "send", "t9"]);
  assert.equal(send.out.context.state, "reused");
  const pressed = cli(["act", "card:closed-home", "send-main", "--root", root, "--terminal", "t9", "--dry-run", "--gathered", p.out.context.key], env);
  assert.equal(pressed.out.context.state, "gathered", "the sidebar's own gather step counts as gathered for that press");
  assert.equal(cli(["act", "card:closed-home", "send-main", "--root", root, "--terminal", "t9", "--dry-run", "--gathered", "other"], env).out.context.state, "reused");
  assert.equal(send.out.rules_file, DEFAULT_RULES_FILE);
  const nm = cli(["act", "card:closed-home", "new-main", "--root", root], env);
  assert.deepEqual([nm.out.command.name, same(nm.out.command.args.task), nm.out.command.args.folder], ["space.new", same(p.out.prompt), root]);
  assert.deepEqual(nm.out.command.args.argv, ["pi", "--name", "Main"]);
  assert.equal(cli(["act", "card:closed-home", "send-main", "--root", root], env).err.error.code, "NO_MAIN");
  const r = receiptsOf(first.state);
  assert.deepEqual(r.map((x) => [x.action, x.context.state]), [["send-main", "reused"], ["send-main", "gathered"], ["send-main", "reused"], ["new-main", "reused"]]);
  assert.equal(cli(["show", "--root", root], env).out.pressing[0].sent.action, "new-main");
});

test("CLI: a failed gather is a named state and nothing is sent; sending without context is an explicit choice", () => {
  const root = project();
  const first = cli(["refresh", "--root", root]);
  const env = { TRIAGE_STATE: first.state, FAKE_BRIEF_FAIL: "1" };
  const g = cli(["gather", "card:closed-home", "--root", root], env);
  assert.deepEqual([g.code, g.err.error.code], [1, "GATHER_FAILED"]);
  assert.match(g.err.error.message, /model down/);
  const send = cli(["act", "card:closed-home", "send-main", "--root", root, "--terminal", "t9", "--dry-run"], env);
  assert.deepEqual([send.code, send.err.error.code], [1, "GATHER_FAILED"]);
  assert.match(send.err.error.message, /--no-context/);
  assert.deepEqual(receiptsOf(first.state), [], "no silent send");
  const item = cli(["show", "--root", root], env).out.pressing[0];
  assert.equal(item.context.state, "failed");
  assert.match(item.context.error, /model down/);
  const bare = cli(["act", "card:closed-home", "send-main", "--root", root, "--terminal", "t9", "--dry-run", "--no-context"], env);
  assert.equal(bare.code, 0, bare.raw);
  assert.equal(bare.out.context.state, "none");
  assert.doesNotMatch(bare.out.prompt, /Context gathered by Issues/);
  assert.match(bare.out.prompt, /Rules for this hand-off/);
  const bad = cli(["gather", "card:closed-home", "--root", root], { TRIAGE_STATE: first.state, FAKE_BRIEF: '{"reported":[{"text":"x","cites":[]}]}' });
  assert.match(bad.err.error.message, /no claim survived/);
  assert.equal(cli(["act", "card:closed-home", "send-main", "--root", root, "--terminal", "t9", "--dry-run", "--rules", "/nope/rules.md"], { TRIAGE_STATE: first.state }).err.error.code, "RULES_MISSING");
});

test("no Fixer anywhere a person can see: actions, legend, menu, describe, docs and shipped files", () => {
  const item = { id: "ticket-0001", title: "Refund timing", kind: "inbox", url: null, context: { state: "failed", error: "model down" } };
  const seen = [JSON.stringify(ACTIONS), JSON.stringify(legendEntries(ACTIONS, item, { main: "t1" })), JSON.stringify(legendEntries(ACTIONS, item, {})), JSON.stringify(menuItems(ACTIONS, item, { main: null })), JSON.stringify(cli(["describe"]).out)];
  for (const f of ["main.js", "surface.js", "menu/main.js", "triage.mjs", "src/actions.mjs", "src/handoff.mjs", "src/gather.mjs", "src/gatherers.mjs", "src/issue.mjs", "CONTEXT.md", "checks.md", "rules.md", "install.sh"]) seen.push(fs.readFileSync(path.join(repo, f), "utf8"));
  for (const s of seen) assert.doesNotMatch(s, /fixer/i);
  assert.deepEqual(ACTIONS.map((a) => a.keyLabel), ["C", "M", "N", "B", "O", "D"]);
  assert.equal(cli(["act", "x", "fixer", "--root", os.tmpdir()]).err.error.code, "INVALID");
});

test("legend and menu: every entry has a tooltip 'Action (Key)'; a failed gather offers 'without context' by name", () => {
  const ok = { id: "a", title: "T", kind: "board", url: null, context: { state: "ready" } };
  const failed = { ...ok, context: { state: "failed", error: "model down" } };
  const l = legendEntries(ACTIONS, ok, { main: "t1" });
  assert.deepEqual(l.map((e) => [e.key, e.label]), [["C", "Copy"], ["M", "Main"], ["N", "New"], ["B", "Brief"], ["O", "Open"], ["D", "Dismiss"]]);
  assert.deepEqual(l.map((e) => e.tooltip), ["Copy (C)", "Gather context, then send to Main (M)", "Gather context, then start a new Main (N)", "View the context brief (B)", "Open source (O)", "Dismiss (D)"]);
  assert.match(legendEntries(ACTIONS, ok, {})[1].tooltip, /unavailable\. No Main conversation in this space/);
  const lf = legendEntries(ACTIONS, failed, { main: "t1" });
  assert.deepEqual(lf.filter((e) => e.action.endsWith("-bare")).map((e) => [e.key, e.tooltip]), [["⇧M", "Send to Main without context (⇧M)"], ["⇧N", "New Main without context (⇧N)"]]);
  assert.equal(l.some((e) => e.action.endsWith("-bare")), false, "offered only after a gather failed");
  const m = menuItems(ACTIONS, failed, { main: "t1" });
  assert.ok(m.some((x) => x.label === "Send to Main without context   ⇧M" && x.action === "send-main-bare"));
  assert.ok(menuItems(ACTIONS, ok, { main: "t1" }).some((x) => x.label === "View brief   B"));
  assert.equal(rowStatus(ok, true), "Gathering context…");
  assert.match(rowStatus(failed, false), /^Couldn't gather context: model down/);
  assert.equal(rowStatus(ok, false), "Brief ready · B to view");
});

test("brief view: wrapped lines carry the brief, what was dropped, the rules file and what was sent", () => {
  assert.deepEqual(wrap("one two three four", 9), ["one two", "three", "four"]);
  assert.deepEqual(wrap("abcdefghijkl", 5), ["abcde", "fghij", "kl"]);
  const lines = briefViewLines({ title: "T", cached: true, text: "What is reported:\n- A guest says x [ticket-0003]", brief: { dropped: [{ text: "Bad", reason: "no citation" }] }, ms: { total: 12 }, cost_usd: 0, first: { ms: { total: 4200 }, cost_usd: 0.0031 }, rules: { path: "/w/rules.md", source: "default" }, last_sent: { at: "2026-11-12T17:20:00Z", action: "send-main", context: { state: "reused" }, prompt: "PROMPT LINE" } }, 80).map((l) => l.text);
  for (const part of ["- A guest says x [ticket-0003]", "Dropped by the citation check (1):", "Rules file: /w/rules.md (default)", "Reused the saved brief (first gathered in 4.2 s,", "$0.0031)", "PROMPT LINE"]) assert.ok(lines.some((l) => l.includes(part)), `${part}\n${lines.join("\n")}`);
});

test("the footer after a hand-off says where it went, and the brief's time and cost or that it was reused", async () => {
  const { sentNotice } = await import("../surface.js");
  assert.equal(sentNotice({ action: "send-main", context: { state: "gathered", ms: 6652, cost_usd: 0.00916 } }), "Sent to Main · brief 6.7 s, $0.0092");
  assert.equal(sentNotice({ action: "send-main", context: { state: "reused" } }), "Sent to Main · brief reused");
  assert.equal(sentNotice({ action: "new-main", context: { state: "gathered", ms: 6617, cost_usd: null } }), "New Main started · brief 6.6 s, cost not reported");
  assert.equal(sentNotice({ action: "new-main", context: { state: "none" } }), "New Main started without context");
});

test("new Main: the prompt rides as space.new's task, which the app passes to Pi as its first message", () => {
  const c = newMainCommand("Refund timing unclear and other words that run long enough to be cut", "PROMPT", "/p");
  assert.deepEqual(c, { name: "space.new", args: { name: "Issue: Refund timing unclear and other words tha", folder: "/p", argv: ["pi", "--name", "Main"], task: "PROMPT" } });
});
