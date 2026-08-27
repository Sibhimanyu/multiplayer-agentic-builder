# Workspace 3 — GitHub-only implementation (route G)

You are building the **third** route in a platform bake-off. Catalyst and Firebase builds are
running in parallel from the same Phase 0 spec. **Do not read `impl/catalyst-*` or
`impl/firebase-*`.** Independence is what makes the comparison valid.

Branch: `impl/github-v1`

## What makes this route different

**No cloud backend at all.** No Catalyst project, no Firebase project, no billing account, no
card. GitHub is the entire backend. `gh auth login` and you are running.

For an open-source tool, that is the lowest adoption friction of the three by a wide margin,
and it may matter more than latency. It is also the only route that needed nothing from the
human to get started.

## Read first, in this order

1. `docs/reference/store-interface.md` — the ten operations. **This is the contract.**
2. `docs/protocol/agent-coordination.md` — protocol v0.2, three layers
3. `docs/reference/agentic-file-contract.md` — the CLI↔agent filesystem interface
4. `docs/reference/blackboard.md` — the git half, already shared by all three routes
5. `docs/reference/territory.md` — what you may and may not touch
6. `docs/how-to/acceptance-checklist.md` — your definition of done
7. `docs/orders/` — every order applies to you too, from 0001 onward

## Two primitives, both measured on this machine

### Atomic claim — VERIFIED, and the naive form is unsafe

Probed against the real GitHub remote before this brief was written.

**The trap — and my original statement of it was wrong in an important way.**

I first wrote that a plain `git push origin <sha>:refs/claims/task-42` to an existing claim ref
**always** succeeds. **Corrected 2026-08-26 by measurement:** it succeeds only when the
challenger's SHA is a **descendant** of the holder's.

```
challenger is a SIBLING     -> ! [rejected] (non-fast-forward)   holder retained
challenger is a DESCENDANT  ->   c620ebe..aa35396                CLAIM SILENTLY STOLEN
```

My probe used `HEAD` and `HEAD~1` — two commits on one line — so I measured the descendant case
and generalised it to "any existing ref".

**Why the wrong reason is more dangerous than no reason.** If you believe "naive push always
fails on an existing ref", you conclude the naive form is *safe* — it visibly rejects — and ship
it. And the descendant case is not exotic: an agent claiming with its current branch tip, in a
repo where agents share history, produces descendant SHAs constantly. It is a claim-steal that
surfaces only once two agents happen to be on the same line of history, which is the worst
possible reproduction profile.

Two design consequences:

- Build claim commits as **fresh commits made for the claim** (`git commit-tree` off a fixed
  base), never the agent's working branch tip. That makes all claim commits siblings.
- **Use the lease anyway.** "Siblings by construction" is an invariant a future refactor can
  quietly break; the lease does not depend on it.

**The correct primitive** is a lease with an *empty* expected value, meaning "only if absent":

```bash
git push --force-with-lease="refs/claims/$TASK:" origin "$SHA:refs/claims/$TASK"
```

Measured, both cases:

```
B1  ref absent  -> * [new reference]                       SUCCESS
B2  ref exists  -> ! [rejected] ... (stale info)           REJECTED
```

Server-enforced, atomic, no database. This is your `claimTask`. A rejection is
`{ok:false, owner}` — a normal outcome, not an error. Read the owner from the ref's commit.

**The lease needs no prior fetch.** `--force-with-lease` normally requires a remote-tracking ref;
with an explicit *empty* expected value it does not. So `claimTask` is a single round trip with
**no read step and therefore no read-verify-write window at all** — verified against a client that
had never seen the ref. Neither cloud route achieves that.

**`releaseTask` has a trap the first version of this brief missed.** The obvious
`git push origin :refs/claims/<task>` lets **any agent release any other agent's claim**, rc=0.
Release must be a lease **pinned to the owner's sha**. Ownership then becomes server-enforced for
free. But the pinned delete returns rc=1 for *both* "you do not own it" and "it was already gone",
and the interface requires releasing a task you do not own to be a no-op rather than an error — so
the adapter must **swallow** that rejection, and must **never** fall back to a plain delete to
force rc=0. The fallback is the vulnerability.

**Probe it yourself before building on it.** I ran it sequentially; you should run it
concurrently, and A2 requires 20 concurrent claimants with exactly one winner, 50 rounds.

### Notification — measured, and free

| Channel | median | cost |
|---|---|---|
| `git ls-remote` | **1,347 ms** | free, slow |
| **GitHub API + `If-None-Match` → 304** | **593 ms** | **free — quota verified flat at 4994 across 3 polls** |

Conditional requests do **not** consume the 5,000/hour rate limit. Verified, not assumed. So
`subscribe` is a conditional-GET poll loop at ~600 ms with effectively no quota cost.

`freshness` = `{ mode: 'poll', stale_ms: 5000 }` — or lower, since the poll is nearly free.
Measure it and report what you actually chose.

## The open problem: presence

Git has no TTL. This is the route's genuine weak spot and mandatory behaviour 7 plus test A9
require staleness to be **derived at read time**.

Do not use commit recency — an agent thinking for five minutes is not offline, and that false
positive would let the reaper steal a live claim.

**Suggested, unproven — validate or replace it:** encode the timestamp in the ref *name*.

```
refs/heartbeats/<agent_id>/<unix_ts>
```

The agent creates the new ref then deletes the old one. `git ls-remote refs/heartbeats/*` or one
conditional API call returns every heartbeat with **no object reads at all** — the timestamp is
the ref name. Each agent owns its own namespace, so there is zero contention.

**Improved on by measurement — it does not have to be two pushes.** A single
`git push --atomic` performs the create and the delete together, so the two-ref window does not
exist:

```
git push --atomic origin $SHA:refs/heartbeats/$A/<new> :refs/heartbeats/$A/<old>
```

Measured over 80 reader observations across 5 concurrently-heartbeating agents, while a 20-way
claim race saturated the same remote: **always exactly one ref. Never two, never zero.**

Keep take-the-max at the reader regardless — it costs nothing and guards against a partial push
from an older client — but the transient is eliminated at the source rather than tolerated.

The timestamp is read **entirely from the ref name**, so no object is ever fetched to answer "is
this agent alive". That is the property that makes presence viable here.

If you find something better, say so in a commit message. If this cannot satisfy A9, that is a
real finding — report it rather than weakening the test.

## Everything else

| Concern | Mechanism |
|---|---|
| Event ledger | commits on `agentic/ledger`, **one file per event**, per `blackboard.md` |
| `seq` | ordering is by commit, not a counter. MB4 needs strictly ascending — design and probe it. |
| Idempotency | the event filename is the natural dedupe key. MB1a still applies: **scope it per project.** |
| File-scope locks | `refs/locks/<hash>` with the same create-if-absent lease |
| Contracts | already git — identical to the other two routes, no work |
| Tasks / board | GitHub Issues + labels. Consider whether GitHub Projects removes the need for a custom board. |
| Webhook | you may not need one: poll instead. If you do, GitHub Actions. |
| Auth | the user's own `gh` token. No new identity system. |
| Dashboard | `client/` as-is, with `store/github.ts`. Host on GitHub Pages. |
| Cost | **$0.** No billing account anywhere. |

## Provision your own

```bash
gh repo create Sibhimanyu/inventory-tracker-github --private \
  --description "Demo target for the GitHub-only route bake-off"
```

**Create only that.** Do not touch `inventory-tracker-catalyst` or
`inventory-tracker-firebase` — those belong to the other builds and a shared repo would corrupt
G1 and G2 for everyone. Delete nothing you did not create.

## Build order

1. `git fetch origin && git rebase origin/zoho-catalyst-app-builder` — pick up `shared/`.
   `npm test` must be **19/19** before you write anything. Do not fork the suite.
2. **Probe the two primitives concurrently.** Claim-by-lease under 20-way concurrency, and the
   heartbeat scheme. Record verbatim results in `docs/handoff/impl-github-notes.md` and push
   **before** building on them.
3. `store/github.ts` implementing `CoordinationStore`. Pass `shared/store/conformance.ts`
   **unmodified**.
4. CLI, ledger, locks, presence.
5. Wire `client/src/App.tsx` — one line, per `territory.md`.
6. F1–F12 on your own repo, then **G1–G6**.

## Where this route will probably lose, and that is fine

Say so plainly rather than hiding it. Likely: A9 presence is the hardest, `seq` ordering needs
real thought, and latency will be seconds not sub-second.

**Where it should win: setup cost.** Catalyst has no `project:create` at all — verified, and
`iac:import` needs a zip from `iac:pack` which needs a template from an async `iac:export` that
delivers to the console. Firebase needed a console visit plus a billing link. You need
`gh auth login`. Time that honestly for G4.

## Standing rules

Every order in `docs/orders/` binds you. Push after every commit. `--force-with-lease` after
every rebase. Never edit `docs/`, `shared/`, or the frozen `client/` paths — run the territory
check. Never read the other builds' branches. Write findings to your own notes; the coordinator
writes the register.
