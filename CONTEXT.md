# Triage — context

A Herdr app sidebar (a mod, written with gpui-kit like herdr-todos) that shows the few most
pressing incoming issues for the project in the shown space and lets you act on one.

## Words

- **Issue**: one incoming report from a source: a support ticket, page feedback, a tracker card or a
  GitHub issue. Ids are source-prefixed: `ticket-0007`, `feedback-2`, `card:closed-home-booking`,
  `gh#12`. Shape and boundary check: `src/issue.mjs` (`parseIssue`).
- **Group**: issues that are the same report word for word (dedupe key = normalized title + body),
  merged by code. Its id is its first member's id. Its content hash decides whether the model
  reads it again.
- **Source**: where issues come from. Contract `{ name, describe, list(), get(id) }`, read-only,
  failing with `SourceUnavailable`. `local` = the project's `data/rentaplace.db` (open support
  tickets, feedback not rated good) + `tracker/board.json` (cards not done); `github` = open issues
  via `gh issue list`. Picked by `config` / `TRIAGE_SOURCE`; default local when the project ships
  them. `src/sources.mjs`.
- **Triage** (the judgement): a small model (default `anthropic/claude-haiku-4-5` through `pi -p`,
  no tools) reads the groups and returns at most 5 **pressing** items, each with ids (it may merge
  groups that say the same thing in other words), a short title and a one-line **why**.
  `src/triage.mjs`.
- **Action**: what you can do with the selected issue: copy, send-main, new-main, fixer, open,
  dismiss (restore undoes). One list (`src/actions.mjs` `ACTIONS`) drives the CLI, keys, right-click
  menu and legend.
- **Main**: the space's Pi named `Main` (else its first Pi). **Fixer**: an agent in the space whose
  session or tab is named Fixer. Triage never watches either; it only sends them a prompt.

## Who decides what

| Code | Model |
|---|---|
| gathering, ids, word-for-word dedupe, content hashes, what to resend | which issues are pressing |
| dropping any claim whose ids don't exist; each group claimed once | why, in one line |
| ordering of "also open" (reports, newest, id) | merging same-problem reports from different sources |
| states, caching, actions, receipts | the headline |

## Rules (one home each)

- Dedupe key, ids, hashes, tie order, issue text: `src/issue.mjs`.
- What the model reads and how its reply is checked: `src/triage.mjs`.
- Which action is available and why not: `src/actions.mjs` (`availability`; the UI mirrors it in
  `disabledReason` for drawing, and the helper re-checks).
- State words (`ready | empty | missing | stale | failed | unavailable`, `busy`): `triage.mjs` `stateOf`.
- Triage's own files: `src/store.mjs` (`~/.cache/herdr-triage/<app>/projects/<root>/`). It never
  writes into the project, and never creates, edits, closes or comments on an issue.

## Interfaces

- Agents: `node triage.mjs describe | show | refresh | act <id> <action> | explain <id> | config`
  (`--root <project>`). JSON out; errors `{error:{code,message}}` on stderr, exit 1.
- People: the sidebar (`main.js`), right-click menu (`menu/`).
- Model seam: `TRIAGE_MODEL_CMD` (JSON argv; gets `{model, system, input}`), used by the tests.

## Fence

`npm run check` (= `fence.sh`): `tsc` on the UI and the Node helper, `node --check`, `node --test`.
