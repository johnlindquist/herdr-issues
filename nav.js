// Widget navigation: one set of rules for every sidebar widget (Issues, Todos, Memories).
// The same file is copied into each mod; test/nav.test.mjs proves the copies match.
// Pure: no herdr imports, so Node tests can load it.
//
// The rules
// - ↑/↓ (or k/j) move the selection inside one widget. They stop at the ends: never wrap, never
//   jump to another widget.
// - Home/End go to the first/last item; PageUp/PageDown move a page (PAGE items).
// - Tab / Shift+Tab move to the next/previous widget (the one below/above).
// - Esc gives the keyboard back to the conversation that had it.
// - "-" collapses or expands the widget; so does clicking its header. Collapsed, it is one
//   header line (name · count · state) and its height goes to the widgets around it.
// - The selected item is kept in view: each list shows its items from a first index (`top`);
//   moving the selection changes `top` only when the selection would leave the visible part.
//   (Herdr's virtual lists forbid handlers in rows, and plain scroll areas can't be scrolled
//   from code, so the widgets window their lists themselves with these functions.)
// - The mouse wheel scrolls the widget under the pointer only.
// - A key means the same thing in every widget (KEYS below): Enter is the item's main action,
//   Space toggles, E edits, D dismisses, Delete removes, R refreshes, C copies, O opens the source,
//   ⌘Z (or U) undoes, ⇧F10 opens the menu. A widget's own actions take letters keyProblems() accepts.
// - Undo: for UNDO_MS after an action that can be reversed, a bar offers Undo and ⌘Z reverses it.
//   ⌘Z at any other time says why nothing happened (undoPress): never a silent key.

export const NAV_VERSION = 2;
export const PAGE = 5;
export const COLLAPSE_KEY = "-";
export const HEADER_PX = 36; // a collapsed widget's height

/** The next selected index for a key, or null when the key isn't navigation. Never wraps. */
export function step(index, count, keystroke, page = PAGE) {
  if (!count) return null;
  const i = Math.min(Math.max(index ?? 0, 0), count - 1);
  switch (keystroke) {
    case "down":
    case "j":
      return Math.min(count - 1, i + 1);
    case "up":
    case "k":
      return Math.max(0, i - 1);
    case "home":
      return 0;
    case "end":
      return count - 1;
    case "pagedown":
      return Math.min(count - 1, i + page);
    case "pageup":
      return Math.max(0, i - page);
    default:
      return null;
  }
}

/** Tab / Shift+Tab: the direction of the widget to move to, else null. */
export function widgetDirection(keystroke) {
  if (keystroke === "tab") return "down";
  if (keystroke === "shift-tab") return "up";
  return null;
}

/** Collapsed state, saved per widget in a Storage (localStorage survives restarts). */
export function loadCollapsed(storage, name) {
  try {
    return storage?.getItem(`collapsed:${name}`) === "1";
  } catch {
    return false;
  }
}
export function saveCollapsed(storage, name, collapsed) {
  try {
    storage?.setItem(`collapsed:${name}`, collapsed ? "1" : "0");
  } catch {}
}

/** Finds the layout block that shows `mod`, with its parent's direction. Null if not in the layout. */
export function blockOf(tree, mod) {
  /** @type {any} */
  let found = null;
  const walk = (n, parent) => {
    if (!n || typeof n !== "object" || found) return;
    const content = n.content;
    if (content && typeof content === "object" && content.mod === mod && n.id) {
      found = { id: n.id, size: n.size ?? null, min: n.min ?? null, parentType: parent?.type ?? null, siblings: (parent?.children ?? []).length };
      return;
    }
    for (const c of n.children ?? []) walk(c, n);
  };
  walk(tree, null);
  return found;
}

/**
 * The resize that collapses or expands a stacked block; null when it isn't in a column with others.
 * `saved` is the block's size from before it collapsed (the layout then holds the collapsed size).
 */
export function collapseResize(block, collapsed, saved = null) {
  if (!block || block.parentType !== "column" || block.siblings < 2) return null;
  if (collapsed) return { id: block.id, px: HEADER_PX };
  const s = saved ?? block.size;
  if (s && typeof s.weight === "number") return { id: block.id, weight: s.weight };
  if (s && typeof s.px === "number" && s.px > HEADER_PX) return { id: block.id, px: s.px };
  return { id: block.id, weight: 1 };
}

/** One wording for every tooltip: "Action (Key)". */
export const tip = (label, key) => (key ? `${label} (${key})` : label);

/** Keys every widget shares, for its legend and tooltips. */
export const SHARED_KEYS = [
  { keys: "↑↓", label: "Select" },
  { keys: "Tab", label: "Next widget" },
  { keys: "−", label: "Collapse" },
  { keys: "⌘Z", label: "Undo" },
  { keys: "Esc", label: "Back to Main" },
];

/** Saved expanded size, so expanding restores what the person had. */
export function loadSize(storage, name) {
  try {
    return JSON.parse(storage?.getItem(`size:${name}`) ?? "null");
  } catch {
    return null;
  }
}
export function saveSize(storage, name, size) {
  try {
    if (size && !(typeof size.px === "number" && size.px <= HEADER_PX)) storage?.setItem(`size:${name}`, JSON.stringify(size));
  } catch {}
}

/**
 * Collapses or expands the widget `mod`: saves the choice and, when stacked with others in a
 * column, resizes its block so the others get the height. Herdr functions are passed in.
 * @param {{ mod: string, collapsed: boolean, storage: any, layout: () => any, run: (name: string, args: any) => any }} o
 */
export function applyCollapse({ mod, collapsed, storage, layout, run }) {
  saveCollapsed(storage, mod, collapsed);
  const block = blockOf(layout(), mod);
  if (collapsed && block) saveSize(storage, mod, block.size);
  const r = collapseResize(block, collapsed, collapsed ? null : loadSize(storage, mod));
  if (r) run("layout.resize", r);
  return r;
}

/** Where Esc returns the keyboard: the pane that had it before, else the space's Main. */
export function returnTarget(before, mainPane) {
  if (before?.pane) return { pane: before.pane };
  if (before?.terminal) return { terminal: before.terminal };
  if (mainPane) return { pane: mainPane };
  return null;
}

/** How many items, from `top`, fit entirely in `viewport` px (at least 1). */
export function fitCount(heights, top, viewport) {
  let used = 0;
  let n = 0;
  for (let i = top; i < heights.length; i++) {
    if (used + heights[i] > viewport && n > 0) break;
    used += heights[i];
    n++;
  }
  return Math.max(1, n);
}

/** The new `top` so item `sel` is fully visible; unchanged when it already is. Never past the end. */
export function keepInView(top, sel, heights, viewport) {
  if (!heights.length) return 0;
  let t = Math.min(Math.max(0, top), heights.length - 1);
  if (sel < t) return sel;
  while (t < sel && sel >= t + fitCount(heights, t, viewport)) t++;
  return t;
}

/** The largest useful `top`: the last items fill the viewport. */
export function maxTop(heights, viewport) {
  let used = 0;
  for (let i = heights.length - 1; i >= 0; i--) {
    used += heights[i];
    if (used > viewport) return Math.min(heights.length - 1, i + 1);
  }
  return 0;
}

/** Mouse wheel over a list: one item per notch, clamped. `dy` < 0 scrolls toward the end. */
export function wheelTop(top, dy, heights, viewport) {
  if (!dy) return top;
  const next = top + (dy < 0 ? 1 : -1) * Math.max(1, Math.round(Math.abs(dy) / 40));
  return Math.min(Math.max(0, next), maxTop(heights, viewport));
}

/**
 * The list's height when it hasn't been measured yet (no pointer over it): the block's share of
 * its column, from the layout and the window height, minus the widget's own header and legend.
 */
export function estimateViewport(tree, mod, windowPx, chromePx) {
  const fallback = Math.max(80, windowPx / 3 - chromePx);
  /** @type {any} */
  let parent = null;
  /** @type {any} */
  let me = null;
  const walk = (n) => {
    if (!n || typeof n !== "object" || me) return;
    for (const c of n.children ?? []) {
      if (c?.content?.mod === mod) {
        parent = n;
        me = c;
        return;
      }
      walk(c);
    }
  };
  walk(tree);
  if (!me) return fallback;
  if (parent.type !== "column") return Math.max(80, windowPx - chromePx);
  const kids = parent.children ?? [];
  const px = kids.reduce((n, c) => n + (typeof c?.size?.px === "number" ? c.size.px : 0), 0);
  const weights = kids.reduce((n, c) => n + (typeof c?.size?.weight === "number" ? c.size.weight : typeof c?.size?.px === "number" ? 0 : 1), 0);
  const mine = typeof me.size?.px === "number" ? me.size.px : ((windowPx - px) * (typeof me.size?.weight === "number" ? me.size.weight : 1)) / Math.max(1, weights);
  return Math.max(60, mine - chromePx);
}

// ---------- item keys: one meaning per key in every widget ----------

/** The keys every widget gives the same meaning. `shown` is what legends and tooltips print. */
export const KEYS = {
  primary: { keys: ["enter"], shown: "Enter" },
  toggle: { keys: ["space"], shown: "Space" },
  edit: { keys: ["e"], shown: "E" },
  dismiss: { keys: ["d"], shown: "D" },
  remove: { keys: ["delete", "backspace"], shown: "Del" },
  refresh: { keys: ["r"], shown: "R" },
  copy: { keys: ["c"], shown: "C" },
  open: { keys: ["o"], shown: "O" },
  undo: { keys: ["cmd-z", "u"], shown: "⌘Z" },
  menu: { keys: ["shift-f10", "menu-key"], shown: "⇧F10" },
};

/** Keys navigation and the title bar already use: never an action's key. */
export const TAKEN_KEYS = ["up", "down", "j", "k", "home", "end", "pageup", "pagedown", "tab", "shift-tab", "escape", COLLAPSE_KEY, "shift-o", "shift-w", "shift-up", "shift-down", "shift-left", "shift-right"];

/**
 * True when `keystroke` is the key for `verb`. Widgets compare keys only through this.
 * @param {keyof typeof KEYS} verb
 * @param {string} keystroke
 */
export function isKey(verb, keystroke) {
  return KEYS[verb].keys.includes(keystroke);
}

/**
 * What is wrong with a widget's own action keys: a shared key given another meaning, a shared
 * meaning put on another key, a navigation key reused, or one key for two actions. Empty when fine.
 * An action named like a shared verb ("copy", "dismiss") is that verb.
 * @param {{ name: string, key: string }[]} actions
 */
export function keyProblems(actions) {
  /** @type {string[]} */
  const out = [];
  /** @type {Record<string, { keys: string[], shown: string }>} */
  const shared = KEYS;
  /** @type {Map<string, string>} */
  const seen = new Map();
  for (const a of actions) {
    const owner = Object.keys(shared).find((verb) => shared[verb].keys.includes(a.key));
    if (shared[a.name] && !shared[a.name].keys.includes(a.key)) out.push(`${a.name} is on "${a.key}"; every widget uses ${shared[a.name].shown}`);
    else if (owner && owner !== a.name) out.push(`"${a.key}" means ${owner} in every widget; ${a.name} needs another key`);
    if (TAKEN_KEYS.includes(a.key)) out.push(`"${a.key}" is a navigation or title bar key; ${a.name} needs another key`);
    const other = seen.get(a.key);
    if (other) out.push(`"${a.key}" is used by both ${other} and ${a.name}`);
    seen.set(a.key, a.name);
  }
  return out;
}

// ---------- undo: a few seconds to take back the last action ----------

export const UNDO_MS = 6000; // how long the last action can be undone
export const NOTICE_MS = 4000; // how long an undo message stays
/** Where an undo message shows: "footer" (the widget's own notice line) or "toast" (Herdr's notification). */
export const NOTICE_STYLE = "footer";

const clip = (text, n = 90) => {
  const s = String(text ?? "").replace(/\s+/g, " ").trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
};

/**
 * The record of an action a widget just ran. With `reverse` (whatever the widget needs to run the
 * opposite action) it can be undone and `label` says what happened ("Dismissed: Use Codicons").
 * Without one, `label` is the action's name ("Send to Main") and `why` says which kind it is:
 * "final" (it had an effect that can't be taken back) or "nothing" (it changed nothing).
 * @param {string} label
 * @param {unknown} [reverse]
 * @param {"final" | "nothing"} [why]
 * @returns {{ label: string, reverse: unknown, why: "final" | "nothing", at: number }}
 */
export function did(label, reverse = null, why = "final", now = Date.now()) {
  return { label: clip(label), reverse: reverse ?? null, why, at: now };
}

/** True while the last action can still be undone. */
export function canUndo(last, now = Date.now()) {
  return Boolean(last && last.reverse != null && now - last.at <= UNDO_MS);
}

/**
 * ⌘Z was pressed: the `reverse` to run (or null) and the message to show. Always a message.
 * @returns {{ reverse: unknown, notice: string }}
 */
export function undoPress(last, now = Date.now()) {
  if (!last) return { reverse: null, notice: "Nothing to undo" };
  if (last.reverse != null) return canUndo(last, now) ? { reverse: last.reverse, notice: `Undone: ${last.label}` } : { reverse: null, notice: `Too late to undo: ${last.label}` };
  if (now - last.at > UNDO_MS) return { reverse: null, notice: "Nothing to undo" };
  return { reverse: null, notice: last.why === "nothing" ? `${last.label} has nothing to undo` : `${last.label} can't be undone` };
}

/**
 * Remembers the action a view just ran, and redraws when its undo time is over so the bar leaves.
 * @param {any} view
 * @param {ReturnType<typeof did>} done
 * @param {any} cx
 */
export function remember(view, done, cx) {
  view.last = done;
  if (done.reverse != null) cx.timer.after(UNDO_MS + 40, (cx) => cx.notify());
}

/**
 * Shows a short message for NOTICE_MS: in the view's notice line (`view.notice`), or as a Herdr
 * notification when NOTICE_STYLE is "toast" and the view passes Herdr's `notify`.
 * @param {any} view
 * @param {string} text
 * @param {any} cx
 * @param {((n: { title: string, level?: "info" }) => unknown) | null} [notify]
 */
export function announce(view, text, cx, notify = null, style = NOTICE_STYLE) {
  if (style === "toast" && notify) return void notify({ title: text, level: "info" });
  view.notice = text;
  cx.timer.after(NOTICE_MS, (cx) => {
    if (view.notice !== text) return;
    view.notice = null;
    cx.notify();
  });
  cx.notify();
}

/**
 * The undo bar under a widget's header, or null when the last action can't be undone (any more).
 * `ui` is { div, h_flex } from the UI kit, passed in so this file stays free of imports.
 * @param {{ div: any, h_flex: any }} ui
 * @param {Record<string, string>} t the theme
 * @param {any} last
 * @param {{ onUndo: (cx: any) => void, onClose: (cx: any) => void, now?: number }} o
 */
export function undoBar(ui, t, last, o) {
  if (!canUndo(last, o.now ?? Date.now())) return null;
  const stop = (_e, cx) => cx.stop_propagation();
  return ui
    .h_flex()
    .id("undo-bar")
    .mx(10)
    .mb(6)
    .px(10)
    .h(28)
    .gap(8)
    .flex_none()
    .items_center()
    .rounded(8)
    .bg(t.raised)
    .text_size(11.5)
    .tooltip(last.label)
    .child(ui.div().flex_1().min_w(0).truncate().text_color(t.muted).child(last.label))
    .child(
      ui
        .h_flex()
        .id("undo-bar-undo")
        .flex_none()
        .gap(5)
        .items_center()
        .cursor_pointer()
        .tooltip(tip("Undo", KEYS.undo.shown))
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => {
          cx.stop_propagation();
          o.onUndo(cx);
        })
        .child(ui.div().font_medium().text_color(t.accent).child("Undo"))
        .child(ui.div().px(4).rounded(3).border(1).border_color(t.border).text_size(10).text_color(t.dim).child(KEYS.undo.shown)),
    )
    .child(
      ui
        .div()
        .id("undo-bar-close")
        .flex_none()
        .px(3)
        .cursor_pointer()
        .text_color(t.dim)
        .tooltip("Hide")
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => {
          cx.stop_propagation();
          o.onClose(cx);
        })
        .child("×"),
    );
}
