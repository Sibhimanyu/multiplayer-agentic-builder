---
order:    0011
to:       both
issued:   2026-08-25
blocking: no
---

# Two test requirements from the Catalyst build. Short order.

## 1. Allowlist with an explicit default-drop, and test the unknown value

Catalyst replaced its pair of `if`s with a **table**, so the whole allowlist is visible at
once, then added a test for a `check_suite` conclusion **GitHub has not invented yet**. Absent
from the table means drop, so a future value cannot default into a red badge on a task whose CI
never reported one.

**A permissive default is invisible until it misfires.** That is the failure mode worth
guarding, and it is not covered by testing the nine values that exist today.

New checklist row **D5a-unknown**: a conclusion not in the table drops, asserted with a
synthetic value.

It also sharpened why dropping `timed_out` was worse than "a missing badge": to an agent,
**silence reads as "not finished yet"**. Dropping a terminal failure does not merely lose
information, it installs the wrong belief. That framing is now in the checklist.

**D5b gains a fifth assertion:** the string `"true"` must not satisfy `merged === true`. Cheap,
and it is the shape a JSON quirk actually takes — particularly on Catalyst, where booleans are
stored as strings and `"false"` is truthy in JS.

**Both builds:** add both.

## 2. Verify cross-branch invariants by RUNNING, not by reading

Catalyst checked the test-resolution axis four ways rather than the obvious one, and the third
is the one that counts: it ran `npm test` **in a throwaway worktree of the shared branch** and
counted, rather than comparing scripts and concluding they matched.

Its own words, and it is right: that is the check it would have skipped if it had trusted its
own reasoning, and it is the exact form the Firebase bug took.

The Firebase root-scripts defect was **invisible from inside either branch**. The script was
fine. The suite passed. Only running the same command in both places revealed 25 versus 19.

```bash
git worktree add /tmp/xcheck origin/<other-branch>
( cd /tmp/xcheck && npm install --silent && npm test )
git worktree remove /tmp/xcheck --force
```

Now in `territory.md`. Applies to root `npm test` count, the `.agentic/` tree in B2, design
tokens in E8, and anything the checklist words as "across both builds".

Note this does **not** mean reading the other build's implementation. Running its test command
and counting the result is not the same as looking at how it solved anything.

## Composite keys — Catalyst stays with separator plus rejection

Recorded, with the tradeoff, not as a defence. For a system whose failure mode is a human
squinting at a claim row wondering why an agent is blocked,
`proj_inventory:task_items_api` beats two hex digests. Firebase keeps hashed parts. Both
documented, both permitted.

## Do

Not blocking. Fold into your next rebase.
