// The keys and the undo rule every widget shares (nav.js). The same file in every widget's test
// folder and in the kit; it finds nav.js beside it or one folder up.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const beside = (name) => [path.join(here, "..", name), path.join(here, name)].find((f) => fs.existsSync(f));
const nav = await import(beside("nav.js"));
const { KEYS, TAKEN_KEYS, isKey, keyProblems, did, canUndo, undoPress, remember, announce, undoBar, UNDO_MS, NOTICE_MS } = nav;

test("a key has one meaning: no shared key is listed twice or collides with navigation", () => {
  const all = Object.values(KEYS).flatMap((k) => k.keys);
  assert.equal(new Set(all).size, all.length);
  for (const k of all) assert.ok(!TAKEN_KEYS.includes(k), `${k} is also a navigation key`);
  assert.ok(isKey("primary", "enter") && isKey("undo", "cmd-z") && isKey("undo", "u") && isKey("menu", "menu-key") && isKey("remove", "backspace"));
  assert.ok(!isKey("dismiss", "delete") && !isKey("edit", "enter"));
});

test("a widget's own action keys: a shared key keeps its meaning, a shared meaning keeps its key", () => {
  assert.deepEqual(keyProblems([{ name: "copy", key: "c" }, { name: "send-main", key: "m" }, { name: "send-main-bare", key: "shift-m" }, { name: "dismiss", key: "d" }]), []);
  assert.match(keyProblems([{ name: "send", key: "d" }])[0], /"d" means dismiss/);
  assert.match(keyProblems([{ name: "copy", key: "y" }])[0], /copy is on "y"; every widget uses C/);
  assert.match(keyProblems([{ name: "keep", key: "k" }])[0], /navigation or title bar key/);
  assert.match(keyProblems([{ name: "a", key: "x" }, { name: "b", key: "x" }])[0], /used by both a and b/);
  assert.match(keyProblems([{ name: "pin", key: "u" }])[0], /"u" means undo/);
});

test("the view compares shared keys only through nav.js", { skip: !beside("main.js") && "no main.js here (the kit)" }, () => {
  const src = fs.readFileSync(beside("main.js"), "utf8");
  const shared = new Set(Object.values(KEYS).flatMap((k) => k.keys));
  const literal = [...src.matchAll(/\bk === "([^"]+)"/g)].map((m) => m[1]).filter((k) => shared.has(k));
  assert.deepEqual(literal, [], "use isKey(verb, k) from nav.js instead of comparing these keys");
  assert.ok(/isKey\("undo", k\)/.test(src), "main.js handles the undo key");
  assert.ok(/undoBar\(/.test(src) && /announce\(/.test(src), "main.js draws the undo bar and says why when nothing can be undone");
});

test("undo: a few seconds for an action with an opposite, and always a message", () => {
  const dismissed = did("Dismissed: Use Codicons", { action: "restore", id: "m1" }, "final", 1000);
  assert.ok(canUndo(dismissed, 1000 + UNDO_MS) && !canUndo(dismissed, 1001 + UNDO_MS));
  assert.deepEqual(undoPress(dismissed, 2000), { reverse: { action: "restore", id: "m1" }, notice: "Undone: Dismissed: Use Codicons" });
  assert.deepEqual(undoPress(dismissed, 1001 + UNDO_MS), { reverse: null, notice: "Too late to undo: Dismissed: Use Codicons" });
  assert.deepEqual(undoPress(null, 0), { reverse: null, notice: "Nothing to undo" });
});

test("undo: an action that can't be taken back says so, and one that changed nothing says that", () => {
  const sent = did("Send to Main", null, "final", 1000);
  assert.ok(!canUndo(sent, 1001));
  assert.deepEqual(undoPress(sent, 2000), { reverse: null, notice: "Send to Main can't be undone" });
  assert.deepEqual(undoPress(did("Copy", null, "nothing", 1000), 2000), { reverse: null, notice: "Copy has nothing to undo" });
  assert.equal(undoPress(sent, 1001 + UNDO_MS).notice, "Nothing to undo", "after a while the old action is no longer the subject");
  assert.ok(did(`Dismissed: ${"long ".repeat(60)}`, {}).label.length <= 90);
});

// A stand-in for the UI kit's context: timers are collected and run by hand.
const fakeCx = () => {
  const cx = { notified: 0, timers: [], notify: () => cx.notified++, timer: { after: (ms, fn) => cx.timers.push({ ms, fn }) } };
  return cx;
};

test("the undo bar leaves when the time is over; a message leaves unless a newer one replaced it", () => {
  const view = { last: null, notice: null };
  const cx = fakeCx();
  remember(view, did("Dismissed: x", { id: 1 }), cx);
  assert.ok(view.last && cx.timers[0].ms > UNDO_MS, "a redraw is scheduled for after the undo time");
  remember(view, did("Copy", null, "nothing"), cx);
  assert.equal(cx.timers.length, 1, "nothing to redraw for an action without an undo bar");
  announce(view, "Copy has nothing to undo", cx);
  assert.equal(view.notice, "Copy has nothing to undo");
  assert.equal(cx.timers[1].ms, NOTICE_MS);
  view.notice = "Sending to Main…"; // the widget said something else meanwhile
  cx.timers[1].fn(cx);
  assert.equal(view.notice, "Sending to Main…");
  announce(view, "Nothing to undo", cx);
  cx.timers[2].fn(cx);
  assert.equal(view.notice, null);
});

test("a message can go to Herdr's notifications instead of the widget's notice line", () => {
  const view = { notice: null };
  const posted = [];
  announce(view, "Send to Main can't be undone", fakeCx(), (n) => posted.push(n), "toast");
  assert.deepEqual(posted, [{ title: "Send to Main can't be undone", level: "info" }]);
  assert.equal(view.notice, null);
});

test("the undo bar is drawn only while the action can be undone, and names the key", () => {
  const made = [];
  const el = () => {
    const node = { text: [], calls: {} };
    made.push(node);
    return new Proxy(node, { get: (n, p) => (p in n ? n[p] : (...a) => ((n.calls[p] = a), p === "child" && typeof a[0] === "string" && n.text.push(a[0]), proxyOf(n))) });
  };
  const proxies = new Map();
  const proxyOf = (n) => proxies.get(n);
  const ui = { div: () => { const p = el(); proxies.set(made.at(-1), p); return p; }, h_flex: () => { const p = el(); proxies.set(made.at(-1), p); return p; } };
  const t = { raised: "#111", muted: "#222", accent: "#333", border: "#444", dim: "#555" };
  let undone = 0;
  const o = { onUndo: () => undone++, onClose: () => {}, now: 2000 };
  assert.equal(undoBar(ui, t, did("Send to Main", null, "final", 1000), o), null);
  assert.equal(undoBar(ui, t, did("Dismissed: x", { id: 1 }, "final", 1000), { ...o, now: 1001 + UNDO_MS }), null);
  assert.ok(undoBar(ui, t, did("Dismissed: x", { id: 1 }, "final", 1000), o));
  const words = made.flatMap((n) => n.text);
  assert.ok(words.includes("Dismissed: x") && words.includes("Undo") && words.includes(KEYS.undo.shown));
  const button = made.find((n) => n.calls.id?.[0] === "undo-bar-undo");
  assert.equal(button.calls.tooltip[0], `Undo (${KEYS.undo.shown})`);
  button.calls.on_click[0]({}, { stop_propagation() {} });
  assert.equal(undone, 1);
});
