// The swarm: several small, fast gatherers run in parallel before a hand-off. Each has one job and
// the same contract:
//   in:  the issue with its merged reports (+ what code already collected in the project)
//   out: { state: "findings" | "nothing" | "timeout" | "error", findings: [{ text, cites }], ... }
// Code fetches and bounds; the small model only judges relevance and condenses; a finding is kept
// only when every citation is something code actually fetched (a file line, a ticket or card id, a
// commit, a URL). "Nothing relevant" is a real result and is shown as such, never padded. One slow
// or failed gatherer never blocks the others or the hand-off.
//
// To add or remove a gatherer: one line in GATHERERS below.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { callModel } from "./triage.mjs";
import { hashOf } from "./issue.mjs";
import { collect, gatherInput, gatherSystem, parseBrief, briefText, excerptsFor, termsOf, GatherFailed, DEFAULT_GATHER_INSTRUCTION } from "./gather.mjs";

/** @typedef {{ cite: string, text: string }} Item something code fetched; `cite` is how a finding points at it */
/** @typedef {{ items: Item[], searched: string[] }} Fetched */
/** @typedef {{ text: string, cites: string[] }} Finding */
/**
 * @typedef {object} GathererResult
 * @property {string} name
 * @property {string} label
 * @property {boolean} outside            true when it looks outside the project (leads to verify)
 * @property {"findings"|"nothing"|"timeout"|"error"} state
 * @property {Finding[]} findings
 * @property {{ text: string, cites: string[], reason: string }[]} dropped
 * @property {string[]} searched          what was looked at, in plain words
 * @property {number} fetched             how many items code fetched for the model to judge
 * @property {number} ms
 * @property {number|null} cost_usd
 * @property {{ input: number, output: number }|null} tokens
 * @property {string|null} error
 * @property {string} [text]              the code gatherer's own four-part brief
 * @property {any} [brief]
 */

export const SWARM_LIMITS = { timeoutMs: 20_000, planMs: 12_000, fetchMs: 6000, items: 24, itemChars: 400, inputChars: 9000, packages: 4, upstream: 2, findings: 4, sessions: 20, sessionBytes: 4_000_000, sessionEntries: 3000, sessionItems: 14, sessionChars: 520 };
/** The cap for one press: at most 6 small-model calls (the planner and five gatherers), each with a bounded input (code 14k characters, the others 9k) and a time box. A press that reports more than this is flagged. */
export const COST_CAP_USD = 0.05;

// ---------- small helpers (injectable in tests through ctx.exec / ctx.fetchJson) ----------

/** @param {string} cmd @param {string[]} argv @param {{ cwd?: string, timeout?: number }} [o] @returns {Promise<{ ok: boolean, out: string, err: string }>} */
export function execP(cmd, argv, o = {}) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let child;
    try {
      child = spawn(cmd, argv, { cwd: o.cwd, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" } });
    } catch (e) {
      return resolve({ ok: false, out: "", err: String(e) });
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), o.timeout ?? SWARM_LIMITS.fetchMs);
    child.stdout.on("data", (d) => (out += d).length > 2_000_000 && child.kill("SIGKILL"));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => (clearTimeout(timer), resolve({ ok: false, out, err: String(e) })));
    child.on("close", (code) => (clearTimeout(timer), resolve({ ok: code === 0, out, err: err.trim().split("\n").pop() ?? "" })));
  });
}

/** GET a JSON document (the npm registry). Read-only. */
export async function fetchJson(url, timeout = SWARM_LIMITS.fetchMs) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeout), headers: { accept: "application/json" } });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

const parse = (s, fallback) => {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};
const clip = (s, n = SWARM_LIMITS.itemChars) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** npm packages the gathered code files import (bare specifiers that the project's package.json declares). */
export function importedPackages(root, files) {
  const pkg = parse(readText(path.join(root, "package.json")), {});
  const declared = { ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) };
  const out = new Map();
  for (const f of files) {
    const src = readText(path.join(root, f));
    for (const m of src.matchAll(/(?:from\s+|require\(\s*|import\s+)['"]([^'"./][^'"]*)['"]/g)) {
      const name = m[1].startsWith("@") ? m[1].split("/").slice(0, 2).join("/") : m[1].split("/")[0];
      if (declared[name] && !out.has(name)) out.set(name, { name, range: declared[name], importedBy: f });
    }
  }
  return [...out.values()].slice(0, SWARM_LIMITS.packages);
}

function readText(file) {
  try {
    return fs.statSync(file).size < 3_000_000 ? fs.readFileSync(file, "utf8") : "";
  } catch {
    return "";
  }
}

/** The version actually installed: node_modules, else the lockfile, else unknown. */
export function installedVersion(root, name) {
  const nm = parse(readText(path.join(root, "node_modules", name, "package.json")), null);
  if (nm?.version) return { version: nm.version, from: `node_modules/${name}/package.json` };
  for (const lock of ["pnpm-lock.yaml", "package-lock.json", "yarn.lock"]) {
    const text = readText(path.join(root, lock));
    if (!text) continue;
    const esc = name.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    const m = new RegExp(`(?:^|[\\s'"/])${esc}@(\\d+\\.\\d+\\.\\d+[\\w.-]*)`, "m").exec(text) ?? new RegExp(`"node_modules/${esc}":\\s*\\{\\s*"version":\\s*"([^"]+)"`).exec(text);
    if (m) return { version: m[1], from: lock };
  }
  return { version: null, from: null };
}

/** owner/name from a repository URL as npm gives it. */
export const repoOfUrl = (u) => /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?(?:[#/].*)?$/.exec(String(u ?? ""))?.[1] ?? null;

// ---------- the gatherers' fetch halves (code only) ----------

/** HISTORY: recent commits on the gathered files, commits whose message names the issue's terms, who last changed the matching lines, and earlier cards and tickets on the same thing. */
export async function fetchHistory(ctx) {
  /** @type {Item[]} */
  const items = [];
  const searched = [];
  const files = [...ctx.candidates.files, ...ctx.candidates.tests].map((f) => f.path);
  const git = (argv) => ctx.exec("git", ["-C", ctx.root, ...argv], { timeout: 3000 });
  const seen = new Set();
  const addCommit = (sha, date, subject, note) => {
    if (!sha || seen.has(sha)) return;
    seen.add(sha);
    items.push({ cite: `commit:${sha}`, text: clip(`${date} ${subject}${note ? ` (${note})` : ""}`) });
  };
  for (const k of ctx.candidates.commits) addCommit(k.sha, k.date, k.subject, `touches ${k.files.join(", ")}`);
  if (files.length) searched.push(`git log on ${files.length} gathered files`);
  const jobs = ctx.terms.slice(0, 3).map(async (t) => {
    const r = await git(["log", "-n", "3", "-i", `--grep=${t}`, "--date=short", "--format=%h%x09%ad%x09%s"]);
    for (const line of r.out.split("\n").filter(Boolean)) {
      const [sha, date, subject] = line.split("\t");
      addCommit(sha, date, subject, `message mentions "${t}"`);
    }
  });
  // Who last changed the lines that match the issue's terms (first matches in the two strongest files).
  const blame = ctx.candidates.files.slice(0, 2).flatMap((f) => f.shown.filter((l) => ctx.terms.some((t) => l.text.toLowerCase().includes(t))).slice(0, 2).map((l) => ({ file: f.path, n: l.n })));
  jobs.push(
    ...blame.map(async ({ file, n }) => {
      const r = await git(["blame", "-L", `${n},${n}`, "--date=short", "-s", "--abbrev=7", "--", file]);
      const sha = /^\^?([0-9a-f]{7,})/.exec(r.out)?.[1]?.slice(0, 7);
      if (!sha) return;
      const info = (await git(["log", "-n", "1", "--date=short", "--format=%h%x09%ad%x09%s", sha])).out.trim().split("\t");
      items.push({ cite: `${file}:${n}`, text: clip(`this line was last changed in commit ${info[0] ?? sha} on ${info[1] ?? "?"}: ${info[2] ?? ""}`) });
    }),
  );
  await Promise.all(jobs);
  if (ctx.terms.length) searched.push(`commit messages naming ${ctx.terms.slice(0, 3).map((t) => `"${t}"`).join(", ")}`);
  if (blame.length) searched.push(`git blame on ${blame.length} matching lines`);
  // Earlier cards on the board (done) that name the same terms or the same files.
  const board = parse(readText(path.join(ctx.root, "tracker/board.json")), null);
  if (board) {
    const mine = new Set(ctx.issue.ids);
    for (const c of board.cards ?? []) {
      if (!c || c.column !== "done" || mine.has(`card:${c.id}`)) continue;
      const text = `${c.title} ${c.description ?? ""}`.toLowerCase();
      const sameFile = (c.files ?? []).filter((f) => files.includes(f));
      if (!sameFile.length && !ctx.terms.slice(0, 6).some((t) => text.includes(t))) continue;
      items.push({ cite: `card:${c.id}`, text: clip(`done card "${c.title}": ${c.description ?? ""}${c.files?.length ? ` Files: ${c.files.join(", ")}` : ""}${c.commit ? ` Commit: ${c.commit}` : ""}`) });
    }
    searched.push("done cards on tracker/board.json");
  }
  return { items: items.slice(0, SWARM_LIMITS.items), searched };
}

/** The GitHub repo of a project: its origin, or (when origin is a local folder) that folder's origin. */
export async function githubRepo(ctx) {
  if (ctx.repo) return ctx.repo;
  let dir = ctx.root;
  for (let hop = 0; hop < 2; hop++) {
    const url = (await ctx.exec("git", ["-C", dir, "remote", "get-url", "origin"], { timeout: 2000 })).out.trim();
    const repo = repoOfUrl(url);
    if (repo) return repo;
    if (!url || !path.isAbsolute(url) || !fs.existsSync(url)) return null;
    dir = url;
  }
  return null;
}

/** For each imported package: what the registry says (latest version, repository). Shared by GITHUB and PACKAGES. */
function registry(ctx, name) {
  ctx.registry ??= new Map();
  if (!ctx.registry.has(name)) ctx.registry.set(name, ctx.fetchJson(`https://registry.npmjs.org/${name.replace("/", "%2f")}/latest`));
  return ctx.registry.get(name);
}

/** GITHUB (read-only `gh search` / `gh api` GETs): related issues and PRs in this repo, in the upstream repos of the packages the gathered code imports, and related projects. */
export async function fetchGithub(ctx) {
  /** @type {Item[]} */
  const items = [];
  const searched = [];
  const have = await ctx.exec("gh", ["--version"], { timeout: 2000 });
  if (!have.ok) throw new Error("gh is not installed or not on PATH");
  const q = ctx.terms.slice(0, 2).join(" ");
  if (!q) return { items, searched: ["no distinctive terms to search GitHub for"] };
  const search = async (kind, repo, query, limit) => {
    const r = await ctx.exec("gh", ["search", kind, query, ...(repo ? ["--repo", repo] : []), "--limit", String(limit), "--json", kind === "repos" ? "fullName,description,url,stargazersCount,updatedAt" : "number,title,url,state,updatedAt,repository"]);
    if (!r.ok) return searched.push(`${kind} search failed${repo ? ` in ${repo}` : ""}: ${clip(r.err, 80)}`);
    searched.push(`${kind}${repo ? ` in ${repo}` : " on GitHub"} for "${query}"`);
    for (const x of parse(r.out, [])) {
      if (!x?.url || items.some((i) => i.cite === x.url)) continue;
      items.push({ cite: x.url, text: clip(kind === "repos" ? `related project ${x.fullName} (${x.stargazersCount ?? 0} stars, updated ${String(x.updatedAt).slice(0, 10)}): ${x.description ?? ""}` : `${kind === "prs" ? "pull request" : "issue"} #${x.number} in ${repo ?? x.repository?.nameWithOwner ?? "?"} (${x.state}, updated ${String(x.updatedAt).slice(0, 10)}): ${x.title}`) });
    }
  };
  const repo = await githubRepo(ctx);
  const jobs = [];
  if (repo) jobs.push(search("issues", repo, q, 5), search("prs", repo, q, 3), ...(ctx.terms[0] && ctx.terms[0] !== q ? [search("issues", repo, ctx.terms[0], 4)] : []));
  else searched.push("this project has no GitHub repository (no github.com origin)");
  const pkgs = importedPackages(ctx.root, ctx.candidates.files.map((f) => f.path)).slice(0, SWARM_LIMITS.upstream);
  for (const p of pkgs) {
    jobs.push(
      (async () => {
        const up = repoOfUrl((await registry(ctx, p.name))?.repository?.url);
        if (up) await search("issues", up, q, 3);
        else searched.push(`no upstream repository found for ${p.name}`);
      })(),
    );
  }
  if (!pkgs.length) searched.push("the gathered code imports no npm packages, so no upstream repositories were searched");
  jobs.push(search("repos", null, ctx.titleTerms.slice(0, 3).join(" ") || q, 3));
  await Promise.all(jobs);
  return { items: items.slice(0, SWARM_LIMITS.items), searched };
}

/** PACKAGES (npm registry and `gh api` GETs; nothing is installed): installed against latest for the packages the gathered code imports, and release-note lines that name the issue's terms. */
export async function fetchPackages(ctx) {
  /** @type {Item[]} */
  const items = [];
  const searched = [];
  const pkgs = importedPackages(ctx.root, ctx.candidates.files.map((f) => f.path));
  if (!pkgs.length) return { items, searched: ["the gathered code imports no npm packages (only built-ins and the project's own files)"] };
  await Promise.all(
    pkgs.map(async (p) => {
      const latest = await registry(ctx, p.name);
      const inst = installedVersion(ctx.root, p.name);
      if (!latest?.version) return searched.push(`the npm registry did not answer for ${p.name}`);
      const url = `https://registry.npmjs.org/${p.name}/latest`;
      searched.push(`${p.name}: installed against latest on the npm registry`);
      items.push({ cite: url, text: clip(`${p.name} (imported by ${p.importedBy}): package.json asks ${p.range}; installed ${inst.version ?? "not found"}${inst.from ? ` (per ${inst.from})` : ""}; latest on npm ${latest.version}${inst.version && inst.version === latest.version ? " (up to date)" : ""}`) });
      const up = repoOfUrl(latest.repository?.url);
      if (!up) return;
      const r = await ctx.exec("gh", ["api", `repos/${up}/releases?per_page=6`]); // a GET
      if (!r.ok) return searched.push(`release notes not readable for ${up}`);
      searched.push(`last 6 release notes of ${up} for ${ctx.terms.slice(0, 4).map((t) => `"${t}"`).join(", ")}`);
      for (const rel of parse(r.out, [])) {
        const hits = String(rel?.body ?? "").split("\n").filter((l) => ctx.terms.slice(0, 6).some((t) => l.toLowerCase().includes(t))).slice(0, 3);
        if (hits.length && rel.html_url) items.push({ cite: rel.html_url, text: clip(`${p.name} release ${rel.tag_name} (${String(rel.published_at).slice(0, 10)}) notes say: ${hits.join(" / ")}`) });
      }
    }),
  );
  return { items: items.slice(0, SWARM_LIMITS.items), searched };
}

// ---------- PAST CONVERSATIONS: this project's Pi sessions, text only, redacted, read-only ----------

/** Where Pi keeps a project's sessions: <agent dir>/sessions/--<project path with / as ->--. */
export function sessionsDirFor(root, agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi/agent")) {
  return path.join(agentDir, "sessions", `--${path.resolve(root).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
}

const SECRETS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant|or)?[-_]?[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_\w{20,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bxox[abprs]-[\w-]{10,}/g,
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g,
  /\bBearer\s+[\w.~+/=-]{12,}/gi,
  /\b[0-9a-f]{32,}\b/gi,
];
/** Secrets, tokens, keys, e-mail addresses and absolute home paths out, before any model sees the text. Pure. */
export function redact(text) {
  let s = String(text ?? "");
  s = s.replace(/\b((?:[\w-]*(?:password|passwd|secret|token|api[_-]?key|apikey|authorization|credential)[\w-]*))(\s*[:=]\s*)(["']?)[^\s"',;]{4,}\3/gi, "$1$2[redacted]");
  for (const re of SECRETS) s = s.replace(re, "[redacted]");
  // long random-looking strings (mixed case and digits, no path or word shape)
  s = s.replace(/\b[A-Za-z0-9+_-]{32,}={0,2}/g, (m) => (/[a-z]/.test(m) && /[A-Z]/.test(m) && /\d/.test(m) ? "[redacted]" : m));
  s = s.replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, "[email]");
  s = s.replace(/(?:\/Users|\/home)\/[^/\s"'`)]+/g, "~").replace(/[A-Z]:\\Users\\[^\\\s"']+/g, "~");
  return s;
}

/** The user and assistant TEXT of one session file's lines: never tool calls, tool results, thinking or system messages. Pure. */
export function sessionTexts(lines) {
  const out = [];
  let n = 0;
  for (const line of lines) {
    const o = parse(line, null);
    if (o?.type !== "message") continue;
    n++; // the entry number counts every message, so a citation points at the same place whatever is filtered
    const role = o.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const c = o.message.content;
    const text = typeof c === "string" ? c : Array.isArray(c) ? c.filter((x) => x?.type === "text" && typeof x.text === "string").map((x) => x.text).join("\n") : "";
    if (text.trim()) out.push({ entry: n, role, text });
  }
  return out;
}

/** PAST CONVERSATIONS: this project's own Pi sessions (newest first, bounded), text only, redacted; entries that name the issue's terms. Never writes. */
export async function fetchConversations(ctx) {
  const dir = ctx.conversations?.dir || sessionsDirFor(ctx.root);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort().reverse().slice(0, SWARM_LIMITS.sessions);
  } catch {
    return { items: [], searched: ["no past Pi conversations found for this project"], read: { sessions: 0, entries: 0, found: false } };
  }
  const terms = [...new Set([...ctx.terms, ...termsOf(ctx.lookFor ?? "", [])])].slice(0, 10);
  const hits = [];
  let entries = 0;
  let sessions = 0;
  for (const f of files) {
    let raw = "";
    try {
      const fd = fs.openSync(path.join(dir, f), "r"); // read-only
      const buf = Buffer.alloc(Math.min(fs.fstatSync(fd).size, SWARM_LIMITS.sessionBytes));
      fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      raw = buf.toString("utf8");
    } catch {
      continue;
    }
    sessions++;
    const when = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})/.exec(f);
    const stamp = when ? `${when[1]}T${when[2]}:${when[3]}` : f.slice(0, 16);
    for (const e of sessionTexts(raw.split("\n")).slice(0, SWARM_LIMITS.sessionEntries)) {
      entries++;
      const text = redact(e.text);
      const low = text.toLowerCase();
      const found = terms.filter((t) => low.includes(t));
      if (!found.length) continue;
      const at = Math.max(0, low.indexOf(found[0]) - 160);
      hits.push({ score: found.length, cite: `session:${stamp}#${e.entry}`, text: clip(`${e.role === "user" ? "the person" : "the assistant"} wrote: ${at ? "…" : ""}${text.slice(at, at + SWARM_LIMITS.sessionChars)}`, SWARM_LIMITS.sessionChars + 40) });
    }
  }
  hits.sort((a, b) => b.score - a.score);
  const items = hits.slice(0, SWARM_LIMITS.sessionItems).map(({ cite, text }) => ({ cite, text }));
  return { items, searched: [`${sessions} past conversation${sessions === 1 ? "" : "s"} in this project (${entries} messages; text only, redacted) for ${terms.slice(0, 5).map((t) => `"${t}"`).join(", ")}`], read: { sessions, entries, found: true } };
}

// ---------- the judging half (the small model), checked by code ----------

const FOCUS = {
  history: "commits, blamed lines and earlier tracker cards from this project's own history",
  github: "issues, pull requests and projects found on GitHub by a read-only search. They are from outside this conversation: leads to verify, not facts",
  packages: "versions of the packages the gathered code imports, and lines from their release notes. They are leads to verify, not facts",
  conversations: "things the person and their assistant wrote in earlier conversations about this project (text only, redacted). Look for decisions already made, things already tried and preferences stated. They are leads to verify, not facts",
};

/** The instruction for a judging gatherer. The words "context brief" and "GATHERER: <name>" are also how the test model tells the calls apart. */
export const findingsSystem = (name) => `GATHERER: ${name}
You help prepare a context brief for a senior engineer who is about to look at one incoming issue. A script fetched the ITEMS below: ${FOCUS[name] ?? name}. You have no tools and see nothing else.

Decide which items are relevant to THIS issue and say why in one line each.
- Most items will not be relevant. An item is relevant only if it is about the same behaviour, the same code or the same question as the reports. If none is, reply {"findings": []}. Never pad: "nothing relevant" is a good answer.
- Each finding says what the item is, in its own words, then "may matter because" and the report's words. At most ${SWARM_LIMITS.findings} findings, each at most 200 characters.
- Each finding has "cites": the id in square brackets of every item it relies on, copied exactly. Only cite items that appear in the input.
- Never state a cause as fact and never say what an item does not contain. Never add a version, date, name or number that is not in the item.

Reply with JSON only: {"findings": [{"text": "...", "cites": ["..."]}]}`;

/** What a judging gatherer reads. */
export function findingsInput(issue, fetched, lookFor = "") {
  const head = [`ISSUE: ${issue.title}`, ...(lookFor ? [`LOOK FOR (from the planner): ${clip(lookFor, 240)}`] : []), "REPORTS:", ...issue.reports.slice(0, 8).map((r) => `- (${r.id}) ${r.title}: ${clip(r.body, 300)}`), "", `ITEMS (${fetched.items.length}; cite by the id in square brackets):`];
  const lines = fetched.items.map((i) => `[${i.cite}] ${i.text}`);
  return `${[...head, ...lines].join("\n").slice(0, SWARM_LIMITS.inputChars)}\n\nReturn the JSON now.`;
}

/** Boundary check, pure: a finding is kept only when it cites something and every cite is an item code fetched. */
export function parseFindings(text, items) {
  const cleaned = String(text ?? "").replace(/```(?:json)?/g, "");
  const a = cleaned.indexOf("{");
  const b = cleaned.lastIndexOf("}");
  if (a < 0 || b <= a) throw new GatherFailed("the model's reply had no JSON");
  let v;
  try {
    v = JSON.parse(cleaned.slice(a, b + 1));
  } catch {
    throw new GatherFailed("the model's reply was not valid JSON");
  }
  const known = new Set(items.map((i) => i.cite));
  const findings = [];
  const dropped = [];
  for (const raw of Array.isArray(v?.findings) ? v.findings.slice(0, 8) : []) {
    const f = { text: clip(raw?.text, 400), cites: Array.isArray(raw?.cites) ? raw.cites.map((c) => String(c).trim().replace(/^\[|\]$/g, "")).filter(Boolean).slice(0, 6) : [] };
    if (!f.text) continue;
    const bad = !f.cites.length ? "no citation" : f.cites.find((c) => !known.has(c));
    if (bad) dropped.push({ ...f, reason: bad === "no citation" ? bad : `not something that was fetched: ${bad}` });
    else if (findings.length < SWARM_LIMITS.findings) findings.push(f);
  }
  return { findings, dropped };
}

// ---------- the list (one line each) and the runner ----------

/** @type {{ name: string, label: string, outside: boolean, about: string, fetch?: (ctx: any) => Promise<Fetched> }[]} */
export const GATHERERS = [
  { name: "code", label: "Code", outside: false, about: "in this project: reports, code, tests" },
  { name: "history", label: "History", outside: false, about: "commits, blame, earlier cards", fetch: fetchHistory },
  { name: "github", label: "GitHub", outside: true, about: "outside: issues, PRs, related projects (read-only)", fetch: fetchGithub },
  { name: "packages", label: "Packages", outside: true, about: "outside: installed against latest, release notes", fetch: fetchPackages },
  { name: "conversations", label: "Past conversations", outside: true, about: "this project's earlier Pi conversations: text only, redacted, read-only", fetch: fetchConversations },
];

// ---------- the planner: one small-model call decides which gatherers start and what each looks for ----------

/** The planner's instruction. "PLANNER" is also how the test model tells this call apart. */
export const planSystem = (available) => `PLANNER
You set up a quick research swarm for one incoming issue in a software project. Each gatherer below is a small script plus a small model; they run in parallel and a senior engineer gets what they find. Starting one costs time and money, so start a gatherer only when THIS issue gives it something to find.

GATHERERS YOU MAY START:
${available.map((g) => `- ${g.name}: ${g.about}`).join("\n")}

For each gatherer you start, say what it should look for in this issue's own words, and why it is worth starting for this issue. One line each, at most 160 characters. Use only the names above. Do not guess at the cause.

Reply with JSON only: {"gatherers": [{"name": "...", "look_for": "...", "reason": "..."}]}`;

/** What the planner reads: the issue, and the few facts code already knows about the project. */
export function planInput(issue, facts) {
  return [`ISSUE: ${issue.title}`, "REPORTS:", ...issue.reports.slice(0, 8).map((r) => `- (${r.id}) ${r.title}: ${clip(r.body, 300)}`), "", "WHAT A SCRIPT ALREADY KNOWS:", ...facts.map((f) => `- ${f}`)].join("\n").slice(0, 5000) + "\n\nReturn the JSON now.";
}

const CODE_REASON = "always runs: the brief starts from the project's own reports, code and tests";
/**
 * The plan, checked by code. Pure and never throws: a name that is not registered (or not available)
 * is dropped and listed; a repeat is dropped; text is clipped; "code" always runs; an empty or
 * unreadable plan is code only.
 * @param {string} text @param {{ name: string, label: string }[]} available
 * @returns {{ gatherers: { name: string, label: string, look_for: string, reason: string }[], dropped: { name: string, reason: string }[], note: string|null }}
 */
export function validatePlan(text, available) {
  const codeOnly = (note) => ({ gatherers: available.filter((g) => g.name === "code").map((g) => ({ name: g.name, label: g.label, look_for: "", reason: CODE_REASON })), dropped: [], note });
  const cleaned = String(text ?? "").replace(/```(?:json)?/g, "");
  const a = cleaned.indexOf("{");
  const b = cleaned.lastIndexOf("}");
  let v = null;
  if (a >= 0 && b > a) v = parse(cleaned.slice(a, b + 1), null);
  if (!v || !Array.isArray(v.gatherers)) return codeOnly("the planner's reply was not a plan; only Code ran");
  const gatherers = [];
  const dropped = [];
  for (const raw of v.gatherers.slice(0, 12)) {
    const name = String(raw?.name ?? "").trim().toLowerCase();
    const g = available.find((x) => x.name === name);
    if (!g) dropped.push({ name: clip(name || "(no name)", 40), reason: "not a gatherer that can start here" });
    else if (gatherers.some((x) => x.name === name)) dropped.push({ name, reason: "named twice" });
    else gatherers.push({ name, label: g.label, look_for: clip(raw?.look_for, 200), reason: clip(raw?.reason, 200) || "no reason given" });
  }
  const code = available.find((g) => g.name === "code");
  if (code && !gatherers.some((g) => g.name === "code")) gatherers.unshift({ name: "code", label: code.label, look_for: "", reason: CODE_REASON });
  if (!gatherers.length) return codeOnly("the plan named no gatherer; only Code ran");
  return { gatherers, dropped, note: gatherers.length === 1 && !v.gatherers.length ? "the plan named no gatherer; only Code ran" : null };
}

/** Which gatherers run: TRIAGE_GATHERERS / config (names, comma-separated), default all. An unknown name is an error. */
export function pickGatherers(names) {
  if (!names) return GATHERERS;
  return String(names).split(",").map((n) => n.trim()).filter(Boolean).map((n) => {
    const g = GATHERERS.find((x) => x.name === n);
    if (!g) throw Object.assign(new Error(`unknown gatherer ${n} (use ${GATHERERS.map((x) => x.name).join(", ")})`), { code: "INVALID" });
    return g;
  });
}

async function runCode(g, ctx) {
  const reply = await callModel({ model: ctx.model, system: gatherSystem(ctx.instruction), input: `${ctx.lookFor ? `LOOK FOR (from the planner): ${clip(ctx.lookFor, 240)}\n\n` : ""}${gatherInput(ctx.issue, ctx.candidates)}`, timeout: ctx.timeoutMs });
  const brief = parseBrief(reply.text, ctx.candidates);
  const findings = ["reported", "where", "tests", "unknown"].flatMap((s) => brief[s]);
  return { state: "findings", findings, dropped: brief.dropped, searched: [`${ctx.candidates.reports.length} reports, ${ctx.candidates.files.length} code files, ${ctx.candidates.tests.length} test files`], fetched: ctx.candidates.files.length + ctx.candidates.tests.length + ctx.candidates.reports.length, brief, text: briefText(brief), reply };
}

async function runJudge(g, ctx) {
  const fetched = await g.fetch(ctx);
  const read = fetched.read ? { read: fetched.read } : {};
  if (!fetched.items.length) return { state: "nothing", findings: [], dropped: [], searched: fetched.searched, fetched: 0, reply: null, ...read };
  const reply = await callModel({ model: ctx.model, system: findingsSystem(g.name), input: findingsInput(ctx.issue, fetched, ctx.lookFor), timeout: ctx.timeoutMs });
  const { findings, dropped } = parseFindings(reply.text, fetched.items);
  return { state: findings.length ? "findings" : "nothing", findings, dropped, searched: fetched.searched, fetched: fetched.items.length, items: fetched.items, reply, ...read };
}

/**
 * Run the gatherers in parallel, each inside its own time box. Never throws: every gatherer ends in
 * one of the four states. `onState` is called whenever one changes (the sidebar shows it).
 * @param {any} o
 * @returns {Promise<GathererResult[]>}
 */
export async function runSwarm({ root, issue, candidates, model, instruction, repo = null, gatherers = GATHERERS, plan = null, conversations = null, timeoutMs = SWARM_LIMITS.timeoutMs, exec = execP, fetchJson: fj = fetchJson, onState = () => {} }) {
  if (plan) gatherers = /** @type {any} */ (plan.map((p) => GATHERERS.find((g) => g.name === p.name)).filter(Boolean));
  const lookFor = (name) => plan?.find((p) => p.name === name)?.look_for ?? "";
  const titleTerms = termsOf(issue.title, []);
  const terms = candidates.terms.length ? [...new Set([...titleTerms.filter((t) => candidates.terms.includes(t)), ...candidates.terms])] : titleTerms;
  const ctx = { root, issue, candidates, model, instruction, repo, terms, titleTerms, timeoutMs, exec, fetchJson: fj, conversations };
  const states = gatherers.map((g) => ({ name: g.name, label: g.label, state: "searching", findings: 0, ms: 0 }));
  onState(states);
  const t0 = Date.now();
  return Promise.all(
    gatherers.map(async (g, i) => {
      const base = { name: g.name, label: g.label, outside: g.outside, findings: [], dropped: [], searched: [], fetched: 0, cost_usd: null, tokens: null, error: null };
      let timer;
      /** @type {any} */
      let r;
      try {
        const own = { ...ctx, lookFor: lookFor(g.name) };
        r = await Promise.race([g.fetch ? runJudge(g, own) : runCode(g, own), new Promise((res) => (timer = setTimeout(() => res({ state: "timeout", error: `no answer in ${Math.round(timeoutMs / 1000)} s` }), timeoutMs)))]);
      } catch (/** @type {any} */ e) {
        r = { state: "error", error: String(e?.message || e).slice(0, 200) };
      }
      clearTimeout(timer);
      const { reply, ...rest } = r;
      const out = { ...base, ...rest, ms: Date.now() - t0, cost_usd: reply?.usage?.cost_usd ?? (reply ? null : 0), tokens: reply?.usage ? { input: reply.usage.input, output: reply.usage.output } : null };
      states[i] = { name: g.name, label: g.label, state: out.state, findings: out.findings.length, ms: out.ms, ...(out.read ? { read: out.read } : {}), ...(out.error ? { error: out.error } : {}) };
      onState(states);
      return out;
    }),
  );
}

const HEAD = (g) => `${g.label.toUpperCase()} (${GATHERERS.find((x) => x.name === g.name)?.about ?? g.name})`;

/** The swarm's results as the text Main reads and the widget shows: grouped by gatherer, each state said plainly. */
export function swarmText(results) {
  const out = [];
  for (const g of results) {
    if (g.state === "findings" && g.text) out.push(`${HEAD(g)}:`, g.text);
    else if (g.state === "findings") out.push(`${HEAD(g)}:`, ...g.findings.map((f) => `- ${f.text} [${f.cites.join(", ")}]`));
    else if (g.state === "findings" && g.name === "conversations") out.push(`${HEAD(g)}:`, ...g.findings.map((f) => `- ${f.text} [${f.cites.join(", ")}]`));
    else if (g.state === "nothing") out.push(`${HEAD(g)}: nothing relevant found. Looked at: ${g.searched.join("; ") || "nothing to look at"}.`);
    else out.push(`${HEAD(g)}: ${g.state === "timeout" ? "timed out" : "failed"} (${g.error}). Nothing from this gatherer.`);
  }
  return out.join("\n");
}

/** One line per gatherer, as the sidebar shows it while and after gathering. */
export function stateLine(s) {
  const what = s.state === "searching" ? "searching…" : s.state === "findings" ? `${s.findings} finding${s.findings === 1 ? "" : "s"}` : s.state === "nothing" ? "nothing relevant" : s.state === "timeout" ? "timed out" : "failed";
  const read = s.read?.found ? ` · read ${s.read.sessions} conversation${s.read.sessions === 1 ? "" : "s"}` : "";
  return `${s.label}: ${what}${read}${s.state !== "searching" && s.ms ? ` · ${(s.ms / 1000).toFixed(1)} s` : ""}`;
}


// ---------- one press: collect, plan, swarm, check, cache ----------

/** Which gatherers may start for this project: the registry, minus what a setting turned off. */
export function availableGatherers({ only = null, conversations = "on" } = {}) {
  const names = only ? String(only).split(",").map((n) => n.trim()).filter(Boolean) : null;
  const off = [];
  const on = [];
  for (const g of GATHERERS) {
    if (g.name === "conversations" && conversations === "off") off.push({ name: g.name, label: g.label, why: "off (project setting)" });
    else if (names && g.name !== "code" && !names.includes(g.name)) off.push({ name: g.name, label: g.label, why: "off (project setting)" });
    else on.push(g);
  }
  return { on, off };
}

/**
 * One press. Code collects; one small-model call plans; the planned gatherers run in parallel, each
 * in its own time box; code checks every citation. Returns the brief document. Throws GatherFailed
 * only when no gatherer at all returned (then nothing is sent unless the person chooses to).
 * `progress(p)` is called as the plan and each gatherer's state change (the sidebar shows them).
 * @param {{ root: string, store: any, model: string, instruction?: string, issue: any, force?: boolean, repo?: string|null, only?: string|null, conversations?: { mode: string, dir: string|null }, exec?: typeof execP, fetchJson?: typeof fetchJson, timeoutMs?: number, progress?: (p: any) => void }} o
 */
export async function gather({ root, store, model, instruction = DEFAULT_GATHER_INSTRUCTION, issue, force = false, repo = null, only = null, conversations = { mode: "on", dir: null }, exec = execP, fetchJson: fj = fetchJson, timeoutMs = SWARM_LIMITS.timeoutMs, progress = () => {} }) {
  const t0 = Date.now();
  const candidates = collect({ root, title: issue.title, reports: issue.reports });
  const { ms: collectMs, ...stable } = candidates;
  const { on, off } = availableGatherers({ only, conversations: conversations.mode });
  const key = hashOf({ v: 3, issue: issue.hash, candidates: stable, model, system: hashOf(gatherSystem(instruction)), gatherers: on.map((g) => g.name), conversations });
  const index = await store.read("gathers.json", {});
  const record = async (entry) => {
    index[issue.id] = { ...entry, issue_hash: issue.hash, key, at: new Date().toISOString() };
    await store.write("gathers.json", index);
  };
  if (!force) {
    const hit = await store.read(`brief-${key}.json`, null);
    if (hit?.brief) {
      const doc = { ...hit, cached: true, ms: { ...hit.ms, collect: collectMs, model: 0, total: Date.now() - t0 }, cost_usd: 0, first: { ms: hit.ms, cost_usd: hit.cost_usd } };
      await record({ state: "ready", claims: hit.claims, dropped: hit.dropped_count, ms: doc.ms.total, cost_usd: 0, cached: true, swarm: { plan: hit.plan.gatherers, not_started: hit.plan.not_started, states: hit.states } });
      return doc;
    }
  }
  // 1. The planner.
  progress({ phase: "planning", plan: [], not_started: off, states: [] });
  const files = [...candidates.files, ...candidates.tests].map((f) => f.path);
  const pkgs = importedPackages(root, candidates.files.map((f) => f.path));
  const facts = [
    files.length ? `files that match the issue's words: ${files.slice(0, 8).join(", ")}` : "no file in the project matches the issue's words",
    pkgs.length ? `npm packages those files import: ${pkgs.map((p) => p.name).join(", ")}` : "those files import no npm packages (only built-ins and the project's own files)",
    repo ? `the project's GitHub repository: ${repo}` : "the project has no GitHub repository of its own",
  ];
  let plan;
  let planReply = null;
  const tp = Date.now();
  try {
    planReply = await callModel({ model, system: planSystem(on), input: planInput(issue, facts), timeout: SWARM_LIMITS.planMs });
    plan = validatePlan(planReply.text, on);
  } catch (/** @type {any} */ e) {
    plan = validatePlan("", on);
    plan.note = `the planner failed (${String(e?.message || e).slice(0, 100)}); only Code ran`;
  }
  const planMs = Date.now() - tp;
  const notStarted = [...on.filter((g) => !plan.gatherers.some((p) => p.name === g.name)).map((g) => ({ name: g.name, label: g.label, why: "the planner did not choose it for this issue" })), ...off];
  // 2. The swarm.
  const results = await runSwarm({ root, issue, candidates, model, instruction, repo, plan: plan.gatherers, conversations, timeoutMs, exec, fetchJson: fj, onState: (states) => progress({ phase: "gathering", plan: plan.gatherers, not_started: notStarted, note: plan.note, states: states.map((s) => ({ ...s })) }) });
  const swarmMs = Date.now() - tp - planMs;
  const costs = [planReply?.usage?.cost_usd, ...results.map((r) => r.cost_usd)];
  const cost = costs.some((c) => typeof c === "number") ? costs.reduce((n, c) => n + (typeof c === "number" ? c : 0), 0) : null;
  const calls = (planReply ? 1 : 0) + results.filter((r) => r.tokens || r.cost_usd !== 0).length;
  if (!results.some((r) => r.state === "findings" || r.state === "nothing")) {
    const why = results.map((r) => `${r.label}: ${r.error}`).join("; ").slice(0, 200);
    await record({ state: "failed", error: why, ms: Date.now() - t0, cost_usd: cost });
    throw new GatherFailed(why);
  }
  const code = results.find((r) => r.name === "code");
  const brief = code?.brief ?? { reported: [], where: [], tests: [], unknown: [], dropped: [] };
  const dropped = results.flatMap((r) => r.dropped.map((d) => ({ ...d, gatherer: r.label })));
  const claims = results.reduce((n, r) => n + r.findings.length, 0);
  const conv = results.find((r) => r.name === "conversations");
  const doc = {
    id: issue.id,
    ids: issue.ids,
    title: issue.title,
    key,
    cached: false,
    gathered_at: new Date().toISOString(),
    model,
    instruction,
    plan: { gatherers: plan.gatherers, dropped: plan.dropped, note: plan.note, not_started: notStarted, ms: planMs, cost_usd: planReply?.usage?.cost_usd ?? null },
    swarm: results.map(({ brief: _b, text: _t, ...r }) => /** @type {any} */ (r)),
    states: results.map((r) => ({ name: r.name, label: r.label, state: r.state, findings: r.findings.length, ms: r.ms, ...(r["read"] ? { read: r["read"] } : {}), ...(r.error ? { error: r.error } : {}) })),
    brief: { ...brief, dropped },
    text: swarmText(results),
    excerpts: excerptsFor(brief, root),
    claims,
    dropped_count: dropped.length,
    conversations: { mode: conversations.mode, read: conv?.["read"] ?? null },
    candidates: { reports: candidates.reports.map((r) => r.id), terms: candidates.terms, files: candidates.files.map((f) => ({ path: f.path, why: f.why, lines_shown: f.shown.length })), tests: candidates.tests.map((f) => ({ path: f.path, why: f.why, lines_shown: f.shown.length })), missing: candidates.missing, commits: candidates.commits.map((k) => k.sha), notes: candidates.notes },
    ms: { collect: collectMs, plan: planMs, swarm: swarmMs, model: planMs + swarmMs, total: Date.now() - t0 },
    calls,
    cost_usd: cost,
    cost_cap_usd: COST_CAP_USD,
    over_cap: typeof cost === "number" && cost > COST_CAP_USD,
  };
  await store.write(`brief-${key}.json`, doc);
  await record({ state: "ready", claims, dropped: dropped.length, ms: doc.ms.total, cost_usd: cost, cached: false, swarm: { plan: plan.gatherers, not_started: notStarted, states: doc.states } });
  return doc;
}
