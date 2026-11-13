# Issues — context

**Issues** is the widget's name: everything a person sees says Issues. A Herdr app sidebar (a mod,
written with gpui-kit like herdr-todos) that shows the few most pressing incoming issues for the
project in the shown space and lets you act on one. Internal ids stay `triage` (mod folder
`mods/triage`, menu `mods/triage-menu`, command prefix `triage.`, helper `triage.mjs`, repo
`herdr-triage`): renaming them would orphan the `{"mod": "triage"}` block already in John's layout.
"Triage" is the verb for what the model does.

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
- **Triage** (the judgement, a verb): a small model (default `anthropic/claude-haiku-4-5` through `pi -p`,
  no tools) reads the groups and returns at most 5 **pressing** items, each with ids (it may merge
  groups that say the same thing in other words), a short title and a one-line **why**.
  `src/triage.mjs`.
- **Action**: what you can do with the selected issue: copy, send-main, new-main, brief, open,
  dismiss (restore undoes). One list (`src/actions.mjs` `ACTIONS`) drives the CLI, keys, right-click
  menu and legend.
- **Main**: the space's Pi named `Main` (else its first Pi). Issues never watches it; it only sends
  it a prompt.
- **Hand-off**: Send to Main (M) or New Main (N). Both gather first, then send one prompt: the
  issue, the context brief, the rules. Nothing else fixes issues: they vary too much for a small
  model, so the small model only prepares the ground and the big one does the work (John, 2026-11-12).
- **Context brief**: what the small model condenses from what code collected about one issue:
  what is reported, where it likely lives, tests near it, what is not known. Every claim cites a
  report id, a `path:line` the model was shown, or `commit:<sha>`; code drops the rest.
- **Rules**: one file sent with every hand-off: `<project>/issues-rules.md` when the project has
  one, else the widget's `rules.md`. The legend names the file in use.

## Instructions

`src/triage.mjs` `INSTRUCTIONS`: **never-overstate** (default, hill-climbed 2026-11-12; 3 of 25 lines overstated on the installed code, against 19 of 25 for the original) and **baseline** (the original, kept for the course's "before"). Pick it with `--instruction`, `config --instruction` or `TRIAGE_INSTRUCTION`. An unknown name is an error. Changing it re-reads the issues, because the instruction is part of the input hash.

## Gather, then hand over

`src/gather.mjs`. `collect()` is code only and bounded (`LIMITS`; 8 s, local git and files, no
network): every merged report's text, the files a tracker card names (kept only if they exist; the
others are listed as missing), code files ranked by the issue's distinctive terms (a term weighs
more the fewer files contain it), tests that import those files, recent commits touching them.
The model (the widget's model, Haiku, no tools) gets those excerpts with line numbers and returns
`{reported, where, tests, unknown}`. `parseBrief()` keeps a claim only when every citation
resolves, a reported claim cites a report and a code claim cites a line; a cause stated as fact
is dropped. Dropped claims stay in `brief.dropped` with the reason and the brief view shows them.
No surviving claim, no JSON or a failed model call is `GATHER_FAILED`: the row says so and nothing
is sent. Sending without context is a separate, named choice (`--no-context`, ⇧M / ⇧N), offered
only after a failure.

The brief is saved by content hash (the issue's reports, what code collected, the model, the
instruction): pressing M again reuses it and says so; changed code or a new report gathers again.

`src/handoff.mjs`: `issueFor` (every report pasted), `loadRules`, `assemblePrompt` (issue + brief +
rules, in that order, nothing else). New Main is Herdr's `space.new {argv, task}`: the app appends
`task` to the agent's argv, so Pi opens with the prompt as its first message.

## Checks

`checks.md`: Do / Expect / Never against the real inbox, run with `node ~/dev/herdr-pi-widget/kit/check.mjs checks.md --runs 3`.

## Who decides what

| Code | Model |
|---|---|
| gathering, ids, word-for-word dedupe, content hashes, what to resend | which issues are pressing |
| dropping any claim whose ids don't exist; each group claimed once | why, in one line |
| ordering of "also open" (reports, newest, id) | merging same-problem reports from different sources |
| states, caching, actions, receipts | the headline |
| collecting evidence for one issue; dropping brief claims whose citation does not resolve | condensing that evidence into the context brief |

## Rules (one home each)

- Dedupe key, ids, hashes, tie order, issue text: `src/issue.mjs`.
- What the model reads and how its reply is checked: `src/triage.mjs`.
- Which action is available and why not: `src/actions.mjs` (`availability`; the UI mirrors it in
  `surface.js` `disabledReason` for drawing, and the helper re-checks).
- What the legend, menu, row status and brief view say: `surface.js` (plain data, no imports;
  `main.js` only draws it, and the tests read the same file).
- What a citation may point at and why a claim is dropped: `src/gather.mjs` (`resolveCite`, `parseBrief`).
- What Main receives: `src/handoff.mjs` (`assemblePrompt`). The rules text: `rules.md` / the project's `issues-rules.md`.
- State words (`ready | empty | missing | stale | failed | unavailable`, `busy`): `triage.mjs` `stateOf`.
- Triage's own files: `src/store.mjs` (`~/.cache/herdr-triage/<app>/projects/<root>/`). It never
  writes into the project, and never creates, edits, closes or comments on an issue.

## Keyboard and navigation (shared with Todos and Memories)

One file, `nav.js`, holds the rules; the same file is copied into herdr-todos (`nav.js`,
`memories/nav.js`) and `test/nav.test.mjs` fails if the copies differ.

- `⌘I` (keys.json `"global": {"cmd-i": "triage.focus"}`): Issues takes the keyboard, expands if
  collapsed, selects the last-selected (else first) issue. `Esc` gives the keyboard back to the
  pane that had it, else the space's Main.
- `↑/↓` (`k/j`), `Home/End`, `PgUp/PgDn` move inside one widget and stop at its ends.
  `Tab`/`Shift+Tab` move to the widget below/above (`pane.go`). `−` or a header click collapses.
- Collapsed: one header line ("Issues · 5 pressing"), saved in the mod's localStorage, and the
  block is resized to 36 px when it shares a column, so the others get the height
  (`layout.resize`; the expanded size is restored).
- Lists window themselves (`keepInView`, `wheelTop`): Herdr's virtual lists forbid handlers in
  rows and plain scroll areas can't be scrolled from code. Rows have fixed heights; long text is
  clipped and the full text is the row's tooltip.
- Every control has a tooltip "Action (Key)"; disabled actions say why.

## Interfaces

- Agents: `node triage.mjs describe | show | refresh | gather <id> | prompt <id> | act <id> <action> |
  rules | explain <id> | config` (`--root <project>`). JSON out; errors `{error:{code,message}}` on
  stderr, exit 1. Named errors: `GATHER_FAILED`, `NO_MAIN`, `RULES_MISSING`, `NOT_FOUND`,
  `ACTION_UNAVAILABLE`, `ACTION_FAILED`, `INVALID`.
- People: the sidebar (`main.js`), right-click menu (`menu/`), keys above, plus the action keys
  C, M, N, B (view the brief; B or Esc closes it), O, D. ⇧M / ⇧N appear only after a gather failed.
- Model seam: `TRIAGE_MODEL_CMD` (JSON argv; gets `{model, system, input}`), used by the tests.

## Fence

`npm run check` (= `fence.sh`): `tsc` on the UI, `nav.js` and the Node helper, `node --check`, `node --test`.
