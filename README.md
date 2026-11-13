# Issues (herdr-triage)

A sidebar widget for the Herdr app. It reads a project's incoming issues, has a small model pick the few most pressing, and hands one to Main with context gathered first. How it works, its commands and its checks: `CONTEXT.md`, `checks.md`, and `node triage.mjs describe`.

## Gathering before a hand-off

Press M or N on an issue. One small-model call plans which gatherers to start and what each looks for; they run in parallel, each inside 20 seconds; a slow or failed one is shown as such and never holds up the hand-off. Every line in the brief cites something the model was actually sent (a report, a file line, a commit, a URL); code drops any line that does not. Main receives the issue, the brief and the cited code as fenced data, then your rules.

Gatherers: Code, History, GitHub (read-only `gh` searches), Packages (the npm registry, read-only), Past conversations.

## Past conversations: off unless you turn it on

This gatherer reads this project's earlier Pi conversations to find decisions you already made. It is **off by default** and stays off until you turn it on for one project:

```
node triage.mjs config --root <project> --conversations on     # on, this project only
node triage.mjs config --root <project> --conversations off    # off again
```

While it is on, the widget's Rules line ends with "Past conversations: on for this project (text only, redacted)", and the issue's row says how many conversations were read.

What it does when on:

- Reads only sessions whose own header says they were started in this project. A session with no header, or from another folder that happens to share the sessions folder, is not read.
- Takes only what you and the assistant wrote. Never tool output, never thinking, never system messages.
- Removes secrets, tokens, keys, e-mail addresses and home paths before any model, cache file, receipt or prompt sees the text. Short excerpts that match the issue's words are then sent to the small model (your model provider sees them).
- Writes nothing in the sessions folder, and stores none of what it read: only findings the model kept, each citing a session and entry.

### Before you turn it on

Three independent reviews each found a named credential that slipped past the redaction (each was fixed and is now a test). That is why it ships off. Turn it on only when all of these hold:

1. **A fresh independent review of the redaction has passed with no leak found.** Not "the last findings were fixed": a review that looked and found none. Until then, treat a leak as likely.
2. **You accept what redaction cannot do.** It recognises a credential by its name (password, token, api key, secret, a cookie or authorization header) or by its shape (a long random-looking string, a private-key block, a URL with a password). A secret with neither, such as a short plain word pasted on its own, is not recognised and can be sent.
3. **You would be comfortable with your model provider reading excerpts of this project's conversations.** If those conversations hold other people's private details, client data, or anything under an agreement that forbids sharing, leave it off.
4. **It is on for this project only, on purpose.** There is no global switch. Turn it on per project, and turn it off when you no longer need it.
5. **You have looked at what it surfaces.** After the first press, open the brief (B) and read the Past conversations section before relying on it. If anything there should not have left your machine, turn it off and report it.

A clone of a project has no conversations of its own. `--conversations-of <the original project folder>` counts the original's conversations as this project's; the same rules apply.

## Install

```
sh install.sh            # copies the widget into the Herdr app's mods folder
```
