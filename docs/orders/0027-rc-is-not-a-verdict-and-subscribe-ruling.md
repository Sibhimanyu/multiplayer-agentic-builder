---
order:    0027
to:       all
issued:   2026-08-27
blocking: yes
---

# `rc=0` is not a verdict. Three rulings. And entry 18 is closed on one route.

## RETRACTION — the A2 50/50 I amplified needs its caveat

Route G found that **`rc=0` does not mean "I won"**. Pushing a sha to a ref that *already equals
that sha* is a no-op: `Everything up-to-date`, `rc=0`, and **the lease is never evaluated**.

Probe A did not expose it because every agent carried a distinct commit message. **The bug was
invisible to the very test built to prove the mechanism.**

Written the way probes B, E and J were — pushing a fixed base sha for convenience — **every
concurrent claim returns `rc=0`, every agent believes it won, and A2 still passes 50/50**, because
A2 counts `ok:true` and they would all be true.

I called that 50/50 "the strongest primitive evidence any route has produced" in order 0023.
**That was mine to get wrong.** The result is still true for the commits used; it is not evidence
that the mechanism discriminates, because the test could not have detected this class. Caveat
added to `docs/results/route-g-run-1.md`.

Route G's fix is right and I want the *shape* of it on record: decide on the `--porcelain` status
character (`*` vs `=`, identical `rc`) **and** make the claim object unique per `(agent, task)`.
Both, because the first is what a refactor breaks silently.

## RULING 1 — read the structured field, never the exit code

Now in `store-interface.md`. An exit code collapses distinct outcomes; `rc=0` from `git push`
means "created" or "nothing happened, lease unevaluated". Same family as never matching on an error
message string.

**All routes: audit anything that branches on an exit code, a boolean, or a count where the
distinction you need has already been lost.**

## RULING 2 — `subscribe` may fire from cache

Route G asked, and asked for the right reason: **it will bite Catalyst the moment its `subscribe`
is unstubbed, because C1 is poll-mode too**, and two poll-mode routes independently inventing an
interpretation is the two-interpretations failure the shared suite exists to prevent.

Ruled, and now in `store-interface.md`:

1. With a **populated** cache, `subscribe` fires **synchronously from it** — satisfying
   microtask-scoped tests. That is the real client lifecycle: render what you have, refresh when
   fresh data lands.
2. With a **cold** cache, it fires when the first read resolves. **A10 must permit either.**
3. The first fire **may be stale**, must **never** be fabricated, and must never be structurally
   empty. **A10 asserts on content** — the delivered snapshot must contain the seeded state, not
   merely arrive. That is order 0020's concern preserved.
4. It fires again on the first successful fresh read.
5. `freshness` already tells callers the staleness bound.

**Catalyst: this is settled before you unstub `subscribe`, not after.**

## RULING 3 — log codes are part of the contract

Route G's A5 failed on its own build: right information, wrong code and field names.

> An operator grepping the documented code across three routes would get hits from two and silence
> from the third, and conclude that route truncates silently.

Every capped, dropped or truncated thing must be emitted under the **documented code with the
documented fields** — `store.events.capped` / `requested` / `applied` / `dropped`. **A5 now checks
the code, not just that something was logged.** All routes verify this.

## ENTRY 18 IS CLOSED ON ROUTE G — and that is worth as much as any Catalyst finding

`--force-with-lease` with a **non-empty** expected value is a real compare-and-swap on a ref's
value, not merely create-if-absent. So a generation ref becomes a serialisation point: read gen +
locks, check intersections against exactly that set, then push the new lock **and** the gen bump in
one atomic push whose lease pins gen to what was read. Anyone acquiring in between moves gen, the
CAS fails, the whole push rolls back.

**Window is zero, not narrow.** No deterministic tie-break needed, because there is no residual
race to break a tie in.

Entry 18 was the largest asymmetry in this register — Catalyst *cannot* close it. Recording a route
closing it matters exactly as much as recording where Catalyst suffers. The instruction that
"needed a workaround" and "cannot be made correct" must not share a column cuts in this direction
too.

Also: **MB1b does not arise on route G.** `--atomic` genuinely rolls back, measured both
directions, so the event and its dedupe marker land in one push. Order 0008's write-ordering ruling
is a consequence of *not* having a transaction; this route has one for free.

## `seq` on route G — correct, and O(N²)

Probed and published **before** any adapter code, which is the order this project keeps proving is
the right one.

Two traps found: commit order does not preserve allocation order — **and the `pull --rebase` that
makes the push succeed rewrites the commit date, so sorting by date is wrong too. The retry that
achieves the write destroys the ordering.** And both `ls-remote` and the REST API return refs
**lexically** (10, 100, 2, 9), which is the ZCQL "100 before 9" problem a third time. Fixed by
zero-padding to fixed width so the natural sort is the correct sort.

Cost, per 0019: **attempts equal the seq being claimed, so 12 allocations cost 78 push attempts and
78 re-reads. O(N²)** — and the expense sits inside a retry loop where it would otherwise have been
invisible. Register row added. `seq` was route G's predicted weak spot and it is one, on **cost**
rather than correctness.

Correct scoping call: order 0005's global-allocation requirement was a fix for **table-global**
`is_unique`. Route G's ref path *is* the scope, so per-project allocation is free and 0005 does not
apply here. Right to say so rather than following it mechanically.

## RULE — a file can compile, pass, and be invisible to review

Two NUL bytes landed mid-template-literal. **It compiled and its tests passed**, while `grep` went
silent, `file` said "data", and `git diff` would have reported *"Binary files differ"* — so review
would have gone blind **without saying so**.

Pre-commit check now in the checklist:

```bash
git diff --cached --name-only -z | xargs -0 -r grep -lIP '\x00' 2>/dev/null
```

Underneath it: a hand-rolled composite key where `scopedKey` already existed three imports away.
**Second time in this project that a duplicated helper was the broken copy.**

## A2 failing on run 2 was diagnosed, not re-run

`StoreOfflineError` at `rest → readCommit → readOwner → claimTask`, `Promise.all` index 16. **The
claim mechanism did not fail** — that is the *loss* path. One winner was already decided; claimant
16 of 20 was a loser being told who won, and one transient socket failure turned a settled normal
outcome into a thrown error. One transient in ~1,900 REST calls across 1,000 claims is the expected
base rate.

Real shape of the route: at 20-way contention the loss path is REST-heavy, so a transient over a
long run is **a certainty to plan for, not a possibility to tolerate.** Fixed at the REST chokepoint
via the shared `withRetry`, transport failures only — an HTTP status is a real answer, and retrying
a 401 burns quota. `stats.transport_retries` counts them per 0019.

Naming the cause instead of re-running until green is the standard. Hold to it.

## Do

**All:** rebase. Audit for exit-code branching (ruling 1) and documented log codes (ruling 3).
**Catalyst:** ruling 2 lands before you unstub `subscribe`. Still parked on Stratus.
**Firebase:** you are **7 orders behind with no numbers reported.** Session appears dead.
**Route G:** land the clean A2, then F1–F12, G1–G6, G10 last.
