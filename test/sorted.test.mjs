// Sorted tickets and drafts: what a project's sorter and drafter wrote, read by plain code.
// The named states, the lines that are dropped and counted, and that nothing here can send a draft.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { parseTag, parseDraft, readTags, readDrafts, readSorted, sortedFor, waitReason, amountsIn, WAITING } from "../src/sorted.mjs";
import { ACTIONS, ACTION_NAMES } from "../src/actions.mjs";
import { KEYS } from "../src/settings.mjs";
import { listSections, sortedLine, shortReason, draftViewLines, draftReason } from "../surface.js";

const here = path.dirname(new URL(import.meta.url).pathname);
const CLI = path.join(here, "..", "triage.mjs");
const FAKE = JSON.stringify(["node", path.join(here, "fake-model.mjs")]);
const J = (o) => JSON.stringify(o);
const FACTS = ["- stay asked about: lakeside-a-frame, 2026-11-16 to 2026-11-19, 2 guests", "- total: $468.00", "- cleaning: $60.00"];
const draftRow = (id, extra = {}) => ({ id, at: "2026-11-15T08:00:00Z", writtenBy: "booking", askIfWrong: "pricing", owner: "pricing", money: false, facts: FACTS, draft: "Hi, the total is $468.00, cleaning $60.00 included.\nBooking", status: WAITING, ...extra });

/** A throwaway project: a board and an inbox with four open tickets and one closed. */
function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "issues-sorted-"));
  fs.cpSync(path.join(here, "fixtures/project"), root, { recursive: true });
  fs.mkdirSync(path.join(root, "data"));
  const db = new DatabaseSync(path.join(root, "data/rentaplace.db"));
  db.exec("CREATE TABLE support_tickets (id TEXT, name TEXT, subject TEXT, message TEXT, category TEXT, status TEXT, created_at TEXT);");
  const t = db.prepare("INSERT INTO support_tickets VALUES (?,?,?,?,?,?,?)");
  t.run("ticket-0001", "Ana", "Price for Lakeside", "How much is Lakeside A-Frame from 2026-11-16 to 2026-11-19 for 2 guests?", "uncategorized", "open", "2026-10-23T09:00:00Z");
  t.run("ticket-0002", "Bo", "Refund", "When will my refund show?", "uncategorized", "open", "2026-10-24T09:00:00Z");
  t.run("ticket-0003", "Cy", "Shortchanged", "What landed was for three nights, not four.", "uncategorized", "open", "2026-10-25T09:00:00Z");
  t.run("ticket-0004", "Di", "Two dogs", "Are two small dogs fine?", "uncategorized", "open", "2026-10-25T10:00:00Z");
  t.run("ticket-0005", "Ed", "Solved", "x", "uncategorized", "closed", "2026-10-25T09:00:00Z");
  db.close();
  return root;
}
function cli(argv, env = {}) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("TRIAGE_")));
  const r = spawnSync("node", ["--disable-warning=ExperimentalWarning", CLI, ...argv], { encoding: "utf8", env: { ...clean, TRIAGE_MODEL_CMD: FAKE, TRIAGE_STATE: env.TRIAGE_STATE ?? fs.mkdtempSync(path.join(os.tmpdir(), "issues-sorted-state-")), ...env } });
  return { code: r.status, out: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr ? JSON.parse(r.stderr.trim().split("\n").pop()) : null };
}
const known = new Set(["ticket-0001", "ticket-0002", "ticket-0003", "ticket-0004"]);
const write = (file, rows) => (fs.mkdirSync(path.dirname(file), { recursive: true }), fs.writeFileSync(file, rows.map((r) => (typeof r === "string" ? r : J(r))).join("\n") + "\n"));

test("a tag is kept only in the sorter's shape; waiting is worked out from money and unsure, never from the line's own waitsFor", () => {
  assert.equal(parseTag("{not json").reason, "not JSON");
  assert.equal(parseTag("[1]").reason, "not an object");
  assert.equal(parseTag(J({ owner: "booking", money: false })).reason, "no ticket id");
  assert.match(parseTag(J({ ticketId: "t", owner: "the CEO", money: false })).reason, /owner must be one of/);
  assert.match(parseTag(J({ ticketId: "t", owner: "booking", money: "yes" })).reason, /money must be/);
  assert.match(parseTag(J({ ticketId: "t", owner: "booking", money: false, unsure: "maybe" })).reason, /unsure must be/);
  assert.equal(parseTag(J({ ticketId: "t", owner: "booking", money: false, waitsFor: "a person" })).tag.waits, false);
  assert.equal(parseTag(J({ ticketId: "t", owner: "pricing", money: true })).tag.waits, true);
  const u = parseTag(J({ ticketId: "t", owner: "booking", money: false, unsure: true, why: ["owner confidence 0.52 is under 0.70"] })).tag;
  assert.equal(u.waits, true);
  assert.equal(waitReason(u), "unsure: owner confidence 0.52 is under 0.70");
  assert.equal(waitReason(parseTag(J({ ticketId: "t", owner: "pricing", money: true, unsure: true, why: ["a", "b"] })).tag), "money · unsure: a; b");
  assert.equal(waitReason(parseTag(J({ ticketId: "t", owner: "nobody", money: false })).tag), null);
});

test("the tags file: none, empty, ready; a malformed line is dropped and counted, a second line is repeated, a tag for a ticket not in the inbox is listed and not shown", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "issues-tags-"));
  const f = path.join(dir, "support-tags.jsonl");
  assert.equal(readTags(f, known).state, "none");
  fs.writeFileSync(f, "");
  assert.equal(readTags(f, known).state, "empty");
  write(f, [{ ticketId: "ticket-0002", owner: "pricing", money: true, waitsFor: "a person" }, "{broken", { ticketId: "ticket-0002", owner: "booking", money: false }, { ticketId: "ticket-9999", owner: "booking", money: true }, { ticketId: "ticket-0004", owner: "wizard", money: false }, { ticketId: "ticket-0001", owner: "pricing", money: false }]);
  const r = readTags(f, known);
  assert.equal(r.state, "ready");
  assert.deepEqual([...r.tags.keys()], ["ticket-0002", "ticket-0001"]);
  assert.equal(r.tags.get("ticket-0002").owner, "pricing"); // the first line wins
  assert.deepEqual([r.tagged, r.waiting, r.repeated], [2, 1, 1]);
  assert.deepEqual(r.ticket_gone, ["ticket-9999"]);
  assert.deepEqual(r.dropped.map((d) => d.line), [2, 5]);
  write(f, ["{broken", { ticketId: "ticket-9999", owner: "booking", money: true }]);
  assert.equal(readTags(f, known).state, "empty");
});

test("a draft is kept only when it waits for a person, has facts and states no amount its facts do not hold", () => {
  assert.ok(parseDraft(J(draftRow("ticket-0001"))).draft);
  assert.match(parseDraft(J(draftRow("ticket-0001", { status: "sent" }))).reason, /status is not/);
  assert.match(parseDraft(J(draftRow("ticket-0001", { status: "rejected by the number check" }))).reason, /status is not/);
  assert.equal(parseDraft(J(draftRow("ticket-0001", { facts: [] }))).reason, "no facts");
  assert.equal(parseDraft(J(draftRow("ticket-0001", { draft: " " }))).reason, "no reply text");
  assert.equal(parseDraft(J(draftRow("", {}))).reason, "no ticket id");
  assert.match(parseDraft(J(draftRow("ticket-0001", { draft: "The total is $486.00." }))).reason, /states an amount its facts do not hold \(\$486\.00\)/);
  assert.deepEqual(amountsIn("$468.00, 60 dollars and USD 30").map((a) => a.cents), [46800, 6000, 3000]);
  const d = parseDraft(J(draftRow("ticket-0001"))).draft;
  assert.deepEqual([d.status, d.written_by, d.ask_if_wrong, d.facts[1]], [WAITING, "booking", "pricing", "total: $468.00"]);
});

test("the drafts folder: none, empty, ready; a draft for an unknown ticket and a made-up one are counted, never shown; the question comes from the inbox", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "issues-drafts-"));
  const folder = path.join(dir, "drafts-out");
  assert.equal(readDrafts(folder, known).state, "none");
  fs.mkdirSync(folder);
  assert.equal(readDrafts(folder, known).state, "empty");
  write(path.join(folder, "drafts.jsonl"), [draftRow("ticket-0001"), draftRow("ticket-7777"), draftRow("ticket-0002", { draft: "You get $999.00 back." }), "nope", draftRow("ticket-0001", { draft: "second" })]);
  write(path.join(folder, "rejected.jsonl"), [draftRow("ticket-0003", { status: "rejected by the number check" })]);
  write(path.join(folder, "no-draft.jsonl"), [{ id: "ticket-0004", why: "nobody owns this ticket yet" }]);
  const r = readDrafts(folder, known);
  assert.deepEqual([r.state, r.waiting, r.repeated, r.rejected, r.no_draft, r.sends], ["ready", 1, 1, 1, 1, false]);
  assert.deepEqual(r.unknown_ticket, ["ticket-7777"]);
  assert.deepEqual(r.dropped.map((d) => d.line), [3, 4]);
  assert.ok(!JSON.stringify([...r.drafts.values()]).includes("999"));
  const tickets = [...known].map((id) => ({ id, title: `T ${id}`, body: `B ${id}`, author: "Ana" }));
  write(path.join(dir, "support-tags.jsonl"), [{ ticketId: "ticket-0001", owner: "pricing", money: false }]);
  const s = readSorted({ root: dir, tagsFile: "support-tags.jsonl", draftsFolder: "drafts-out", tickets });
  assert.deepEqual(s.drafts.drafts.get("ticket-0001").question, { subject: "T ticket-0001", message: "B ticket-0001", from: "Ana" });
  const one = sortedFor(["ticket-0001"], s);
  assert.deepEqual([one.sorted.owner, one.sorted.waits, one.draft.ticket], ["pricing", false, "ticket-0001"]);
  assert.deepEqual(sortedFor(["ticket-0003"], s), { sorted: null, draft: null });
});

test("no tags file and no drafts folder: show is the list as it always was, and the states are named", () => {
  const root = project();
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "issues-sorted-state-"));
  const r = cli(["refresh", "--root", root], { TRIAGE_STATE: state });
  assert.equal(r.code, 0);
  assert.deepEqual(r.out.waiting, []);
  assert.deepEqual([r.out.sorted.tags.state, r.out.sorted.drafts.state], ["none", "none"]);
  for (const x of [...r.out.pressing, ...r.out.others]) assert.ok(!("sorted" in x) && !("draft" in x), x.id);
  assert.deepEqual(listSections(r.out).map((s) => s.label.replace(/ · \d+$/, "")), [...(r.out.pressing.length ? ["MOST PRESSING"] : []), ...(r.out.others.length ? ["ALSO OPEN"] : [])]);
  assert.deepEqual(listSections(r.out).flatMap((s) => s.items.map((i) => i.id)), [...r.out.pressing, ...r.out.others].map((i) => i.id));
  const s = cli(["sorted", "--root", root], { TRIAGE_STATE: state });
  assert.deepEqual([s.out.tags.state, s.out.drafts.state, s.out.counts.tickets, s.out.counts.sorted, s.out.waiting.length], ["none", "none", 4, 0, 0]);
});

test("with a tags file and a drafts folder: owners on the tickets, the waiting group first (money, then unsure), the draft beside its ticket, and the most pressing read still there", () => {
  const root = project();
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "issues-sorted-state-"));
  write(path.join(root, "support-tags.jsonl"), [
    { ticketId: "ticket-0003", owner: "booking", money: false, unsure: true, why: ["owner confidence 0.30 is under 0.70"], waitsFor: "a person" },
    { ticketId: "ticket-0001", owner: "pricing", money: false },
    { ticketId: "ticket-0002", owner: "pricing", money: true, waitsFor: "a person" },
    { ticketId: "ticket-0005", owner: "booking", money: true }, // closed: not in the inbox
    "{half a line",
  ]);
  write(path.join(root, "drafts-out/drafts.jsonl"), [draftRow("ticket-0001"), draftRow("ticket-0002", { draft: "Your refund of $75.00 is on its way." }), draftRow("ticket-4040")]);
  const env = { TRIAGE_STATE: state };
  const s = cli(["sorted", "--root", root], env).out;
  assert.deepEqual(s.waiting.map((w) => [w.id, w.owner, w.reason]), [["ticket-0002", "pricing", "money"], ["ticket-0003", "booking", "unsure: owner confidence 0.30 is under 0.70"]]);
  assert.deepEqual([s.tags.state, s.tags.tagged, s.tags.dropped, s.tags.ticket_gone, s.drafts.waiting, s.drafts.dropped, s.drafts.unknown_ticket], ["ready", 3, 1, ["ticket-0005"], 1, 1, ["ticket-4040"]]);
  assert.deepEqual(s.tickets.find((t) => t.id === "ticket-0004"), { id: "ticket-0004", title: "Two dogs", owner: null, money: null, unsure: null, waits_for: null, reason: null, draft: null });
  assert.equal(s.tickets.find((t) => t.id === "ticket-0002").draft, null); // its draft stated $75.00, which its facts do not hold
  const v = cli(["refresh", "--root", root], env).out;
  assert.deepEqual(v.waiting, ["ticket-0002", "ticket-0003"]);
  assert.ok(Array.isArray(v.pressing) && v.headline, "the most pressing read is still made");
  const all = [...v.pressing, ...v.others];
  assert.equal(all.find((x) => x.id === "ticket-0001").sorted.owner, "pricing");
  assert.equal(all.find((x) => x.id === "ticket-0001").draft.question.message, "How much is Lakeside A-Frame from 2026-11-16 to 2026-11-19 for 2 guests?");
  const sections = listSections(v);
  assert.equal(sections[0].label, "WAITING FOR YOU · 2");
  assert.deepEqual(sections[0].items.map((i) => i.id), ["ticket-0002", "ticket-0003"]);
  const ids = sections.flatMap((x) => x.items.map((i) => i.id));
  assert.equal(new Set(ids).size, ids.length, "no issue is listed twice");
  assert.deepEqual([...ids].sort(), all.map((i) => i.id).sort());
  const d = cli(["draft", "ticket-0001", "--root", root], env);
  assert.deepEqual([d.out.status, d.out.sends, d.out.question.subject, d.out.facts[1], d.out.owner], [WAITING, false, "Price for Lakeside", "total: $468.00", "pricing"]);
  assert.equal(cli(["draft", "ticket-0002", "--root", root], env).err.error.code, "NO_DRAFT");
  assert.equal(cli(["draft", "ticket-4040", "--root", root], env).err.error.code, "NOT_FOUND");
  // The two places are settings: a project file can point somewhere else.
  write(path.join(root, ".herdr/issues.json"), [{ tagsFile: "elsewhere/tags.jsonl", draftsFolder: "elsewhere/drafts" }]);
  const moved = cli(["sorted", "--root", root], env).out;
  assert.deepEqual([moved.tags.state, moved.drafts.state], ["none", "none"]);
  assert.ok(moved.tags.file.endsWith("elsewhere/tags.jsonl"));
});

test("nothing sends a draft: no such action, and the agent interface says so", () => {
  assert.ok(!ACTION_NAMES.some((n) => /draft|reply|guest/.test(n)));
  assert.deepEqual(ACTIONS.map((a) => a.name), ["copy", "send-main", "new-main", "brief", "open", "dismiss"]);
  const root = project();
  write(path.join(root, "drafts-out/drafts.jsonl"), [draftRow("ticket-0001")]);
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "issues-sorted-state-"));
  cli(["refresh", "--root", root], { TRIAGE_STATE: state });
  assert.equal(cli(["act", "ticket-0001", "send-draft", "--root", root], { TRIAGE_STATE: state }).err.error.code, "INVALID");
  const before = fs.readFileSync(path.join(root, "drafts-out/drafts.jsonl"), "utf8");
  cli(["draft", "ticket-0001", "--root", root], { TRIAGE_STATE: state });
  cli(["sorted", "--root", root], { TRIAGE_STATE: state });
  assert.equal(fs.readFileSync(path.join(root, "drafts-out/drafts.jsonl"), "utf8"), before);
  assert.deepEqual(fs.readdirSync(root).sort(), ["data", "drafts-out", "tracker"]); // nothing written into the project
  const d = cli(["describe"]).out;
  assert.match(d.commands.sorted, /none \(no tags file\).*empty.*ready.*dropped.*ticket_gone.*unknown_ticket/s);
  assert.match(d.commands.draft, /no action that sends a draft/);
  assert.ok(d.errors.NO_DRAFT && d.settings.tagsFile && d.settings.draftsFolder);
  assert.deepEqual([KEYS.tagsFile.default, KEYS.draftsFolder.default], ["support-tags.jsonl", "drafts-out"]);
});

test("what a person reads: the row's line, the reason in a few words, the draft's lines and the Enter key's reason", () => {
  assert.equal(shortReason("money · unsure: money probability 0.65 is between 0.30 and 0.70; owner confidence 0.30 is under 0.70"), "money · unsure (money 0.65, owner 0.30)");
  assert.equal(shortReason("unsure: something new"), "unsure (something new)");
  assert.equal(sortedLine({ id: "a" }), null);
  assert.equal(sortedLine({ sorted: { owner: "nobody", waits: false } }), "Owner: nobody yet");
  assert.equal(sortedLine({ sorted: { owner: "pricing", waits: true, reason: "money" }, draft: {} }), "Waits for you: money · Owner: Pricing · Draft waiting");
  const item = { id: "ticket-0001", sorted: { owner: "pricing", waits: false }, draft: { ...parseDraft(J(draftRow("ticket-0001"))).draft, question: { subject: "Price for Lakeside", message: "How much?", from: "Ana" } } };
  const text = draftViewLines(item, 60).map((l) => l.text).join("\n");
  for (const want of ["waiting for a person", "Nothing is sent from Issues", "The guest asked (Ana):", "How much?", "Facts code looked up:", "- total: $468.00", "The reply, written by Booking (if it is wrong, ask Pricing):", "the total is $468.00"]) assert.ok(text.includes(want), want);
  assert.deepEqual(draftViewLines({ id: "x" }), []);
  assert.deepEqual([draftReason(null), draftReason({ id: "x" }), draftReason(item)], ["Select an issue first", "No draft for this issue", null]);
});
