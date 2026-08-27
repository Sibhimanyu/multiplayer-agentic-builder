---
order:    0023
to:       all
issued:   2026-08-26
blocking: no
---

# Route G's probe corrected my probe. Three findings, one of them mine to own.

Route G is live on **`impl/github-v2`**, not `-v1`. Both were byte-identical at `3fb9169` with no
route-G work; the workspace was handed to it on `-v2` and told not to rename. `-v1` is abandoned
at the pre-work base — same treatment as `origin/impl/catalyst`. Results:
`docs/results/route-g-run-1.md`.

## MY ERROR — the naive push is not unconditionally unsafe

Order 0016 and the brief both said a plain push to an **existing** claim ref always succeeds,
citing `72d448f..3fb9169`. Measured properly:

```
challenger SHA is a SIBLING    -> ! [rejected] (non-fast-forward)   holder retained
challenger SHA is a DESCENDANT ->   c620ebe..aa35396                CLAIM SILENTLY STOLEN
```

My probe used `HEAD` and `HEAD~1` — two commits on **one line** — so I measured the descendant
case and generalised it to every case.

**The conclusion was right and the reason was wrong, and that is worse than being wrong outright.**
Believe "naive push always fails on an existing ref" and you conclude the naive form is *safe*,
because it visibly rejects, and you ship it. The descendant case is not exotic: an agent claiming
with its current branch tip, in a repo where agents share history, produces descendant SHAs
constantly. It is a claim-steal that appears only once two agents are on the same line of history
— the worst possible reproduction profile.

Fourth correction in this project traceable to **one probe generalised past what it measured.** The
others: `ROWID` monotonicity, `is_unique` scope, and Firebase's console gates. Same shape every
time.

## Three route-G findings the brief did not have

**1. The lease needs no prior fetch.** `--force-with-lease` normally wants a remote-tracking ref;
with an explicit *empty* expected value it does not. So `claimTask` is a single round trip with
**no read step and therefore no read-verify-write window at all** — verified against a client that
had never seen the ref. Neither cloud route achieves that: Catalyst carries a residual scope-lock
race, Firebase needs a transaction.

**2. `releaseTask` has a real vulnerability in the obvious form.** `git push origin :refs/claims/<task>`
lets **any agent release any other agent's claim**, rc=0. Release must be a lease **pinned to the
owner's sha**, which makes ownership server-enforced for free.

But: the pinned delete returns rc=1 for *both* "you do not own it" and "it was already gone", while
`store-interface.md` requires releasing a task you do not own to be a **no-op, not an error**. So
the adapter must **swallow** that rejection — and must **never** fall back to a plain delete to
force rc=0. **The fallback is the vulnerability.** That is a case where satisfying the contract
naively reintroduces the hole.

**3. Presence needs one push, not two.** The brief said create-then-delete is two pushes and told
readers to tolerate a two-ref window. `git push --atomic` does both together. Measured over 80
reader observations, 5 concurrent heartbeating agents, **while the 20-way claim race saturated the
same remote: always exactly one ref, never two, never zero.**

Take-the-max stays at the reader — costs nothing, guards against a partial push from an older
client — but the transient is now **eliminated at the source rather than tolerated.**

## A2 is the strongest evidence any route has produced

50 rounds, 20 concurrent claimants, `pass=50 fail=0`, against the **real** backend rather than a
double. And each round only passed if all three of: exactly one rc=0, the ref pointed at **that
winner's** commit, and all 19 losers reported a refusal rather than a crash.

That is order 0009's correlation rule applied without being told to.

## Provisioning — the number route G exists to produce

**One CLI command. Zero console steps. Zero accounts. Zero billing. Nothing blocked on a human.**

Against Catalyst's 3 manual gates and Firebase's 2. Larger than predicted, and register rows are
added showing all three side by side.

**Honest gap, declared rather than papered over:** the `gh repo create` wall-clock was lost because
the timing snippet used `date +%s%3N`, which macOS `date` rejects — it errored *after* the create
succeeded. Not re-measurable without creating a second repo, which the scope limit forbids. The
build declined to substitute a guess. Correct call; a missing number is better than an invented
one.

## Do

**Route G:** rebase — you are 4 behind, including `NotProvisionedError` in `shared/`, A16 and A17.
Then `store/github.ts` against `shared/store/conformance.ts` unmodified. `seq` ordering is your
next unproven primitive and it needs the same treatment you gave the other two: probe it, publish
the result, then build.

**Catalyst:** 2 behind. Still gated on the Stratus and Slate console visit, with the human.

**Firebase:** 3 behind. Still gated on the service-account key, with the human.
