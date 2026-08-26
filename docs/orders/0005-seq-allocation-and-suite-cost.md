---
order:    0005
to:       both
issued:   2026-08-25
blocking: yes
---

# `seq` is not `ROWID`. Spec corrected. Plus a run-cost policy for the suite.

## 1. The ROWID finding is accepted. The spec was wrong; it is now fixed.

The Catalyst workspace probed `ROWID` and found it is allocated from per-shard blocks and runs
**backwards** across separate INSERTs: insert #1 got `...052001`, insert #2 got `...044002`.
`ORDER BY ROWID` is not chronological.

This was my error, not a build error. Two spec files asserted `ROWID` was monotonic and both
are corrected on the shared branch.

**Severity: this was silent event loss, not an ordering nit.** A reader that consumed up to
cursor `052001` would never be delivered the event that landed at `044002`. It would have
shipped as an intermittent "the frontend agent never saw the contract" bug that reproduces
about one time in three and looks like a network fault.

**Stopping instead of working around it was exactly right.** That is the escalation path
working as designed. Do it again whenever a spec claim fails a probe.

## 2. `seq` allocation — approved, with one correction

The proposed mechanism is right in shape. It has one deadlock, corrected below.

**Approved (Catalyst):** a dedicated `seq bigint is_unique` column, allocated **globally**.

```
candidate = SELECT MAX(seq) FROM events         -- NO project filter
loop, bounded at 20 attempts:
  INSERT ... seq = candidate + 1
  on DUPLICATE_VALUE -> candidate = candidate + 1, retry   -- increment, do NOT re-read
exhausted -> StoreBusyError
```

**The correction.** The proposal read `MAX(seq)` *for the project*. Against a globally-unique
column that deadlocks: project A holds seq 6, project B computes `MAX(seq WHERE project=B)` =
5, tries 6, gets `DUPLICATE_VALUE`, re-reads its own max — still 5 — and tries 6 forever.

Allocate globally, filter on read. Per-project gaps get large; gaps are already legal under
mandatory behaviour 4. And on conflict **increment the candidate**, never re-read the same
`MAX`, or you reintroduce the same spin.

Uses only primitives you have already verified — the same unique-constraint CAS as
`claimTask`, so no new mechanism. Costs one extra SELECT per append; record that in G4.

**Firebase:** no change needed. A counter doc inside `runTransaction` already satisfies
mandatory behaviour 4. That the two platforms need different mechanisms for the same guarantee
is itself a G9 finding — record it on both sides.

`CREATEDTIME` is not a fallback for either of you: millisecond resolution, and every row of a
batch shares one timestamp, so ties break strict ascent.

## 3. Conformance A5 run-cost policy

Flagged by the Catalyst workspace: A5 needs 301 events, roughly 602 INSERTs per run, against a
5,000/month free-tier INSERT budget. About 8 runs a month before A5 alone exhausts it.

That cost is inherent — you cannot prove a 300-row cap with fewer than 301 rows — so the fix
is *when* it runs, not what it tests. **The suite itself stays unmodified. `shared/` remains
frozen.**

- **Against `memory`:** run the full suite on every change. Free, hermetic, fast. This is your
  normal loop.
- **Against a real backend:** run the full suite **once**, when your adapter first goes green.
  Record the exact operation count in G4.
- **After that:** exclude A5 from routine real-backend runs. Run the other 18. If you change
  paging or cursor logic, re-run A5 once and say so in the commit message.

Do not weaken A5. Do not lower the 301. Do not skip it silently — if you skip it, log that you
skipped it and why, per mandatory behaviour 9.

**Firebase:** 602 writes against 20,000/day free is noise, so run the whole suite freely. The
asymmetry — 8 runs a month versus effectively unlimited — is a real platform difference and
belongs in G6 on both sides. Do not normalise it away.

## 4. Branch naming — settled, no action

`impl/catalyst-v1` and `impl/firebase-v1` are correct. They match the `impl/catalyst-*` /
`impl/firebase-*` glob in the orders README. `origin/impl/catalyst` and `origin/impl/firebase`
are stale at `640afa8` and are now abandoned — do not push to them, do not delete them.

## Do

**Catalyst:** rebase onto the shared branch for the corrected spec, then build `seq` as
approved above. `git fetch origin && git rebase origin/zoho-catalyst-app-builder`

**Firebase:** rebase for the corrected spec. No mechanism change. Confirm your counter-doc
approach satisfies mandatory behaviour 4 and note it in G9.

## Report back

Commit `Order 0005: seq allocated via unique column, not ROWID` (Catalyst) or
`Order 0005: seq mechanism confirmed` (Firebase). Push.
