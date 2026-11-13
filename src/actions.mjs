// Actions on one issue. One list, used by the CLI (`act`), the sidebar's keys, its right-click
// menu and its legend, so they can't drift apart. Each action says whether it can run now and,
// when it can't, why (shown on the disabled item).

import { issueText } from "./issue.mjs";

/** @typedef {"copy"|"send-main"|"new-main"|"brief"|"dismiss"|"restore"|"open"} ActionName */
/** @typedef {{ main?: string|null }} Targets terminals in the shown space */

/** @type {{ name: ActionName, label: string, key: string, keyLabel: string }[]} */
export const ACTIONS = [
  { name: "copy", label: "Copy", key: "c", keyLabel: "C" },
  { name: "send-main", label: "Send to Main", key: "m", keyLabel: "M" },
  { name: "new-main", label: "New Main from this", key: "n", keyLabel: "N" },
  { name: "brief", label: "View brief", key: "b", keyLabel: "B" },
  { name: "open", label: "Open source", key: "o", keyLabel: "O" },
  { name: "dismiss", label: "Dismiss", key: "d", keyLabel: "D" },
];
export const ACTION_NAMES = [...ACTIONS.map((a) => a.name), "restore"];
/** The two hand-offs: both gather context first, then send issue + brief + rules. */
export const HANDOFFS = ["send-main", "new-main"];

export class ActionUnavailable extends Error {
  /** @param {string} message @param {string} [code] */
  constructor(message, code = "ACTION_UNAVAILABLE") {
    super(message);
    this.code = code;
  }
}

/** @param {ActionName} action @param {import("./issue.mjs").Group} g @param {Targets} targets @returns {{ enabled: boolean, reason: string|null, code?: string }} */
export function availability(action, g, targets = {}) {
  const i = g.members[0];
  if (action === "send-main" && !targets.main) return { enabled: false, reason: "No Main conversation in this space", code: "NO_MAIN" };
  if (action === "open" && !i.url && i.kind !== "board") return { enabled: false, reason: "Lives in the app database: no page to open" };
  return { enabled: true, reason: null };
}

/**
 * The Herdr command that starts a new Main (a new space) for the issue. The app appends `task` to
 * the agent's argv (herdr-app src/window.rs agent_argv), so Pi starts with the prompt as its first
 * message. The sidebar runs it; `act --apply` runs it through herdr-app.
 * @param {string} title @param {string} prompt @param {string} root
 */
export function newMainCommand(title, prompt, root, piArgv = ["pi"]) {
  return { name: "space.new", args: { name: `Issue: ${title}`.slice(0, 48), folder: root, argv: [...piArgv, "--name", "Main"], task: prompt } };
}

/** What "Open source" opens: the issue's link, or the tracker file that holds the card. */
export function openTarget(g, root) {
  const i = g.members[0];
  if (i.url) return i.url;
  if (i.kind === "board") return `${root}/tracker/board.json`;
  return null;
}

export { issueText };
