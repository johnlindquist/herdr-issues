// Issue: one incoming report from a source (a GitHub issue, a support ticket, page feedback, a
// tracker card). Group: issues that are the same report word for word, merged by code before the
// model sees them. The dedupe key, ids, hashes and ordering ties live here and nowhere else.

import { createHash } from "node:crypto";

/** @typedef {"github" | "inbox" | "feedback" | "board"} Kind */
/**
 * @typedef {object} Issue
 * @property {string} id       stable, source-prefixed: "gh#12", "ticket-0003", "feedback-2", "card:closed-home-booking"
 * @property {Kind} kind
 * @property {string} title
 * @property {string} body
 * @property {string|null} url  a link a person can open (null when the source has none)
 * @property {string} where     where it lives, for "Open source" when there is no url
 * @property {string|null} created_at
 * @property {string[]} labels
 * @property {string|null} author
 */
/**
 * @typedef {object} Group
 * @property {string} id        the first member id: what the model and every action refer to
 * @property {string} key       dedupe key (normalized title + body)
 * @property {string} hash      content hash of every member: unchanged hash = nothing new to read
 * @property {Issue[]} members
 */

const KINDS = ["github", "inbox", "feedback", "board"];

export class SchemaError extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.code = "SCHEMA";
  }
}

/** Boundary check for anything a source hands back. @param {any} x @returns {Issue} */
export function parseIssue(x) {
  if (!x || typeof x !== "object") throw new SchemaError("issue is not an object");
  const str = (k, max) => {
    if (typeof x[k] !== "string" || !x[k].trim()) throw new SchemaError(`issue.${k} must be a non-empty string`);
    return x[k].trim().slice(0, max);
  };
  if (!KINDS.includes(x.kind)) throw new SchemaError(`issue.kind must be one of ${KINDS.join(", ")}`);
  return {
    id: str("id", 120),
    kind: x.kind,
    title: str("title", 200),
    body: typeof x.body === "string" ? x.body.trim().slice(0, 4000) : "",
    url: typeof x.url === "string" && /^https?:\/\//.test(x.url) ? x.url : null,
    where: str("where", 400),
    created_at: typeof x.created_at === "string" ? x.created_at : null,
    labels: Array.isArray(x.labels) ? x.labels.filter((l) => typeof l === "string").slice(0, 12) : [],
    author: typeof x.author === "string" ? x.author : null,
  };
}

export const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
export const dedupeKey = (/** @type {Issue} */ i) => `${norm(i.title)}|${norm(i.body).slice(0, 300)}`;
export const hashOf = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);

/** Ids sort by prefix, then numerically: ticket-0002 before ticket-0010, gh#9 before gh#10. */
export function compareIds(a, b) {
  return a.localeCompare(b, "en", { numeric: true });
}

/** Word-for-word duplicates become one group. Groups are ordered by id. @param {Issue[]} issues @returns {Group[]} */
export function groupIssues(issues) {
  /** @type {Map<string, Issue[]>} */
  const byKey = new Map();
  for (const i of issues) {
    const k = dedupeKey(i);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(i);
  }
  return [...byKey.entries()]
    .map(([key, members]) => {
      members.sort((x, y) => compareIds(x.id, y.id));
      return { id: members[0].id, key, hash: hashOf(members), members };
    })
    .sort((x, y) => compareIds(x.id, y.id));
}

/** Newest report time in a group (ties in ranking break on it). */
export const lastAt = (/** @type {Group} */ g) => g.members.map((m) => m.created_at ?? "").sort().pop() ?? "";

/** The issue as plain text: what Copy puts on the clipboard (a hand-off uses src/handoff.mjs issueFor, which pastes every report). @param {Group} g */
export function issueText(g, why = null) {
  const i = g.members[0];
  const lines = [`${i.title}  [${i.id}]`];
  if (g.members.length > 1) lines.push(`Reported ${g.members.length} times: ${g.members.map((m) => m.id).join(", ")}`);
  if (why) lines.push(`Why it's pressing (Issues): ${why}`);
  if (i.labels.length) lines.push(`Labels: ${i.labels.join(", ")}`);
  const authors = [...new Set(g.members.map((m) => m.author).filter(Boolean))];
  if (authors.length) lines.push(`From: ${authors.join(", ")}`);
  if (i.created_at) lines.push(`First reported: ${g.members.map((m) => m.created_at).filter(Boolean).sort()[0]}`);
  lines.push(`Source: ${i.url ?? i.where}`);
  if (i.body) lines.push("", i.body);
  return lines.join("\n");
}
