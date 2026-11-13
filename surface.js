// What a person sees in Issues, as plain data: legend entries, menu rows, a row's status line and
// the brief view's lines. No imports, so the app's runtime and Node's tests read the same file;
// main.js only draws what these return.

/** Why an action can't run now (mirrors src/actions.mjs availability(); the helper re-checks on act). */
export function disabledReason(action, item, targets) {
  if (!item) return "Select an issue first";
  if ((action === "send-main" || action === "send-main-bare") && !targets?.main) return "No Main conversation in this space";
  if (action === "open" && !item.url && item.kind !== "board") return "Lives in the app database: no page to open";
  return null;
}

export const tip = (label, key) => (key ? `${label} (${key})` : label);
const SHORT = { "send-main": "Main", "new-main": "New", brief: "Brief", open: "Open" };
const LONG = { "send-main": "Gather context, then send to Main", "new-main": "Gather context, then start a new Main", brief: "View the context brief", open: "Open source" };
/** Offered only after a gather failed for the selected issue: an explicit choice, never a fallback. */
export const BARE = [
  { name: "send-main-bare", of: "send-main", label: "Send to Main without context", short: "Main, no context", key: "shift-m", keyLabel: "⇧M" },
  { name: "new-main-bare", of: "new-main", label: "New Main without context", short: "New, no context", key: "shift-n", keyLabel: "⇧N" },
];
export const gatherFailed = (item) => item?.context?.state === "failed";

/** The legend's action keys for the selected issue. */
export function legendEntries(actions, item, targets) {
  const entry = (name, key, label, long) => {
    const reason = disabledReason(name, item, targets);
    return { action: name, key, label, disabled: Boolean(reason), reason, tooltip: reason ? `${tip(long, key)}: unavailable. ${reason}` : tip(long, key) };
  };
  const out = actions.map((a) => entry(a.name, a.keyLabel, SHORT[a.name] ?? a.label, LONG[a.name] ?? a.label));
  if (gatherFailed(item)) for (const b of BARE) out.push(entry(b.name, b.keyLabel, b.short, b.label));
  return out;
}

/** The right-click menu's rows for one issue. */
export function menuItems(actions, item, targets) {
  const row = (name, label, keyLabel, extra = {}) => {
    const reason = disabledReason(name, item, targets);
    return { label: reason ? `${label} — ${reason}` : `${label}   ${keyLabel}`, action: reason ? "noop" : name, args: { id: item.id }, ...extra };
  };
  const out = [];
  for (const a of actions) {
    out.push(row(a.name, a.label, a.keyLabel, { sep: a.name === "dismiss", danger: a.name === "dismiss" }));
    const bare = gatherFailed(item) && BARE.find((b) => b.of === a.name);
    if (bare) out.push(row(bare.name, bare.label, bare.keyLabel));
  }
  return out;
}

/** The status line on an issue's row: gathering, failed (named, with the way on), or brief ready. */
export function rowStatus(item, gathering) {
  if (gathering) return "Gathering context…";
  if (gatherFailed(item)) return `Couldn't gather context: ${item.context.error ?? "error"}. ⇧M or ⇧N sends without context.`;
  if (item?.context?.state === "ready") return "Brief ready · B to view";
  return null;
}

const STATE = (s) => (s.state === "searching" ? "searching…" : s.state === "findings" ? `${s.findings} finding${s.findings === 1 ? "" : "s"}` : s.state === "nothing" ? "nothing relevant" : s.state === "timeout" ? "timed out" : "failed");
/** One gatherer's line: its state (and, for past conversations, that it read them and how many), its time, then the planner's reason. */
export function gathererLine(s, reason = "") {
  const read = s.read?.found ? ` · read ${s.read.sessions} conversation${s.read.sessions === 1 ? "" : "s"}` : "";
  const time = s.state !== "searching" && s.ms ? ` · ${(s.ms / 1000).toFixed(1)} s` : "";
  return `${s.label}: ${STATE(s)}${read}${time}${reason ? ` — ${reason}` : ""}`;
}

/** The plan and the gatherers' states as lines: "Planning…", then one line per chosen gatherer, then what did not start. */
export function progressLines(p) {
  if (!p || p.phase === "planning" || p.phase === "none" || !p.plan?.length) return ["Planning…"];
  const out = p.plan.map((g) => gathererLine(p.states?.find((s) => s.name === g.name) ?? { label: g.label, state: "searching" }, g.reason));
  if (p.not_started?.length) out.push(`Not started: ${p.not_started.map((g) => g.label).join(", ")}`);
  return out;
}

/** The status lines on an issue's row: while gathering, the plan and the gatherers; afterwards the same lines and "Brief ready". */
export function rowStatusLines(item, gathering, progress = null) {
  if (gathering) return progressLines(progress);
  const one = rowStatus(item, false);
  if (!one) return [];
  const swarm = item?.context?.state === "ready" ? item.context.swarm : null;
  return swarm?.plan?.length ? [...progressLines({ phase: "done", ...swarm }), one] : [one];
}

/** A brief that finished gathering may be shown only in the project it was gathered for. The view remembers its project. */
export function briefViewFor({ root, activeRoot, id, doc }) {
  return doc && root === activeRoot ? { id, root, doc, top: 0 } : null;
}
export const viewBelongs = (view, activeRoot) => Boolean(view) && view.root === activeRoot;

/** Said in the widget only while past conversations are on for the shown project. */
export function settingsLine(doc) {
  return doc?.conversations === "on" ? "Past conversations: on for this project (text only, redacted)" : null;
}

/** Word wrap to a character width; a word longer than the width is cut. */
export function wrap(text, width) {
  const out = [];
  for (const para of String(text ?? "").split("\n")) {
    let line = "";
    for (let word of para.split(/\s+/).filter(Boolean)) {
      while (word.length > width) {
        if (line) (out.push(line), (line = ""));
        out.push(word.slice(0, width));
        word = word.slice(width);
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += " " + word;
      else (out.push(line), (line = word));
    }
    out.push(line);
  }
  return out;
}

const secs = (ms) => `${(Number(ms ?? 0) / 1000).toFixed(1)} s`;
const usd = (c) => (c == null ? "cost not reported" : `$${Number(c).toFixed(4)}`);
/** "gathered in 4.2 s, $0.0031" or "reused the saved brief". */
export function costLine(doc) {
  if (doc.cached && doc.plan) return `Reused the saved brief (first gathered in ${secs(doc.first?.ms?.total)}, ${doc.calls} small-model calls, ${usd(doc.first?.cost_usd)}; cap ${usd(doc.cost_cap_usd)} per press)`;
  if (doc.cached) return `Reused the saved brief (first gathered in ${secs(doc.first?.ms?.total)}, ${usd(doc.first?.cost_usd)})`;
  if (doc.plan) return `Gathered in ${secs(doc.ms?.total)} (planning ${secs(doc.ms?.plan)}, gatherers ${secs(doc.ms?.swarm)}), ${doc.calls} small-model calls, ${usd(doc.cost_usd)}${doc.over_cap ? ` — OVER the cap of ${usd(doc.cost_cap_usd)} per press` : ` (cap ${usd(doc.cost_cap_usd)} per press)`}`;
  return `Gathered in ${secs(doc.ms?.total)} (script ${secs(doc.ms?.collect)}, model ${secs(doc.ms?.model)}), ${usd(doc.cost_usd)}`;
}

/** After a hand-off: the footer line, short enough to fit the footer. */
export function sentNotice(receipt) {
  const to = receipt.action === "new-main" ? "New Main started" : "Sent to Main";
  const c = receipt.context ?? {};
  if (c.state === "none") return `${to} without context`;
  return `${to} · brief ${c.state === "reused" ? "reused" : `${secs(c.ms)}, ${usd(c.cost_usd)}`}`;
}

/** The brief view as fixed-height lines: the brief, what the check dropped, the rules file, cost, and what was last sent. */
export function briefViewLines(doc, width = 44) {
  /** @type {{ text: string, tone: "head"|"body"|"dim"|"warn" }[]} */
  const out = [];
  const add = (text, tone = "body", indent = "") => wrap(text, width - indent.length).forEach((l, i) => out.push({ text: (i ? indent : "") + l, tone: /** @type {any} */ (tone) }));
  add(`Context brief · ${doc.title ?? doc.id}`, "head");
  out.push({ text: "", tone: "body" });
  if (doc.plan) {
    add("The plan (one small model chose the gatherers):", "head");
    for (const g of doc.plan.gatherers) {
      add(`- ${gathererLine(doc.states?.find((s) => s.name === g.name) ?? { label: g.label, state: "searching" })}`, "body", "  ");
      add(`  Why: ${g.reason}`, "dim", "  ");
      if (g.look_for) add(`  Looks for: ${g.look_for}`, "dim", "  ");
    }
    for (const g of doc.plan.not_started ?? []) add(`- ${g.label}: not started — ${g.why}`, "dim", "  ");
    for (const d of doc.plan.dropped ?? []) add(`- "${d.name}" dropped from the plan: ${d.reason}`, "warn", "  ");
    if (doc.plan.note) add(doc.plan.note, "warn");
    const r = doc.conversations?.read;
    if (doc.conversations?.mode !== "on") add("Past conversations were not read (off for this project).", "dim");
    else if (r?.found) add(`Read ${r.sessions} past conversation${r.sessions === 1 ? "" : "s"} in this project (${r.entries} messages; text only, redacted, nothing written).`, "dim");
    else if (r) add("No past conversations found for this project.", "dim");
    out.push({ text: "", tone: "body" });
  }
  for (const line of String(doc.text ?? "").split("\n")) add(line, line.startsWith("- ") ? "body" : "head", line.startsWith("- ") ? "  " : "");
  const dropped = doc.brief?.dropped ?? [];
  if (dropped.length) {
    out.push({ text: "", tone: "body" });
    add(`Dropped by the citation check (${dropped.length}):`, "head");
    for (const d of dropped) add(`- ${d.gatherer ? `${d.gatherer}: ` : ""}${d.text} (${d.reason})`, "warn", "  ");
  }
  out.push({ text: "", tone: "body" });
  add(costLine(doc), "dim");
  if (doc.rules) add(`Rules file: ${doc.rules.path} (${doc.rules.source})`, "dim");
  const s = doc.last_sent;
  out.push({ text: "", tone: "body" });
  if (!s) add("Not sent yet. M sends it to Main, N starts a new Main.", "dim");
  else {
    add(`${s.action === "new-main" ? "A new Main" : "Main"} received this at ${String(s.at).slice(11, 16)} UTC (${s.context?.state === "none" ? "without context" : s.context?.state === "reused" ? "brief reused" : "brief gathered"}):`, "head");
    add(s.prompt ?? "", "body");
  }
  return out;
}
