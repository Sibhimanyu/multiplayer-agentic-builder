# 0001 — Firebase coordinates, git stores

Status: **accepted**
Date: 2026-08-28
Decided by: the user, on the measurements in `docs/results/scoreboard.md`
Supersedes: the platform question the whole three-route exercise was built to settle

## Decision

**Firebase Firestore is the coordination layer. Git is the durable store.** The dashboard reads
the Firestore store adapter; contracts, schemas and decisions live in the git blackboard.

The comparison is **closed**. Catalyst (C1/C2) and route G are no longer competing implementations.

## Why

All three routes ended with a working atomic claim primitive, so correctness stopped being the
discriminator. What decided it:

- **Firebase is the only route with a push subscriber** — 191 ms listener push, against ~5 s and
  ~8.5 s polls. It is the only one where a dashboard feels live rather than refreshed.
- **Nothing blocks it.** Catalyst is down on an exhausted Data Store quota that its identity
  resolution depends on; route G's conformance suite cannot currently complete A5.
- **Its primitive was verified contended** — `runTransaction`, 40 won / 160 lost, exactly one winner
  per task.

## What this costs, stated plainly

- **Presence is 48% of the daily write allowance at 10 agents**, against zero UPDATEs on Catalyst and
  zero metered writes on route G. This is the worst part of the choice and it is a real ceiling.
- **Firebase's latency numbers skip a hop the others pay** — Spark plan, no Cloud Functions, so they
  are adapter→Firestore direct. Fewer moving parts is a genuine advantage; it is not a latency win.
- **Its contended figure (1,955 ms) is unvalidated** and may carry the same unexplained inflation as
  the 1,167 ms uncontended anomaly that a tested-and-disproven hypothesis could not account for.

## What is NOT discarded

**Route G's git work becomes the durable layer, not a loser.** The blackboard, the one-file-per-fact
rule, the sha-pinned CDN read path and the `--atomic` push discipline all ship. So does its
**git-timeout fix** — a wedged `git send-pack` with no deadline would have hung a production daemon
forever while appearing healthy.

**Catalyst is not disproven, it is unchosen.** Its zero-UPDATE presence design is the best of the
three and is worth revisiting if Firebase's write ceiling ever binds.

## Consequence

Do not re-litigate. The two findings worth more than this decision — `is_unique` not enforcing under
concurrency, and Data Store CAS reporting success to every racer — are recorded as entries 37 and 41
and are reportable to Zoho independently of which platform we build on.
