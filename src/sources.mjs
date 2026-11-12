// Sources: where incoming issues come from. Every source keeps one contract,
//   { name, describe, list(): Promise<Issue[]>, get(id): Promise<Issue|null> }
// and fails with SourceUnavailable when it can't be read (no gh login, no database), so the
// sidebar can say "source unavailable" instead of "no issues". Sources only read: Triage never
// creates, edits, closes or comments on an issue.

import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { parseIssue } from "./issue.mjs";

/** @typedef {import("./issue.mjs").Issue} Issue */
/** @typedef {{ name: string, describe: string, list: () => Promise<Issue[]>, get: (id: string) => Promise<Issue|null> }} Source */

export class SourceUnavailable extends Error {
  /** @param {string} source @param {string} message */
  constructor(source, message) {
    super(`${source}: ${message}`);
    this.code = "SOURCE_UNAVAILABLE";
    this.source = source;
  }
}

const byId = (/** @type {Source["list"]} */ list) => async (/** @type {string} */ id) => (await list()).find((i) => i.id === id) ?? null;

// ---------- GitHub issues through the gh CLI (read-only: `gh issue list`) ----------

/** @param {{ repo: string, limit?: number, run?: (argv: string[]) => { status: number|null, stdout: string, stderr: string } }} o @returns {Source} */
export function githubSource({ repo, limit = 100, run = ghRun }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? "")) throw new SourceUnavailable("github", `repo must look like owner/name (got ${repo})`);
  let cached = null;
  const list = async () => {
    if (cached) return cached;
    const r = run(["issue", "list", "-R", repo, "--state", "open", "--limit", String(limit), "--json", "number,title,body,labels,createdAt,url,author"]);
    if (r.status !== 0) throw new SourceUnavailable("github", (r.stderr.trim().split("\n").pop() || `gh exited ${r.status}`).slice(0, 200));
    let rows;
    try {
      rows = JSON.parse(r.stdout);
    } catch {
      throw new SourceUnavailable("github", "gh did not print JSON");
    }
    cached = rows.map((x) =>
      parseIssue({
        id: `gh#${x.number}`,
        kind: "github",
        title: x.title,
        body: x.body,
        url: x.url,
        where: `${repo}#${x.number}`,
        created_at: x.createdAt,
        labels: (x.labels ?? []).map((l) => l.name),
        author: x.author?.login ?? null,
      }),
    );
    return cached;
  };
  return { name: "github", describe: `GitHub issues in ${repo} (open, via gh)`, list, get: byId(list) };
}

function ghRun(argv) {
  const r = spawnSync("gh", argv, { encoding: "utf8", timeout: 30_000 });
  return { status: r.error ? -1 : r.status, stdout: r.stdout ?? "", stderr: r.stderr || String(r.error ?? "") };
}

// ---------- The project's own files: its app inbox and its tracker board ----------
// RentAPlace ships both: support tickets and page feedback in data/rentaplace.db (written by its
// support and feedback forms; `pnpm seed` fills the demo set) and tracker/board.json.

const DB = "data/rentaplace.db";
const BOARD = "tracker/board.json";

/** @param {{ root: string }} o @returns {Source} */
export function localSource({ root }) {
  let cached = null;
  const list = async () => {
    if (cached) return cached;
    const db = path.join(root, DB);
    const board = path.join(root, BOARD);
    const haveDb = fsSync.existsSync(db) && fsSync.statSync(db).size > 0;
    const haveBoard = fsSync.existsSync(board);
    if (!haveDb && !haveBoard) throw new SourceUnavailable("local", `neither ${DB} nor ${BOARD} in ${root}`);
    const out = [];
    if (haveDb) out.push(...(await readInbox(db)));
    if (haveBoard) out.push(...(await readBoard(board)));
    cached = out;
    return cached;
  };
  return { name: "local", describe: `${root}: ${DB} (support tickets, feedback) and ${BOARD}`, list, get: byId(list) };
}

async function readInbox(file) {
  // node:sqlite prints an "experimental" warning on stderr; the JSON interface keeps stderr for errors.
  const emit = process.emitWarning;
  process.emitWarning = (w, ...rest) => (String(w).includes("SQLite") ? undefined : emit.call(process, w, ...rest));
  const { DatabaseSync } = await import("node:sqlite");
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch (/** @type {any} */ e) {
    throw new SourceUnavailable("local", `cannot open ${file}: ${e.message}`);
  }
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
    const out = [];
    if (tables.has("support_tickets")) {
      for (const r of db.prepare("SELECT id, name, subject, message, category, created_at FROM support_tickets WHERE status = 'open' ORDER BY id").all()) {
        out.push(parseIssue({ id: r.id, kind: "inbox", title: r.subject, body: r.message, url: null, where: `${file} support_tickets ${r.id}`, created_at: r.created_at, labels: r.category === "uncategorized" ? [] : [r.category], author: r.name }));
      }
    }
    if (tables.has("feedback")) {
      for (const r of db.prepare("SELECT id, page, rating, text, created_at FROM feedback WHERE rating != 'good' ORDER BY id").all()) {
        out.push(parseIssue({ id: r.id, kind: "feedback", title: `Feedback on ${r.page}`, body: r.text, url: null, where: `${file} feedback ${r.id}`, created_at: r.created_at, labels: [r.rating], author: null }));
      }
    }
    return out;
  } finally {
    db.close();
  }
}

async function readBoard(file) {
  let b;
  try {
    b = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (/** @type {any} */ e) {
    throw new SourceUnavailable("local", `cannot read ${file}: ${e.message}`);
  }
  return (b.cards ?? [])
    .filter((c) => c && c.column !== "done")
    .map((c) =>
      parseIssue({
        id: `card:${c.id}`,
        kind: "board",
        title: c.title,
        body: [c.description, c.waitingOn ? `Waiting on: ${c.waitingOn}` : "", `Column: ${c.column}${c.owner ? ` · Owner: ${c.owner}` : ""}`, c.files?.length ? `Files: ${c.files.join(", ")}` : ""].filter(Boolean).join("\n"),
        url: null,
        where: `${file} card ${c.id}`,
        created_at: null,
        labels: c.labels ?? [],
        author: c.owner ?? null,
      }),
    );
}

// ---------- Config: which sources, picked by name ----------

/**
 * "local", "github" or "local,github". Default: local when the project ships an inbox or board,
 * else github when a repo is known.
 * @param {{ source?: string, root: string, repo?: string|null }} cfg @returns {Source[]}
 */
export function pickSources({ source, root, repo }) {
  const names = (source || defaultSource(root, repo)).split(",").map((s) => s.trim()).filter(Boolean);
  return names.map((n) => {
    if (n === "local") return localSource({ root });
    if (n === "github" || n === "gh") return githubSource({ repo });
    throw new SourceUnavailable(n, "unknown source (use local, github or local,github)");
  });
}

function defaultSource(root, repo) {
  if (fsSync.existsSync(path.join(root, DB)) || fsSync.existsSync(path.join(root, BOARD))) return "local";
  return repo ? "github" : "local";
}
