# Route G (GitHub-only) — measured, run 1

Recorded by the coordinator from the route G build's report, 2026-08-26. Branch
**`impl/github-v2`** (not `-v1` — see below), tip `5111bf8`.

All probes ran against the **real** GitHub remote, not a double. Every probe ref was deleted
afterwards.

## Branch name

The brief and order 0016 both name `impl/github-v1`. The workspace was handed to the build
already on `impl/github-v2` and it was told not to rename. Both were byte-identical at `3fb9169`
and neither carried route-G work. **`impl/github-v2` is live; `impl/github-v1` is abandoned at the
pre-work base.** Same treatment as `origin/impl/catalyst` — not pushed to, not deleted.

## Provisioning — the headline

| Step | Command | Console steps |
|---|---|---|
| Auth | none, `gh` already authenticated | 0 |
| Backend project | **none exists — GitHub *is* the backend** | 0 |
| Billing | none | 0 |
| Demo repo | `gh repo create … --private` | 0 |

**One CLI command. Zero console steps. Zero new accounts. Zero billing. Nothing blocked waiting
on a human.**

Against Catalyst's **3** manual gates (project, Stratus, Slate) and Firebase's **2** (project,
service-account key). This is the asymmetry route G exists to demonstrate, and it is larger than
predicted.

**Honest gap, declared:** the `gh repo create` wall-clock was lost — the timing snippet used
`date +%s%3N`, unsupported by macOS `date`, which errored *after* the create had already
succeeded. Not re-measurable without creating a second repo, which the scope limit forbids. The
build declined to substitute a guess.

## A2 — atomic claim. 50/50 against the real backend.

```
rounds=50  agents=20  pass=50  fail=0  total_wall_s=361.4
```

A round counted as PASS only if all three held (order 0009, correlation not count):

1. exactly one of 20 pushes returned rc=0,
2. `refs/claims/<task>` pointed at **that winner's** commit, not merely at *a* commit,
3. all 19 losers reported `rejected` — a refusal, not a crash.

~~This satisfies A2 and the non-negotiable "A2 passes 50 consecutive runs". Strongest A2 evidence
of any route so far.~~

> **CAVEAT ADDED 2026-08-27 — do not quote the 50/50 without this.** The build later found that
> **`rc=0` does not mean "I won"**. Pushing a sha to a ref that *already equals that sha* is a
> no-op: `Everything up-to-date`, `rc=0`, and **the lease is never evaluated**.
>
> Probe A did not expose it because every agent there carried a distinct commit message. **The bug
> was invisible to the very test meant to prove the mechanism.**
>
> Had the adapter been written the way probes B, E and J were — pushing a fixed base sha for
> convenience — every concurrent claim would return `rc=0`, every agent would believe it won, and
> **A2 would still pass 50/50**, because A2 counts `ok:true` results and they would all be true.
>
> The 50/50 remains true *for the commits used*. It is **not** evidence that the mechanism
> discriminates, because the test could not have detected this failure class. Fixed by deciding on
> the `--porcelain` status character (`*` new reference vs `=` up to date, identical `rc`) **and**
> making the claim object unique per `(agent, task)` — both, because the first is what a refactor
> breaks silently.

I amplified the uncaveated version in order 0023 and called it the strongest primitive evidence of
any route. That was my error to record, and this correction is the build's, not mine.

## CORRECTION to the brief — the naive push is not unconditionally unsafe

My probe claimed a plain `git push origin <sha>:refs/claims/<task>` to an **existing** ref
succeeds, citing `72d448f..3fb9169`. Measured properly:

```
D1  challenger SHA is a SIBLING of the holder's
    ! [rejected] (non-fast-forward)     holder retained

D2  challenger SHA is a DESCENDANT of the holder's
      c620ebe..aa35396                  >>> CLAIM SILENTLY STOLEN
```

**The conclusion was right and the reason was wrong, and the difference is dangerous.** My probe
used `HEAD` and `HEAD~1` — two commits on one line — so I measured the descendant case and
generalised it to "any existing ref".

Believing "naive push always fails on an existing ref" leads to the opposite conclusion: that the
naive form is *safe*, because it visibly rejects. And the descendant case is not exotic — an agent
claiming with its current branch tip, in a repo where agents share history, produces descendant
SHAs constantly. It is a claim-steal that appears only once two agents are on the same line of
history: **the worst possible reproduction profile.**

Two design consequences the build drew:

- Claim commits must be **fresh commits built for the claim** (`git commit-tree` off a fixed
  base), never the agent's working branch tip — which makes all claim commits siblings.
- **The adapter uses the lease regardless**, because "siblings by construction" is an invariant a
  future refactor can quietly break, and the lease does not depend on it.

## The lease needs no prior fetch — a genuine advantage

`--force-with-lease` normally needs a remote-tracking ref. With an explicit **empty** expected
value it does not:

```
D4  client has NEVER seen the ref, 0 local remote-tracking refs
    ! [rejected] (stale info)     >>> rejected without any prior fetch
```

So `claimTask` is **a single network round trip with no read step, and therefore no
read-verify-write window at all.** Neither cloud route achieves that: Catalyst carries a residual
scope-lock race it can narrow but not close, Firebase needs a transaction.

## `releaseTask` — a trap the brief missed

The obvious release, `git push origin :refs/claims/<task>`, **lets any agent release any other
agent's claim, returning rc=0.** Release must be a lease pinned to the owner's sha.

```
D5  non-owner delete, lease pinned to a sha it does not hold
    ! [rejected] (stale info)     holder retained
    owner delete                  - [deleted]  rc=0
```

Two consequences:

- **Ownership on release is server-enforced for free** — neither other route gets that from its
  primitive; both check it in application code.
- The pinned delete returns rc=1 for *both* "you do not own it" and "it was already gone". Since
  `store-interface.md` requires releasing a task you do not own to be a **no-op, not an error**,
  the adapter must **swallow** that rejection. It must **not** fall back to a plain delete to
  force rc=0 — that fallback *is* the vulnerability.

## Presence — the brief's known weak spot, improved on

The brief proposed create-then-delete as two pushes, warning readers to tolerate a two-ref window.
**It does not have to be two pushes:**

```
git push --atomic origin $SHA:refs/heartbeats/$A/<new> :refs/heartbeats/$A/<old>
 - [deleted]        …/<old>
 * [new reference]  …/<new>
rc=0
```

Measured over **80 reader observations, 5 concurrently-heartbeating agents, while the 20-way claim
race saturated the same remote**:

```
80 refs=1        never two, never zero
```

Take-the-max remains the right reader implementation — it costs nothing and guards against a
partial push from an older client — but **the transient is eliminated at the source rather than
tolerated at the reader.** Zero heartbeat pushes failed across both probes.

## A9 — and the test discriminates

Asserting "all agents eventually go stale" passes on a broken reader that marks *everything*
stale. So: three agents, 20 s timeout, one killed at t=12 s, assert **only that one flips**.

```
19s  e1=live(5s)   e2=live(5s)   e3=live(12s)
28s  e1=live(7s)   e2=live(7s)   e3=STALE(21s)
73s  e1=live(8s)   e2=live(8s)   e3=STALE(66s)

PASS — exactly the stopped agent flipped, live agents unaffected
```

Zero false positives across the full 73 s window.

The timestamp is read **entirely from the ref name** — `git ls-remote` returns `<sha>\t<refname>`
and the reader parses the path. **No object is ever fetched to answer "is this agent alive."**
That is what makes presence viable here, and why commit-recency is not needed.

A heartbeat costs **one ref update and zero rows**, with a storage footprint of exactly one ref
per agent forever, because the old one is deleted in the same atomic push. The interface
constraint — "MUST NOT cost a durable row UPDATE per call" — is satisfied more cheaply than
either cloud route manages.
