// Review 4 (of b1576a9): code excerpts come only from validated file-line citations. Failed by assertion before the fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import * as GA from "../src/gather.mjs";

const here = path.dirname(new URL(import.meta.url).pathname);
const CLI = path.join(here, "..", "triage.mjs");
const FAKE = JSON.stringify(["node", path.join(here, "fake-model.mjs")]);
const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
const ID = "ticket-private.json:1"; // a report id that also reads as line 1 of a file

function project() {
  const root = tmp("rev4-proj-");
  const w = (f, s) => (fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true }), fs.writeFileSync(path.join(root, f), s));
  w("tracker/board.json", JSON.stringify({ cards: [] }));
  w("src/bookings.ts", 'export function createBooking(listing) {\n  if (listing.status === "closed") return null;\n  return { id: 1 };\n}\n');
  w("src/other.ts", "// NEVER-GATHERED-SENTINEL\nexport const unrelated = 1;\n");
  w("ticket-private.json", '{\n  "note": "UNRELATED-FILE-SENTINEL",\n  "customer": "private"\n}\n');
  fs.mkdirSync(path.join(root, "data"));
  const db = new DatabaseSync(path.join(root, "data/rentaplace.db"));
  db.exec("CREATE TABLE support_tickets (id TEXT, name TEXT, subject TEXT, message TEXT, category TEXT, status TEXT, created_at TEXT); CREATE TABLE feedback (id TEXT, page TEXT, rating TEXT, text TEXT, created_at TEXT);");
  db.prepare("INSERT INTO support_tickets VALUES (?,?,?,?,?,?,?)").run(ID, "Cy", "Closed listing still available", "The closed Beach House still opens checkout in src/bookings.ts.", "uncategorized", "open", "2026-10-25T09:00:00Z");
  db.close();
  const git = (...a) => spawnSync("git", ["-C", root, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" });
  git("init", "-q");
  fs.writeFileSync(path.join(root, ".gitignore"), "data/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "Checkout refuses closed listings");
  return root;
}
function cli(argv, env = {}) {
  const state = env.TRIAGE_STATE ?? tmp("rev4-state-");
  const r = spawnSync("node", ["--disable-warning=ExperimentalWarning", CLI, ...argv], { encoding: "utf8", env: { ...process.env, TRIAGE_MODEL_CMD: FAKE, TRIAGE_STATE: state, PI_CODING_AGENT_DIR: path.join(state, "no-agent"), ...env } });
  let out = null;
  try { out = r.stdout ? JSON.parse(r.stdout) : null; } catch {}
  return { code: r.status, out, state, raw: r.stdout + r.stderr };
}

test("a report id that looks like file:line is a report, not a file: no excerpt is read for it, and nothing from that file reaches Main", () => {
  const root = project();
  const FAKE_REPLY = JSON.stringify({ headline: "h", pressing: [{ ids: [ID], title: "Closed home bookable", why: "Booking: a guest says checkout opens" }] });
  const first = cli(["refresh", "--root", root], { FAKE_REPLY });
  assert.equal(first.code, 0, first.raw);
  const log = path.join(first.state, "model.log");
  const env = {
    TRIAGE_STATE: first.state, FAKE_REPLY, FAKE_LOG: log,
    FAKE_BRIEF: JSON.stringify({
      reported: [{ text: "A guest says the closed Beach House opens checkout.", cites: [ID] }],
      where: [{ text: "Likely in createBooking: the cited line checks the listing's status.", cites: ["src/bookings.ts:2"] }],
      tests: [],
      unknown: [{ text: "The report does not say which listing page the guest used.", cites: [ID] }],
    }),
  };
  const g = cli(["gather", ID, "--root", root], env);
  assert.equal(g.code, 0, g.raw);
  const sent = fs.readFileSync(log, "utf8");
  assert.doesNotMatch(sent, /UNRELATED-FILE-SENTINEL/, "the file was never gathered or shown to the small model");
  assert.deepEqual(g.out.brief.unknown.map((c) => c.cites), [[ID]], "the claim citing the report is kept: the id is a real report");
  assert.deepEqual(g.out.excerpts.files.map((f) => f.path), ["src/bookings.ts"], "excerpts were read for something that is not a validated file-line citation");
  assert.doesNotMatch(g.out.excerpts.text, /UNRELATED-FILE-SENTINEL|ticket-private\.json:\d+\|/, "an unrelated file's lines were attached as cited code");
  assert.match(g.out.excerpts.text, /src\/bookings\.ts:2\| /, "the validated file line still gets its excerpt");
  const prompt = cli(["prompt", ID, "--root", root], env).out.prompt;
  assert.doesNotMatch(prompt, /UNRELATED-FILE-SENTINEL/, "the unrelated file reached Main's prompt");
  assert.match(prompt, /src\/bookings\.ts:2\| /);
});

test("excerptsFor reads only lines the model was sent as file lines: not report ids, not a path that was never gathered, and nothing at all without the sent evidence", () => {
  const root = project();
  const sent = {
    reports: [{ id: ID }, { id: "src/other.ts:1" }],
    files: [{ path: "src/bookings.ts", shown: [{ n: 1, text: "" }, { n: 2, text: "" }] }],
    tests: [],
    commits: [],
  };
  const brief = (cites) => ({ reported: [], where: [{ text: "x", cites }], tests: [], unknown: [{ text: "y", cites }], dropped: [] });
  // A version that does not take the sent evidence shows up as a failed comparison, not a crash.
  const excerpts = (...args) => {
    try {
      return GA.excerptsFor(...args);
    } catch (e) {
      return { files: [{ path: `excerptsFor threw: ${e.message}` }], text: "threw" };
    }
  };
  const one = excerpts(brief(["src/bookings.ts:2"]), root, sent);
  assert.deepEqual(one.files.map((f) => f.path), ["src/bookings.ts"]);
  for (const cite of [ID, "src/other.ts:1", "ticket-private.json:2", "src/bookings.ts:4", "README.md:1"]) {
    const r = excerpts(brief([cite]), root, sent);
    assert.deepEqual([cite, r.files, r.text], [cite, [], ""], `${cite} is not a file line the model was sent`);
  }
  const none = excerpts(brief(["src/bookings.ts:2", ID]), root);
  assert.deepEqual([none.files, none.text], [[], ""], "with no sent evidence to check against, nothing is read");
});
