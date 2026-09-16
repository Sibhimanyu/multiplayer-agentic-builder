---
order:    0062
to:       firebase
issued:   2026-09-16
blocking: yes
---

# The projects index is a stub. Make it worth opening.

The user is authenticated and about to create real projects. The index they will land on shows a
name, a role tag, avatars and a repo path — and nothing about whether anything is **happening**.

## Context you should have

Login failed for the user across ~8 exchanges, and the cause was none of the things we fixed: their
shell resolved `~/.local/bin/flotilla` ahead of `/opt/homebrew/bin/flotilla`, so they ran a build
from before the local login page existed. **Every test I ran hit the current binary; every command
they ran hit a stale one.** Two installs, different PATH order.

Worth carrying: **"I tested it" and "they ran it" are different claims when a binary can be
installed twice.** The installer writes to whichever prefix npm is configured for, so this recurs.
Have `flotilla` detect a competing install on a different prefix and say so — one line, on `whoami`
and on `login`. It cost the user an evening.

## What the index must answer

Someone opening this has one question: **where does my attention need to go?** Today they cannot tell
a project with three blocked agents from one nobody has touched in a week.

Per project card:

- **Task counts by column** — open / claimed / in progress / needs review. The board already folds
  these; the index should not recompute them differently.
- **Live agent count**, using the presence you already have, with the same staleness derivation.
  Not a raw member count — who is *working right now*.
- **Last activity**, from the ledger's newest event. "3 minutes ago" beats a member avatar for
  answering "is this alive".
- **Anything blocked or failing** — a blocked task or a failed CI check is the one thing that should
  pull the eye. Use the existing badge idiom, not new chrome.

Sort by **most recently active**, not creation order. A stale project must not sit above a live one.

## Constraints

- `tokens.css` and the existing card/badge/avatar idioms. **No new visual language** — the board and
  the index should look like one product.
- **One subscription for the page**, as `App` already does for the board. Do not open a listener per
  project card; ten projects must not mean ten listeners.
- Every count comes from the store. **Do not compute a second definition of "in progress"** in the
  index — if the board and the index disagree, both are wrong and nobody can tell which.
- Empty state keeps teaching `flotilla new <name>`.

## Cost check before you build

Read costs money and this page multiplies by project count. **State the read cost per index load**,
and if it scales with projects × tasks, say so and propose the shape that does not. Entry 56's lesson:
a per-listener cost is the one that surprises people, and presence already bills
writes × listeners × payload.

## Verify

Server-render the index with **0, 1, and 12 projects** and assert the ordering is by activity. Assert
a project with a blocked task renders the badge and one without does not — both halves, or "renders
a badge" passes for a card that always renders one.

Then a real browser: the index against live Firestore, with a screenshot.
