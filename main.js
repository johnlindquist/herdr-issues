// Triage: the few most pressing incoming issues for the project in the shown space, with what to
// do about each. The work happens in triage.mjs (Node): it gathers the issues, asks a small model
// which are pressing and why, and carries out actions. This view decides when to refresh, draws
// the result, and turns keys and right-clicks into those same actions.
//
// Keyboard first: ↑/↓ select, C copy, M send to Main, N new Main, F hand to Fixer, O open source,
// D dismiss, R refresh. The legend under the list always shows them; a disabled one says why.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, focused, exec, home, appHome, run, theme, nextCommand, shared, openOverlay } from "herdr";

const NAME = "triage";
const ICON = (n) => `mods/${NAME}/icons/${n}.svg`;
const helper = () => `${appHome()}/mods/${NAME}/triage.mjs`;
const stateDir = () => {
  const app = appHome();
  const key = app === `${home()}/.config/herdr-app` ? "default" : app.replace(/[^A-Za-z0-9]/g, "_");
  return `${home()}/.cache/herdr-triage/${key}`;
};
const REFRESH_MS = 2 * 60_000; // cheap when nothing changed: the model is only asked about changed issues

/** One call to the helper; JSON in, JSON out. */
async function callHelper(argv, timeout = 120_000) {
  const r = await exec("node", ["--disable-warning=ExperimentalWarning", helper(), ...argv, "--state", stateDir()], /** @type {any} */ ({ timeout }));
  if (r.code === 0) {
    try {
      return { ok: JSON.parse(r.stdout) };
    } catch {
      return { error: "helper printed no JSON" };
    }
  }
  try {
    return { error: JSON.parse(r.stderr.trim().split("\n").pop()).error.message };
  } catch {
    return { error: r.stderr.trim().slice(0, 200) || `exit ${r.code}` };
  }
}

function ago(iso) {
  if (!iso) return "";
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

// Pi titles its terminal "π - <session name> - <folder>".
const sessionName = (x) => (x ?? "").replace(/^π\s*-\s*/, "").replace(/\s+-\s+[^-]+$/, "").trim();

/** The space's Main (a Pi named Main, else its first Pi) and Fixer (an agent named Fixer). */
function targetsIn(space) {
  const here = agents().filter((a) => a.space === space);
  const pis = here.filter((a) => a.app === "pi");
  const main = pis.find((a) => /^main$/i.test(sessionName(a.title))) ?? pis.slice().sort((x, y) => x.tab_index - y.tab_index)[0] ?? null;
  const fixer = here.find((a) => /fixer/i.test(sessionName(a.title)) || /fixer/i.test(a.tab_name ?? "")) ?? null;
  return { main: main?.address ?? null, fixer: fixer?.address ?? null };
}

/** Same rules as src/actions.mjs availability(), for drawing; the helper re-checks on act. */
function disabledReason(action, item, targets) {
  if (!item) return "Select an issue";
  if (action === "send-main" && !targets.main) return "No Main conversation in this space";
  if (action === "fixer" && !targets.fixer) return "No Fixer agent in this space";
  if (action === "open" && !item.url && item.kind !== "board") return "Lives in the app database: no page to open";
  return null;
}

const KIND = { github: "GitHub", inbox: "Support", feedback: "Feedback", board: "Tracker" };

export default class Triage extends View {
  init(_props, cx) {
    this.roots = {}; // cwd -> project root (git top level)
    this.docs = {}; // root -> last `show` document
    this.busy = new Set();
    this.errors = {}; // root -> last helper error
    this.selected = {}; // root -> selected issue id
    this.notice = null;
    this.handle = cx.focus_handle();
    this.tick(cx);
    cx.timer.every(3000, (cx) => this.tick(cx));
    cx.timer.every(REFRESH_MS, (cx) => this.root && this.refresh(this.root, cx, false));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.handle.focus();
        else if (c === "refresh" && this.root) this.refresh(this.root, cx, true);
        else if (c === "menu") {
          const m = /** @type {any} */ (shared("triage.menu"));
          if (m?.action && m.action !== "noop") this.act(m.args?.id, m.action, cx);
        }
      }
    });
  }

  // The shown space's project: the git top level of the focused pane's folder.
  tick(cx) {
    const f = focused();
    const cwd = f?.cwd;
    if (!cwd) return;
    if (this.roots[cwd] === undefined) {
      this.roots[cwd] = null;
      cx.spawn(async (cx) => {
        const r = await exec("git", ["-C", cwd, "rev-parse", "--show-toplevel"], /** @type {any} */ ({ timeout: 5000 }));
        this.roots[cwd] = r.code === 0 ? r.stdout.trim() : cwd;
        this.tick(cx);
        cx.notify();
      });
      return;
    }
    const root = this.roots[cwd];
    if (!root || root === this.root) return;
    this.root = root;
    this.space = f.space;
    this.load(root, cx);
    cx.notify();
  }

  load(root, cx) {
    cx.spawn(async (cx) => {
      const r = await callHelper(["show", "--root", root], 15_000);
      if (r.ok) this.docs[root] = r.ok;
      cx.notify();
      if (!r.ok || r.ok.state === "missing" || r.ok.state === "stale") this.refresh(root, cx, false);
    });
  }

  refresh(root, cx, force) {
    if (this.busy.has(root)) return;
    this.busy.add(root);
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await callHelper(["refresh", "--root", root, ...(force ? ["--force"] : [])]);
      this.busy.delete(root);
      if (r.ok) {
        this.docs[root] = r.ok;
        delete this.errors[root];
      } else this.errors[root] = r.error;
      cx.notify();
    });
  }

  // Pressing first, then the rest: one list for ↑/↓.
  items(doc) {
    return [...(doc?.pressing ?? []).map((p, i) => ({ ...p, rank: i + 1 })), ...(doc?.others ?? [])];
  }

  selectedItem(doc) {
    const list = this.items(doc);
    return list.find((x) => x.id === this.selected[this.root]) ?? list[0] ?? null;
  }

  move(doc, by) {
    const list = this.items(doc);
    if (!list.length) return;
    const at = Math.max(0, list.findIndex((x) => x.id === this.selectedItem(doc)?.id));
    this.selected[this.root] = list[(at + by + list.length) % list.length].id;
  }

  act(id, action, cx) {
    const root = this.root;
    const doc = this.docs[root];
    const item = this.items(doc).find((x) => x.id === id);
    const targets = targetsIn(this.space);
    const why = disabledReason(action, item, targets);
    if (why) {
      this.notice = why;
      return cx.notify();
    }
    const terminal = action === "send-main" ? targets.main : action === "fixer" ? targets.fixer : null;
    cx.spawn(async (cx) => {
      const r = await callHelper(["act", id, action, "--root", root, ...(terminal ? ["--terminal", terminal] : [])], 30_000);
      if (!r.ok) this.notice = r.error;
      else if (action === "new-main") {
        run(r.ok.command.name, r.ok.command.args); // a new space with Pi, its first message the issue
        this.notice = "Started a new Main for it";
      } else {
        this.notice = { copy: "Copied", "send-main": "Sent to Main", fixer: "Handed to the Fixer", open: "Opened", dismiss: "Dismissed", restore: "Restored" }[action];
        if (action === "dismiss" || action === "restore") this.load(root, cx);
      }
      cx.notify();
    });
  }

  menu(item) {
    const targets = targetsIn(this.space);
    const actions = this.docs[this.root]?.actions ?? [];
    const items = actions.map((a) => {
      const reason = disabledReason(a.name, item, targets);
      return { label: reason ? `${a.label} — ${reason}` : `${a.label}   ${a.keyLabel}`, action: reason ? "noop" : a.name, args: { id: item.id }, sep: a.name === "dismiss", danger: a.name === "dismiss" };
    });
    openOverlay({ mod: "triage-menu", kind: "popup", width: 300, height: 12 + items.length * 31 + 9 + 24, props: { owner: "triage", title: item.title, items } });
  }

  onKey(e, cx) {
    const doc = this.docs[this.root];
    const k = e.keystroke;
    if (k === "down" || k === "j") this.move(doc, 1);
    else if (k === "up" || k === "k") this.move(doc, -1);
    else if (k === "r") this.root && this.refresh(this.root, cx, true);
    else if (k === "shift-f10" || k === "menu") this.selectedItem(doc) && this.menu(this.selectedItem(doc));
    else {
      const a = (doc?.actions ?? []).find((x) => x.key === k);
      const item = this.selectedItem(doc);
      if (!a || !item) return;
      this.act(item.id, a.name, cx);
    }
    this.notice = k === "up" || k === "down" || k === "j" || k === "k" ? null : this.notice;
    cx.notify();
  }

  row(t, item, selected) {
    const meta = [KIND[item.kind] ?? item.kind, item.count > 1 ? `${item.count} reports` : null, item.merged?.length ? `+ ${item.merged.map((m) => m.id).join(", ")}` : null].filter(Boolean).join(" · ");
    return v_flex()
      .id(`issue-${item.id}`)
      .px(10)
      .py(7)
      .gap(2)
      .rounded(7)
      .cursor_pointer()
      .border(1)
      .border_color(selected ? t.accent : t.chrome)
      .when(selected, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => {
        this.selected[this.root] = item.id;
        this.handle.focus();
        cx.notify();
      })
      .on_mouse_down("right", (_e, cx) => {
        this.selected[this.root] = item.id;
        this.menu(item);
        cx.notify();
      })
      .child(
        h_flex()
          .gap(7)
          .items_center()
          .when(Boolean(item.rank), (el) => el.child(div().flex_none().w(16).text_size(11).font_medium().text_color(t.blocked).child(String(item.rank))))
          .child(div().flex_1().min_w(0).truncate().text_size(12.8).font_medium().text_color(t.foreground).child(item.title)),
      )
      .when(Boolean(item.why), (el) => el.child(div().pl(item.rank ? 23 : 0).whitespace_normal().text_size(11.8).text_color(t.muted).child(item.why)))
      .child(div().pl(item.rank ? 23 : 0).truncate().text_size(10.8).text_color(t.dim).child(`${item.id} · ${meta}`));
  }

  legend(t, item) {
    const targets = targetsIn(this.space);
    const actions = this.docs[this.root]?.actions ?? [];
    const key = (k, label, reason) =>
      h_flex()
        .gap(4)
        .items_center()
        .when(Boolean(reason), (el) => el.opacity(0.4))
        .child(div().px(4).rounded(3).border(1).border_color(t.border).text_size(10).text_color(t.foreground).child(k))
        .child(div().text_size(10.5).text_color(t.dim).child(label));
    const reasons = actions.map((a) => [a, disabledReason(a.name, item, targets)]);
    const off = reasons.filter(([, r]) => r).map(([a, r]) => `${a.label}: ${r}`);
    return v_flex()
      .flex_none()
      .px(12)
      .py(7)
      .gap(5)
      .border_t(1)
      .border_color(t.border)
      .child(
        h_flex()
          .gap(8)
          .flex_wrap()
          .child(key("↑↓", "select", null))
          .children(reasons.map(([a, r]) => key(a.keyLabel, a.label, r)))
          .child(key("R", "refresh", null))
          .child(key("⇧F10", "menu", null)),
      )
      .when(off.length > 0, (el) => el.child(div().text_size(10.5).text_color(t.dim).whitespace_normal().child(off.join(" · "))));
  }

  render(cx) {
    const t = /** @type {Record<string, any>} */ (theme());
    const root = this.root;
    const doc = root ? this.docs[root] : null;
    const busy = root ? this.busy.has(root) : false;
    const error = root ? this.errors[root] : null;
    const item = this.selectedItem(doc);
    const name = root ? root.split("/").pop() : "";

    // Distinct states: loading, never read, empty, stale, failed, source unavailable.
    let banner = null;
    let tone = t.dim;
    if (!root) banner = "No project shown";
    else if (!doc && busy) banner = "Reading the issues…";
    else if (!doc) banner = error ? `Couldn't read: ${error}` : "Not read yet";
    else if (doc.state === "unavailable") ((banner = `Source unavailable: ${doc.error?.message ?? ""}`), (tone = t.blocked));
    else if (doc.state === "failed") ((banner = `Couldn't update (${doc.error?.message ?? "error"}). Showing the last summary.`), (tone = t.blocked));
    else if (doc.state === "stale") ((banner = `Stale: last read ${ago(doc.checked_at)}`), (tone = t.working));
    else if (doc.state === "empty") banner = "No open issues";
    else if (doc.state === "missing") banner = busy ? "Reading the issues…" : "Not read yet";

    const pressing = (doc?.pressing ?? []).map((p, i) => ({ ...p, rank: i + 1 }));
    const rest = doc?.others ?? [];
    const cost = doc?.refresh?.cost_usd;
    const footer = this.notice ?? (busy ? "Updating…" : doc?.updated_at ? `Read ${ago(doc.checked_at ?? doc.updated_at)}` : "");

    return v_flex()
      .id("triage-root")
      .track_focus(this.handle)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_l(1)
      .border_color(t.border)
      .text_size(13)
      .child(
        h_flex()
          .px(14)
          .h(44)
          .pt(10)
          .flex_none()
          .gap(8)
          .items_center()
          .child(div().flex_none().text_size(11.5).font_medium().text_color(t.dim).child("Triage"))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(name))
          .child(
            div()
              .id("triage-refresh")
              .flex_none()
              .p(3)
              .rounded(5)
              .text_color(t.dim)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover).text_color(t.foreground))
              .tooltip(busy ? "Updating…" : "Read again (R)")
              .on_click((_e, cx) => root && this.refresh(root, cx, true))
              .child(busy ? svg(ICON("spinner")).size(13).spin(900) : svg(ICON("refresh")).size(13)),
          ),
      )
      .when(Boolean(doc?.headline), (el) => el.child(div().px(14).pb(6).whitespace_normal().text_size(12).text_color(t.foreground).child(doc.headline)))
      .when(Boolean(banner), (el) => el.child(div().px(14).py(4).whitespace_normal().text_size(11.5).text_color(tone).child(banner)))
      .child(
        v_flex()
          .id("triage-list")
          .flex_1()
          .min_h(0)
          .px(6)
          .pb(8)
          .gap(2)
          .overflow_y_scrollbar()
          .when(pressing.length > 0, (el) => el.child(div().px(10).pt(4).pb(2).text_size(10.5).font_medium().text_color(t.dim).child("MOST PRESSING")))
          .children(pressing.map((p) => this.row(t, p, item?.id === p.id)))
          .when(rest.length > 0, (el) => el.child(div().px(10).pt(10).pb(2).text_size(10.5).font_medium().text_color(t.dim).child(`ALSO OPEN · ${rest.length}`)))
          .children(rest.map((o) => this.row(t, o, item?.id === o.id))),
      )
      .when(Boolean(doc), (el) => el.child(this.legend(t, item)))
      .child(
        h_flex()
          .flex_none()
          .px(14)
          .py(6)
          .gap(6)
          .border_t(1)
          .border_color(t.border)
          .text_size(11)
          .text_color(t.dim)
          .child(div().flex_1().truncate().child(footer))
          .child(div().flex_none().child(doc ? `${String(doc.model).split("/").pop().replace(/^claude-/, "")}${cost ? ` · $${cost.toFixed(4)}` : ""}` : "")),
      );
  }
}
