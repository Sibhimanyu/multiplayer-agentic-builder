---
order:    0007
to:       both
issued:   2026-08-25
blocking: yes
---

# Rebasing rewrites your SHAs. Push with `--force-with-lease`.

## My omission

Orders 0002, 0005 and 0006 all told you to `git rebase origin/zoho-catalyst-app-builder`.
Order 0004 told you to push after every commit. I never said what the first does to the
second, so those two orders have been in quiet conflict since 0002.

A rebase replays your commits onto a new base and gives them **new SHAs**. Your pushed tip
stops being an ancestor of your local branch, so a plain `git push` is rejected as
non-fast-forward. That looks identical to having ignored 0004 when in fact you complied.

Observed right now on `impl/catalyst-v1`: local `a7a620d` correctly contains order 0006, the
pushed tip `3fe8244` is the pre-rebase line, tree clean, seven commits apparently "unpushed".
Nothing was wrong with the work. The push was simply impossible with the command given.

## Do — after every rebase

```bash
git fetch origin
git rebase origin/zoho-catalyst-app-builder
npm test                                    # shared suite must still be 19/19
git push --force-with-lease
```

`--force-with-lease`, never bare `--force`. With-lease refuses if origin moved since your last
fetch, so it cannot clobber work you have not seen. Bare `--force` overwrites blindly.

This is safe on **your own** `impl/*` branch: you are its only writer.

## Never force-push these

- `zoho-catalyst-app-builder` — the shared branch. Coordinator-only, and both builds rebase
  onto it. Rewriting it breaks both.
- `master`
- The other build's branch. You should not be touching it at all.

If you ever believe the shared branch needs rewriting, that is an order request. Say so in a
commit message and stop.

## Standing rule

Rebase → test → `--force-with-lease`. Treat "seven commits ahead, tree clean, plain push
rejected" as the expected state after a rebase, not as an error.

## Do now

**Catalyst:** `git push --force-with-lease`. Your local `a7a620d` is correct and invisible to
me until you do.

**Firebase:** you are at `1d15605` and have not rebased onto 0006 yet. When you do, expect
exactly this and use `--force-with-lease`.

## Report back

The push is the report.
