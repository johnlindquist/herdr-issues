// Review 1 (of 7b26b87): one test per finding. Each failed by assertion before its fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import * as G from "../src/gatherers.mjs";
import * as GA from "../src/gather.mjs";
import * as S from "../surface.js";

const here = path.dirname(new URL(import.meta.url).pathname);
const repo = path.join(here, "..");
const CLI = path.join(repo, "triage.mjs");
const FAKE = JSON.stringify(["node", path.join(here, "fake-model.mjs")]);
const FAKE_REPLY = JSON.stringify({ headline: "h", pressing: [{ ids: ["card:closed-home", "ticket-0003"], title: "Closed home bookable", why: "Booking: guests say checkout opens" }] });
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const load = async (f) => { try { return await import(f); } catch { return null; } };

function project(root = tmp("rev-proj-")) {
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
  const state = env.TRIAGE_STATE ?? tmp("rev-state-");
  const r = spawnSync("node", ["--disable-warning=ExperimentalWarning", CLI, ...argv], { encoding: "utf8", env: { ...process.env, TRIAGE_MODEL_CMD: FAKE, FAKE_REPLY, TRIAGE_STATE: state, PI_CODING_AGENT_DIR: path.join(state, "no-agent"), ...env } });
  let out = null;
  let err = null;
  try { out = r.stdout ? JSON.parse(r.stdout) : null; } catch {}
  try { err = r.stderr ? JSON.parse(r.stderr.trim().split("\n").pop()) : null; } catch {}
  return { code: r.status, out, err, state, raw: r.stdout + r.stderr };
}
const folderFor = (agentDir, root) => path.join(agentDir, "sessions", `--${root.replace(/^\//, "").replace(/[/:]/g, "-")}--`);
/** Write one Pi session file for `cwd` into the folder Pi would use for `folderRoot` (default: cwd). `messages`: [role, content]. */
function session(agentDir, cwd, name, messages, folderRoot = cwd) {
  const dir = folderFor(agentDir, folderRoot);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [JSON.stringify({ type: "session", version: 3, id: name, timestamp: "2026-11-01T10:00:00Z", cwd }), ...messages.map(([role, content]) => JSON.stringify({ type: "message", id: "m", message: { role, content } }))];
  const file = path.join(dir, `${name}.jsonl`);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  return file;
}
const everyFile = (dir) => fs.readdirSync(dir, { withFileTypes: true, recursive: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath ?? e.path, e.name));

// Every value below is a made-up sentinel. [text, the part that must be gone]
const SECRET_SHAPES = [
  ['checkout {"password":"hunter2"}', "hunter2"],
  ['checkout {"password": "correct horse battery"}', "correct horse"],
  ["checkout {'api_key': 'zzTOPzz1'}", "zzTOPzz1"],
  ['checkout {"db":{"clientSecret":"s3cr3tVal","port":5432}}', "s3cr3tVal"],
  ["checkout password=hunter3", "hunter3"],
  ["checkout password: hunter4", "hunter4"],
  ['checkout PASSWORD = "hunter five"', "hunter five"],
  ["checkout the password is hunter6 ok", "hunter6"],
  ["checkout export STRIPE_SECRET_KEY=sk_live_abcdEFGH12345678", "sk_live_abcdEFGH12345678"],
  ["checkout DATABASE_URL=postgres://admin:pgpass99@db.internal:5432/app", "pgpass99"],
  ["checkout git clone https://jo:ghtoken77@github.com/o/r.git", "ghtoken77"],
  ["checkout Authorization: Bearer abc.def-ghi_123456", "abc.def-ghi_123456"],
  ["checkout curl -H 'authorization: Basic dXNlcjpwYXNz'", "dXNlcjpwYXNz"],
  ["checkout -H \"X-Api-Key: k3yk3yk3y\"", "k3yk3yk3y"],
  ["checkout Cookie: session=abc123xyz; theme=dark", "abc123xyz"],
  ["checkout token ghp_abcdefghijklmnopqrstuvwx1234", "ghp_abcdefghijklmnopqrstuvwx1234"],
  ["checkout github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz", "github_pat_11ABCDEFG0abcdefghijkl"],
  ["checkout sk-ant-api03-abcdefghijklmnop1234", "sk-ant-api03-abcdefghijklmnop1234"],
  ["checkout AKIAABCDEFGHIJKLMNOP", "AKIAABCDEFGHIJKLMNOP"],
  ["checkout xoxb-1234567890-abcdefghij", "xoxb-1234567890-abcdefghij"],
  ["checkout eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.SflKxwRJSMeKKF2QT4fwpM", "SflKxwRJSMeKKF2QT4fwpM"],
  ["checkout -----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA7sentinelKeyBody\n-----END RSA PRIVATE KEY-----", "sentinelKeyBody"],
  ["checkout -----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXkCutOffKeyBody", "CutOffKeyBody"],
  ["checkout id 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", "9f86d081884c7d659a2feaa0c55ad015"],
  ["checkout key Zx8Kq2Lm9Pw4Rt7Yv1Bn6Cd3 end", "Zx8Kq2Lm9Pw4Rt7Yv1Bn6Cd3"],
  ["checkout mail jo.smith@example.com", "jo.smith@example.com"],
  ["checkout file /Users/zed9/secret-project/notes.txt", "/Users/zed9"],
  ["checkout file /home/zed9/x.txt", "/home/zed9"],
  ['checkout {"access_token":"tok_live_1","refresh_token":"tok_live_2"}', "tok_live_2"],
  ["checkout passwd:hunter8;next", "hunter8"],
  ["checkout client_secret => 'hunter9'", "hunter9"],
];
const KEPT = ["closed homes must refuse checkout in src/domain/bookings.ts:15", "createBookingForListing(listing, guestReservationRequest)", "commit 74c56e9 touched app/book/[slug]/page.tsx", "the token count was high and the key idea is simple", "ticket-0007 and card:closed-home-booking", "https://github.com/johnlindquist/rentaplace/issues/18"];

test("finding 1a: redaction is one pure function; a table of credential shapes (quoted and unquoted keys, JSON, env lines, headers, URLs, key blocks, long tokens) all come out gone", () => {
  const left = SECRET_SHAPES.filter(([text, secret]) => G.redact(text).includes(secret)).map(([text]) => text);
  assert.deepEqual(left, [], "these still carry their secret after redact()");
  for (const [text] of SECRET_SHAPES) assert.equal(G.redact(G.redact(text)), G.redact(text), "redacting twice changes nothing");
  for (const k of KEPT) assert.equal(G.redact(k), k, "ordinary project text is left alone");
});

test("finding 1b: nothing from a past conversation reaches a model call, the cache, a receipt, the brief view or Main's prompt unredacted; the fetched excerpt is not stored", () => {
  const root = project();
  const first = cli(["refresh", "--root", root]);
  const agent = path.join(first.state, "agent");
  session(agent, root, "2026-11-01T10-00-00-000Z_aaaa1111", SECRET_SHAPES.map(([text]) => ["user", [{ type: "text", text: text.replace("checkout", "closed checkout") }]]));
  const log = path.join(first.state, "model.log");
  const env = { TRIAGE_STATE: first.state, FAKE_LOG: log, PI_CODING_AGENT_DIR: agent, TRIAGE_CONVERSATIONS: "on", FAKE_PLAN: JSON.stringify({ gatherers: [{ name: "conversations", look_for: "closed checkout", reason: "r" }] }) };
  const g = cli(["gather", "card:closed-home", "--root", root], env);
  assert.equal(g.code, 0, g.raw);
  const conv = g.out.swarm.find((r) => r.name === "conversations");
  assert.ok(conv && conv.fetched > 0, "the conversation was read and matched");
  const send = cli(["act", "card:closed-home", "send-main", "--root", root, "--terminal", "t9", "--dry-run"], env);
  assert.equal(send.code, 0, send.raw);
  const view = S.briefViewLines(g.out, 400).map((l) => l.text).join("\n");
  const sinks = { "model calls": fs.readFileSync(log, "utf8"), "gather output": JSON.stringify(g.out), "Main's prompt": send.out.prompt, "brief view": view };
  for (const f of everyFile(path.join(first.state, "projects"))) sinks[`state file ${path.basename(f)}`] = fs.readFileSync(f, "utf8");
  assert.ok(Object.keys(sinks).some((k) => /receipts/.test(k)) && Object.keys(sinks).some((k) => /brief-/.test(k)));
  const leaks = [];
  for (const [where, text] of Object.entries(sinks)) for (const [, secret] of SECRET_SHAPES) if (text.includes(secret) || text.includes(JSON.stringify(secret).slice(1, -1))) leaks.push(`${where}: ${secret}`);
  assert.deepEqual(leaks, []);
  for (const [where, text] of Object.entries(sinks)) if (/state file|gather output/.test(where)) assert.doesNotMatch(text, /the person wrote: /, `${where} stores the fetched excerpt`);
});

test("finding 1c: one choke point: raw conversation text is a type that cannot be printed, joined or serialised; only redaction opens it", async () => {
  const R = await load("../src/redact.mjs");
  assert.ok(R && typeof R.raw === "function" && typeof R.redactRaw === "function", "src/redact.mjs exports raw() and redactRaw()");
  const x = R.raw('{"password":"hunter2"}');
  assert.throws(() => String(x), /redact/);
  assert.throws(() => `${x}`, /redact/);
  assert.throws(() => x + "", /redact/);
  assert.throws(() => JSON.stringify({ x }), /redact/);
  assert.throws(() => [x].join(","), /redact/);
  assert.deepEqual([Object.keys(x), Object.getOwnPropertyNames(x), Object.getOwnPropertySymbols(x)], [[], [], []], "no readable field holds the text");
  assert.doesNotMatch(R.redactRaw(x), /hunter2/);
  assert.throws(() => R.redactRaw('{"password":"hunter2"}'), /raw/i, "redactRaw takes only the raw type");
  // What reading a session gives back is that type, never a string.
  const m = (role, content) => JSON.stringify({ type: "message", message: { role, content } });
  const texts = G.sessionTexts([m("user", "closed checkout"), m("assistant", [{ type: "text", text: "ok" }])]);
  assert.equal(texts.length, 2);
  for (const t of texts) assert.ok(t.text instanceof R.Raw, "sessionTexts returns Raw text");
  assert.throws(() => JSON.stringify(texts), /redact/);
  // In the source: session files are opened in one function, and the raw type is opened in one place.
  const src = fs.readFileSync(path.join(repo, "src/gatherers.mjs"), "utf8");
  assert.equal((src.match(/redactRaw\(/g) ?? []).length, 1, "gatherers.mjs opens raw text in exactly one place");
  assert.equal((src.match(/sessionTexts\(/g) ?? []).length, 2, "sessionTexts is defined once and called once");
  const others = fs.readdirSync(repo, { recursive: true }).map(String).filter((f) => /\.(mjs|js)$/.test(f) && !/node_modules|^test\//.test(f) && !/src\/(gatherers|redact)\.mjs$/.test(f));
  for (const f of others) assert.doesNotMatch(fs.readFileSync(path.join(repo, f), "utf8"), /redactRaw|sessionTexts|sessionsDirFor|\.pi\/agent/, `${f} has no way to past conversations`);
});

test("finding 2: a session is read only when its own recorded cwd is this project; a shared folder name is not enough", async () => {
  const base = tmp("rev-iso-");
  const mine = path.join(base, "a-b");
  const other = path.join(base, "a", "b");
  fs.mkdirSync(mine);
  fs.mkdirSync(other, { recursive: true });
  const agent = path.join(base, "agent");
  assert.equal(folderFor(agent, mine), folderFor(agent, other), "the two projects map to one sessions folder");
  session(agent, mine, "2026-11-01T10-00-00-000Z_mine0001", [["user", "closed checkout MINE-NOTE"]]);
  session(agent, other, "2026-11-02T10-00-00-000Z_other001", [["user", "closed checkout OTHER-PROJECT-PRIVATE"]]);
  fs.writeFileSync(path.join(folderFor(agent, mine), "2026-11-03T10-00-00-000Z_nohead01.jsonl"), JSON.stringify({ type: "message", message: { role: "user", content: "closed checkout NO-HEADER-PRIVATE" } }) + "\n");
  const got = await G.fetchConversations({ root: mine, agentDir: agent, terms: ["closed", "checkout"], conversations: { mode: "on", dir: folderFor(agent, mine), of: null } });
  const all = JSON.stringify(got);
  assert.match(all, /MINE-NOTE/);
  assert.doesNotMatch(all, /OTHER-PROJECT-PRIVATE/, "another project's conversation was read");
  assert.doesNotMatch(all, /NO-HEADER-PRIVATE/, "a session with no recorded cwd was read");
  assert.equal(got.read.sessions, 1);
});

test("finding 3: a named file that is a symlink out of the project is not read: not collected, not excerpted", () => {
  const root = project();
  const outside = path.join(tmp("rev-outside-"), "private.ts");
  fs.writeFileSync(outside, "// closed checkout OUTSIDE-PRIVATE-SENTINEL\nexport const closed = 1;\n");
  fs.symlinkSync(outside, path.join(root, "src/local.ts"));
  fs.symlinkSync(path.dirname(outside), path.join(root, "linked"));
  const c = GA.collect({ root, title: "Closed home checkout", reports: [{ id: "t1", title: "Closed", body: "Closed checkout. Files: src/local.ts, linked/private.ts, src/bookings.ts" }] });
  assert.doesNotMatch(JSON.stringify(c), /OUTSIDE-PRIVATE-SENTINEL/, "the outside file's lines were collected");
  assert.ok(c.files.some((f) => f.path === "src/bookings.ts"), "a real file inside the project is still read");
  const brief = { reported: [], where: [{ text: "x", cites: ["src/local.ts:1", "linked/private.ts:1"] }], tests: [], unknown: [], dropped: [] };
  assert.doesNotMatch(GA.excerptsFor(brief, root).text, /OUTSIDE-PRIVATE-SENTINEL/);
  // A symlink that stays inside the project is fine.
  fs.symlinkSync(path.join(root, "src/bookings.ts"), path.join(root, "src/alias.ts"));
  assert.match(GA.excerptsFor({ ...brief, where: [{ text: "x", cites: ["src/alias.ts:1"] }] }, root).text, /createBooking/);
});

test("finding 4: when a gatherer's deadline passes its model call is ended, not left running; its cost is unknown, not zero", async () => {
  const done = path.join(tmp("rev-time-"), "done.log");
  const prev = { ...process.env };
  Object.assign(process.env, { TRIAGE_MODEL_CMD: FAKE, FAKE_SLOW_SLOWONE: "1500", FAKE_DONE: done });
  try {
    const g = { name: "slowone", label: "Slow", outside: false, about: "x", fetch: async () => (await new Promise((r) => setTimeout(r, 200)), { items: [{ cite: "commit:abc1234", text: "closed" }], searched: ["1 commit"] }) };
    const t0 = Date.now();
    const [r] = await G.runSwarm({ root: os.tmpdir(), issue: { title: "Closed home", reports: [] }, candidates: { terms: ["closed"], files: [], tests: [], commits: [], reports: [] }, model: "m", timeoutMs: 500, gatherers: [g] });
    assert.equal(r.state, "timeout");
    assert.ok(Date.now() - t0 < 1200, "the swarm returned at the deadline");
    assert.equal(r.cost_usd, null, "a call that was started and cut off has an unknown cost, not $0");
    await new Promise((res) => setTimeout(res, 1900));
    assert.equal(fs.existsSync(done) ? fs.readFileSync(done, "utf8") : "", "", "the model process ran on after the deadline");
  } finally {
    for (const k of ["TRIAGE_MODEL_CMD", "FAKE_SLOW_SLOWONE", "FAKE_DONE"]) prev[k] === undefined ? delete process.env[k] : (process.env[k] = prev[k]);
  }
});

test("finding 5: Packages behind a fake registry: installed against latest, release-note lines, read-only; a registry that does not answer is a named failure", async () => {
  const root = tmp("rev-pkg-");
  const w = (f, s) => (fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }), fs.writeFileSync(path.join(root, f), s));
  w("package.json", JSON.stringify({ dependencies: { "date-lib": "^2.0.0", "@scope/ui": "^1.0.0" } }));
  w("node_modules/date-lib/package.json", JSON.stringify({ version: "2.1.0" }));
  w("node_modules/@scope/ui/package.json", JSON.stringify({ version: "1.4.0" }));
  w("src/payouts.ts", 'import { addDays } from "date-lib";\nimport { Card } from "@scope/ui/card";\nimport fs from "node:fs";\nimport { x } from "./local";\n');
  const before = everyFile(root).sort().map((f) => [f, fs.readFileSync(f, "utf8")]);
  const urls = [];
  const registry = { "date-lib": { version: "2.3.0", repository: { url: "git+https://github.com/acme/date-lib.git" } }, "@scope/ui": { version: "1.4.0" } };
  const fetchJson = async (url) => (urls.push(url), registry[decodeURIComponent(/registry\.npmjs\.org\/(.+)\/latest$/.exec(url)?.[1] ?? "")] ?? null);
  const cmds = [];
  const exec = async (cmd, argv) => (cmds.push([cmd, ...argv]), { ok: true, err: "", out: JSON.stringify([{ tag_name: "v2.3.0", published_at: "2026-10-01T00:00:00Z", html_url: "https://github.com/acme/date-lib/releases/tag/v2.3.0", body: "- fix: payout dates off by one\n- chore: docs" }, { tag_name: "v2.2.0", html_url: "https://github.com/acme/date-lib/releases/tag/v2.2.0", body: "- nothing here" }]) });
  const ctx = { root, terms: ["payout"], candidates: { files: [{ path: "src/payouts.ts" }] }, fetchJson, exec };
  const got = await G.fetchPackages(ctx);
  const byCite = Object.fromEntries(got.items.map((i) => [i.cite, i.text]));
  assert.match(byCite["https://registry.npmjs.org/date-lib/latest"], /date-lib \(imported by src\/payouts\.ts\): package\.json asks \^2\.0\.0; installed 2\.1\.0 .*; latest on npm 2\.3\.0$/);
  assert.match(byCite["https://registry.npmjs.org/@scope/ui/latest"], /installed 1\.4\.0 .*latest on npm 1\.4\.0 \(up to date\)/);
  assert.match(byCite["https://github.com/acme/date-lib/releases/tag/v2.3.0"], /release v2\.3\.0 \(2026-10-01\) notes say: - fix: payout dates off by one/);
  assert.equal(got.items.length, 3, "a release that does not name the issue's words is not an item");
  assert.deepEqual(cmds, [["gh", "api", "repos/acme/date-lib/releases?per_page=6"]], "the only command is one GET");
  assert.ok(urls.every((u) => u.startsWith("https://registry.npmjs.org/")) && urls.length === 2);
  assert.deepEqual(everyFile(root).sort().map((f) => [f, fs.readFileSync(f, "utf8")]), before, "nothing was installed or written");
  // No npm imports: nothing to look at, and no request is made.
  w("src/plain.ts", 'import fs from "node:fs";\n');
  const none = await G.fetchPackages({ ...ctx, candidates: { files: [{ path: "src/plain.ts" }] }, fetchJson: async () => assert.fail("no request expected") });
  assert.deepEqual(none.items, []);
  // The registry does not answer at all: a named failure, never "nothing relevant".
  await assert.rejects(G.fetchPackages({ ...ctx, registry: undefined, fetchJson: async () => null }), /npm registry did not answer/);
  // It answers for one package and not the other: the answer is kept and the failure is listed.
  const half = await G.fetchPackages({ ...ctx, registry: undefined, fetchJson: async (url) => (/date-lib/.test(url) ? registry["date-lib"] : null) });
  assert.ok(half.items.length >= 1 && half.searched.some((s) => /^failed: .*@scope\/ui/.test(s)), JSON.stringify(half.searched));
});

test("finding 6: a brief that finishes gathering after the sidebar moved to another project is not shown there", () => {
  assert.equal(typeof S.briefViewFor, "function", "surface.js decides whether a gathered brief may be shown");
  const doc = { id: "t1", text: "x" };
  assert.equal(S.briefViewFor({ root: "/a", activeRoot: "/b", id: "t1", doc }), null, "project A's brief must not open in project B's sidebar");
  assert.deepEqual(S.briefViewFor({ root: "/a", activeRoot: "/a", id: "t1", doc }), { id: "t1", root: "/a", doc, top: 0 });
  assert.equal(S.briefViewFor({ root: "/a", activeRoot: "/a", id: "t1", doc: null }), null);
  assert.equal(S.viewBelongs({ id: "t1", root: "/a" }, "/b"), false);
  assert.equal(S.viewBelongs({ id: "t1", root: "/a" }, "/a"), true);
  const main = fs.readFileSync(path.join(repo, "main.js"), "utf8");
  assert.match(main, /briefViewFor\(\{ root, activeRoot: this\.root/, "main.js opens a brief only through briefViewFor");
  assert.doesNotMatch(main, /this\.view = \{ id, doc: b, top: 0 \}/, "main.js no longer opens the view unconditionally");
  assert.match(main, /viewBelongs\(this\.view, this\.root\)/, "main.js drops a view that belongs to another project");
});

test("finding 7: two conversations started in the same minute never share a citation", async () => {
  const base = tmp("rev-cite-");
  const root = path.join(base, "proj");
  fs.mkdirSync(root);
  const agent = path.join(base, "agent");
  session(agent, root, "2026-11-01T10-00-05-111Z_01a1d178-aaaa-73cd-84c7-7b3a52381f18", [["system", "s"], ["user", "closed checkout FIRST"]]);
  session(agent, root, "2026-11-01T10-00-40-222Z_01a1d178-bbbb-73cd-84c7-7b3a52381f18", [["system", "s"], ["user", "closed checkout SECOND"]]);
  const got = await G.fetchConversations({ root, agentDir: agent, terms: ["closed", "checkout"], conversations: { mode: "on", dir: folderFor(agent, root), of: null } });
  assert.equal(got.items.length, 2);
  assert.equal(new Set(got.items.map((i) => i.cite)).size, 2, `two different messages share the citation ${got.items[0].cite}`);
  for (const i of got.items) assert.match(i.cite, /^session:2026-11-01T10:00:\d\d\S*#2$/);
});

test("past conversations ship off: read only when the project's setting says on, and the widget says when it is on", () => {
  const root = project();
  const first = cli(["refresh", "--root", root]);
  const agent = path.join(first.state, "agent");
  session(agent, root, "2026-11-01T10-00-00-000Z_aaaa1111", [["user", "closed checkout DEFAULT-OFF-SENTINEL"]]);
  const log = path.join(first.state, "model.log");
  const env = { TRIAGE_STATE: first.state, FAKE_LOG: log, PI_CODING_AGENT_DIR: agent, FAKE_PLAN: JSON.stringify({ gatherers: [{ name: "conversations", look_for: "x", reason: "r" }] }) };
  const g = cli(["gather", "card:closed-home", "--root", root], env);
  assert.equal(g.code, 0, g.raw);
  assert.deepEqual(g.out.states.map((s) => s.name), ["code"], "with no setting, past conversations do not start");
  assert.match(g.out.plan.not_started.find((n) => n.name === "conversations").why, /^off/);
  assert.deepEqual(g.out.conversations, { mode: "off", read: null });
  assert.doesNotMatch(fs.readFileSync(log, "utf8") + JSON.stringify(g.out), /DEFAULT-OFF-SENTINEL/);
  assert.doesNotMatch(fs.readFileSync(log, "utf8").split("\n")[0], /conversations/, "the planner is not offered a gatherer that is off");
  const shown = cli(["show", "--root", root], env).out;
  assert.equal(shown.conversations, "off");
  assert.equal(S.settingsLine(shown), null, "nothing is said while it is off");
  assert.equal(cli(["config", "--root", root, "--conversations", "on"], env).code, 0);
  const on = cli(["show", "--root", root], env).out;
  assert.equal(on.conversations, "on");
  assert.equal(S.settingsLine(on), "Past conversations: on for this project (text only, redacted)");
  const g2 = cli(["gather", "card:closed-home", "--root", root], env);
  assert.deepEqual(g2.out.states.map((s) => s.name), ["code", "conversations"]);
  assert.deepEqual(g2.out.conversations.read, { sessions: 1, entries: 1, found: true });
  assert.match(fs.readFileSync(path.join(repo, "main.js"), "utf8"), /settingsLine\(/, "main.js draws that line");
});
