# Herdr Issues (herdr-triage)

Issues is a sidebar widget for the [Herdr](https://herdr.dev/) app. It reads a project's support inbox, page feedback and board, has a small model pick the few most pressing with one line on why, and hands one to Main with context that a swarm of small models gathered first.

This is John Lindquist's own Issues widget from MEGA.dev S04E02. The lesson teaches you to build your own for the services you use. This repository is the finished Herdr version, shown on the sample project [RentAPlace](https://github.com/johnlindquist/rentaplace), so you can compare.

On screen it is called **Issues**. Its folder and command names say `triage`, the word for what its model does.

## Requirements

| You need | Why | Without it |
|---|---|---|
| The [Herdr](https://github.com/herdrdev/herdr-app) desktop app (checked on 0.1.14) with `herdr-app` and `hc` on your `PATH` | Issues is a Herdr mod; `herdr-app check` verifies it and `hc send` delivers the hand-off to Main | `./install.sh` stops and says which tool is missing |
| [Pi](https://github.com/earendil-works/pi) (checked on 1.5.0), signed in to a provider that has the model | Every model call is `pi -p` with no tools, no extensions and no session | The widget says "Couldn't update (…)" with Pi's error |
| Node 24 or newer (checked on 25.2.1) | The helper is plain Node and reads the inbox with Node's built-in SQLite | The widget says "Couldn't read: …" |
| `git` | Finds the project folder and reads history for the brief | The History gatherer reports a failure; the rest works |
| [`gh`](https://cli.github.com/), signed in (optional) | The GitHub gatherer searches issues and pull requests, read-only | That gatherer is shown as failed; the hand-off still goes |
| macOS | The only system this was checked on. Copy uses `pbcopy`, Open uses `open` | Unverified |

**Models and cost.** Everything runs on `anthropic/claude-haiku-4-5` unless you change it. Reading RentAPlace's 17 groups of issues cost about $0.004 to $0.008 and 4 seconds; the model is asked again only when an issue changed. One hand-off (M or N) made 4 small-model calls and cost about $0.017 in 11 seconds; code caps a press at 6 calls and flags anything over $0.05. A brief is saved, so pressing M again on an unchanged issue costs nothing. Change the model for one project:

```sh
node ~/.config/herdr-app/mods/triage/triage.mjs config --root <project> --model anthropic/claude-sonnet-4-6
```

`pi --list-models` lists the ids you can use.

## Install

```sh
git clone https://github.com/johnlindquist/herdr-triage
cd herdr-triage
./install.sh
```

`install.sh` copies two mods into Herdr's mods folder (`~/.config/herdr-app/mods`, or `$HERDR_APP_HOME/mods`): `triage` (the widget and its helper) and `triage-menu` (the right-click menu). It runs `herdr-app check` on both and prints `check passed` twice. It then binds **Command I** in Herdr's `keys.json`, but only when that key is free; it saves the previous file as `keys.json.before-issues` and tells you what it did. Herdr treats an edited `keys.json` as yours, so shortcuts added by later Herdr releases must then be added by hand.

The first time Herdr sees the new folder it docks Issues on the right of the window. There is nothing to download: the widget has no dependencies.

- Update: `git pull`, then `./install.sh` again.
- Remove: delete `mods/triage` and `mods/triage-menu`, remove the `"cmd-i": "triage.focus"` line from `keys.json`, and delete `~/.cache/herdr-triage` (its saved reads, briefs and receipts).

## The sample project

Issues reads three places in RentAPlace. Two of them live in a database that is not in the repository, so create it once:

```sh
git clone https://github.com/johnlindquist/rentaplace
cd rentaplace
npm run seed
```

| Place | Where it is | What Issues takes |
|---|---|---|
| Support inbox | `data/rentaplace.db`, table `support_tickets` | open tickets (`ticket-0001` …) |
| Page feedback | `data/rentaplace.db`, table `feedback` | feedback not rated good (`feedback-2`) |
| Board | `tracker/board.json` | cards not in Done (`card:closed-home-booking` …) |

Without `npm run seed` only the board is read. Open the `rentaplace` folder in a Herdr space and start Pi there, named Main (`pi --name Main`).

## Walkthrough, in the video's order

1. **Ask for the widget.** In the lesson you type `/widget issues` in Main and describe it: read RentAPlace's support inbox and board, pick the few most pressing with one line on why, keep the source ID for everything. `/widget` comes from [herdr-pi-widget](https://github.com/johnlindquist/herdr-pi-widget). This repository is what that request grew into, so installing it skips the building.

2. **Plain code gathers.** With RentAPlace open, Issues reads the three places itself, with no model: 28 open tickets, 1 feedback and 8 cards. Tickets that say the same thing word for word are merged by code, which leaves 17 groups. See exactly what was read, with every id:

   ```sh
   node ~/.config/herdr-app/mods/triage/triage.mjs refresh --root . --pretty
   ```

3. **The model judges.** One small-model call gets those groups as data and returns at most five under **MOST PRESSING**, each with a title, a one-line why and its ids. Code drops any id the model made up. The rest are listed under **ALSO OPEN**. On RentAPlace the top row read:

   ```
   1  Refund timing unclear to guests
      Money: 4 guests ask when their refund will arrive after cancellation; card:refund-window is in Checking
      ticket-0001 · Support · 4 reports
   ```

   The model's wording differs from run to run. What "pressing" means is a paragraph you own: `INSTRUCTIONS` in `src/triage.mjs`.

4. **Toss it into the lab.** `checks.md` holds the expectations in the lab's Do / Expect / Never form, to run with the kit in [herdr-pi-widget](https://github.com/johnlindquist/herdr-pi-widget). Read the top row closely: the ticket says "When will the refund show up?" A why that turns that question into a missing refund is the failure the lesson shows.

5. **Get your expectations down.** The rule "never overstate what a ticket says" is in `checks.md`, and the instructions that were changed to meet it are the default. The original instructions are kept so you can see the difference:

   ```sh
   node ~/.config/herdr-app/mods/triage/triage.mjs config --root . --instruction baseline          # before
   node ~/.config/herdr-app/mods/triage/triage.mjs config --root . --instruction never-overstate   # after (default)
   ```

   On the same inbox the baseline wrote "3 guests report Beach House checkout works despite being closed; blocks product integrity". No report says anything is blocked. The default wrote "3 guests report Beach House is closed but checkout still works; card is in Todo".

6. **A small or a larger model.** `config --model` (above) switches the model for one project, and the footer of the widget names the model in use and what the last read cost. Run your lab on each and keep the one that passes best.

7. **Keys, listed under the list.** The legend sits under the list and shows only what you can do now; a key that cannot be used is dim and its tooltip says why.

   | Key | What it does |
   |---|---|
   | **Command I** | Jump to Issues from anywhere. It expands if collapsed and selects an issue |
   | **Esc** | Back to the pane you came from, or Main |
   | **↑ / ↓** or **K / J** | Select an issue. **Home**, **End**, **PgUp**, **PgDn** also work |
   | **M** | Gather context, then send to Main |
   | **N** | Gather context, then start a new Main in a new space |
   | **B** | View the context brief. **B** or **Esc** closes it |
   | **C** | Copy the issue |
   | **O** | Open the source (a board card or a GitHub issue) |
   | **D** | Dismiss |
   | **R** | Read the issues again |
   | **Tab** / **Shift+Tab** | The widget below or above |
   | **−** | Collapse to one line: "Issues · 5 pressing" |

8. **The right-click menu.** Right-click an issue (or press **Shift+F10**) for the same actions with their keys. **↑/↓** move, **Enter** chooses, **Esc** closes.

9. **Gather before the hand-off.** Select an issue and press **M**. The row shows the work as it happens:

   ```
   Planning…
   Code: searching…
   History: 3 findings · 2.4 s
   GitHub: 3 findings · 3.2 s
   Not started: Packages, Past conversations
   ```

   One small-model call reads the issue and plans which gatherers start and what each looks for. They run in parallel, each inside 20 seconds. A slow or failed one is shown as such and never holds up the hand-off.

   | Gatherer | Where it looks |
   |---|---|
   | Code | the reports, the files a card names, matching code, tests near it |
   | History | commits that touched those files or mention the issue's words |
   | GitHub | related issues and pull requests, read-only through `gh` |
   | Packages | newer versions of the libraries involved, from the npm registry |
   | Past conversations | decisions in this project's earlier Pi conversations. Off until you turn it on (below) |

10. **Every line names its source.** Each line of the brief ends with what it cites: a ticket id, a `file:line`, `commit:<sha>` or a URL. Code checks each citation against what the model was actually sent and drops a line that cites nothing real; **B** shows the brief, the dropped lines and why. A gatherer that finds nothing says "nothing relevant".

11. **Your rules ride along.** One file is sent with every hand-off. The widget's own `rules.md` is used until the project has its own:

    ```sh
    node ~/.config/herdr-app/mods/triage/triage.mjs rules --root . --init   # writes issues-rules.md in the project
    ```

    Edit `issues-rules.md`; the line under the legend names the file in use ("Rules: triage/rules.md (default)"). The default rules:

    ```
    - Find the cause before changing anything. Tell me what you found and what you would change.
    - Reproduce it with a failing test first. Name the test before you edit any other file.
    - Give me your plan and your questions first, and wait for my answer before you change anything.
    - Ask before touching money: refunds, payouts, charges or prices.
    - When you are done, say what you changed and how you checked it.
    ```

12. **What Main receives.** One message: the issue with every merged report, the brief with a source on every line, the cited code copied by a script, then your rules. The footer says "Sent to Main · brief 11.1 s, $0.0173". Main is told to treat everything gathered as evidence, not instructions, so it comes back with what it found, its plan and its questions, and waits. See the exact message without sending it:

    ```sh
    node ~/.config/herdr-app/mods/triage/triage.mjs prompt ticket-0001 --root .
    ```

No separate agent tries to solve the issue. Issues prepares the ground with small models; you and Main solve it together.

### What you should see

- A panel titled **Issues** on the right, a one-sentence headline, **MOST PRESSING** with up to five numbered rows, **ALSO OPEN · 9** below, the legend under the list, and a footer such as "Read just now" with the model's name and cost.
- Before the first read: "Reading the issues…". In a folder with no inbox or board: "Source unavailable: …" naming what is missing.
- After **M**: the gatherers' lines on the row, then "Brief ready · B to view", and the message arrives in Main.
- If gathering fails, the row says so and nothing is sent. **Shift+M** and **Shift+N** then appear in the legend: they send without context, on purpose.

## More than the video shows

- **GitHub issues as a source.** `config --root <project> --source github --repo owner/name` reads open issues through `gh` instead of, or with (`local,github`), the project's own files.
- **For agents.** Everything the panel does is a command that prints JSON: `node triage.mjs describe` lists `show`, `refresh`, `gather`, `prompt`, `act`, `rules`, `explain`, `config` and `progress`, the named errors and the environment variables.
- **Receipts.** Every hand-off is recorded with the message that was sent, the time and the cost, under `~/.cache/herdr-triage`. Issues never writes into your project except `rules --init`, and never creates, edits, closes or comments on an issue.
- **Which gatherers may start.** `config --root <project> --gatherers code,history`.

### Past conversations: off unless you turn it on

This gatherer reads this project's earlier Pi conversations to find decisions you already made. It is **off by default** and stays off until you turn it on for one project:

```sh
node ~/.config/herdr-app/mods/triage/triage.mjs config --root <project> --conversations on     # on, this project only
node ~/.config/herdr-app/mods/triage/triage.mjs config --root <project> --conversations off    # off again
```

While it is on, the tooltip of the widget's rules line ends with "Past conversations: on for this project (text only, redacted)", and the issue's row says how many conversations were read.

What it does when on:

- Reads only sessions whose own header says they were started in this project.
- Takes only what you and the assistant wrote. Never tool output, never thinking, never system messages.
- Removes secrets, tokens, keys, e-mail addresses and home paths before any model, cache file, receipt or prompt sees the text. Short excerpts that match the issue's words are then sent to the small model, so your model provider sees them.
- Writes nothing in the sessions folder, and stores none of what it read: only findings the model kept, each citing a session and entry.

Before you turn it on, know its limits. Redaction recognises a credential by its name (password, token, api key, secret, a cookie or authorization header) or by its shape (a long random-looking string, a private-key block, a URL with a password). A secret with neither, such as a short plain word pasted on its own, is not recognised and can be sent. Three reviews of the redaction each found a credential that slipped past; each was fixed and is now a test, but treat a leak as possible. Leave it off if the conversations hold other people's private details or anything you may not share with your model provider. After the first press, open the brief (**B**) and read the Past conversations section before relying on it.

A clone of a project has no conversations of its own. `--conversations-of <the original project folder>` counts the original's conversations as this project's; the same rules apply.

## Troubleshooting

- **Command I does nothing.** `install.sh` said why: either `keys.json` did not exist yet (open Herdr once, run `./install.sh` again) or the key was already taken. Add `"cmd-i": "triage.focus"` under `"global"` in `keys.json` yourself.
- **No Issues panel.** Herdr docks it the first time it sees the folder. If you removed it, add a block with `{ "mod": "triage" }` to your layout. `herdr-app status` lists mod errors.
- **"Source unavailable: local: neither data/rentaplace.db nor tracker/board.json in …"** The folder of the focused pane is not a project Issues knows how to read. Open RentAPlace, or point it at GitHub issues (above).
- **Only board cards show.** The database is missing: run `npm run seed` in RentAPlace.
- **"Couldn't update (…)" with a model error.** Run `pi --list-models`; if the model is not listed, sign in to its provider or pick another with `config --model`.
- **M is dim: "No Main conversation in this space".** Start Pi in that space. Issues sends to the Pi named Main, else the first Pi. **N** works without one.
- **"Couldn't gather context: …"** Nothing was sent. Press **M** again, or **Shift+M** to send the issue and rules without a brief.
- **GitHub: failed.** `gh auth status` should show a login. The hand-off still goes without it.

## How it is built

| File | What it holds |
|---|---|
| `main.js` | The panel: when to read, what to draw, and keys, clicks and right-clicks turned into actions |
| `surface.js` | Every word the panel shows (legend, menu rows, status lines, the brief view) as plain data, so tests read the same file |
| `nav.js` | The keyboard rules shared with the Todos and Memories widgets |
| `menu/` | The right-click menu, a second small mod |
| `triage.mjs` | The helper and command line. The panel calls it for everything |
| `src/sources.mjs` | Where issues come from: RentAPlace's files, or GitHub. Read-only |
| `src/issue.mjs` | Ids, word-for-word merging, content hashes |
| `src/triage.mjs` | The instructions, the model call, and the check of its reply |
| `src/gatherers.mjs`, `src/gather.mjs` | The planner, the swarm, and the citation check |
| `src/redact.mjs` | Removes secrets from past conversations before anything else sees them |
| `src/handoff.mjs` | The one message Main receives |
| `rules.md` | The default rules |
| `checks.md` | The lab's expectations |
| `CONTEXT.md` | The glossary and which file owns each rule |

Who decides what:

| Code | Model |
|---|---|
| reading the sources, ids, merging identical reports, what changed | which issues are pressing, and why in one line |
| dropping ids and citations that do not exist | merging the same problem told in different words |
| caching, cost cap, time limits, receipts | which gatherers to start, and what is relevant |

## Build the same thing for another workspace

There is no right or wrong place for this. The helper is the widget; the Herdr panel is one way to show it. `node triage.mjs show --root <project>` prints everything the panel draws as JSON, and `act <id> send-main --terminal <address>` does the hand-off, so the same pieces fit elsewhere:

- **A web page from a dev server:** serve `show` as JSON and render the two lists; a button posts to something that runs `act`.
- **A terminal UI:** print `show` in a pane beside your agent and bind keys to `act`.
- **Another workspace:** replace `hc send` with whatever delivers text to your agent's pane (tmux `send-keys`, Zellij `write-chars`).

To build your own from nothing, give your agent the lesson's request, then the second one:

> Read RentAPlace's support inbox and board, pick the few most pressing with one line on why, and keep the source ID for everything. Then give me the key points for what to do next.

> Make the Issues widget gather information before it sends to Main. Have a small, fast model read the issue and plan which gatherers to start as a swarm. Every line names its source; "nothing relevant" is a fine answer. Send my rules along from one file I own.

Swap `src/sources.mjs` for the services you use: a source is four things (`name`, `describe`, `list()`, `get(id)`) and only reads.

The sibling widgets from the same lesson are [Todos and Memories](https://github.com/johnlindquist/herdr-todos); `/widget` and the lab kit are in [herdr-pi-widget](https://github.com/johnlindquist/herdr-pi-widget).

## Tested

What was checked for 0.1.0 on 2026-11-15, macOS, Herdr 0.1.14, Pi 1.5.0, Node 25.2.1:

- **Clean install.** A fresh clone of this repository, `./install.sh` into an empty Herdr home: both mods copied, `herdr-app check` passed for `triage` and `triage-menu`. With a `keys.json` present, Command I was added when free, reported as already set on a second run, and left alone when taken.
- **Checks from the clean clone.** `npm install`, then `npm run check`: types, syntax and 62 tests passed.
- **End to end from the command line**, with the installed helper, real `claude-haiku-4-5` calls and a fresh clone of RentAPlace after `npm run seed`: `refresh` read 28 tickets, 1 feedback and 8 cards and returned five pressing issues with real ids in 4 s; `gather ticket-0001` planned Code, History and GitHub, kept 13 cited lines and dropped 1, in 11 s for $0.017; `prompt` printed the message with the issue, the brief, the cited code and the rules; `act … send-main --dry-run` and `act … new-main` produced the `hc send` and `space.new` commands. `config --model anthropic/claude-sonnet-4-6` switched the model and read the inbox for $0.013.
- **Not checked for 0.1.0:** the panel in a Herdr window after a clean install (docking on first sight, Command I, the legend, the right-click menu, the message arriving in a live Main).

```sh
npm install
npm run check
```

## License

[MIT](LICENSE)
