// Triage: the judgement. A small model reads the grouped issues and names the few most pressing
// ones, each with a one-line why, merging reports that are the same problem in other words. It
// gets no tools: only the issues as JSON. Everything else is code: which ids exist, what is read
// again (groups whose content hash changed), ordering ties, and the "also open" list.

import { spawn } from "node:child_process";
import { groupIssues, lastAt, compareIds, hashOf } from "./issue.mjs";

/** @typedef {import("./issue.mjs").Group} Group */
/** @typedef {{ id: string, ids: string[], title: string, why: string }} Pressing */
/** @typedef {{ headline: string, pressing: Pressing[] }} Summary */
/** @typedef {{ text: string, ms: number, usage: { input: number, output: number, cost_usd: number } | null }} ModelReply */

export const DEFAULT_MODEL = "anthropic/claude-haiku-4-5"; // the cheap model herdr-todos uses
export const MAX_PRESSING = 5;

const BASELINE = `You triage incoming issues for a software project: support tickets, page feedback, tracker cards and GitHub issues.
Pick the few issues that are most pressing right now (at most ${MAX_PRESSING}) and say why in one short line each.

Pressing means, in this order: money is wrong or at risk (refunds, payouts, charges, prices); something blocks people from booking or using the product; many people report it (see "reported"); it is a duplicate of something already pressing (merge it instead of listing it twice).
Merge issues that describe the same problem in different words, from any source: put every id in one item's "ids", most important first.
Only use ids that appear in the input. Never invent issues, numbers or facts that are not in the input. Questions with an obvious answer and feature ideas are not pressing unless many people ask.
"why" is at most 110 characters, plain words, and names the evidence (e.g. "Money: 4 guests ask where their refund is; tracker card is in Checking").
"headline" is one sentence (at most 90 characters) on the state of the inbox.

Reply with JSON only:
{"headline": "...", "pressing": [{"ids": ["<id>", "..."], "title": "<short title, at most 60 characters>", "why": "..."}]}`;

// Hill-climbed on 2026-11-12 (Haiku, 5 runs x 5 lines, a separate
// judge model checking each why against the reports it cites): the baseline overstated 20 of 25
// lines, this one 6 of 25. The baseline stays selectable so the "before" can be shown.
const NEVER_OVERSTATE = `${BASELINE}

Never overstate what a ticket says. Describe what people asked or saw in their own terms: a question about when something will happen is a question, not a report that it is missing or delayed. Do not add impact, severity or causes that no report states ("blocks", "trust", "under review") unless a report says so.
Start each why with one plain category word (Money, Booking, Usage, Support) and never use the word "blocks" or "blocked" unless a report says something is blocked.
For a tracker card, give its column and what it asks for, never a conclusion it has not reached ("confirms bug", "incorrect amount"). End the why after the evidence: no added consequence such as trust, communication or inventory.`;

/** Named instructions: `--instruction <name>`, config `instruction`, or TRIAGE_INSTRUCTION. */
export const INSTRUCTIONS = { "never-overstate": NEVER_OVERSTATE, baseline: BASELINE };
export const DEFAULT_INSTRUCTION = "never-overstate";
export const SYSTEM = INSTRUCTIONS[DEFAULT_INSTRUCTION];

/** The system prompt for an instruction name; an unknown name is an error, not a silent fallback. */
export function systemFor(name = DEFAULT_INSTRUCTION, maxPressing = MAX_PRESSING) {
  const s = INSTRUCTIONS[name];
  if (!s) throw Object.assign(new Error(`unknown instruction ${name} (use ${Object.keys(INSTRUCTIONS).join(" or ")})`), { code: "INVALID" });
  // The limit is a setting (maxPressing); the instructions name it once, in their second line.
  return maxPressing === MAX_PRESSING ? s : s.replace(`(at most ${MAX_PRESSING})`, `(at most ${maxPressing})`);
}

// ---------- the model call (swappable: TRIAGE_MODEL_CMD) ----------

/** @param {string} cmd @param {string[]} argv @param {string} input @param {number} timeout */
function runProcess(cmd, argv, input, timeout, signal = null) {
  return new Promise((resolve) => {
    const child = spawn(cmd, argv, { env: { ...process.env, PI_NO_TITLE: "1" }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      stderr += `\n[timeout after ${timeout}ms]`;
    }, timeout);
    if (signal) {
      const end = () => {
        child.kill("SIGKILL");
        stderr += "\n[cancelled]";
      };
      signal.aborted ? end() : signal.addEventListener("abort", end, { once: true });
    }
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: String(e) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

/**
 * Pi in print mode, JSON events, no tools, extensions or context files. TRIAGE_MODEL_CMD (a JSON
 * argv array) replaces Pi: it gets {"model","system","input"} on stdin and prints the reply.
 * @returns {Promise<ModelReply>}
 */
export async function callModel({ model, system, input, timeout = 90_000, signal = null, thinking = "off" }) {
  const t0 = Date.now();
  const custom = process.env.TRIAGE_MODEL_CMD;
  if (custom) {
    const argv = JSON.parse(custom);
    if (!Array.isArray(argv) || !argv.length || argv.some((x) => typeof x !== "string")) throw new Error("TRIAGE_MODEL_CMD must be a JSON array of strings");
    const r = await runProcess(argv[0], argv.slice(1), JSON.stringify({ model, system, input }), timeout, signal);
    if (r.code !== 0) throw new Error((r.stderr.trim().split("\n").pop() || `model command exited ${r.code}`).slice(0, 200));
    return { text: r.stdout, ms: Date.now() - t0, usage: null };
  }
  const r = await runProcess(
    "pi",
    ["-p", "--mode", "json", "--no-session", "-ne", "-nt", "-ns", "-np", "-nc", "--no-mcp", "--no-themes", "--thinking", thinking, "--model", model, "--system-prompt", system],
    input,
    timeout,
    signal,
  );
  if (r.code !== 0) throw new Error((r.stderr.trim().split("\n").pop() || `pi exited ${r.code}`).slice(0, 200));
  let last = null;
  for (const line of r.stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.type === "message_end" && ev.message?.role === "assistant") last = ev.message;
    } catch {}
  }
  if (!last) throw new Error("pi printed no assistant message");
  if (last.stopReason === "error") throw new Error(String(last.errorMessage ?? "model error").slice(0, 200));
  const text = (last.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("");
  const u = last.usage;
  return { text, ms: Date.now() - t0, usage: u ? { input: u.input + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0), output: u.output, cost_usd: u.cost?.total ?? 0 } : null };
}

// ---------- what the model reads ----------

/**
 * Changed or new groups are sent in full; a group whose hash matches the last read is sent as its
 * title and counts only, with the last why when it was pressing.
 * @param {Group[]} groups @param {{ hashes?: Record<string,string>, why?: Record<string,string> }} previous
 */
export function modelInput(groups, previous = {}) {
  const hashes = previous.hashes ?? {};
  const why = previous.why ?? {};
  let read = 0;
  const rows = groups.map((g) => {
    const i = g.members[0];
    const same = hashes[g.id] === g.hash;
    if (!same) read++;
    return {
      id: g.id,
      source: i.kind,
      title: i.title,
      reported: g.members.length,
      ...(g.members.length > 1 ? { also: g.members.slice(1).map((m) => m.id) } : {}),
      ...(i.labels.length ? { labels: i.labels } : {}),
      ...(lastAt(g) ? { last_reported: lastAt(g) } : {}),
      ...(same ? { unchanged: true, ...(why[g.id] ? { last_why: why[g.id] } : {}) } : { body: i.body.slice(0, 700) }),
    };
  });
  return { text: `Issues (${groups.length} distinct, ${groups.reduce((n, g) => n + g.members.length, 0)} reports):\n${JSON.stringify(rows)}\n\nReturn the JSON now.`, read, reused: groups.length - read };
}

// ---------- what the model says, checked ----------

/** Boundary check on the model reply: ids must exist; each group is claimed once. @param {string} text @param {Group[]} groups @returns {Summary} */
export function parseSummary(text, groups, maxPressing = MAX_PRESSING) {
  const cleaned = text.replace(/```(?:json)?/g, "");
  const a = cleaned.indexOf("{");
  const b = cleaned.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("model reply had no JSON object");
  const v = JSON.parse(cleaned.slice(a, b + 1));
  const owner = new Map();
  for (const g of groups) for (const m of g.members) owner.set(m.id, g.id);
  const claimed = new Set();
  /** @type {Pressing[]} */
  const pressing = [];
  for (const p of Array.isArray(v.pressing) ? v.pressing : []) {
    if (!p || !Array.isArray(p.ids)) continue;
    const ids = [];
    for (const raw of p.ids) {
      const gid = owner.get(String(raw));
      if (gid && !claimed.has(gid) && !ids.includes(gid)) ids.push(gid);
    }
    if (!ids.length) continue; // a claim with no real source is dropped, never shown
    ids.forEach((x) => claimed.add(x));
    const title = String(p.title ?? "").trim().slice(0, 80) || groups.find((g) => g.id === ids[0]).members[0].title;
    pressing.push({ id: ids[0], ids, title, why: String(p.why ?? "").trim().slice(0, 160) });
    if (pressing.length >= maxPressing) break;
  }
  return { headline: String(v.headline ?? "").trim().slice(0, 200), pressing };
}

/** Everything open that isn't pressing: most reported first, then newest, then id. @param {Group[]} groups @param {Set<string>} skip */
export function others(groups, skip) {
  return groups
    .filter((g) => !skip.has(g.id))
    .sort((x, y) => y.members.length - x.members.length || lastAt(y).localeCompare(lastAt(x)) || compareIds(x.id, y.id));
}

export { groupIssues, hashOf };
