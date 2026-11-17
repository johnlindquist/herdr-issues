// Sorted tickets and drafts: what a project's own sorter and drafter wrote about its support
// tickets, read by plain code and shown beside the tickets. No model is called here and nothing
// is written: Issues only reads the two places.
//
//   tags file      one JSON line per ticket: { ticketId, owner, money, unsure?, why? }
//   drafts folder  drafts.jsonl, one JSON line per ticket: { id, facts, draft, status }
//                  (rejected.jsonl and no-draft.jsonl are counted, never shown)
//
// The rules live here and nowhere else:
// - A ticket WAITS FOR A PERSON when its tag says money, or says the sorter was unsure. Code works
//   that out from `money` and `unsure`; a line's own "waitsFor" is not trusted.
// - A line that is not exactly the shape above is dropped and counted, with the reason. So is a
//   draft that states an amount its own facts do not hold. A dropped line is never shown as real.
// - A tag or a draft for a ticket that is not in the inbox is counted (its id is listed) and not shown.
// - The first line for a ticket wins; later lines for the same ticket are counted as repeated.

import fs from "node:fs";
import path from "node:path";

export const OWNERS = ["booking", "pricing", "nobody"];
export const WAITING = "waiting for a person";
const NO_SEND = "Nothing is sent from Issues: a person reads the draft and sends it.";

/** Lines of a JSONL file, or null when the file is not there. */
function lines(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  return raw.split("\n").map((l, i) => ({ n: i + 1, text: l.trim() })).filter((l) => l.text);
}

const str = (v) => typeof v === "string" && v.trim().length > 0;

/** One line of the tags file, checked. @returns {{ tag?: any, reason?: string }} */
export function parseTag(text) {
  let x;
  try {
    x = JSON.parse(text);
  } catch {
    return { reason: "not JSON" };
  }
  if (!x || typeof x !== "object" || Array.isArray(x)) return { reason: "not an object" };
  if (!str(x.ticketId)) return { reason: "no ticket id" };
  if (!OWNERS.includes(x.owner)) return { reason: `owner must be one of ${OWNERS.join(", ")}` };
  if (typeof x.money !== "boolean") return { reason: "money must be true or false" };
  if (x.unsure !== undefined && typeof x.unsure !== "boolean") return { reason: "unsure must be true or false" };
  const why = Array.isArray(x.why) ? x.why.filter(str).map((s) => s.trim().slice(0, 120)).slice(0, 4) : str(x.why) ? [x.why.trim().slice(0, 120)] : [];
  const unsure = x.unsure === true;
  return { tag: { ticket: x.ticketId.trim(), owner: x.owner, money: x.money, unsure, why: unsure ? why : [], waits: x.money || unsure, at: str(x.at) ? x.at : null, by: str(x.model) ? x.model : null } };
}

/** Why a ticket waits, in a few words: "money", "unsure: owner confidence 0.52 is under 0.70". */
export function waitReason(tag) {
  if (!tag?.waits) return null;
  const parts = [];
  if (tag.money) parts.push("money");
  if (tag.unsure) parts.push(`unsure${tag.why.length ? `: ${tag.why.join("; ")}` : ""}`);
  return parts.join(" · ");
}

/**
 * The tags file against the tickets in the inbox.
 * state: none (no such file) | empty (a file, no usable line) | ready.
 * @param {string} file @param {Set<string>} known ticket ids in the inbox
 */
export function readTags(file, known) {
  const out = { state: "none", file, tags: new Map(), tagged: 0, waiting: 0, dropped: [], repeated: 0, ticket_gone: [] };
  const ls = lines(file);
  if (!ls) return out;
  const seen = new Set();
  for (const l of ls) {
    const r = parseTag(l.text);
    if (!r.tag) {
      out.dropped.push({ line: l.n, reason: r.reason });
      continue;
    }
    if (seen.has(r.tag.ticket)) {
      out.repeated++;
      continue;
    }
    seen.add(r.tag.ticket);
    if (!known.has(r.tag.ticket)) {
      out.ticket_gone.push(r.tag.ticket);
      continue;
    }
    out.tags.set(r.tag.ticket, r.tag);
  }
  out.tagged = out.tags.size;
  out.waiting = [...out.tags.values()].filter((t) => t.waits).length;
  out.state = out.tags.size ? "ready" : "empty";
  return out;
}

/** Amounts of money a text states, in cents ("$468.00", "468 dollars", "USD 30"). */
export function amountsIn(text) {
  const found = [];
  const re = /(?:\$|USD\s?)\s?(\d[\d,]*(?:\.\d{1,2})?)|(\d[\d,]*(?:\.\d{1,2})?)\s?(?:dollars|USD|bucks)\b/gi;
  for (const m of String(text).matchAll(re)) found.push({ text: m[0].trim(), cents: Math.round(Number((m[1] ?? m[2]).replace(/,/g, "")) * 100) });
  return found;
}

/** One line of drafts.jsonl, checked. @returns {{ draft?: any, reason?: string }} */
export function parseDraft(text) {
  let x;
  try {
    x = JSON.parse(text);
  } catch {
    return { reason: "not JSON" };
  }
  if (!x || typeof x !== "object" || Array.isArray(x)) return { reason: "not an object" };
  if (!str(x.id)) return { reason: "no ticket id" };
  if (x.status !== WAITING) return { reason: `status is not "${WAITING}"` };
  if (!str(x.draft)) return { reason: "no reply text" };
  if (!Array.isArray(x.facts) || !x.facts.length || !x.facts.every(str)) return { reason: "no facts" };
  const allowed = new Set(amountsIn(x.facts.join("\n")).map((a) => a.cents));
  const extra = amountsIn(x.draft).filter((a) => !allowed.has(a.cents));
  if (extra.length) return { reason: `the reply states an amount its facts do not hold (${[...new Set(extra.map((a) => a.text))].join(", ")})` };
  return {
    draft: {
      ticket: x.id.trim(),
      facts: x.facts.map((f) => f.replace(/^-\s*/, "").trim().slice(0, 400)).slice(0, 20),
      reply: x.draft.trim().slice(0, 6000),
      status: WAITING,
      written_by: str(x.writtenBy) ? x.writtenBy : null,
      ask_if_wrong: str(x.askIfWrong) ? x.askIfWrong : str(x.owner) ? x.owner : null,
      at: str(x.at) ? x.at : null,
    },
  };
}

/**
 * The drafts folder against the tickets in the inbox.
 * state: none (no such folder) | empty (a folder, no usable draft) | ready.
 * @param {string} folder @param {Set<string>} known ticket ids in the inbox
 */
export function readDrafts(folder, known) {
  const out = { state: "none", folder, drafts: new Map(), waiting: 0, dropped: [], repeated: 0, unknown_ticket: [], rejected: 0, no_draft: 0, sends: false, note: NO_SEND };
  if (!fs.existsSync(folder)) return out;
  out.state = "empty";
  const seen = new Set();
  for (const l of lines(path.join(folder, "drafts.jsonl")) ?? []) {
    const r = parseDraft(l.text);
    if (!r.draft) {
      out.dropped.push({ line: l.n, reason: r.reason });
      continue;
    }
    if (seen.has(r.draft.ticket)) {
      out.repeated++;
      continue;
    }
    seen.add(r.draft.ticket);
    if (!known.has(r.draft.ticket)) {
      out.unknown_ticket.push(r.draft.ticket);
      continue;
    }
    out.drafts.set(r.draft.ticket, r.draft);
  }
  out.rejected = (lines(path.join(folder, "rejected.jsonl")) ?? []).length;
  out.no_draft = (lines(path.join(folder, "no-draft.jsonl")) ?? []).length;
  out.waiting = out.drafts.size;
  if (out.drafts.size) out.state = "ready";
  return out;
}

/**
 * Both places, for one project. `tickets` are the support tickets in the inbox (issues of kind "inbox").
 * @param {{ root: string, tagsFile: string, draftsFolder: string, tickets: { id: string, title: string, body: string, author?: string|null }[] }} o
 */
export function readSorted({ root, tagsFile, draftsFolder, tickets }) {
  const known = new Set(tickets.map((t) => t.id));
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const tags = readTags(path.resolve(root, tagsFile), known);
  const drafts = readDrafts(path.resolve(root, draftsFolder), known);
  // The draft beside its ticket: the guest's question comes from the inbox, never from the draft row.
  for (const d of drafts.drafts.values()) {
    const t = byId.get(d.ticket);
    d.question = { subject: t.title, message: t.body, from: t.author ?? null };
  }
  return { tags, drafts };
}

/** What one shown issue (one or more tickets) carries: the first tagged ticket's owner, whether any waits and why, and the first draft. */
export function sortedFor(ids, sorted) {
  const tagged = ids.map((id) => sorted.tags.tags.get(id)).filter(Boolean);
  const draft = ids.map((id) => sorted.drafts.drafts.get(id)).find(Boolean) ?? null;
  if (!tagged.length) return { sorted: null, draft };
  const waiting = tagged.filter((t) => t.waits);
  const lead = waiting[0] ?? tagged[0];
  const owners = [...new Set(tagged.map((t) => t.owner))];
  return { sorted: { ticket: lead.ticket, owner: owners.length === 1 ? owners[0] : owners.join(" / "), money: tagged.some((t) => t.money), unsure: tagged.some((t) => t.unsure), waits: waiting.length > 0, reason: waitReason(lead), tagged: tagged.length, of: ids.length }, draft };
}

/** The two places as `show` and `sorted` print them: counts and names, never the dropped lines' content. */
export function summary(sorted) {
  const { tags, drafts } = sorted;
  return {
    tags: { state: tags.state, file: tags.file, tagged: tags.tagged, waiting: tags.waiting, dropped: tags.dropped.length, dropped_lines: tags.dropped, repeated: tags.repeated, ticket_gone: tags.ticket_gone },
    drafts: { state: drafts.state, folder: drafts.folder, waiting: drafts.waiting, dropped: drafts.dropped.length, dropped_lines: drafts.dropped, repeated: drafts.repeated, unknown_ticket: drafts.unknown_ticket, rejected: drafts.rejected, no_draft: drafts.no_draft, sends: false, note: drafts.note },
  };
}

/** The waiting group's order: plainly money first, then money the sorter was unsure about, then unsure only; ties by id as everywhere else. */
const waitRank = (x) => (x.sorted.money && !x.sorted.unsure ? 0 : x.sorted.money ? 1 : 2);
export function waitingOrder(a, b, compareIds) {
  return waitRank(a) - waitRank(b) || compareIds(a.id, b.id);
}
