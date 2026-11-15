#!/usr/bin/env node
// Triage: the agent interface, and the only thing the sidebar calls. One JSON document on stdout;
// errors are JSON on stderr ({error: {code, message}}) with exit 1.
//
//   node triage.mjs describe
//   node triage.mjs show    --root <project>
//   node triage.mjs refresh --root <project> [--force]
//   node triage.mjs gather <id> --root <project> [--force]          the context brief for one issue, with citations
//   node triage.mjs prompt <id> --root <project> [--no-context]     exactly what a hand-off would send
//   node triage.mjs act <id> <copy|send-main|new-main|brief|open|dismiss|restore> --root <project> [--terminal t] [--apply] [--dry-run] [--no-context]
//   node triage.mjs rules   --root <project> [--init]
//   node triage.mjs explain <id> --root <project>
//   node triage.mjs config  --root <project> [--source local|github|local,github] [--repo owner/name] [--model provider/id]

import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { pickSources, SourceUnavailable } from "./src/sources.mjs";
import { groupIssues, hashOf, issueText, compareIds, lastAt } from "./src/issue.mjs";
import { DEFAULT_MODEL, DEFAULT_INSTRUCTION, INSTRUCTIONS, systemFor, callModel, modelInput, parseSummary, others } from "./src/triage.mjs";
import { ACTIONS, ACTION_NAMES, HANDOFFS, ActionUnavailable, availability, newMainCommand, openTarget } from "./src/actions.mjs";
import { GatherFailed, validateBrief, DEFAULT_GATHER_INSTRUCTION, GATHER_INSTRUCTIONS, LIMITS } from "./src/gather.mjs";
import { gather, GATHERERS, SWARM_LIMITS, COST_CAP_USD } from "./src/gatherers.mjs";
import { issueFor, assemblePrompt, loadRules, PROJECT_RULES, DEFAULT_RULES_FILE } from "./src/handoff.mjs";
import fs from "node:fs";
import { defaultStateDir, storeFor } from "./src/store.mjs";
import * as settings from "./src/settings.mjs";

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

// ---------- settings: default < user file < project file < saved on this machine < environment < flag ----------
// What is valid and where a value comes from: src/settings.mjs. Past conversations are not a
// settings-file key on purpose: they are switched on per project, on this machine only (`config --conversations on`).

async function configFor(args) {
  const root = path.resolve(expandHome(typeof args.root === "string" ? args.root : process.cwd()));
  const stateDir = path.resolve(expandHome(typeof args.state === "string" ? args.state : defaultStateDir()));
  const store = storeFor(stateDir, root);
  const saved = await store.read("config.json", {});
  const user = settings.readFile(settings.userFile());
  const project = settings.readFile(settings.projectFile(root));
  const set = settings.resolve({ user: user.values, project: project.values, saved, env: process.env, flags: args, problems: [...user.problems, ...project.problems] });
  if (set.flagErrors.length) throw new UsageError(set.flagErrors.join("; "));
  const v = set.values;
  const local = (k, env) => (typeof args[k] === "string" ? args[k] : saved[k] ?? process.env[env] ?? null);
  return {
    root,
    stateDir,
    store,
    saved,
    settings: { values: v, from: set.from, problems: set.problems, files: { user: user.file, project: project.file } },
    source: v.sources,
    repo: v.repo ?? githubRepoOf(root),
    model: v.model,
    thinking: v.thinking,
    maxPressing: v.maxPressing,
    gatherMs: v.gatherSeconds * 1000,
    instruction: v.instruction,
    rules: v.rulesFile ? expandHome(v.rulesFile) : null,
    gatherInstruction: v.gatherInstruction,
    gatherers: v.gatherers,
    conversations: { mode: local("conversations", "TRIAGE_CONVERSATIONS") === "on" ? "on" : "off", of: local("conversations-of", "TRIAGE_CONVERSATIONS_OF") ? path.resolve(expandHome(local("conversations-of", "TRIAGE_CONVERSATIONS_OF"))) : null },
  };
}

/** How to change the model, said wherever a model call failed. */
const changeModelHint = (cfg) => `Model ${cfg.model} (${cfg.settings.from.model}). To use another: node triage.mjs config set model <provider/id>`;

/** One press of gathering, with the plan and each gatherer's state written where the sidebar can read them (`progress <id>`). */
function gatherWith(cfg, issue, force = false) {
  let chain = Promise.resolve();
  const progress = (p) => (chain = chain.then(() => cfg.store.write("progress.json", { id: issue.id, at: new Date().toISOString(), ...p }).catch(() => {})));
  return gather({ root: cfg.root, store: cfg.store, model: cfg.model, instruction: cfg.gatherInstruction, issue, force, repo: cfg.repo, only: cfg.gatherers, conversations: cfg.conversations, thinking: cfg.thinking, timeoutMs: cfg.gatherMs, progress })
    .catch((e) => {
      if (e?.code === "GATHER_FAILED") e.message = `${e.message}. ${changeModelHint(cfg)}`;
      throw e;
    })
    .finally(() => chain);
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
    const inputHash = hashOf({ g: groups.map((g) => [g.id, g.hash]), model: cfg.model, system: hashOf(systemFor(cfg.instruction, cfg.maxPressing)), ...(cfg.thinking === "off" ? {} : { thinking: cfg.thinking }) });
    const base = { version: VERSION, root: cfg.root, sources: sourceInfo, model: cfg.model, instruction: cfg.instruction, groups, hashes: Object.fromEntries(groups.map((g) => [g.id, g.hash])) };
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
        reply = await callModel({ model: cfg.model, system: systemFor(cfg.instruction, cfg.maxPressing), input: input.text, thinking: cfg.thinking });
        summary = parseSummary(reply.text, groups, cfg.maxPressing);
      } catch (/** @type {any} */ e) {
        modelError = `${String(e?.message || e)}. ${changeModelHint(cfg)}`;
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
  // Per issue: is there a context brief for it as it reads now, and what was last handed over.
  const gathers = await cfg.store.read("gathers.json", {});
  const sent = await cfg.store.read("sent.json", {});
  const withContext = (item, groupIds) => {
    const g = gathers[item.id];
    const hash = hashOf(groupIds.map((x) => [x, byId.get(x)?.hash]));
    const s = sent[item.id];
    return { ...item, context: g && g.issue_hash === hash ? { state: g.state, at: g.at, error: g.error ?? null, claims: g.claims ?? null, dropped: g.dropped ?? null, swarm: g.swarm ?? null } : { state: "none" }, sent: s ? { at: s.at, action: s.action, context: s.context?.state ?? null } : null };
  };
  let rules = null;
  try {
    const r = loadRules({ root: cfg.root, explicit: cfg.rules });
    rules = { path: r.path, source: r.source, error: null };
  } catch (/** @type {any} */ e) {
    rules = { path: null, source: null, error: String(e.message) };
  }
  return {
    version: VERSION,
    root: cfg.root,
    state: stateOf(doc),
    busy: cfg.store.busy(),
    model: doc?.model ?? cfg.model,
    instruction: doc?.instruction ?? cfg.instruction,
    sources: doc?.sources ?? [],
    updated_at: doc?.updated_at ?? null,
    checked_at: doc?.checked_at ?? null,
    headline: doc?.summary?.headline ?? null,
    pressing: pressing.map((p) => withContext(p, [p.id, ...p.merged.map((m) => m.id)])),
    others: others(groups, taken).filter((g) => !dismissed.has(g.id)).map((g) => withContext(card(g), [g.id])),
    rules,
    conversations: cfg.conversations.mode, // "on" only when this project's setting says so
    settings: { model: cfg.model, model_from: cfg.settings.from.model, thinking: cfg.thinking, refreshSeconds: cfg.settings.values.refreshSeconds, problems: cfg.settings.problems, files: cfg.settings.files },
    dismissed: [...dismissed].sort(compareIds),
    counts: { issues: groups.reduce((n, g) => n + g.members.length, 0), distinct: groups.length },
    actions: ACTIONS,
    refresh: doc?.refresh ?? null,
    error: doc?.error ?? null,
  };
}

// ---------- gather, prompt, act ----------

/** The issue an id belongs to: its own group first, then every group the model merged with it; the why and the shown title. */
async function findIssue(cfg, id) {
  const doc = await cfg.store.read("triage.json", null);
  const groups = doc?.groups ?? [];
  const g = groups.find((x) => x.members.some((m) => m.id === id));
  if (!g) throw Object.assign(new Error(`no issue ${id} in the last refresh (run refresh)`), { code: "NOT_FOUND" });
  const p = (doc.summary?.pressing ?? []).find((x) => x.ids.includes(g.id)) ?? null;
  const all = p ? p.ids.map((x) => groups.find((y) => y.id === x)).filter(Boolean) : [g];
  const lead = all[0] ?? g;
  return { g: lead, groups: all, why: p?.why ?? null, title: p?.title ?? null, doc, issue: issueFor(all, p?.why ?? null, p?.title ?? null) };
}

function sh(cmd, argv, input) {
  const r = spawnSync(cmd, argv, { input, encoding: "utf8", timeout: 20_000 });
  return { ok: r.status === 0, code: r.status, stdout: (r.stdout ?? "").trim().slice(0, 400), stderr: (r.stderr ?? "").trim().slice(0, 300) || (r.error ? String(r.error) : "") };
}

const lastSent = async (cfg, id) => (await cfg.store.read("sent.json", {}))[id] ?? null;

/** `gather <id>`: the context brief as JSON, with its citations, what the check dropped, time and cost. */
async function gatherFor(cfg, id, force) {
  const { issue } = await findIssue(cfg, id);
  const doc = await gatherWith(cfg, issue, force);
  validateBrief(doc.brief);
  let rules;
  try {
    const r = loadRules({ root: cfg.root, explicit: cfg.rules });
    rules = { path: r.path, source: r.source, error: null };
  } catch (/** @type {any} */ e) {
    rules = { path: null, source: null, error: String(e.message) };
  }
  return { ...doc, id: issue.id, ids: issue.ids, title: issue.title, state: "ready", rules, last_sent: await lastSent(cfg, issue.id) };
}

/**
 * What a hand-off sends: issue + brief + rules. Gathers first (reusing a saved brief). A failed
 * gather throws GATHER_FAILED: nothing is assembled unless the caller chose --no-context.
 */
async function handoff(cfg, id, noContext, justGathered = null) {
  const { g, issue } = await findIssue(cfg, id);
  const rules = loadRules({ root: cfg.root, explicit: cfg.rules });
  let context = { state: "none", key: null, ms: 0, cost_usd: 0, claims: 0, dropped: 0 };
  let brief = null;
  let excerpts = null;
  if (!noContext) {
    let doc;
    try {
      doc = await gatherWith(cfg, issue);
    } catch (/** @type {any} */ e) {
      if (!(e instanceof GatherFailed)) throw e;
      throw new GatherFailed(`${e.message}. Nothing was sent. To send the issue and the rules without context, repeat with --no-context`);
    }
    validateBrief(doc.brief);
    brief = doc.text;
    excerpts = doc.excerpts?.text ?? null;
    // The sidebar gathers as its own visible step, then acts: `--gathered <key>` says the brief with that key was made for this press.
    const fresh = !doc.cached || (justGathered && justGathered === doc.key);
    const made = doc.cached ? doc.first : doc;
    context = { state: fresh ? "gathered" : "reused", key: doc.key, ms: fresh ? made.ms.total : doc.ms.total, cost_usd: fresh ? made.cost_usd : 0, claims: doc.claims, dropped: doc.brief.dropped.length, gatherers: doc.states.map((s) => `${s.label}: ${s.state}`) };
  }
  return { g, issue, rules, context, brief, prompt: assemblePrompt({ issue: issue.text, brief, excerpts, rules }) };
}

async function act(cfg, id, action, args) {
  if (!ACTION_NAMES.includes(action)) throw new UsageError(`action is one of ${ACTION_NAMES.join(", ")}`);
  if (action === "brief") return gatherFor(cfg, id, !!args.force);
  const dry = !!args["dry-run"];
  const found = await findIssue(cfg, id);
  const g = found.g;
  if (action === "send-main" || action === "open") {
    const a = availability(/** @type {any} */ (action), g, { main: action === "send-main" && typeof args.terminal === "string" ? args.terminal : null });
    if (!a.enabled) throw new ActionUnavailable(a.reason, a.code);
  }
  const receipt = { at: new Date().toISOString(), action, id: g.id, ids: found.issue.ids, dry_run: dry };
  if (action === "copy") {
    const text = issueText(g, found.why);
    Object.assign(receipt, { text, clipboard: dry || args["no-clipboard"] ? false : sh("pbcopy", [], text).ok });
  } else if (HANDOFFS.includes(action)) {
    const h = await handoff(cfg, id, !!args["no-context"], typeof args.gathered === "string" ? args.gathered : null);
    Object.assign(receipt, { context: h.context, rules_file: h.rules.path, prompt: h.prompt });
    if (action === "send-main") {
      Object.assign(receipt, { terminal: args.terminal, command: ["hc", "send", args.terminal, h.prompt] });
      if (!dry) receipt.result = sh("hc", ["send", String(args.terminal), h.prompt]);
    } else {
      const command = newMainCommand(h.issue.title, h.prompt, cfg.root);
      Object.assign(receipt, { command, applied: Boolean(args.apply && !dry) });
      if (args.apply && !dry) receipt.result = sh("herdr-app", ["do", command.name, JSON.stringify(command.args)]);
    }
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
  if (HANDOFFS.includes(action)) {
    const sent = await cfg.store.read("sent.json", {});
    sent[g.id] = { at: receipt.at, action, context: receipt["context"], rules_file: receipt["rules_file"], prompt: receipt["prompt"], dry_run: dry };
    await cfg.store.write("sent.json", sent);
  }
  return receipt;
}

/** `rules`: which file a hand-off would use and its text; --init copies the default into the project so it can be edited there. */
function rulesCmd(cfg, init) {
  const own = path.join(cfg.root, PROJECT_RULES);
  let created = false;
  if (init && !fs.existsSync(own)) {
    fs.copyFileSync(DEFAULT_RULES_FILE, own);
    created = true;
  }
  const r = loadRules({ root: cfg.root, explicit: cfg.rules });
  return { path: r.path, source: r.source, text: r.text, project_file: own, default_file: DEFAULT_RULES_FILE, created };
}

async function explain(cfg, id) {
  const { g, why, doc } = await findIssue(cfg, id);
  const rank = (doc.summary?.pressing ?? []).findIndex((p) => p.ids.includes(g.id));
  const prompt = `Explain this issue from the project's tracker and why Issues ranked it ${rank >= 0 ? `#${rank + 1} of the most pressing` : "as not pressing"}. Read the code it touches; don't change anything.\n\n${issueText(g, why)}`;
  return { id: g.id, ids: g.members.map((m) => m.id), pressing_rank: rank >= 0 ? rank + 1 : null, why, text: issueText(g, why), hash: g.hash, prompt, argv: ["pi", "--name", `Explain ${g.id}`, prompt] };
}

/** Past-conversation and other machine-local choices, stored for one project in the state folder (the older `config --flag value` form). */
const SAVED_FLAGS = ["source", "repo", "model", "instruction", "rules", "gather-instruction", "gatherers", "conversations", "conversations-of"];

/**
 * `config`: the effective settings and where each came from. `config set <key> <value> [--project]`
 * and `config unset <key> [--project]` write the user file (or the project's); `config path` names both.
 */
async function configCmd(cfg, args) {
  const [, sub, key, ...rest] = args._;
  const files = cfg.settings.files;
  if (typeof args.project === "string") throw new UsageError("put --project last: config set <key> <value> --project");
  const file = args.project ? files.project : files.user;
  if (sub === "path") return { user: files.user, project: files.project, user_exists: fs.existsSync(files.user), project_exists: fs.existsSync(files.project) };
  if (sub === "set" || sub === "unset") {
    if (!key || (sub === "set" && !rest.length)) throw new UsageError(`config ${sub} <key>${sub === "set" ? " <value>" : ""} [--project]`);
    const value = sub === "set" ? settings.setInFile(file, key, rest.join(" ")) : null;
    const removed = sub === "unset" ? settings.unsetInFile(file, key) : null;
    const now = await configFor(args);
    return { [sub]: key, ...(sub === "set" ? { value } : { removed }), file, effective: { value: now.settings.values[key], from: now.settings.from[key] }, problems: now.settings.problems };
  }
  if (sub) throw new UsageError(`unknown config command ${sub}; use config, config set, config unset or config path`);
  const saved = { ...cfg.saved };
  let wrote = false;
  for (const k of SAVED_FLAGS) if (typeof args[k] === "string") ((saved[k] = args[k]), (wrote = true));
  if (wrote) await cfg.store.write("config.json", saved);
  const now = wrote ? await configFor({ ...args, ...Object.fromEntries(SAVED_FLAGS.map((k) => [k, undefined])) }) : cfg;
  return {
    root: cfg.root,
    settings: Object.fromEntries(Object.keys(settings.KEYS).map((k) => [k, { value: now.settings.values[k], from: now.settings.from[k] }])),
    problems: now.settings.problems,
    files,
    order: settings.LAYERS,
    conversations: now.conversations,
    config: saved,
  };
}

const DESCRIBE = {
  name: "Issues (herdr-triage)",
  what: "The Issues widget. Gathers a project's incoming issues (its app inbox and tracker board, and/or GitHub issues), has a small model pick the few most pressing with a one-line why each (duplicates merged, every claim keeps its source ids), and acts on one: copy it, hand it to Main or to a new Main (after gathering a cited context brief, with the project's rules), view that brief, open its source, dismiss it.",
  commands: {
    show: "show --root <project>: the last refresh, no model call. state: ready | empty | missing (never refreshed) | stale (older than 30 min) | failed (model failed; last summary kept) | unavailable (no source could be read); busy: a refresh is running. Each issue has context {state: none | ready | failed, error} (its context brief) and sent (the last hand-off); rules names the rules file a hand-off would use",
    refresh: "refresh --root <project> [--force]: read the sources; ask the model only when an issue changed (content hash), sending changed issues in full and unchanged ones as titles",
    gather: "gather <id> --root <project> [--force]: the context brief for one issue as JSON. Code collects every merged report, the files a tracker card names, repo lines matching the issue's distinctive terms, tests near them and recent commits (bounded; local only); the small model condenses that into brief {reported, where, tests, unknown}, each a list of {text, cites}. A cite is a report id, a path:line the model was shown, or commit:<sha>; a claim with a missing or unresolvable cite, or a cause stated as fact, is moved to brief.dropped with the reason. Also: text (the brief as sent), candidates, ms {collect, model, total}, tokens, cost_usd, cached (true when the saved brief was reused; saved by content hash of the issue, the collected evidence, the model and the instruction), rules, last_sent",
    prompt: "prompt <id> --root <project> [--no-context]: exactly what a hand-off would send: {prompt, context {state: gathered | reused | none, ms, cost_usd, claims, dropped}, rules_file}. The prompt is the issue (title, ids, the why, every merged report), then the context brief, then the rules, and nothing else",
    act: "act <id> <action> --root <project>: copy (to the clipboard) | send-main --terminal <Main terminal> (gathers, then hc send) | new-main [--apply] (gathers, then prints the herdr space.new command whose task is the prompt; --apply runs it) | brief (same as gather) | open | dismiss | restore. --gathered <key>: the brief with this key was gathered for this hand-off just now (the sidebar gathers as a visible step first), so the receipt says gathered, not reused. --no-context: hand over the issue and the rules without a brief (an explicit choice; a failed gather never sends on its own). --dry-run records the receipt without doing it. Every hand-off's receipt keeps the prompt, the context state, time, cost and the rules file",
    rules: `rules --root <project> [--init]: the one rules file a hand-off uses and its text: --rules <path> or config, else <project>/${PROJECT_RULES}, else the widget's own rules.md. --init copies the default to <project>/${PROJECT_RULES} so it can be edited there`,
    explain: "explain <id> --root <project>: the issue as text, its rank and why, and a Pi command that explains it",
    config: "config --root <project>: the effective settings, each with where it came from (default | user file | project file | saved | environment | flag), any problems found in the files, and both file paths. config set <key> <value> [--project]: check the value, then write it to the user file, or with --project (last on the line) to <project>/.herdr/issues.json. config unset <key> [--project]: remove it. config path: the two files. A problem (an unknown key, a bad value, a file that is not JSON) is reported and that entry is skipped; the weaker layers still apply. Machine-local, per project, never in a file: config --conversations on|off and --conversations-of <folder>. The older form config --model <id> (also --source, --repo, --instruction, --rules, --gather-instruction, --gatherers) still saves a value for one project on this machine (the 'saved' layer)",
    progress: "progress <id> --root <project>: the plan and each gatherer's state for the gather that is running or last ran: {phase: planning | gathering | none, plan [{name, label, look_for, reason}], not_started [{label, why}], states [{label, state: searching | findings | nothing | timeout | error, findings, ms}]}",
    swarm: `gathering is a planner plus a swarm. One small-model call reads the issue and picks which gatherers start and what each looks for (${GATHERERS.map((g) => g.name).join(", ")}); code checks the plan (an unknown name is dropped, an empty plan is code only, code always runs). The chosen gatherers run in parallel, each inside ${SWARM_LIMITS.timeoutMs / 1000} s; a slow or failed one is shown as such and never blocks the hand-off. Code fetches and bounds; the small model only judges relevance; a line is kept only when it cites something code fetched. Everything outside the project is read-only (git, gh search and GETs, the npm registry, Pi session files). Cap per press: at most 6 small-model calls, $${COST_CAP_USD}; a press that reports more is flagged. Past conversations are OFF unless the project turns them on. Settings (config): --gatherers code,history,... (which may start), --conversations on (read this project's past Pi conversations: only sessions whose own header says they were started in this project; user and assistant text only; redacted before any model, cache, receipt or prompt sees it; nothing is written there), --conversations-of <project folder> (count that folder's conversations as this project's, for a clone).`,
    describe: "this description",
  },
  actions: ACTIONS,
  errors: {
    GATHER_FAILED: "the context brief could not be made (model call failed, no JSON, or no claim survived the citation check). Nothing was sent; --no-context sends without it",
    NO_MAIN: "send-main without --terminal: no Main conversation to send to",
    RULES_MISSING: "the rules file is missing or empty; nothing is sent without rules",
    NOT_FOUND: "no such issue in the last refresh",
    ACTION_UNAVAILABLE: "the action can't run for this issue (the message says why)",
    ACTION_FAILED: "the command that carries the action out failed",
    INVALID: "bad usage or an unknown name",
    CONFIG_BROKEN: "config set or unset found a settings file that is not valid JSON; nothing was written",
    SOURCE_UNAVAILABLE: "no source could be read",
  },
  gather_limits: LIMITS,
  sources: { local: "<root>/data/rentaplace.db (open support tickets, feedback not rated good) and <root>/tracker/board.json (cards not done)", github: "open issues via `gh issue list` (read-only)" },
  settings: settings.describeKeys(),
  settings_files: { user: "~/.config/herdr-issues/config.json, or the path in HERDR_ISSUES_CONFIG", project: "<project>/.herdr/issues.json", order: settings.LAYERS },
  environment: { TRIAGE_MODEL: `default ${DEFAULT_MODEL} (reads the inbox and writes the context brief)`, TRIAGE_INSTRUCTION: `${Object.keys(INSTRUCTIONS).join(" | ")} (default ${DEFAULT_INSTRUCTION})`, TRIAGE_GATHER_INSTRUCTION: `${Object.keys(GATHER_INSTRUCTIONS).join(" | ")} (default ${DEFAULT_GATHER_INSTRUCTION})`, TRIAGE_RULES: "path of the rules file", TRIAGE_SOURCE: "local | github | local,github", TRIAGE_REPO: "owner/name", TRIAGE_STATE: "state dir (default ~/.cache/herdr-triage/default)", TRIAGE_MODEL_CMD: 'JSON argv run instead of Pi; gets {"model","system","input"} on stdin, prints the reply' },
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
    } else if (cmd === "gather") {
      if (!a1) throw new UsageError("gather <id>");
      out = await gatherFor(cfg, a1, !!args.force);
    } else if (cmd === "progress") {
      const p = await cfg.store.read("progress.json", null);
      out = p && (!a1 || p.id === a1) ? p : { id: a1 ?? null, phase: "none", plan: [], not_started: [], states: [] };
    } else if (cmd === "prompt") {
      if (!a1) throw new UsageError("prompt <id>");
      const h = await handoff(cfg, a1, !!args["no-context"]);
      out = { id: h.issue.id, ids: h.issue.ids, prompt: h.prompt, context: h.context, rules_file: h.rules.path, rules_source: h.rules.source };
    } else if (cmd === "rules") {
      out = rulesCmd(cfg, !!args.init);
    } else if (cmd === "explain") {
      if (!a1) throw new UsageError("explain <id>");
      out = await explain(cfg, a1);
    } else if (cmd === "config") {
      out = await configCmd(cfg, args);
    } else throw new UsageError(`unknown command ${cmd ?? "(none)"}; try describe`);
  }
  process.stdout.write(JSON.stringify(out, null, args.pretty ? 1 : 0) + "\n");
} catch (/** @type {any} */ e) {
  fail(e);
}
