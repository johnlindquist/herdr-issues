// Review 3 (of 2f792c7): one test per finding. Each failed by assertion before its fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import * as G from "../src/gatherers.mjs";
import * as GA from "../src/gather.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
const repo = path.join(here, "..");
const CLI = path.join(repo, "triage.mjs");
const FAKE = JSON.stringify(["node", path.join(here, "fake-model.mjs")]);
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

/** A project whose one issue has 20 long reports (word-for-word duplicates, so they merge): together they are longer than the model's input limit. */
function bigIssueProject() {
  const root = tmp("rev3-proj-");
  const w = (f, s) => (fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }), fs.writeFileSync(path.join(root, f), s));
  w("tracker/board.json", JSON.stringify({ cards: [] }));
  w("src/bookings.ts", 'export function createBooking(listing) {\n  if (listing.status === "closed") return null;\n  return { id: 1 };\n}\n');
  w("test/bookings.test.ts", 'import { createBooking } from "../src/bookings";\ntest("a closed listing cannot be booked", () => {});\n');
  fs.mkdirSync(path.join(root, "data"));
  const db = new DatabaseSync(path.join(root, "data/rentaplace.db"));
  db.exec("CREATE TABLE support_tickets (id TEXT, name TEXT, subject TEXT, message TEXT, category TEXT, status TEXT, created_at TEXT); CREATE TABLE feedback (id TEXT, page TEXT, rating TEXT, text TEXT, created_at TEXT);");
  const body = `The closed Beach House still opens checkout in src/bookings.ts. ${"It keeps happening when a guest follows an old link. ".repeat(30)}`.slice(0, 1150);
  const t = db.prepare("INSERT INTO support_tickets VALUES (?,?,?,?,?,?,?)");
  for (let i = 1; i <= 20; i++) t.run(`ticket-${String(i).padStart(4, "0")}`, "Cy", "Closed listing still available", body, "uncategorized", "open", `2026-10-${String(i).padStart(2, "0")}T09:00:00Z`);
  db.close();
  const git = (...a) => spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" });
  git("init", "-q");
  fs.writeFileSync(path.join(root, ".gitignore"), "data/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "Checkout refuses closed listings");
  return root;
}
function cli(argv, env = {}) {
  const state = env.TRIAGE_STATE ?? tmp("rev3-state-");
  const r = spawnSync("node", ["--disable-warning=ExperimentalWarning", CLI, ...argv], { encoding: "utf8", env: { ...process.env, TRIAGE_MODEL_CMD: FAKE, TRIAGE_STATE: state, PI_CODING_AGENT_DIR: path.join(state, "no-agent"), ...env } });
  let out = null;
  try { out = r.stdout ? JSON.parse(r.stdout) : null; } catch {}
  return { code: r.status, out, state, raw: r.stdout + r.stderr };
}

test("finding 1 (Code): a claim may cite only evidence that was in the input the model was actually sent; what the size limit cut off cannot be cited and gets no excerpt", () => {
  const root = bigIssueProject();
  const FAKE_REPLY = JSON.stringify({ headline: "h", pressing: [{ ids: ["ticket-0001"], title: "Closed home bookable", why: "Booking: guests say checkout opens" }] });
  const first = cli(["refresh", "--root", root], { FAKE_REPLY });
  assert.equal(first.code, 0, first.raw);
  const log = path.join(first.state, "model.log");
  const env = { TRIAGE_STATE: first.state, FAKE_REPLY, FAKE_LOG: log };
  // First gather: only to see what the Code gatherer is sent.
  cli(["gather", "ticket-0001", "--root", root], { ...env, FAKE_BRIEF: JSON.stringify({ reported: [{ text: "A guest says the closed Beach House opens checkout.", cites: ["ticket-0001"] }], where: [], tests: [], unknown: [] }) });
  const sent = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)).find((c) => /context brief/.test(c.system) && !/^PLANNER|^GATHERER/.test(c.system)).input;
  assert.match(sent, /\[ticket-0001\]/, "the first report was sent");
  assert.match(sent, /cut at the size limit/, "the reports alone pass the size limit");
  assert.doesNotMatch(sent, /src\/bookings\.ts:2\|/, "the code lines were cut off: the model never saw them");
  const all = Array.from({ length: 20 }, (_, i) => `ticket-${String(i + 1).padStart(4, "0")}`);
  const unseen = all.filter((id) => !sent.includes(`[${id}]`));
  assert.ok(unseen.length >= 5, "some reports were cut off too");
  // Second gather: the model's reply cites a code line and a report it was never sent.
  const FAKE_BRIEF = JSON.stringify({
    reported: [{ text: "A guest says the closed Beach House opens checkout.", cites: ["ticket-0001"] }, { text: "A later guest says the same.", cites: [unseen.at(-1)] }],
    where: [{ text: "Likely in createBooking: the cited line checks the listing's status.", cites: ["src/bookings.ts:2"] }],
    tests: [{ text: "a closed listing cannot be booked", cites: ["test/bookings.test.ts:2"] }],
    unknown: [],
  });
  const g = cli(["gather", "ticket-0001", "--root", root, "--force"], { ...env, FAKE_BRIEF });
  assert.equal(g.code, 0, g.raw);
  assert.deepEqual(g.out.brief.where, [], "a claim citing a code line the model was not sent was kept");
  assert.deepEqual(g.out.brief.tests, []);
  assert.deepEqual(g.out.brief.reported.map((c) => c.cites), [["ticket-0001"]], "a claim citing a report the model was not sent was kept");
  assert.equal(g.out.excerpts.text, "", "code was attached as supporting evidence for a claim the model could not have checked");
  assert.equal(g.out.brief.dropped.length, 3);
  for (const d of g.out.brief.dropped) assert.match(d.reason, /not (?:shown|sent) to the model|not in what the model was sent/, d.reason);
  const prompt = cli(["prompt", "ticket-0001", "--root", root], env).out.prompt;
  assert.doesNotMatch(prompt, /createBooking|src\/bookings\.ts:2/);
});

test("finding 1 (judging gatherers): a finding may cite only an item that was in the input the model was sent", async () => {
  const log = path.join(tmp("rev3-judge-"), "model.log");
  const items = Array.from({ length: 80 }, (_, i) => ({ cite: `commit:${(0xabc000 + i).toString(16)}0`, text: `closed checkout change number ${i} ${"detail ".repeat(40)}`.slice(0, 300) }));
  const prev = { ...process.env };
  Object.assign(process.env, { TRIAGE_MODEL_CMD: FAKE, FAKE_LOG: log, FAKE_FINDINGS_BIG: JSON.stringify({ findings: [{ text: "The first change is about closed checkout.", cites: [items[0].cite] }, { text: "The last change is about closed checkout.", cites: [items.at(-1).cite] }, { text: "Both together.", cites: [items[1].cite, items.at(-2).cite] }] }) });
  try {
    const g = { name: "big", label: "Big", outside: false, about: "x", fetch: async () => ({ items, searched: ["80 commits"] }) };
    const [r] = await G.runSwarm({ root: os.tmpdir(), issue: { title: "Closed home", reports: [] }, candidates: { terms: ["closed"], files: [], tests: [], commits: [], reports: [] }, model: "m", timeoutMs: 5000, gatherers: [g] });
    const sent = JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n").pop()).input;
    assert.ok(sent.includes(`[${items[0].cite}]`) && sent.includes(`[${items[1].cite}]`), "the first items were sent");
    assert.ok(!sent.includes(`[${items.at(-1).cite}]`) && !sent.includes(`[${items.at(-2).cite}]`), "the last items were cut off by the size limit");
    assert.deepEqual(r.findings.map((f) => f.text), ["The first change is about closed checkout."], "a finding citing an item the model was not sent was kept");
    assert.deepEqual(r.dropped.map((d) => d.reason), [`not something that was sent to the model: ${items.at(-1).cite}`, `not something that was sent to the model: ${items.at(-2).cite}`]);
    assert.equal(r.fetched, 80);
    assert.ok(r.searched.some((s) => /^\d+ of 80 items fit the model's input/.test(s)), "it says how many items the model was sent");
    // No item is ever sent in part: every item line in the input is whole.
    for (const line of sent.split("\n").filter((l) => l.startsWith("[commit:"))) assert.ok(items.some((i) => line === `[${i.cite}] ${i.text}`), "an item was sent cut in half");
  } finally {
    for (const k of ["TRIAGE_MODEL_CMD", "FAKE_LOG", "FAKE_FINDINGS_BIG"]) prev[k] === undefined ? delete process.env[k] : (process.env[k] = prev[k]);
  }
});

// [what it is, text, the parts that must be gone]
const LEAKS = [
  ["YAML block with Windows line endings (reviewer)", "password: |\r\n  checkout violet\r\n  meadow\r\nnext: kept-value\r\n", ["violet", "meadow"]],
  ["YAML folded block, Windows line endings, nested", "db:\r\n  secret: >-\r\n    checkout crimson\r\n    harbor\r\n  port: 5432\r\n", ["crimson", "harbor"]],
  ["old Mac line endings", "password: |\r  checkout umber\r  falcon\rnext: kept-value\r", ["umber", "falcon"]],
  ["quoted value closing after 8,400 characters (reviewer)", `password: "${"a ".repeat(4200)}\ncheckout violet meadow"`, ["violet", "meadow"]],
  ["single-quoted value closing after 20,000 characters", `api_key = '${"b\n".repeat(10000)}checkout cobalt lantern'`, ["cobalt", "lantern"]],
  ["quoted value that never closes: everything after it", `token: "${"c ".repeat(5000)}\ncheckout saffron quartz`, ["saffron", "quartz"]],
  ["spoken: the api key is (reviewer)", "checkout the api key is violetmeadow", ["violetmeadow"]],
  ["spoken: API key was", "checkout our API key was tealember ok", ["tealember"]],
  ["two words then a colon", "checkout api key: indigothistle", ["indigothistle"]],
  ["two words then equals, quoted", 'checkout access key = "jade moss"', ["jade", "moss"]],
  ["private key is", "checkout the private key is coralreef", ["coralreef"]],
  ["secret key:", "checkout secret key: garnetfive", ["garnetfive"]],
  ["pass phrase is", "checkout the pass phrase is olivethree", ["olivethree"]],
];
test("findings 2 to 4: Windows line endings, a quoted value that closes far away, and two-word names (\"api key\") all lose their value, in redact() and in what the model would be sent", async () => {
  const left = LEAKS.filter(([, text, parts]) => parts.some((p) => G.redact(text).includes(p))).map(([what]) => what);
  assert.deepEqual(left, [], "these named credentials survive redact()");
  for (const [, text] of LEAKS) assert.equal(G.redact(G.redact(text)), G.redact(text), "redacting twice changes nothing");
  assert.match(G.redact(LEAKS[0][1]), /next: kept-value/, "the line after a block is kept");
  assert.match(G.redact(LEAKS[1][1]), /port: 5432/);
  for (const k of ["the key idea is simple", "press any key: it works", "the keyword is closed", "api keys are rotated monthly"]) assert.equal(G.redact(k), k, "ordinary text is left alone");
  // Through the real reader and the real input builder.
  const base = tmp("rev3-");
  const project = path.join(base, "p");
  fs.mkdirSync(project);
  const agent = path.join(base, "agent");
  const dir = G.sessionsDirFor(project, agent);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "2026-11-01T10-00-00-000Z_s1.jsonl"), [JSON.stringify({ type: "session", cwd: project }), ...LEAKS.map(([, text]) => JSON.stringify({ type: "message", message: { role: "user", content: text } }))].join("\n") + "\n");
  const got = await G.fetchConversations({ root: project, agentDir: agent, terms: ["checkout"], conversations: { mode: "on", of: null } });
  assert.equal(got.read.entries, LEAKS.length, "the messages were read");
  const input = G.findingsInput({ title: "Closed home", reports: [] }, got, "checkout") + JSON.stringify(got);
  const sent = LEAKS.flatMap(([what, , parts]) => parts.filter((p) => input.includes(p)).map((p) => `${what}: ${p}`));
  assert.deepEqual(sent, [], "these reach the model's input");
});

test("past conversations are on by default, and the README says in plain words what is read, what is left, and how to turn them off", () => {
  assert.deepEqual(G.availableGatherers().off, []);
  assert.deepEqual(G.availableGatherers({ conversations: "off" }).off.map((g) => g.name), ["conversations"]);
  const readme = fs.existsSync(path.join(repo, "README.md")) ? fs.readFileSync(path.join(repo, "README.md"), "utf8") : "";
  assert.match(readme, /### Past conversations: on, and how to turn it off/, "README.md has the section");
  assert.match(readme, /--conversations off/);
  assert.match(readme, /TRIAGE_CONVERSATIONS=off/);
  assert.match(readme, /may be a different provider/i, "the one limit left is stated");
  assert.doesNotMatch(readme, /off by default|off unless you turn it on|must not be able to switch on/i, "no sentence from the old default is left");
  assert.doesNotMatch(readme, /fixer/i);
});
