// Actions on one issue. One list, used by the CLI (`act`), the sidebar's keys, its right-click
// menu and its legend, so they can't drift apart. Each action says whether it can run now and,
// when it can't, why (shown on the disabled item).

import { issueText } from "./issue.mjs";

/** @typedef {"copy"|"send-main"|"new-main"|"fixer"|"dismiss"|"restore"|"open"} ActionName */
/** @typedef {{ main?: string|null, fixer?: string|null }} Targets terminals in the shown space */

/** @type {{ name: ActionName, label: string, key: string, keyLabel: string }[]} */
export const ACTIONS = [
  { name: "copy", label: "Copy", key: "c", keyLabel: "C" },
  { name: "send-main", label: "Send to Main", key: "m", keyLabel: "M" },
  { name: "new-main", label: "New Main from this", key: "n", keyLabel: "N" },
  { name: "fixer", label: "Hand to Fixer", key: "f", keyLabel: "F" },
  { name: "open", label: "Open source", key: "o", keyLabel: "O" },
  { name: "dismiss", label: "Dismiss", key: "d", keyLabel: "D" },
];
export const ACTION_NAMES = [...ACTIONS.map((a) => a.name), "restore"];

export class ActionUnavailable extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.code = "ACTION_UNAVAILABLE";
  }
}

/** @param {ActionName} action @param {import("./issue.mjs").Group} g @param {Targets} targets @returns {{ enabled: boolean, reason: string|null }} */
export function availability(action, g, targets = {}) {
  const i = g.members[0];
  if (action === "send-main" && !targets.main) return { enabled: false, reason: "No Main conversation in this space" };
  if (action === "fixer" && !targets.fixer) return { enabled: false, reason: "No Fixer agent in this space" };
  if (action === "open" && !i.url && i.kind !== "board") return { enabled: false, reason: "Lives in the app database: no page to open" };
  return { enabled: true, reason: null };
}

/** The prompt Main receives. */
export const mainPrompt = (g, why) =>
  `The Issues widget passed you this issue.\n\n${issueText(g, why)}\n\nFind the cause before changing anything, and tell me what you found and what you'd change. Ask before touching money.`;

/**
 * What the Fixer receives: the issue and nothing else. No instruction that widens its job: the
 * Fixer's own role decides what to do (it fixes one failing test in one named file, and asks
 * which file when none is named). John, 2026-11-12.
 */
export const fixerPrompt = (g, why) => `Fixer: an issue from the Issues widget.\n\n${issueText(g, why)}`;

/** The Herdr command that starts a new Main (space) for the issue; the sidebar runs it, `act --apply` runs it via herdr-app. */
export function newMainCommand(g, why, root, piArgv = ["pi"]) {
  const name = `Issue: ${g.members[0].title}`.slice(0, 48);
  return { name: "space.new", args: { name, folder: root, argv: [...piArgv, "--name", "Main"], task: mainPrompt(g, why) } };
}

/** What "Open source" opens: the issue's link, or the tracker file that holds the card. */
export function openTarget(g, root) {
  const i = g.members[0];
  if (i.url) return i.url;
  if (i.kind === "board") return `${root}/tracker/board.json`;
  return null;
}
