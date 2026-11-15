// Issues: the few most pressing incoming issues for the project in the shown space, with what to
// do about each. (Internal mod id: "triage", the verb for what its model does.) The work happens
// in triage.mjs (Node): it gathers the issues, asks a small model which are pressing and why, and
// carries out actions. This view decides when to refresh, draws the result, and turns keys,
// clicks and right-clicks into those same actions.
//
// Keys: ⌘I (global, keys.json "triage.focus") gives Issues the keyboard; Esc gives it back.
// Inside: the shared navigation rules in nav.js (↑↓ Home End PgUp PgDn, Tab, −), plus the action
// keys from src/actions.mjs. Every control has a tooltip "Action (Key)".
//
// Hand-offs (M: Send to Main, N: New Main) gather context first: the row says "Gathering context…",
// then the helper sends the issue, the cited brief and the rules. B shows the brief and what was
// sent. A failed gather is a named state on the row; ⇧M / ⇧N then send without context, on purpose.
// What the legend, menu and brief view say comes from surface.js (plain data, tested in Node).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agents, focused, panes, exec, home, appHome, run, theme, nextCommand, shared, openOverlay, layout, setShared, closeOverlay, props } from "herdr";
import { step, widgetDirection, COLLAPSE_KEY, loadCollapsed, applyCollapse, returnTarget, tip, keepInView, wheelTop, maxTop, fitCount, estimateViewport } from "./nav.js";
import { createFrame, frameParts } from "./frame.js";
import { modelLabel, modelTip, settingsProblemLine, refreshMs, disabledReason, legendEntries, menuItems, rowStatusLines, briefViewLines, briefViewFor, viewBelongs, settingsLine, settingsTip, actionItem, sentNotice, costLine, gatherFailed, BARE } from "./surface.js";

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
// Fixed row heights: the virtual list places rows by these, so rows clip their text to fit
// (the full text is in the row's tooltip, Copy and the right-click menu).
const H = { section: 28, pressing: 96, other: 60, status: 18, line: 16 };

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

/** The space's Main: a Pi named Main, else its first Pi. */
function targetsIn(space) {
  const here = agents().filter((a) => a.space === space);
  const pis = here.filter((a) => a.app === "pi");
  const main = pis.find((a) => /^main$/i.test(sessionName(a.title))) ?? pis.slice().sort((x, y) => x.tab_index - y.tab_index)[0] ?? null;
  return { main: main?.address ?? null, mainPane: main?.pane ?? null };
}

const LONG = { Next: "Next widget", Back: "Back to Main", Refresh: "Refresh issues", Close: "Close the brief", Scroll: "Scroll the brief" };
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
    this.gathering = new Set(); // issue ids whose context is being gathered right now
    this.view = null; // the open brief: { id, doc, top }
    this.progress = {}; // issue id -> the plan and each gatherer's state, while its context is being gathered
    // Title bar, move, pop out, close: the shared rules in frame.js. Only the copy on screen works.
    this.frame = createFrame({ mod: NAME, h: { layout, run, shared, setShared, openOverlay, closeOverlay, props } });
    const carried = this.frame.start();
    if (carried) {
      this.top = carried.top ?? 0;
      if (typeof carried.collapsed === "boolean") this.collapsed = carried.collapsed;
    }
    if (this.frame.floating) this.handle.focus();
    this.tick(cx);
    cx.timer.every(600, (cx) => this.poll(cx));
    cx.timer.every(3000, (cx) => this.tick(cx));
    // Read again every `refreshSeconds` (a setting). Cheap when nothing changed: the model is only asked about changed issues.
    this.lastAuto = Date.now();
    cx.timer.every(5000, (cx) => {
      if (!this.root || !this.frame.active() || Date.now() - this.lastAuto < refreshMs(this.docs[this.root])) return;
      this.lastAuto = Date.now();
      this.refresh(this.root, cx, false);
    });
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

  // What the next copy (the window, or the docked block again) starts from.
  viewState() {
    return { sel: null, top: this.top, collapsed: this.collapsed };
  }

  close() {
    this.frame.closed();
  }

  // Takes the keyboard without expanding or scrolling (a press on the title bar).
  takeKeyboardQuietly() {
    const f = focused();
    if (f && (f.pane || f.terminal)) this.before = { pane: f.pane, terminal: f.terminal };
    this.handle.focus();
  }

  setCollapsed(on) {
    this.collapsed = on;
    if (this.frame.floating) return; // a window has no column to give its height to
    applyCollapse({ mod: NAME, collapsed: on, storage: localStorage, layout, run });
  }

  // The shown space's project: the git top level of the focused pane's folder.
  // While a gather runs: read its plan and each gatherer's state from the helper, and show them on the row.
  poll(cx) {
    if (!this.gathering.size || this.polling || !this.root) return;
    this.polling = true;
    const root = this.root;
    cx.spawn(async (cx) => {
      const r = await callHelper(["progress", "--root", root], 5000);
      this.polling = false;
      if (r.ok?.id && this.gathering.has(r.ok.id) && r.ok.phase !== "none") {
        this.progress[r.ok.id] = r.ok;
        cx.notify();
      }
    });
  }

  tick(cx) {
    this.frame.check();
    if (!this.frame.active()) return; // hidden or closed: no reading, no model calls
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
    this.view = null;
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

  // The issue actions are about: the open brief's issue while a brief is open (clicked or typed), else the selection.
  actionItem(doc) {
    return actionItem({ view: this.view, items: this.items(doc), selected: this.selectedItem(doc) });
  }

  selectedItem(doc) {
    const list = this.items(doc);
    return list.find((x) => x.id === this.selected[this.root]) ?? list[0] ?? null;
  }

  rowHeight(r) {
    if (r.type === "section") return H.section;
    return (r.item.rank ? H.pressing : H.other) + rowStatusLines(r.item, this.gathering.has(r.item.id), this.progress[r.item.id]).length * H.status;
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
    if (k === "escape" && this.frame.dragging() === "mine") return (this.frame.dragCancel(), true);
    if (this.frame.command(k, this.viewState())) return true;
    const doc = this.docs[this.root];
    const list = this.items(doc);
    if (this.view && !this.collapsed) {
      // The brief is open: Esc or B closes it, the list keys scroll it, M and N still hand over.
      if (k === "escape" || k === "b") {
        this.view = null;
        return true;
      }
      const lines = this.viewLines();
      const next = step(this.view.top, Math.max(1, lines.length), k);
      if (next != null) {
        this.view.top = Math.min(next, Math.max(0, lines.length - 3));
        return true;
      }
    }
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
      const item = this.actionItem(doc);
      if (item) this.menu(item);
      return true;
    }
    const at = Math.max(0, list.findIndex((x) => x.id === this.selectedItem(doc)?.id));
    const next = this.view ? null : step(at, list.length, k);
    if (next != null) {
      this.selected[this.root] = list[next].id;
      this.notice = null;
      this.reveal(doc);
      return true;
    }
    const item = this.actionItem(doc); // with a brief open: the issue it shows, or none
    const bare = BARE.find((b) => b.key === k || b.keyLabel === k || (k === b.key.slice(-1).toUpperCase()));
    if (bare && item) {
      if (!gatherFailed(item)) this.notice = "Sending without context is offered only after gathering failed. M and N gather first.";
      else this.act(item.id, bare.name, cx);
      return true;
    }
    const a = (doc?.actions ?? []).find((x) => x.key === k);
    if (!a || !item) return false;
    this.act(item.id, a.name, cx);
    return true;
  }

  viewLines() {
    return this.view ? briefViewLines(this.view.doc, this.chars()) : [];
  }

  // How many characters fit on a line of the brief view (the panel's width, when the layout says it).
  chars() {
    let px = 320;
    const walk = (n, w) => {
      if (!n) return;
      const mine = n.size?.px ?? w;
      if (n.content?.mod === NAME && mine) px = mine;
      (n.children ?? []).forEach((c) => walk(c, mine));
    };
    try {
      walk(layout(), null);
    } catch {}
    return Math.max(28, Math.floor((px - 30) / 6.0));
  }

  // One step of a hand-off or a brief view: gather the context (the row says so), reload the
  // issue's state, and say what happened. Returns the brief document, or null when it failed.
  async gatherStep(id, root, cx) {
    this.gathering.add(id);
    delete this.progress[id];
    this.notice = "Gathering context…";
    cx.notify();
    const r = await callHelper(["gather", id, "--root", root], 75_000);
    this.gathering.delete(id);
    const shown = await callHelper(["show", "--root", root], 15_000);
    if (shown.ok) this.docs[root] = shown.ok;
    if (!r.ok) this.notice = `Couldn't gather context: ${r.error}`.slice(0, 220);
    cx.notify();
    return r.ok ?? null;
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
    if (this.view && !viewBelongs(this.view, this.root)) this.view = null; // a brief from another project is never acted on
    if (this.gathering.has(id)) {
      this.notice = "Still gathering context for this issue…";
      return cx.notify();
    }
    const bare = BARE.find((b) => b.name === action);
    const real = bare ? bare.of : action;
    const terminal = real === "send-main" ? targets.main : null;
    cx.spawn(async (cx) => {
      if (real === "brief") {
        const b = await this.gatherStep(id, root, cx);
        // Only in the project it was gathered for: the sidebar may have moved on while it gathered.
        const v = briefViewFor({ root, activeRoot: this.root, id, doc: b });
        if (v) {
          this.view = v;
          this.notice = costLine(b);
        }
        return cx.notify();
      }
      const handoff = real === "send-main" || real === "new-main";
      let fresh = null; // the key of a brief gathered in this press (not one reused from before)
      if (handoff && !bare) {
        // Gather first, where the person can see it. A failure stops here: nothing is sent.
        const b = await this.gatherStep(id, root, cx);
        if (!b) return;
        if (this.root !== root) {
          this.notice = "The project changed while gathering; nothing was sent.";
          return cx.notify();
        }
        if (!b.cached) fresh = b.key;
        this.notice = real === "send-main" ? "Sending to Main…" : "Starting a new Main…";
        cx.notify();
      }
      const r = await callHelper(["act", id, real, "--root", root, ...(terminal ? ["--terminal", terminal] : []), ...(bare ? ["--no-context"] : []), ...(fresh ? ["--gathered", fresh] : [])], 75_000);
      if (!r.ok) this.notice = r.error;
      else if (handoff) {
        if (real === "new-main") run(r.ok.command.name, r.ok.command.args); // a new space with Pi, its first message the prompt
        this.notice = sentNotice(r.ok);
        if (this.view?.id === id) this.view = { ...this.view, doc: { ...this.view.doc, last_sent: { at: r.ok.at, action: real, context: r.ok.context, prompt: r.ok.prompt } } };
        this.load(root, cx);
      } else {
        this.notice = { copy: "Copied", open: "Opened", dismiss: "Dismissed", restore: "Restored" }[real];
        if (real === "dismiss" || real === "restore") this.load(root, cx);
      }
      cx.notify();
    });
  }

  menu(item) {
    const targets = targetsIn(this.space);
    const actions = this.docs[this.root]?.actions ?? [];
    const items = menuItems(actions, item, targets);
    openOverlay({ mod: "triage-menu", kind: "popup", width: 320, height: 12 + items.length * 31 + 9 + 24, props: { owner: "triage", title: `Issues · ${item.title}`, items } });
  }

  row(t, item, selected, focusedNow) {
    const meta = [KIND[item.kind] ?? item.kind, item.count > 1 ? `${item.count} reports` : null, item.merged?.length ? `+ ${item.merged.map((m) => m.id).join(", ")}` : null].filter(Boolean).join(" · ");
    const full = [item.title, item.why, `${item.id} · ${meta}`].filter(Boolean).join("\n");
    const pad = item.rank ? 23 : 0;
    const gathering = this.gathering.has(item.id);
    const lines = rowStatusLines(item, gathering, this.progress[item.id]);
    const status = lines.join("\n");
    return v_flex()
      .id(`issue-${item.id}`)
      .h((item.rank ? H.pressing - 4 : H.other - 4) + lines.length * H.status)
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
      .tooltip(`${full}${status ? `\n${status}` : ""}\n\nRight-click or ⇧F10 for actions`)
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
      .child(div().pl(pad).flex_none().truncate().text_size(10.8).text_color(t.dim).child(`${item.id} · ${meta}`))
      .children(
        lines.map((line, i) =>
          h_flex()
            .id(`issue-status-${item.id}-${i}`)
            .h(H.status - 2)
            .pl(pad)
            .gap(5)
            .items_center()
            .flex_none()
            .when(gathering && (/searching…/.test(line) || line === "Planning…"), (x) => x.child(svg(ICON("spinner")).size(10).spin(900).text_color(t.working)))
            .child(div().flex_1().min_w(0).truncate().text_size(10.8).text_color(/: (failed|timed out)/.test(line) || gatherFailed(item) ? t.blocked : gathering && !/searching…|Planning…/.test(line) ? t.foreground : gathering ? t.working : i === lines.length - 1 ? t.accent : t.muted).child(line)),
        ),
      );
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
    // An action key: its words and tooltip come from surface.js.
    const entry = (e) =>
      h_flex()
        .id(`legend-${e.action}`)
        .gap(4)
        .items_center()
        .cursor_pointer()
        .tooltip(e.tooltip)
        .when(e.disabled, (el) => el.opacity(0.4))
        .when(!e.disabled, (el) => el.on_click((_e, cx) => item && this.act(item.id, e.action, cx)))
        .child(div().px(4).rounded(3).border(1).border_color(t.border).text_size(10).text_color(t.foreground).child(e.key))
        .child(div().text_size(10.5).text_color(t.dim).child(e.label));
    const rules = this.docs[this.root]?.rules;
    const second = this.view
      ? [key("scroll", "↑↓", "Scroll", null, null), key("close", "B / Esc", "Close", null, (cx) => ((this.view = null), cx.notify()))]
      : [
          key("sel", "↑↓", "Select", null, null),
          key("tab", "Tab", "Next", null, null),
          key("col", "−", "Collapse", null, () => this.setCollapsed(true)),
          key("esc", "Esc", "Back", null, () => this.giveBack()),
          key("ref", "R", "Refresh", null, (cx) => this.root && this.refresh(this.root, cx, true)),
          ...(this.frameLegend ?? []).map(([k, label]) => key(`frame-${label}`, k, label, null, null)),
        ];
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
          .children(legendEntries(actions, item, targets).filter((e) => !(this.view && e.action === "brief")).map((e) => entry(e))),
      )
      .child(h_flex().gap_x(8).gap_y(3).flex_wrap().children(second))
      .when(Boolean(rules), (el) =>
        el.child(
          div()
            .id("issues-rules")
            .truncate()
            .text_size(10.5)
            .text_color(rules.error ? t.blocked : t.dim)
            .tooltip(`${rules.error ? `${rules.error}. Hand-offs need a rules file.` : `Rules sent with every hand-off: ${rules.path}`}${settingsTip(this.docs[this.root]) ? `\n${settingsTip(this.docs[this.root])}` : ""}`)
            .child(`${rules.error ? `Rules: missing (${rules.error})` : `Rules: ${rules.path.split("/").slice(-2).join("/")} (${rules.source})`}${settingsLine(this.docs[this.root]) ? ` · ${settingsLine(this.docs[this.root])}` : ""}`),
        ),
      );
  }

  // The brief, in place of the list: fixed-height lines from surface.js, windowed like the list.
  brief(t) {
    const lines = this.viewLines();
    const fit = Math.max(3, Math.floor(this.viewport() / H.line));
    this.view.top = Math.max(0, Math.min(this.view.top, Math.max(0, lines.length - 3)));
    const tone = { head: t.foreground, body: t.muted, dim: t.dim, warn: t.blocked };
    this.rangeText = lines.length > fit ? `lines ${this.view.top + 1}–${Math.min(lines.length, this.view.top + fit)} of ${lines.length}` : null;
    return div()
      .id("issues-brief")
      .flex_1()
      .min_h(60)
      .overflow_hidden()
      .px(14)
      .on_scroll_wheel((e, cx) => {
        this.view.top = Math.max(0, Math.min(Math.max(0, lines.length - 3), this.view.top + (e.delta.y < 0 ? 3 : -3)));
        cx.notify();
      })
      .child(v_flex().children(lines.slice(this.view.top, this.view.top + fit + 1).map((l) => div().h(H.line).flex_none().overflow_hidden().whitespace_nowrap().text_size(11.3).text_color(tone[l.tone]).when(l.tone === "head", (x) => x.font_medium()).child(l.text || " "))));
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
    this.rangeText = rows.length > shown ? `${before + 1}–${before + Math.max(1, seen)} of ${issues}` : null;
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

    const parts = frameParts({ div, h_flex, v_flex }, t, this.frame, tip, () => this.viewState());
    this.frameLegend = parts.legend;
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
      // Pressing the bar starts a drag: release over another widget to land above or below it.
      .on_mouse_down("left", () => {
        if (!this.handle.is_focused()) this.takeKeyboardQuietly();
        this.frame.dragStart();
      })
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
      )
      .children(parts.buttons);

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
      .relative()
      .on_mouse_up("left", () => this.frame.dragCancel())
      .child(header)
      .when(Boolean(parts.note), (el) => el.child(parts.note))
      .when(Boolean(parts.drop), (el) => el.child(parts.drop));
    if (this.collapsed) return shell;

    return shell
      .when(Boolean(doc?.headline), (el) => el.child(div().id("issues-headline").px(14).mb(6).h(38).flex_none().overflow_hidden().whitespace_normal().text_size(12).text_color(t.foreground).tooltip(doc.headline).child(doc.headline)))
      .when(Boolean(banner), (el) => el.child(div().px(14).py(4).flex_none().whitespace_normal().text_size(11.5).text_color(tone).child(banner)))
      .when(Boolean(settingsProblemLine(doc)), (el) => el.child(div().id("issues-settings-problem").px(14).py(4).flex_none().whitespace_normal().text_size(11.5).text_color(t.blocked).tooltip((doc?.settings?.problems ?? []).join("\n")).child(settingsProblemLine(doc))))
      .child(this.view ? this.brief(t) : this.list(t, rows, item, hasKeys))
      .when(Boolean(doc), (el) => el.child(this.legend(t, this.actionItem(doc))))
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
          .child(div().id("issues-model").flex_none().tooltip(doc ? modelTip(doc) : "").child(doc ? `${modelLabel(doc)}${cost ? ` · $${cost.toFixed(4)}` : ""}` : "")),
      );
  }
}
