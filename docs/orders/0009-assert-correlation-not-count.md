---
order:    0009
to:       both
issued:   2026-08-25
blocking: no
---

# Two testing rules, from the Catalyst build. Short order.

## 1. Assert correlation, not count

`docs/how-to/acceptance-checklist.md` gains A1b and A1c, plus a general rule.

The Catalyst build implemented mandatory behaviour 1b correctly but noticed its coverage was
only **implicit**, so it added named tests rather than claiming it on the strength of the
design. In doing so it found that the obvious assertion is useless:

> "for each idempotency record, some event exists at that `seq`"

That **passes while the records are cross-wired to the wrong events** — precisely the corruption
1b prevents. Counts right, correlation wrong.

**A test that cannot distinguish the bug from the fix is worse than no test**, because it turns
an open question into false confidence.

Ask of every assertion: *would this still pass if the values were correct in number but wired
to the wrong records?*

Applies beyond A1. Named in the checklist: A2 assert the winner's `agent_id` matches the row;
A7 assert the conflict names the actual holder; D4 assert the ledger still contains the
original event, not just that the count held.

**Firebase:** check your MB1b coverage for exactly this weakness. If `runTransaction` gives you
atomicity for free, you are probably correct — but "probably correct by construction" is what
1b's test is for, and an implicit guarantee is the easiest kind to lose in a refactor.

## 2. Missing is drift

A consistency guard must treat **absent** as a violation, not as "nothing to check".

The Catalyst `_lib` drift guard fired on twelve missing copies after a rebase. Not real drift —
its own test deliberately deletes copies to prove the guard fires, and cleanup left the tree
empty. The tempting fix is to make the guard quiet about missing files. That would have been
broken in the direction that matters: a deploy with no vendored library would have passed.

It fixed the test's housekeeping instead. Correct call, and the reasoning is the point:
**when a guard fires on something your tooling caused, fix the tooling, not the guard.**

## Do

Not blocking. Fold into your next rebase.

**Catalyst:** already done, nothing to change.
**Firebase:** audit MB1b coverage against rule 1.
