// Gather: the leg-up Main gets before it starts on an issue. Two halves, kept apart:
//   collect()    code, no model: every merged report, the files the tracker card names, repo lines
//                that match the issue's distinctive terms, the tests near those files, recent commits.
//                Bounded in size and time; nothing leaves the machine.
//   parseBrief() the small model condenses that into a context brief; code then drops every claim
//                whose citation does not resolve to a report id, a `path:line` the model was shown,
//                or a commit it was shown. A cause stated as fact is dropped too.
// The brief is cached by content: the issue's reports + what code collected + model + instruction.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { hashOf } from "./issue.mjs";
import { callModel, DEFAULT_MODEL } from "./triage.mjs";

/** @typedef {{ id: string, title: string, body: string, author: string|null, created_at: string|null, kind: string }} Report */
/** @typedef {{ path: string, lines: number, why: string[], shown: { n: number, text: string }[] }} FileEvidence */
/** @typedef {{ sha: string, date: string, subject: string, files: string[] }} Commit */
/**
 * @typedef {object} Candidates what code collected, all of it citable
 * @property {Report[]} reports
 * @property {string[]} terms            the distinctive terms searched for
 * @property {FileEvidence[]} files      code files: named in a card, or matching a term
 * @property {FileEvidence[]} tests      test files near them
 * @property {string[]} missing          paths a card names that are not in the project
 * @property {Commit[]} commits
 * @property {string[]} notes            limits hit, things that could not be searched
 * @property {number} ms
 */
/** @typedef {{ text: string, cites: string[] }} Claim */
/** @typedef {{ section: string, text: string, cites: string[], reason: string }} Dropped */
/** @typedef {{ reported: Claim[], where: Claim[], tests: Claim[], unknown: Claim[], dropped: Dropped[] }} Brief */

export class GatherFailed extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.code = "GATHER_FAILED";
  }
}

export const LIMITS = { reports: 40, reportChars: 1200, namedFiles: 6, matchFiles: 4, terms: 8, tests: 3, commits: 5, linesPerFile: 22, lineChars: 160, inputChars: 14_000, ms: 8000, gitMs: 3000 };
const CODE = ["*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs", "*.py", "*.rb", "*.go", "*.rs", "*.java", "*.kt", "*.swift", "*.php", "*.sql", "*.vue", "*.svelte"];
const CODE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|php|sql|vue|svelte)$/;
const TEST_RE = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[a-z]+$/;
const PATH_RE = /(?:[\w@.\[\]-]+\/)*[\w@.\[\]-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|swift|php|sql|vue|svelte|json|md|css|html|yml|yaml|toml)\b/g;
const STOP = new Set(
  "about after again also another been before being both cannot could does doesn done each even every from have having here into just like looks made make many more most much need needs only open opens other over same seems should show shows some still such than that their them then there these they this those through under until very want wants were what when where which while will with would your yesterday today tomorrow please thanks hello know think tried trying when's can't still page site app issue problem bug feature column owner files waiting todo checking progress hold review expected different stated before changing confirm guest guests host hosts user users though even reach existing behavior behaviour expected available look thing things something anything time date dates days number clear unclear question questions give incoming house beach".split(" "),
);

// ---------- collect (code only) ----------

/** Distinctive-term candidates from the reports: words of 4+ letters, plus a simple stem, title words first. */
export function termsOf(title, bodies) {
  const words = (s) => (s.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? []).filter((w) => !STOP.has(w));
  const stem = (w) => w.replace(/(ations?|ings?|able|ible|ed|es|s)$/, "");
  const out = [];
  const add = (w) => {
    for (const v of [w, stem(w)]) if (v.length >= 4 && !STOP.has(v) && !out.includes(v)) out.push(v);
  };
  words(title).forEach(add);
  for (const b of bodies) words(b.replace(/^(Column|Files|Waiting on):.*$/gim, "")).forEach(add);
  return out.slice(0, 24);
}

/** Paths a report names ("Files: a, b" on a tracker card, or a path in the text). */
export function namedPaths(bodies) {
  const out = [];
  for (const b of bodies) for (const m of b.match(PATH_RE) ?? []) if (m.includes("/") && !out.includes(m)) out.push(m);
  return out;
}

/**
 * The real path of a file named inside the project, or null. Both the written path and the path
 * the filesystem resolves it to (through any symlink, of the file or of a folder on the way) must
 * be inside the project's real root: a link that leaves the project is not read.
 */
export function safePath(root, rel) {
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  try {
    const realRoot = fs.realpathSync(root);
    const real = fs.realpathSync(abs);
    return real === realRoot || real.startsWith(realRoot + path.sep) ? real : null;
  } catch {
    return null;
  }
}

function readLines(root, rel) {
  const abs = safePath(root, rel);
  if (!abs) return null;
  try {
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > 400_000) return null;
    return fs.readFileSync(abs, "utf8").split("\n");
  } catch {
    return null;
  }
}

/** The lines of one file the model gets to see: term hits and declarations, each with a little surrounding code. */
function excerpt(lines, terms, isTest) {
  const hit = [];
  const decl = [];
  const res = terms.map((t) => t.toLowerCase());
  lines.forEach((l, i) => {
    const low = l.toLowerCase();
    if (res.some((t) => low.includes(t))) hit.push(i);
    else if (isTest ? /^\s*(test|it|describe)\s*[.(]/.test(l) : /^\s*(export\s+)?(default\s+)?(async\s+)?(function|class|const\s+\w+\s*=\s*(async\s*)?\(|def |pub fn |fn |func )/.test(l)) decl.push(i);
  });
  const want = new Set();
  const around = (i, r) => {
    for (let k = Math.max(0, i - r); k <= Math.min(lines.length - 1, i + r); k++) want.add(k);
  };
  const strength = (i) => res.filter((t) => lines[i].toLowerCase().includes(t)).length;
  for (const i of hit.slice().sort((x, y) => strength(y) - strength(x) || x - y).slice(0, 8)) {
    if (want.size >= LIMITS.linesPerFile - 2) break;
    around(i, 1);
  }
  for (const i of decl) {
    if (want.size >= LIMITS.linesPerFile) break;
    want.add(i);
  }
  return [...want]
    .sort((a, b) => a - b)
    .slice(0, LIMITS.linesPerFile)
    .map((i) => ({ n: i + 1, text: lines[i].slice(0, LIMITS.lineChars) }));
}

/**
 * Everything code can find about an issue, bounded. `git` is injectable for tests.
 * @param {{ root: string, title: string, reports: Report[], now?: () => number, git?: (argv: string[]) => { ok: boolean, out: string } }} o
 * @returns {Candidates}
 */
export function collect({ root, title, reports, now = Date.now, git }) {
  const t0 = now();
  const notes = [];
  const left = () => LIMITS.ms - (now() - t0);
  const run =
    git ??
    ((argv) => {
      const r = spawnSync("git", ["-C", root, ...argv], { encoding: "utf8", timeout: Math.max(200, Math.min(LIMITS.gitMs, left())), maxBuffer: 4_000_000 });
      return { ok: r.status === 0 || r.status === 1, out: r.stdout ?? "" }; // git grep exits 1 for "no match"
    });
  const kept = reports.slice(0, LIMITS.reports).map((r) => ({ ...r, body: r.body.slice(0, LIMITS.reportChars) }));
  if (reports.length > kept.length) notes.push(`${reports.length - kept.length} more reports not shown (limit ${LIMITS.reports}): ${reports.slice(kept.length).map((r) => r.id).join(", ")}`);
  const bodies = kept.map((r) => r.body);

  // Files the card names: kept only when they exist inside the project.
  /** @type {Map<string, string[]>} */
  const why = new Map();
  const missing = [];
  for (const r of kept) {
    for (const p of namedPaths([r.body])) {
      if (readLines(root, p)) {
        if (why.size < LIMITS.namedFiles || why.has(p)) why.set(p, [...(why.get(p) ?? []), `named in ${r.id}`]);
      } else if (!missing.includes(p)) missing.push(p);
    }
  }

  // Distinctive terms: each term weighs more the fewer code files contain it (and more when it is in
  // the title); a term most of the code contains says nothing and is skipped. Files are ranked by
  // the weight of the terms they contain.
  const isRepo = run(["rev-parse", "--is-inside-work-tree"]).out.trim() === "true";
  /** @type {{ term: string, weight: number, files: string[] }[]} */
  const found = [];
  if (!isRepo) notes.push("not a git repository: no term search, tests or commits were looked up");
  else {
    const total = Math.max(1, run(["ls-files", "--", ...CODE]).out.split("\n").filter(Boolean).length);
    const inTitle = new Set(termsOf(title, []));
    for (const term of termsOf(title, bodies)) {
      if (left() < 500) {
        notes.push("term search stopped at the time limit");
        break;
      }
      const files = run(["grep", "-l", "-i", "-I", "-F", "-e", term, "--", ...CODE]).out.split("\n").filter(Boolean);
      if (!files.length || files.length > Math.max(3, total * 0.3)) continue;
      found.push({ term, weight: Math.log(1 + total / files.length) * (inTitle.has(term) ? 2 : 1), files });
    }
  }
  const terms = found.sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term)).slice(0, LIMITS.terms);
  /** @type {Map<string, { terms: string[], weight: number }>} */
  const score = new Map();
  for (const t of terms)
    for (const f of t.files) {
      const e = score.get(f) ?? { terms: [], weight: 0 };
      e.terms.push(t.term);
      e.weight += t.weight;
      score.set(f, e);
    }
  const says = (ts) => `matches ${ts.map((t) => `"${t}"`).join(", ")}`;
  const matched = [...score.entries()].sort((a, b) => b[1].weight - a[1].weight || a[0].localeCompare(b[0])).map(([f, e]) => /** @type {[string, string[]]} */ ([f, e.terms]));
  for (const [f, ts] of matched) if (why.has(f)) why.get(f).push(says(ts));
  for (const [f, ts] of matched.filter(([f]) => !why.has(f) && !TEST_RE.test(f)).slice(0, LIMITS.matchFiles)) why.set(f, [says(ts)]);

  // Tests near them: test files that import a candidate file by name, are named in a report, or match the terms.
  /** @type {Map<string, string[]>} */
  const testWhy = new Map();
  for (const [f, w] of why) if (TEST_RE.test(f)) testWhy.set(f, w);
  for (const f of testWhy.keys()) why.delete(f);
  if (isRepo) {
    for (const f of [...why.keys()].filter((f) => CODE_RE.test(f))) {
      if (left() < 500) break;
      const base = path.basename(f).replace(/\.[^.]+$/, "");
      if (!/^[\w-]{3,}$/.test(base) || base === "index") continue;
      const r = run(["grep", "-l", "-I", "-E", "-e", `(from|require|import).*[/'"]${base}(\\.[a-z]+)?['"]`, "--", "*test*", "*spec*"]);
      for (const tf of r.out.split("\n").filter((x) => x && TEST_RE.test(x))) testWhy.set(tf, [...(testWhy.get(tf) ?? []), `imports ${base}`]);
    }
    for (const [f, ts] of matched.filter(([f]) => TEST_RE.test(f))) if (testWhy.has(f)) testWhy.get(f).push(says(ts));
    const rank = (f) => score.get(f)?.weight ?? 0;
    const order = [...testWhy.keys()].sort((x, y) => rank(y) - rank(x) || x.localeCompare(y));
    for (const f of order.slice(LIMITS.tests)) testWhy.delete(f);
  }
  const termList = terms.map((t) => t.term);
  const evidence = (m, isTest, max) =>
    [...m.entries()]
      .slice(0, max)
      .map(([p, w]) => {
        const lines = readLines(root, p) ?? [];
        return { path: p, lines: lines.length, why: [...new Set(w)], shown: excerpt(lines, termList, isTest) };
      })
      .filter((f) => f.lines > 0);
  const files = evidence(why, false, LIMITS.namedFiles + LIMITS.matchFiles);
  const tests = evidence(testWhy, true, LIMITS.tests);

  // Recent commits touching them.
  /** @type {Commit[]} */
  const commits = [];
  const all = [...files, ...tests].map((f) => f.path);
  if (isRepo && all.length && left() > 300) {
    const r = run(["log", "-n", String(LIMITS.commits), "--date=short", "--format=%x01%h%x09%ad%x09%s", "--name-only", "--", ...all]);
    for (const block of r.out.split("\x01").filter(Boolean)) {
      const [head, ...names] = block.split("\n").filter(Boolean);
      const [sha, date, subject] = head.split("\t");
      if (sha) commits.push({ sha, date, subject: (subject ?? "").slice(0, 140), files: names.filter((n) => all.includes(n)) });
    }
  }
  return { reports: kept, terms: termList, files, tests, missing, commits, notes, ms: now() - t0 };
}

// ---------- what the model reads ----------

const BASE = `You prepare a context brief for a senior engineer who is about to look at one incoming issue. You are given the reports (support tickets, tracker cards), and what a script found in the project: lines of code, tests and recent commits. You have no tools and cannot see anything else.

Write short claims in four lists:
- "reported": what people reported, in the reporters' own words (quote them). Count how many reports say the same thing.
- "where": where in the code it likely lives. Say "likely" and give the evidence: what the cited lines show.
- "tests": which tests exist near that code, and what each cited test checks.
- "unknown": what the evidence does not show and someone must find out.

Rules:
- Every claim has "cites": at least one of: a report id exactly as given (ticket-0007, card:closed-home-booking), a line you were shown as path:line (src/a.ts:12, or a range src/a.ts:12-15), or a commit as commit:<sha>. Only cite lines that appear in the input. A claim without a citation is thrown away.
- "reported" claims cite report ids. "where" and "tests" claims cite path:line.
- Never state a cause as fact. You have not run anything. Say "likely" or "may", then what the lines show.
- Never name a file, function, test or ticket that is not in the input.
- At most 3 claims per list, each at most 180 characters, plain words.

Reply with JSON only:
{"reported": [{"text": "...", "cites": ["..."]}], "where": [...], "tests": [...], "unknown": [...]}`;

// Round 2 of the brief's hill climb (checks.md "The context brief"). Round 1's judge found 22 of 68 claims said what
// the code "does not check" or what a test "does not cover" from excerpts that cannot show it, and 7 added to the reports.
const EVIDENCE_ONLY = `${BASE}

Say only what the cited lines themselves show. You see excerpts, not whole files, so you cannot know what the code does not do.
- A "where" claim says what the cited line is, in its own words ("line 40 throws ListingClosed when status is not active"), then "likely relevant because" and the report's words. Never write "does not check", "does not validate", "never", "missing", "no check" or "lacks" about code: write "the excerpt shows no line about X" instead.
- A "tests" claim gives the test's name as written on the cited line and stops. Never say what a test does not cover and never say that no test exists: write "no test naming X appears in the excerpts" as an "unknown" instead.
- A "reported" claim quotes the report and counts the reports that say the same. It adds no dates, impact, cause or severity that the report text does not state. A question stays a question.
- An "unknown" claim is a question someone must answer, citing the report or line that raises it. It does not guess the answer.`;

// Round 3 (not the default: 73 of 80 ok, no better than round 2). Round 2 left 5 of 82: three said code acts "without checking" (or that "no test ... appears") from partial
// excerpts, one put a detail on the wrong line, one read seed data as what the app does.
const ABSENCE_IS_A_QUESTION = `${EVIDENCE_ONLY}

What an excerpt leaves out is not evidence. Lines between excerpts are hidden from you ("…").
- Never write "without checking", "without validating" or "no test ... appears". In "where" and "tests", say only what the cited line contains. If you wonder whether something is checked or tested, put it in "unknown" as a plain question that cites the line ("Does the page check the home's status after loading it on line 31?").
- Each detail you state must be on the exact line you cite for it. If two details are on two lines, cite both lines.
- A line in seed data, a fixture or a migration shows what the data looks like, not what the app does when someone acts. Say "seed data" or "the table has" for those lines.`;

export const GATHER_INSTRUCTIONS = { baseline: BASE, "evidence-only": EVIDENCE_ONLY, "absence-is-a-question": ABSENCE_IS_A_QUESTION };
export const DEFAULT_GATHER_INSTRUCTION = "evidence-only"; // graded 2026-11-12 (5 gathers x 2 issues, judged by opus-5-5): baseline 39 of 68 claims ok, evidence-only 77 of 82, absence-is-a-question 73 of 80

/** @param {string} [name] */
export function gatherSystem(name = DEFAULT_GATHER_INSTRUCTION) {
  const s = GATHER_INSTRUCTIONS[name];
  if (!s) throw Object.assign(new Error(`unknown gather instruction ${name} (use ${Object.keys(GATHER_INSTRUCTIONS).join(" or ")})`), { code: "INVALID" });
  return s;
}

/** The evidence as the model reads it. Everything in it can be cited; nothing else can. @param {{ title: string, why: string|null }} issue @param {Candidates} c */
export function gatherInput(issue, c) {
  const out = [`ISSUE: ${issue.title}`];
  if (issue.why) out.push(`The Issues widget's one-line why (written by a model, not evidence): ${issue.why}`);
  out.push("", `REPORTS (${c.reports.length}; cite by id):`);
  for (const r of c.reports) out.push(`[${r.id}] ${r.kind}${r.author ? `, from ${r.author}` : ""}${r.created_at ? `, ${r.created_at.slice(0, 10)}` : ""}: ${r.title}: ${r.body.replace(/\n/g, " / ")}`);
  if (c.missing.length) out.push("", `NAMED IN A REPORT BUT NOT IN THE PROJECT (do not cite): ${c.missing.join(", ")}`);
  const section = (label, list) => {
    out.push("", `${label}:`);
    if (!list.length) out.push("(none found)");
    for (const f of list) {
      out.push(`== ${f.path} (${f.lines} lines; ${f.why.join("; ")})`);
      let prev = 0;
      for (const l of f.shown) {
        if (prev && l.n > prev + 1) out.push("   …");
        out.push(`${f.path}:${l.n}| ${l.text}`);
        prev = l.n;
      }
    }
  };
  section(`CODE (excerpts; cite as path:line; searched for ${c.terms.map((t) => `"${t}"`).join(", ") || "no distinctive terms"})`, c.files);
  section("TESTS NEAR THAT CODE (excerpts; cite as path:line)", c.tests);
  out.push("", "RECENT COMMITS TOUCHING THOSE FILES (cite as commit:<sha>):");
  if (!c.commits.length) out.push("(none found)");
  for (const k of c.commits) out.push(`commit:${k.sha} ${k.date} ${k.subject} (${k.files.join(", ")})`);
  if (c.notes.length) out.push("", `NOTES FROM THE SCRIPT: ${c.notes.join("; ")}`);
  let text = out.join("\n");
  if (text.length > LIMITS.inputChars) text = text.slice(0, LIMITS.inputChars) + "\n[cut at the size limit]";
  return `${text}\n\nReturn the JSON now.`;
}

// ---------- what the model says, checked (pure) ----------

/** What a citation may point at. A line counts only when the model was shown it. @param {Candidates} c */
export function resolverFor(c) {
  const lines = new Map();
  for (const f of [...c.files, ...c.tests]) lines.set(f.path, new Set(f.shown.map((l) => l.n)));
  return { ids: new Set(c.reports.map((r) => r.id)), lines, commits: new Set(c.commits.map((k) => k.sha)) };
}

/** @returns {{ ok: boolean, kind: "report"|"line"|"commit"|null, reason?: string }} */
export function resolveCite(raw, resolver) {
  const cite = String(raw ?? "").trim().replace(/^\[|\]$/g, "");
  if (resolver.ids.has(cite)) return { ok: true, kind: "report" };
  const k = /^commit:([0-9a-f]{4,40})$/.exec(cite);
  if (k) return resolver.commits.has(k[1]) ? { ok: true, kind: "commit" } : { ok: false, kind: null, reason: `no such commit in what was gathered: ${cite}` };
  const m = /^(.+?):(\d+)(?:-(\d+))?$/.exec(cite);
  if (m) {
    const shown = resolver.lines.get(m[1]);
    if (!shown) return { ok: false, kind: null, reason: `file was not gathered: ${m[1]}` };
    const a = Number(m[2]);
    const b = Number(m[3] ?? m[2]);
    if (b < a || b - a > 200) return { ok: false, kind: null, reason: `bad line range: ${cite}` };
    for (let n = a; n <= b; n++) if (!shown.has(n)) return { ok: false, kind: null, reason: `line was not shown to the model: ${m[1]}:${n}` };
    return { ok: true, kind: "line" };
  }
  return { ok: false, kind: null, reason: `not a report id, path:line or commit: ${cite || "(empty)"}` };
}

const SECTIONS = /** @type {const} */ (["reported", "where", "tests", "unknown"]);
const NEEDS = { reported: "report", where: "line", tests: "line" };
// A cause stated as fact: causal words with no hedge anywhere in the claim.
const CAUSAL = /\b(the cause is|is the cause|root cause|caused by|is caused|because of a bug|the bug is|the problem is|this is why|which is why|fails because|broken because)\b/i;
const HEDGE = /\b(likely|may|might|possibly|could|appears?|seems?|unclear|unknown|not shown|does not show)\b/i;

/**
 * Boundary check on the model's brief. Pure: needs no model, no files, no app.
 * A claim is kept only when every citation resolves; dropped claims are returned with the reason.
 * @param {string} text @param {Candidates} candidates @returns {Brief}
 */
export function parseBrief(text, candidates) {
  const cleaned = String(text ?? "").replace(/```(?:json)?/g, "");
  const a = cleaned.indexOf("{");
  const b = cleaned.lastIndexOf("}");
  if (a < 0 || b <= a) throw new GatherFailed("the model's reply had no JSON brief");
  let v;
  try {
    v = JSON.parse(cleaned.slice(a, b + 1));
  } catch {
    throw new GatherFailed("the model's brief was not valid JSON");
  }
  const resolver = resolverFor(candidates);
  /** @type {Brief} */
  const brief = { reported: [], where: [], tests: [], unknown: [], dropped: [] };
  for (const s of SECTIONS) {
    for (const raw of Array.isArray(v?.[s]) ? v[s].slice(0, 8) : []) {
      const claim = { text: String(raw?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 400), cites: Array.isArray(raw?.cites) ? raw.cites.map((c) => String(c).trim().replace(/^\[|\]$/g, "")).filter(Boolean).slice(0, 8) : [] };
      if (!claim.text) continue;
      const drop = (reason) => brief.dropped.push({ section: s, ...claim, reason });
      if (!claim.cites.length) {
        drop("no citation");
        continue;
      }
      const res = claim.cites.map((c) => resolveCite(c, resolver));
      const bad = res.find((r) => !r.ok);
      if (bad) {
        drop(bad.reason);
        continue;
      }
      if (NEEDS[s] && !res.some((r) => r.kind === NEEDS[s])) {
        drop(s === "reported" ? "a reported claim must cite a report id" : "a code claim must cite a path:line");
        continue;
      }
      if (CAUSAL.test(claim.text) && !HEDGE.test(claim.text)) {
        drop("states a cause as fact");
        continue;
      }
      brief[s].push(claim);
    }
  }
  if (!SECTIONS.some((s) => brief[s].length)) throw new GatherFailed(brief.dropped.length ? `no claim survived the citation check (${brief.dropped.length} dropped; first: ${brief.dropped[0].reason})` : "the model's brief had no claims");
  return brief;
}

/** Shape check for a stored or passed-in brief. @param {any} x @returns {Brief} */
export function validateBrief(x) {
  if (!x || typeof x !== "object") throw new GatherFailed("brief is not an object");
  for (const s of SECTIONS) {
    if (!Array.isArray(x[s])) throw new GatherFailed(`brief.${s} must be a list`);
    for (const c of x[s]) if (typeof c?.text !== "string" || !Array.isArray(c.cites) || !c.cites.length) throw new GatherFailed(`brief.${s} has a claim without text or citations`);
  }
  return { reported: x.reported, where: x.where, tests: x.tests, unknown: x.unknown, dropped: Array.isArray(x.dropped) ? x.dropped : [] };
}

const HEADS = { reported: "What is reported", where: "Where it likely lives", tests: "Tests near it", unknown: "Not known yet" };

/** The brief as the text Main reads and the widget shows. @param {Brief} brief */
export function briefText(brief) {
  const out = [];
  for (const s of SECTIONS) {
    out.push(`${HEADS[s]}:`);
    if (!brief[s].length) out.push("- (nothing with a checked citation)");
    for (const c of brief[s]) out.push(`- ${c.text} [${c.cites.join(", ")}]`);
  }
  return out.join("\n");
}

// ---------- the cited code itself, copied by code (never by the model) ----------

/** How much cited code rides along with the brief: lines around each cited line, a test's body after its name, and a total. */
export const EXCERPT = { around: 6, testAfter: 14, maxLines: 150, lineChars: 240, maxChars: 12_000 };

/**
 * For every `path:line` a kept claim cites, the real lines from the file: the cited line(s) with
 * EXCERPT.around lines each side (for a test file: the cited line and the EXCERPT.testAfter lines
 * after it, its body). Overlaps merge; the total is bounded. The model never writes these lines,
 * so they cannot be misquoted. `read` is injectable for tests.
 * @param {Brief} brief @param {string} root @param {(rel: string) => string[]|null} [read]
 * @returns {{ text: string, files: { path: string, ranges: [number, number][] }[], lines: number, cut: boolean }}
 */
export function excerptsFor(brief, root, read = (rel) => readLines(root, rel)) {
  /** @type {Map<string, [number, number][]>} */
  const want = new Map();
  for (const s of /** @type {const} */ (["where", "tests", "unknown"])) {
    for (const c of brief[s]) {
      for (const cite of c.cites) {
        const m = /^(.+?):(\d+)(?:-(\d+))?$/.exec(cite);
        if (!m || cite.startsWith("commit:")) continue;
        const a = Number(m[2]);
        const b = Number(m[3] ?? m[2]);
        const isTest = TEST_RE.test(m[1]);
        want.set(m[1], [...(want.get(m[1]) ?? []), [Math.max(1, a - (isTest ? 1 : EXCERPT.around)), b + (isTest ? EXCERPT.testAfter : EXCERPT.around)]]);
      }
    }
  }
  const out = [];
  const files = [];
  let lines = 0;
  let chars = 0;
  let cut = false;
  for (const [file, ranges] of want) {
    const src = read(file);
    if (!src) continue;
    const merged = [];
    for (const [a, b] of ranges.sort((x, y) => x[0] - y[0])) {
      const last = merged[merged.length - 1];
      const end = Math.min(b, src.length);
      if (last && a <= last[1] + 1) last[1] = Math.max(last[1], end);
      else if (a <= src.length) merged.push([a, end]);
    }
    const kept = [];
    const block = [`== ${file} (${src.length} lines)`];
    for (const [a, b] of merged) {
      if (cut) break;
      if (kept.length) block.push("   …");
      let n = a;
      for (; n <= b; n++) {
        const line = `${file}:${n}| ${src[n - 1].slice(0, EXCERPT.lineChars)}`;
        if (lines + 1 > EXCERPT.maxLines || chars + line.length > EXCERPT.maxChars) {
          cut = true;
          break;
        }
        block.push(line);
        lines++;
        chars += line.length + 1;
      }
      if (n > a) kept.push(/** @type {[number, number]} */ ([a, n - 1]));
    }
    if (kept.length) {
      out.push(...block);
      files.push({ path: file, ranges: kept });
    }
    if (cut) break;
  }
  if (cut) out.push(`[cut at the limit: ${EXCERPT.maxLines} lines or ${EXCERPT.maxChars} characters]`);
  return { text: out.join("\n"), files, lines, cut };
}

export const claimCount = (/** @type {Brief} */ b) => SECTIONS.reduce((n, s) => n + b[s].length, 0);
