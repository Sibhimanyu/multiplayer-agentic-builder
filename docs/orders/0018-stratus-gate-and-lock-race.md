---
order:    0018
to:       all
issued:   2026-08-26
blocking: no
---

# The Stratus gate is real and correctly not worked around. A second gate is waiting.

## Refusing to work around it was the right call

Stratus first-time bucket creation requires a browser session:

```
Create_Bucket -> OPERATION_NOT_ALLOWED
  "User needs to be in session when accessing Stratus for the first time"
```

`Get_All_Buckets` succeeds and returns `[]` on the same credentials, so reads are permitted and
only first-time creation is gated. **There is no `stratus` command in the CLI** — verified — so
no non-browser path exists.

The Catalyst build refused to substitute Filestore or Cache, and its reasoning is the standard
for all three routes:

> A workaround would leave me reporting numbers for a design I invented to dodge a provisioning
> gate, presented as if it were the design under test.

**The measured read path *is* route C1.** Snapshot-via-CDN at 34 ms against 1,347 ms for git is
the entire reason C1 was chosen over C2. Swapping the storage layer and reporting the result as
C1 would have produced a number that looks like evidence and is not. Being blocked visibly beats
being wrong invisibly.

**Standing rule: never substitute a component that is part of what is being measured.** If a
provisioning gate blocks the design under test, report the gate.

## A second gate is waiting, and it fails later and more confusingly

One-time console activation is a **documented Catalyst pattern**, not a Stratus quirk — Slate,
Signals and SmartBrowz all carry it.

**Slate needs it, and the dashboard is hosted on Slate.** Worse, the failure is deferred:

> `slate:create` runs locally and succeeds without activation — the first backend call happens
> at deploy time, which fails with `HTTP 400: Please access the Slate service in your project's
> console before deploying`

So local scaffolding will look fine and the deploy will fail. Both gates have been raised with
the human as **one console visit** rather than two round trips.

**Running total of manual gates for route C1: three.** Project creation, Stratus activation,
Slate activation. Register entry 17. Everything else — nine tables, 63 columns, the function
deploy, 300 measured requests — was CLI or API.

## Scope locks cannot be made atomic. That is entry 18 and it is the largest asymmetry yet.

Without transactions, the glob-intersection check and the lock INSERT are separate operations,
and `is_unique` on the lock key cannot stop two agents with *overlapping but non-identical*
globs both passing the pre-check in the same instant.

The mitigation is right, and one detail in it is the actual fix: **a deterministic tie-break**,
lower `lock_key` wins, so both racers compute the same comparison from the same data and exactly
one concludes it lost. A naive "on conflict, back off" would have both yield and **neither** hold
the scope — worse than the race it was meant to solve. Tested from both sides by injecting a
competitor between the pre-check and the re-check.

**Why this is bigger than the composite keys.** Entry 2 cost a naming convention: annoying,
solvable, provably correct once built. Entry 18 costs a **residual correctness window** that can
be narrowed but not closed, because the primitive needed to close it does not exist. Firestore
closes it with one `runTransaction`.

When the final comparison is written, "needed a workaround" and "cannot be made correct" must not
end up in the same column.

## Two judgement calls, both ruled correct, both the same shape

- **A presence value with no usable timestamp is ABSENT, not live.** Defaulting to "now" would
  make a dead agent look alive.
- **An unparseable `globs` column is `['**']`** — a lock on everything, so it conflicts loudly.
  Treating it as `[]` would silently disable the check the table exists for.

Both fail toward the safe answer for the question being asked. **All routes: when a value is
unreadable, fail in the direction that is loud rather than the direction that is convenient.**

## Sequence confirmed: reaper next, not the CLI

Asked and answered. The reaper needs no Stratus, completes the presence story just built, and
unblocks A9. The CLI is a client of a store whose `readSnapshot` and `subscribe` are stubbed, so
building it now means building against stubs and retesting after the gate clears. Reaper, then
`store/catalyst.ts` with the stubs explicitly marked, then the CLI.

## Also worth keeping

Snapshot fold orders by `seq` and **only** `seq`, with a test placing two events at the same
timestamp in opposite seq order and asserting the higher seq wins. That test exists *because*
`created_at` is second-resolution, so a batch shares one timestamp — ruling 2 in order 0017 is
what makes ordering-by-seq safe, and this test is what makes it true rather than assumed.

`snapshot.seq` is the highest seq **applied**, not a count of events read, because that is the
value a caller compares `last_written_seq` against. Getting that wrong would break MB5.
