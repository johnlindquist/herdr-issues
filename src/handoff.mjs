// Hand-over: what Main receives when Issues passes it an issue. Three parts in a fixed order:
// the issue (every merged report), the context brief (src/gather.mjs), and the rules. The rules
// live in one file a person can edit; the prompt and the widget both say which file was used.
// Everything here is pure except loadRules, which reads that one file.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashOf } from "./issue.mjs";

/** The project's own rules file, at its top level. When it is absent the widget's shipped rules.md is used. */
export const PROJECT_RULES = "issues-rules.md";
export const DEFAULT_RULES_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "rules.md");

export class RulesMissing extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.code = "RULES_MISSING";
  }
}

/**
 * The one rules file for this hand-off: --rules / config, else <project>/issues-rules.md, else the shipped default.
 * @param {{ root: string, explicit?: string|null }} o @returns {{ path: string, source: "config"|"project"|"default", text: string }}
 */
export function loadRules({ root, explicit = null }) {
  const own = path.join(root, PROJECT_RULES);
  const [file, source] = explicit ? [path.resolve(root, explicit), "config"] : fs.existsSync(own) ? [own, "project"] : [DEFAULT_RULES_FILE, "default"];
  let text;
  try {
    text = fs.readFileSync(file, "utf8").trim();
  } catch {
    throw new RulesMissing(`rules file not found: ${file}`);
  }
  if (!text) throw new RulesMissing(`rules file is empty: ${file}`);
  return { path: file, source: /** @type {any} */ (source), text: text.slice(0, 6000) };
}

const REPORT_CHARS = 1200;
const MAX_REPORTS = 40;

/**
 * One issue as it is handed over: the pressing item's groups (the first is the one shown), with
 * every member report's own text, not only the first.
 * @param {import("./issue.mjs").Group[]} groups @param {string|null} why @param {string|null} title
 */
export function issueFor(groups, why, title) {
  const members = groups.flatMap((g) => g.members);
  const first = members[0];
  const reports = members.map((m) => ({ id: m.id, kind: m.kind, title: m.title, body: m.body, author: m.author, created_at: m.created_at }));
  const lines = [`${title || first.title}  [${first.id}]`];
  if (members.length > 1) lines.push(`Reports (${members.length}): ${members.map((m) => m.id).join(", ")}`);
  if (why) lines.push(`Why it's pressing (Issues): ${why}`);
  const labels = [...new Set(members.flatMap((m) => m.labels))];
  if (labels.length) lines.push(`Labels: ${labels.join(", ")}`);
  const dates = members.map((m) => m.created_at).filter(Boolean).sort();
  if (dates.length) lines.push(`First reported: ${dates[0]}`);
  lines.push(`Source: ${[...new Set(groups.map((g) => g.members[0].url ?? g.members[0].where))].join(" · ")}`);
  for (const m of members.slice(0, MAX_REPORTS)) {
    lines.push("", `[${m.id}] ${[m.author, m.created_at?.slice(0, 10)].filter(Boolean).join(", ")}${m.author || m.created_at ? " · " : ""}${m.title}`);
    if (m.body) lines.push(m.body.slice(0, REPORT_CHARS));
  }
  if (members.length > MAX_REPORTS) lines.push("", `(${members.length - MAX_REPORTS} more reports not pasted: ${members.slice(MAX_REPORTS).map((m) => m.id).join(", ")})`);
  return { id: first.id, ids: members.map((m) => m.id), title: title || first.title, why: why ?? null, hash: hashOf(groups.map((g) => [g.id, g.hash])), reports, text: lines.join("\n") };
}

/**
 * The prompt handed to Main: issue + brief + rules, in that order, and nothing else. With no brief
 * (the person chose "without context") it is issue + rules.
 * @param {{ issue: string, brief: string|null, rules: { path: string, text: string } }} o
 */
export function assemblePrompt({ issue, brief, rules }) {
  if (typeof issue !== "string" || !issue.trim()) throw Object.assign(new Error("prompt needs the issue text"), { code: "INVALID" });
  if (!rules || typeof rules.text !== "string" || !rules.text.trim()) throw new RulesMissing("prompt needs the rules text");
  const parts = [`The Issues widget passed you this issue.\n\n${issue.trim()}`];
  if (brief && brief.trim()) parts.push(`Context gathered by Issues before handing over (a small model condensed what a script found; every line cites its source; nothing was run, so check it before relying on it):\n${brief.trim()}`);
  parts.push(`Rules for this hand-off (${rules.path}):\n${rules.text.trim()}`);
  return parts.join("\n\n");
}
