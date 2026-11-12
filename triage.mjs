#!/usr/bin/env node
// Triage: the agent interface, and the only thing the sidebar calls. One JSON document on stdout;
// errors are JSON on stderr ({error: {code, message}}) with exit 1.
//
//   node triage.mjs describe
//   node triage.mjs show    --root <project>
//   node triage.mjs refresh --root <project> [--force]
//   node triage.mjs act <id> <copy|send-main|new-main|fixer|open|dismiss|restore> --root <project> [--terminal t] [--apply] [--dry-run]
//   node triage.mjs explain <id> --root <project>
//   node triage.mjs config  --root <project> [--source local|github|local,github] [--repo owner/name] [--model provider/id]

import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { pickSources, SourceUnavailable } from "./src/sources.mjs";
import { groupIssues, hashOf, issueText, compareIds, lastAt } from "./src/issue.mjs";
import { DEFAULT_MODEL, SYSTEM, callModel, modelInput, parseSummary, others } from "./src/triage.mjs";
import { ACTIONS, ACTION_NAMES, ActionUnavailable, availability, mainPrompt, fixerPrompt, newMainCommand, openTarget } from "./src/actions.mjs";
import { defaultStateDir, storeFor } from "./src/store.mjs";

const VERSION = 1;
const STALE_MS = 30 * 60_000;

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.code = "INVALID";
  }
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) out._.push(a);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = true;
  }
  return out;
}
const expandHome = (p) => (p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p);

// ---------- config: flags, then the project's saved config, then env, then defaults ----------

async function configFor(args) {
  const root = path.resolve(expandHome(typeof args.root === "string" ? args.root : process.cwd()));
  const stateDir = path.resolve(expandHome(typeof args.state === "string" ? args.state : defaultStateDir()));
  const store = storeFor(stateDir, root);
  const saved = await store.read("config.json", {});
  const pick = (k, env) => (typeof args[k] === "string" ? args[k] : saved[k] ?? process.env[env] ?? null);
  return { root, stateDir, store, source: pick("source", "TRIAGE_SOURCE"), repo: pick("repo", "TRIAGE_REPO") ?? githubRepoOf(root), model: pick("model", "TRIAGE_MODEL") ?? DEFAULT_MODEL };
}

function githubRepoOf(root) {
  const r = spawnSync("git", ["-C", root, "remote", "get-url", "origin"], { encoding: "utf8" });
  const m = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec((r.stdout ?? "").trim());
  return m ? m[1] : null;
}

// ---------- refresh: gather (code), judge (model), store ----------

async function refresh(cfg, force) {
  const { store } = cfg;
  const prev = await store.read("triage.json", null);
  const out = await store.withLock(async () => {
    const t0 = Date.now();
    let sources;
    try {
      sources = pickSources(cfg);
    } catch (/** @type {any} */ e) {
      return await saveFailure(store, prev, e, cfg, t0);
    }
    const issues = [];
    const sourceInfo = [];
    for (const s of sources) {
      try {
        const list = await s.list();
        issues.push(...list);
        sourceInfo.push({ name: s.name, describe: s.describe, count: list.length, error: null });
      } catch (/** @type {any} */ e) {
        if (!(e instanceof SourceUnavailable)) throw e;
        sourceInfo.push({ name: s.name, describe: s.describe, count: 0, error: e.message });
      }
    }
    if (sourceInfo.every((s) => s.error)) return await saveFailure(store, prev, new SourceUnavailable(sourceInfo.map((s) => s.name).join(","), sourceInfo.map((s) => s.error).join("; ")), cfg, t0, sourceInfo);
    const gatherMs = Date.now() - t0;
    const groups = groupIssues(issues);
    const inputHash = hashOf({ g: groups.map((g) => [g.id, g.hash]), model: cfg.model, system: hashOf(SYSTEM) });
    const base = { version: VERSION, root: cfg.root, sources: sourceInfo, model: cfg.model, groups, hashes: Object.fromEntries(groups.map((g) => [g.id, g.hash])) };
    if (!force && prev?.summary && prev.input_hash === inputHash && !prev.error) {
      const doc = { ...prev, ...base, checked_at: new Date().toISOString(), refresh: { at: new Date().toISOString(), cached: true, gather_ms: gatherMs, model_ms: 0, total_ms: Date.now() - t0, read_groups: 0, reused_groups: groups.length, tokens: null, cost_usd: 0 } };
      doc.history = [...(prev.history ?? []), doc.refresh].slice(-20);
      await store.write("triage.json", doc);
      return doc;
    }
    let summary = null;
    let reply = null;
    let modelError = null;
    let input = { read: 0, reused: 0, text: "" };
    if (groups.length) {
      const why = Object.fromEntries((prev?.summary?.pressing ?? []).map((p) => [p.id, p.why]));
      input = modelInput(groups, force ? {} : { hashes: prev?.hashes, why });
      try {
        reply = await callModel({ model: cfg.model, system: SYSTEM, input: input.text });
        summary = parseSummary(reply.text, groups);
      } catch (/** @type {any} */ e) {
        modelError = String(e?.message || e);
      }
    } else summary = { headline: "No open issues.", pressing: [] };
    const now = new Date().toISOString();
    const r = { at: now, cached: false, gather_ms: gatherMs, model_ms: reply?.ms ?? 0, total_ms: Date.now() - t0, read_groups: input.read, reused_groups: input.reused, tokens: reply?.usage ? { input: reply.usage.input, output: reply.usage.output } : null, cost_usd: reply?.usage?.cost_usd ?? null };
    const doc = {
      ...base,
      input_hash: modelError ? prev?.input_hash ?? null : inputHash,
      updated_at: modelError ? prev?.updated_at ?? null : now,
      checked_at: now,
      summary: summary ?? prev?.summary ?? null,
      raw_reply: reply?.text ?? prev?.raw_reply ?? null,
      error: modelError ? { code: "MODEL_FAILED", message: modelError } : null,
      refresh: r,
      history: [...(prev?.history ?? []), r].slice(-20),
    };
    await store.write("triage.json", doc);
    return doc;
  });
  if (out?.busy) return { ...(await view(cfg)), busy: true };
  return view(cfg);
}

async function saveFailure(store, prev, e, cfg, t0, sourceInfo = []) {
  const now = new Date().toISOString();
  const doc = { ...(prev ?? { version: VERSION, root: cfg.root, groups: [], summary: null }), sources: sourceInfo, model: cfg.model, checked_at: now, error: { code: e.code ?? "FAILED", message: String(e.message) }, refresh: { at: now, cached: false, total_ms: Date.now() - t0, cost_usd: 0 } };
  await store.write("triage.json", doc);
  return doc;
}

// ---------- show: the stored refresh as the sidebar and agents see it ----------

function stateOf(doc, now = Date.now()) {
  if (!doc) return "missing";
  if (doc.error?.code === "SOURCE_UNAVAILABLE") return "unavailable";
  if (doc.error) return "failed";
  if (!doc.groups?.length) return "empty";
  if (!doc.updated_at || now - Date.parse(doc.checked_at ?? doc.updated_at) > STALE_MS) return "stale";
  return "ready";
}

const card = (g) => {
  const i = g.members[0];
  return { id: g.id, ids: g.members.map((m) => m.id), title: i.title, kind: i.kind, count: g.members.length, url: i.url, where: i.where, labels: i.labels, last_at: lastAt(g) || null };
};

async function view(cfg) {
  const doc = await cfg.store.read("triage.json", null);
  const dismissed = new Set(await cfg.store.read("dismissed.json", []));
  const groups = doc?.groups ?? [];
  const byId = new Map(groups.map((g) => [g.id, g]));
  const pressing = (doc?.summary?.pressing ?? [])
    .filter((p) => !dismissed.has(p.id) && byId.has(p.id))
    .map((p) => ({ ...card(byId.get(p.id)), title: p.title, why: p.why, merged: p.ids.slice(1).map((x) => card(byId.get(x))).filter(Boolean), count: p.ids.reduce((n, x) => n + (byId.get(x)?.members.length ?? 0), 0) }));
  const taken = new Set((doc?.summary?.pressing ?? []).flatMap((p) => p.ids));
  return {
    version: VERSION,
    root: cfg.root,
    state: stateOf(doc),
    busy: cfg.store.busy(),
    model: doc?.model ?? cfg.model,
    sources: doc?.sources ?? [],
    updated_at: doc?.updated_at ?? null,
    checked_at: doc?.checked_at ?? null,
    headline: doc?.summary?.headline ?? null,
    pressing,
    others: others(groups, taken).filter((g) => !dismissed.has(g.id)).map(card),
    dismissed: [...dismissed].sort(compareIds),
    counts: { issues: groups.reduce((n, g) => n + g.members.length, 0), distinct: groups.length },
    actions: ACTIONS,
    refresh: doc?.refresh ?? null,
    error: doc?.error ?? null,
  };
}

// ---------- act ----------

async function findGroup(cfg, id) {
  const doc = await cfg.store.read("triage.json", null);
  const g = (doc?.groups ?? []).find((x) => x.members.some((m) => m.id === id));
  if (!g) throw Object.assign(new Error(`no issue ${id} in the last refresh (run refresh)`), { code: "NOT_FOUND" });
  const why = (doc.summary?.pressing ?? []).find((p) => p.ids.includes(g.id))?.why ?? null;
  return { g, why, doc };
}

function sh(cmd, argv, input) {
  const r = spawnSync(cmd, argv, { input, encoding: "utf8", timeout: 20_000 });
  return { ok: r.status === 0, code: r.status, stderr: (r.stderr ?? "").trim().slice(0, 300) || (r.error ? String(r.error) : "") };
}

async function act(cfg, id, action, args) {
  if (!ACTION_NAMES.includes(action)) throw new UsageError(`action is one of ${ACTION_NAMES.join(", ")}`);
  const { g, why } = await findGroup(cfg, id);
  const dry = !!args["dry-run"];
  const targets = { main: action === "send-main" ? args.terminal : null, fixer: action === "fixer" ? args.terminal : null };
  if (action !== "dismiss" && action !== "restore" && action !== "copy" && action !== "new-main") {
    const a = availability(/** @type {any} */ (action), g, targets);
    if (!a.enabled) throw new ActionUnavailable(a.reason);
  }
  const receipt = { at: new Date().toISOString(), action, id: g.id, ids: g.members.map((m) => m.id), dry_run: dry };
  if (action === "copy") {
    const text = issueText(g, why);
    Object.assign(receipt, { text, clipboard: dry || args["no-clipboard"] ? false : sh("pbcopy", [], text).ok });
  } else if (action === "send-main" || action === "fixer") {
    const prompt = action === "send-main" ? mainPrompt(g, why) : fixerPrompt(g, why);
    Object.assign(receipt, { terminal: args.terminal, prompt, command: ["hc", "send", args.terminal, prompt] });
    if (!dry) receipt.result = sh("hc", ["send", String(args.terminal), prompt]);
  } else if (action === "new-main") {
    const command = newMainCommand(g, why, cfg.root);
    Object.assign(receipt, { command });
    if (args.apply && !dry) receipt.result = sh("herdr-app", ["do", command.name, JSON.stringify(command.args)]);
  } else if (action === "open") {
    const target = openTarget(g, cfg.root);
    Object.assign(receipt, { target });
    if (!dry) receipt.result = sh("open", [target]);
  } else {
    const d = new Set(await cfg.store.read("dismissed.json", []));
    if (action === "dismiss") d.add(g.id);
    else d.delete(g.id);
    await cfg.store.write("dismissed.json", [...d].sort(compareIds));
  }
  if (receipt.result && !receipt.result.ok) throw Object.assign(new Error(`${action} failed: ${receipt.result.stderr || receipt.result.code}`), { code: "ACTION_FAILED" });
  await cfg.store.receipt(receipt);
  return receipt;
}

async function explain(cfg, id) {
  const { g, why, doc } = await findGroup(cfg, id);
  const rank = (doc.summary?.pressing ?? []).findIndex((p) => p.ids.includes(g.id));
  const prompt = `Explain this issue from the project's tracker and why Triage ranked it ${rank >= 0 ? `#${rank + 1} of the most pressing` : "as not pressing"}. Read the code it touches; don't change anything.\n\n${issueText(g, why)}`;
  return { id: g.id, ids: g.members.map((m) => m.id), pressing_rank: rank >= 0 ? rank + 1 : null, why, text: issueText(g, why), hash: g.hash, prompt, argv: ["pi", "--name", `Explain ${g.id}`, prompt] };
}

const DESCRIBE = {
  name: "herdr-triage",
  what: "Gathers a project's incoming issues (its app inbox and tracker board, and/or GitHub issues), has a small model pick the few most pressing with a one-line why each (duplicates merged, every claim keeps its source ids), and acts on one: copy it, send it to Main, start a new Main for it, hand it to the Fixer, open its source, dismiss it.",
  commands: {
    show: "show --root <project>: the last refresh, no model call. state: ready | empty | missing (never refreshed) | stale (older than 30 min) | failed (model failed; last summary kept) | unavailable (no source could be read); busy: a refresh is running",
    refresh: "refresh --root <project> [--force]: read the sources; ask the model only when an issue changed (content hash), sending changed issues in full and unchanged ones as titles",
    act: "act <id> <action> --root <project>: copy (to the clipboard) | send-main --terminal <Main terminal> (hc send) | new-main [--apply] (prints the herdr space.new command; --apply runs it) | fixer --terminal <Fixer terminal> | open | dismiss | restore. --dry-run records the receipt without doing it",
    explain: "explain <id> --root <project>: the issue as text, its rank and why, and a Pi command that explains it",
    config: "config --root <project> [--source local|github|local,github] [--repo owner/name] [--model provider/id]: saved per project",
    describe: "this description",
  },
  actions: ACTIONS,
  sources: { local: "<root>/data/rentaplace.db (open support tickets, feedback not rated good) and <root>/tracker/board.json (cards not done)", github: "open issues via `gh issue list` (read-only)" },
  environment: { TRIAGE_MODEL: `default ${DEFAULT_MODEL}`, TRIAGE_SOURCE: "local | github | local,github", TRIAGE_REPO: "owner/name", TRIAGE_STATE: "state dir (default ~/.cache/herdr-triage/default)", TRIAGE_MODEL_CMD: 'JSON argv run instead of Pi; gets {"model","system","input"} on stdin, prints the reply' },
};

function fail(e) {
  process.stderr.write(JSON.stringify({ error: { code: e?.code ?? "FAILED", message: String(e?.message || e) } }) + "\n");
  process.exit(1);
}

const args = parseArgs(process.argv.slice(2));
const [cmd, a1, a2] = args._;
try {
  let out;
  if (cmd === "describe") out = DESCRIBE;
  else {
    const cfg = await configFor(args);
    if (cmd === "show") out = await view(cfg);
    else if (cmd === "refresh") out = await refresh(cfg, !!args.force);
    else if (cmd === "act") {
      if (!a1 || !a2) throw new UsageError("act <id> <action>");
      out = await act(cfg, a1, a2, args);
    } else if (cmd === "explain") {
      if (!a1) throw new UsageError("explain <id>");
      out = await explain(cfg, a1);
    } else if (cmd === "config") {
      const saved = await cfg.store.read("config.json", {});
      for (const k of ["source", "repo", "model"]) if (typeof args[k] === "string") saved[k] = args[k];
      await cfg.store.write("config.json", saved);
      out = { root: cfg.root, config: saved };
    } else throw new UsageError(`unknown command ${cmd ?? "(none)"}; try describe`);
  }
  process.stdout.write(JSON.stringify(out, null, args.pretty ? 1 : 0) + "\n");
} catch (/** @type {any} */ e) {
  fail(e);
}
