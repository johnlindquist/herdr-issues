// Issues: the few most pressing incoming issues for the project in the shown space, with what to
// do about each. (Internal mod id: "triage", the verb for what its model does.) The work happens
// in triage.mjs (Node): it gathers the issues, asks a small model which are pressing and why, and
// carries out actions. This view decides when to refresh, draws the result, and turns keys,
// clicks and right-clicks into those same actions.
//
// Keys: ⌘I (global, keys.json "triage.focus") gives Issues the keyboard; Esc gives it back.
// Inside: the shared navigation rules in nav.js (↑↓ Home End PgUp PgDn, Tab, −), plus the action
// keys from src/actions.mjs. Every control has a tooltip "Action (Key)".

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, focused, panes, exec, home, appHome, run, theme, nextCommand, shared, openOverlay, layout } from "herdr";
import { step, widgetDirection, COLLAPSE_KEY, loadCollapsed, applyCollapse, returnTarget, tip, keepInView, wheelTop, maxTop, fitCount, estimateViewport } from "./nav.js";

const NAME = "triage"; // mod folder and command prefix; people see "Issues"
const TITLE = "Issues";
const FOCUS_KEY = "⌘I";
const ICON = (n) => `mods/${NAME}/icons/${n}.svg`;
const helper = () => `${appHome()}/mods/${NAME}/triage.mjs`;
const stateDir = () => {
  const app = appHome();
  const key = app === `${home()}/.config/herdr-app` ? "default" : app.replace(/[^A-Za-z0-9]/g, "_");
  return `${home()}/.cache/herdr-triage/${key}`;
};
const CHROME_PX = 200; // header, headline, legend and footer: what the list doesn't get
const windowHeight = () => {
  try {
    return /** @type {any} */ (globalThis).window?.viewport_size?.().height ?? 900;
  } catch {
    return 900;
  }
};
const REFRESH_MS = 2 * 60_000; // cheap when nothing changed: the model is only asked about changed issues
// Fixed row heights: the virtual list places rows by these, so rows clip their text to fit
// (the full text is in the row's tooltip, Copy and the right-click menu).
const H = { section: 28, pressing: 96, other: 60 };

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
  return { main: main?.address ?? null, mainPane: main?.pane ?? null, fixer: fixer?.address ?? null };
}

/** Same rules as src/actions.mjs availability(), for drawing; the helper re-checks on act. */
function disabledReason(action, item, targets) {
  if (!item) return "Select an issue first";
  if (action === "send-main" && !targets.main) return "No Main conversation in this space";
  if (action === "fixer" && !targets.fixer) return "No Fixer agent in this space";
  if (action === "open" && !item.url && item.kind !== "board") return "Lives in the app database: no page to open";
  return null;
}

const LONG = { Next: "Next widget", Back: "Back to Main", Refresh: "Refresh issues", Main: "Send to Main", New: "New Main from this", Fixer: "Hand to Fixer", Open: "Open source" };
const SHORT = { "send-main": "Main", "new-main": "New", fixer: "Fixer", open: "Open" };
const KIND = { github: "GitHub", inbox: "Support", feedback: "Feedback", board: "Tracker" };

export default class Issues extends View {
  init(_props, cx) {
    this.roots = {}; // cwd -> project root (git top level)
    this.docs = {}; // root -> last `show` document
    this.busy = new Set();
    this.errors = {}; // root -> last helper error
    this.selected = {}; // root -> selected issue id
    this.notice = null;
    this.before = null; // what had the keyboard before ⌘I
    this.collapsed = loadCollapsed(localStorage, NAME);
    this.handle = cx.focus_handle();
    this.top = 0; // first list row shown (the list windows itself: see nav.js)
    this.viewH = null; // the list's measured height, once the pointer has been over it
    this.tick(cx);
    cx.timer.every(3000, (cx) => this.tick(cx));
    cx.timer.every(REFRESH_MS, (cx) => this.root && this.refresh(this.root, cx, false));
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.takeKeyboard(cx);
        else if (c === "menu") {
          const m = /** @type {any} */ (shared("triage.menu"));
          if (m?.action && m.action !== "noop") this.act(m.args?.id, m.action, cx);
        } else this.command(c, cx); // refresh, collapse, escape, and key names (lets agents and the Lab drive it)
        cx.notify();
      }
    });
  }

  // ⌘I: remember what had the keyboard, expand if collapsed, select, take the keyboard.
  takeKeyboard(cx) {
    const f = focused();
    if (!this.handle.is_focused() && f && (f.pane || f.terminal)) this.before = { pane: f.pane, terminal: f.terminal };
    if (this.collapsed) this.setCollapsed(false);
    const doc = this.docs[this.root];
    if (doc && !this.selected[this.root]) this.selected[this.root] = this.items(doc)[0]?.id;
    this.handle.focus();
    this.reveal(doc);
    cx.notify();
  }

  // Esc: back to the pane that had the keyboard, else the space's Main.
  giveBack() {
    const t = returnTarget(this.before, targetsIn(this.space).mainPane);
    this.before = null;
    if (t) run("pane.focus", t);
  }

  setCollapsed(on) {
    this.collapsed = on;
    applyCollapse({ mod: NAME, collapsed: on, storage: localStorage, layout, run });
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
    this.space = f.space;
    if (!root || root === this.root) return;
    this.root = root;
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

  // The virtual list's rows: section labels and issues.
  rows(doc) {
    const pressing = (doc?.pressing ?? []).map((p, i) => ({ type: "issue", item: { ...p, rank: i + 1 } }));
    const rest = (doc?.others ?? []).map((o) => ({ type: "issue", item: o }));
    return [
      ...(pressing.length ? [{ type: "section", label: "MOST PRESSING" }, ...pressing] : []),
      ...(rest.length ? [{ type: "section", label: `ALSO OPEN · ${rest.length}` }, ...rest] : []),
    ];
  }

  selectedItem(doc) {
    const list = this.items(doc);
    return list.find((x) => x.id === this.selected[this.root]) ?? list[0] ?? null;
  }

  rowHeight(r) {
    return r.type === "section" ? H.section : r.item.rank ? H.pressing : H.other;
  }

  viewport() {
    return this.viewH ?? estimateViewport(layout(), NAME, windowHeight(), CHROME_PX);
  }

  // Keep the selection on screen: move the list only when the selection would leave it.
  reveal(doc) {
    const sel = this.selectedItem(doc);
    const rows = this.rows(doc);
    let at = rows.findIndex((r) => r.type === "issue" && r.item.id === sel?.id);
    if (at < 0) return;
    if (at > 0 && rows[at - 1].type === "section" && at - 1 < this.top) at -= 1; // bring its section label along
    this.top = keepInView(this.top, at, rows.map((r) => this.rowHeight(r)), this.viewport());
  }

  /** Keys and commands share one path. Returns true when handled. */
  command(k, cx) {
    const doc = this.docs[this.root];
    const list = this.items(doc);
    if (k === "escape") {
      this.giveBack();
      return true;
    }
    if (k === COLLAPSE_KEY || k === "collapse") {
      this.setCollapsed(!this.collapsed);
      return true;
    }
    if (k === "refresh" || k === "r") {
      if (this.root) this.refresh(this.root, cx, true);
      return true;
    }
    const dir = widgetDirection(k);
    if (dir) {
      run("pane.go", { direction: dir });
      return true;
    }
    if (this.collapsed) return false;
    if (k === "shift-f10" || k === "menu-key") {
      const item = this.selectedItem(doc);
      if (item) this.menu(item);
      return true;
    }
    const at = Math.max(0, list.findIndex((x) => x.id === this.selectedItem(doc)?.id));
    const next = step(at, list.length, k);
    if (next != null) {
      this.selected[this.root] = list[next].id;
      this.notice = null;
      this.reveal(doc);
      return true;
    }
    const a = (doc?.actions ?? []).find((x) => x.key === k);
    const item = this.selectedItem(doc);
    if (!a || !item) return false;
    this.act(item.id, a.name, cx);
    return true;
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
    openOverlay({ mod: "triage-menu", kind: "popup", width: 320, height: 12 + items.length * 31 + 9 + 24, props: { owner: "triage", title: `Issues · ${item.title}`, items } });
  }

  row(t, item, selected, focusedNow) {
    const meta = [KIND[item.kind] ?? item.kind, item.count > 1 ? `${item.count} reports` : null, item.merged?.length ? `+ ${item.merged.map((m) => m.id).join(", ")}` : null].filter(Boolean).join(" · ");
    const full = [item.title, item.why, `${item.id} · ${meta}`].filter(Boolean).join("\n");
    const pad = item.rank ? 23 : 0;
    return v_flex()
      .id(`issue-${item.id}`)
      .h(item.rank ? H.pressing - 4 : H.other - 4)
      .mx(6)
      .px(10)
      .py(6)
      .gap(2)
      .rounded(7)
      .overflow_hidden()
      .cursor_pointer()
      .border(focusedNow && selected ? 2 : 1)
      .border_color(selected ? t.accent : t.chrome)
      .when(selected, (el) => el.bg(t.selected))
      .hover((s) => s.bg(t.hover))
      .tooltip(`${full}\n\nRight-click or ⇧F10 for actions`)
      .on_mouse_down("left", (_e, cx) => {
        this.selected[this.root] = item.id;
        if (!this.handle.is_focused()) {
          const f = focused();
          if (f && (f.pane || f.terminal)) this.before = { pane: f.pane, terminal: f.terminal };
        }
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
          .flex_none()
          .when(Boolean(item.rank), (el) => el.child(div().flex_none().w(16).text_size(11).font_medium().text_color(t.blocked).child(String(item.rank))))
          .child(div().flex_1().min_w(0).truncate().text_size(12.8).font_medium().text_color(t.foreground).child(item.title)),
      )
      .when(Boolean(item.why), (el) => el.child(div().pl(pad).h(36).flex_none().overflow_hidden().whitespace_normal().text_size(11.8).text_color(t.muted).child(item.why)))
      .child(div().pl(pad).flex_none().truncate().text_size(10.8).text_color(t.dim).child(`${item.id} · ${meta}`));
  }

  legend(t, item) {
    const targets = targetsIn(this.space);
    const actions = this.docs[this.root]?.actions ?? [];
    const key = (id, k, label, reason, onClick) =>
      h_flex()
        .id(`legend-${id}`)
        .gap(4)
        .items_center()
        .cursor_pointer()
        .tooltip(reason ? `${tip(LONG[label] ?? label, k)}: unavailable. ${reason}` : tip(LONG[label] ?? label, k))
        .when(Boolean(reason), (el) => el.opacity(0.4))
        .when(Boolean(onClick) && !reason, (el) => el.on_click((_e, cx) => onClick(cx)))
        .child(div().px(4).rounded(3).border(1).border_color(t.border).text_size(10).text_color(t.foreground).child(k))
        .child(div().text_size(10.5).text_color(t.dim).child(label));
    const reasons = actions.map((a) => [a, disabledReason(a.name, item, targets)]);
    return v_flex()
      .flex_none()
      .px(12)
      .py(5)
      .gap(3)
      .border_t(1)
      .border_color(t.border)
      .child(
        h_flex()
          .gap_x(8)
          .gap_y(3)
          .flex_wrap()
          .children(reasons.map(([a, r]) => key(a.name, a.keyLabel, SHORT[a.name] ?? a.label, r, (cx) => item && this.act(item.id, a.name, cx)))),
      )
      .child(
        h_flex()
          .gap_x(8)
          .gap_y(3)
          .flex_wrap()
          .child(key("sel", "↑↓", "Select", null, null))
          .child(key("tab", "Tab", "Next", null, null))
          .child(key("col", "−", "Collapse", null, () => this.setCollapsed(true)))
          .child(key("esc", "Esc", "Back", null, () => this.giveBack()))
          .child(key("ref", "R", "Refresh", null, (cx) => this.root && this.refresh(this.root, cx, true))),
      );
  }

  // The list shows rows from `top` and clips the rest; the wheel moves `top` (nav.js wheelTop).
  list(t, rows, item, hasKeys) {
    const heights = rows.map((r) => this.rowHeight(r));
    const vp = this.viewport();
    this.top = Math.min(this.top, maxTop(heights, vp));
    const shown = fitCount(heights, this.top, vp);
    const issues = rows.filter((r) => r.type === "issue").length;
    const seen = rows.slice(this.top, this.top + shown).filter((r) => r.type === "issue").length;
    const before = rows.slice(0, this.top).filter((r) => r.type === "issue").length;
    this.rangeText = rows.length > shown ? `${before + 1}–${before + seen} of ${issues}` : null;
    return div()
      .id("issues-list")
      .flex_1()
      .min_h(60)
      .overflow_hidden()
      .relative()
      .on_mouse_move((e) => {
        if (e.bounds?.height) this.viewH = e.bounds.height;
      })
      .on_scroll_wheel((e, cx) => {
        if (e.bounds?.height) this.viewH = e.bounds.height;
        this.top = wheelTop(this.top, e.delta.y, heights, this.viewport());
        cx.notify();
      })
      .child(
        v_flex().children(
          rows
            .slice(this.top, this.top + shown + 1)
            .map((r) =>
              r.type === "section"
                ? div().h(H.section).flex_none().px(16).pt(10).text_size(10.5).font_medium().text_color(t.dim).child(r.label)
                : div().h(this.rowHeight(r)).flex_none().child(this.row(t, r.item, item?.id === r.item.id, hasKeys)),
            ),
        ),
      )
      ;
  }

  /** One-line summary for the collapsed header: "Issues · 5 pressing". */
  summaryLine(doc, busy) {
    if (!doc) return busy ? "reading…" : "";
    if (doc.state === "unavailable") return "source unavailable";
    if (doc.state === "failed") return `${doc.pressing.length} pressing · update failed`;
    if (doc.state === "empty") return "no open issues";
    const s = `${doc.pressing.length} pressing`;
    return doc.state === "stale" ? `${s} · stale` : s;
  }

  render(cx) {
    const t = /** @type {Record<string, any>} */ (theme());
    const root = this.root;
    const doc = root ? this.docs[root] : null;
    const busy = root ? this.busy.has(root) : false;
    const error = root ? this.errors[root] : null;
    const item = this.selectedItem(doc);
    const name = root ? root.split("/").pop() : "";
    const hasKeys = this.handle.is_focused();

    // Distinct states: loading, never read, empty, stale, failed, source unavailable.
    let banner = null;
    let tone = t.dim;
    if (!root) banner = "Issues shows the most pressing incoming issues for the project in this space. Open a project folder to fill it.";
    else if (!doc && busy) banner = "Reading the issues…";
    else if (!doc) banner = error ? `Couldn't read: ${error}` : "Not read yet. Press R to read the issues.";
    else if (doc.state === "unavailable") ((banner = `Source unavailable: ${doc.error?.message ?? ""}`), (tone = t.blocked));
    else if (doc.state === "failed") ((banner = `Couldn't update (${doc.error?.message ?? "error"}). Showing the last summary.`), (tone = t.blocked));
    else if (doc.state === "stale") ((banner = `Stale: last read ${ago(doc.checked_at)}. Press R to read again.`), (tone = t.working));
    else if (doc.state === "empty") banner = "No open issues. New support tickets, feedback and tracker cards show up here.";
    else if (doc.state === "missing") banner = busy ? "Reading the issues…" : "Not read yet. Press R to read the issues.";

    const rows = this.rows(doc);
    const cost = doc?.refresh?.cost_usd;
    const range = this.rangeText ? `${this.rangeText} · ` : "";
    const footer = this.notice ?? range + (busy ? "Updating…" : doc?.updated_at ? `Read ${ago(doc.checked_at ?? doc.updated_at)}` : "");

    const header = h_flex()
      .id("issues-header")
      .px(14)
      .h(36)
      .flex_none()
      .gap(8)
      .items_center()
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .tooltip(this.collapsed ? `${tip("Expand Issues", "−")} · ${tip("Focus Issues", FOCUS_KEY)}` : `${tip("Collapse Issues", "−")} · ${tip("Focus Issues", FOCUS_KEY)}`)
      .on_click(() => this.setCollapsed(!this.collapsed))
      .child(div().flex_none().text_size(10).text_color(t.dim).child(this.collapsed ? "▸" : "▾"))
      .child(div().flex_none().text_size(11.5).font_medium().text_color(hasKeys ? t.accent : t.dim).child(TITLE))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted).child(this.collapsed ? `· ${this.summaryLine(doc, busy)}` : name))
      .child(div().id("issues-focus-hint").flex_none().px(4).rounded(3).border(1).border_color(t.border).text_size(10).text_color(t.dim).tooltip(hasKeys ? tip("Back to Main", "Esc") : tip("Focus Issues", FOCUS_KEY)).child(hasKeys ? "Esc" : FOCUS_KEY))
      .when(!this.collapsed, (el) =>
        el.child(
          div()
            .id("triage-refresh")
            .flex_none()
            .p(3)
            .rounded(5)
            .text_color(t.dim)
            .cursor_pointer()
            .hover((s) => s.bg(t.hover).text_color(t.foreground))
            .tooltip(busy ? "Updating…" : tip("Refresh issues", "R"))
            .on_click((_e, cx) => {
              cx.stop_propagation();
              root && this.refresh(root, cx, true);
            })
            .child(busy ? svg(ICON("spinner")).size(13).spin(900) : svg(ICON("refresh")).size(13)),
        ),
      );

    const shell = v_flex()
      .id("triage-root")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (this.command(e.keystroke, cx)) cx.notify();
      })
      .size_full()
      .min_h(0)
      .bg(t.chrome)
      .border_l(1)
      .border_color(t.border)
      .when(hasKeys, (el) => el.border_t(2).border_color(t.accent))
      .text_size(13)
      .child(header);
    if (this.collapsed) return shell;

    return shell
      .when(Boolean(doc?.headline), (el) => el.child(div().id("issues-headline").px(14).mb(6).h(38).flex_none().overflow_hidden().whitespace_normal().text_size(12).text_color(t.foreground).tooltip(doc.headline).child(doc.headline)))
      .when(Boolean(banner), (el) => el.child(div().px(14).py(4).flex_none().whitespace_normal().text_size(11.5).text_color(tone).child(banner)))
      .child(this.list(t, rows, item, hasKeys))
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
