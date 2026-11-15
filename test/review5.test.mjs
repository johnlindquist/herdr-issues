// Review 5 (of 11224aa): a brief cached by an earlier version is never reused. Failed by assertion before the fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { hashOf } from "../src/issue.mjs";
import { collect, gatherSystem } from "../src/gather.mjs";
import { availableGatherers } from "../src/gatherers.mjs";
import { issueFor } from "../src/handoff.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
const CLI = path.join(here, "..", "triage.mjs");
const FAKE = JSON.stringify(["node", path.join(here, "fake-model.mjs")]);
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

function project() {
  const root = tmp("rev5-proj-");
  const w = (f, s) => (fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }), fs.writeFileSync(path.join(root, f), s));
  w("tracker/board.json", JSON.stringify({ cards: [] }));
  w("src/bookings.ts", 'export function createBooking(listing) {\n  if (listing.status === "closed") return null;\n  return { id: 1 };\n}\n');
  fs.mkdirSync(path.join(root, "data"));
  const db = new DatabaseSync(path.join(root, "data/rentaplace.db"));
  db.exec("CREATE TABLE support_tickets (id TEXT, name TEXT, subject TEXT, message TEXT, category TEXT, status TEXT, created_at TEXT); CREATE TABLE feedback (id TEXT, page TEXT, rating TEXT, text TEXT, created_at TEXT);");
  db.prepare("INSERT INTO support_tickets VALUES (?,?,?,?,?,?,?)").run("ticket-0003", "Cy", "Closed listing still available", "The closed Beach House still opens checkout in src/bookings.ts.", "uncategorized", "open", "2026-10-25T09:00:00Z");
  db.close();
  const git = (...a) => spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" });
  git("init", "-q");
  fs.writeFileSync(path.join(root, ".gitignore"), "data/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "Checkout refuses closed listings");
  return root;
}
function cli(argv, env = {}) {
  const state = env.TRIAGE_STATE ?? tmp("rev5-state-");
  const r = spawnSync("node", ["--disable-warning=ExperimentalWarning", CLI, ...argv], { encoding: "utf8", env: { ...process.env, TRIAGE_MODEL_CMD: FAKE, TRIAGE_STATE: state, PI_CODING_AGENT_DIR: path.join(state, "no-agent"), ...env } });
  let out = null;
  try { out = r.stdout ? JSON.parse(r.stdout) : null; } catch {}
  return { code: r.status, out, state, raw: r.stdout + r.stderr };
}

test("a brief cached under the earlier cache version (4) is not reused: the issue is gathered again, and the old brief's excerpts never come back", () => {
  const root = project();
  const FAKE_REPLY = JSON.stringify({ headline: "h", pressing: [{ ids: ["ticket-0003"], title: "Closed home bookable", why: "Booking: a guest says checkout opens" }] });
  const first = cli(["refresh", "--root", root], { FAKE_REPLY });
  assert.equal(first.code, 0, first.raw);
  const env = {
    TRIAGE_STATE: first.state, FAKE_REPLY,
    FAKE_BRIEF: JSON.stringify({ reported: [{ text: "A guest says the closed Beach House opens checkout.", cites: ["ticket-0003"] }], where: [{ text: "Likely in createBooking: the cited line checks the listing's status.", cites: ["src/bookings.ts:2"] }], tests: [], unknown: [] }),
  };
  const g = cli(["gather", "ticket-0003", "--root", root], env);
  assert.equal(g.code, 0, g.raw);
  assert.equal(g.out.cached, false);
  // The key an earlier version would have used for this same issue, evidence, model and settings: the same parts, version 4.
  const dir = path.join(first.state, "projects", fs.readdirSync(path.join(first.state, "projects"))[0]);
  const triage = JSON.parse(fs.readFileSync(path.join(dir, "triage.json"), "utf8"));
  const group = triage.groups.find((x) => x.members.some((m) => m.id === "ticket-0003"));
  const p = triage.summary.pressing.find((x) => x.ids.includes(group.id));
  const issue = issueFor(p.ids.map((x) => triage.groups.find((y) => y.id === x)), p.why, p.title);
  const { ms: _ms, ...stable } = collect({ root, title: issue.title, reports: issue.reports });
  const keyAt = (v) => hashOf({ v, issue: issue.hash, candidates: stable, model: g.out.model, system: hashOf(gatherSystem(g.out.instruction)), gatherers: availableGatherers({ only: null, conversations: "on" }).on.map((x) => x.name), conversations: { mode: "on", of: null } });
  assert.ok([4, 5, 6, 7, 8].some((v) => keyAt(v) === g.out.key), "this test builds the cache key the way the widget does");
  // Plant what a version-4 cache would hold: a brief whose excerpts were made before the excerpt fix.
  const old = { ...g.out, key: keyAt(4), excerpts: { text: "== ticket-private.json (4 lines)\nticket-private.json:1| PRE-FIX-EXCERPT-SENTINEL", files: [{ path: "ticket-private.json", ranges: [[1, 4]] }], lines: 1, cut: false } };
  fs.writeFileSync(path.join(dir, `brief-${keyAt(4)}.json`), JSON.stringify(old));
  const again = cli(["gather", "ticket-0003", "--root", root], env);
  assert.equal(again.code, 0, again.raw);
  assert.notEqual(again.out.key, keyAt(4), "the widget still looks under the version-4 key");
  assert.doesNotMatch(again.out.excerpts.text, /PRE-FIX-EXCERPT-SENTINEL/, "the version-4 brief's excerpts were returned from the cache");
  assert.deepEqual(again.out.excerpts.files.map((f) => f.path), ["src/bookings.ts"]);
  const prompt = cli(["prompt", "ticket-0003", "--root", root], env).out.prompt;
  assert.doesNotMatch(prompt, /PRE-FIX-EXCERPT-SENTINEL/, "the version-4 brief's excerpts reached Main's prompt");
  // The current version's own brief is still reused.
  assert.equal(again.out.cached, true, "an unchanged issue reuses the brief this version made");
  assert.equal(again.out.key, g.out.key);
});
