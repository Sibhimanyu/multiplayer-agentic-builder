---
order:    0004
to:       both
issued:   2026-08-25
blocking: yes
---

# Push after every commit. Both sessions have already lost work to this.

## What has happened twice

**Catalyst session `riga-e6`** committed `f5a7dce` and ended without pushing. Its commit
message named an `is_unique` probe; the probe result was never written to disk. That answer is
gone and has to be re-run. See order 0003.

**Firebase session `worcester-fa`** committed `121bb79` — store adapter, CLI, functions,
dashboard wiring — and ended without pushing, leaving 23 further uncommitted paths in the
working tree.

Neither loss was necessary. Both were one `git push` away from safe.

## Do — from now on, every time

```bash
git add <specific paths>          # never git add -A
git commit -m "..."
git push                          # NOT optional, NOT batched for later
```

**Push immediately after every commit.** Not at the end of the session. Not when the feature is
finished. Every commit.

Also: before you end a turn, if `git status` is not clean, commit and push what is safe to
commit. A working tree full of uncommitted work is one workspace reset away from nothing.

## Why

Your pushed branch is the **only** channel through which the coordinator can see your work.
Not your local commits, not your working tree, not your reasoning — the pushed branch.

- An unpushed commit is invisible to coordination and dies with your session.
- Uncommitted work is invisible *and* unrecoverable.
- The coordinator promotes shared code by reading your branch. If it isn't pushed, it can't be
  promoted, and the other build sits blocked waiting for something that already exists.

Sessions end for reasons you do not control. Treat every commit as though the session ends one
second later, because twice now it effectively has.

## Report back

Nothing to report. Just push. The push *is* the report.
