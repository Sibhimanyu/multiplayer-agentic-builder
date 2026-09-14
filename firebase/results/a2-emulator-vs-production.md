# A2: emulator vs production. The discriminating experiment — order 0042

**Ruling: pre-registered branch 2 — A2 passes on production and fails only on the emulator.**
`attempts` was not raised. The retry design was not touched.

Every figure below is measured, on the host and backend named, per entry 30. Reproduce with
`firebase/a2-production.mjs` and `firebase/contention-probe.mjs`.

## The mechanisms are different, and the error text proves it

| | emulator | production Firestore |
| --- | --- | --- |
| concurrency control | **pessimistic locking with a lock timeout** | **optimistic concurrency** (server-side version check) |
| message on `ABORTED` | `Transaction lock timeout.` | `Aborted due to cross-transaction contention. This occurs when multiple transactions attempt to access the same data, requiring Firestore to abort at least one in order to enforce serializability.` |

Same structured `grpc_code: ABORTED`; different mechanism underneath. The hypothesis that
*"Transaction lock timeout" is emulator-specific wording for an emulator-specific mechanism* was
correct — and it was checked rather than assumed, because this project has been wrong about exactly
this shape before.

## A2 at its own specified load — 20 racers × 50 rounds

| run | result | contention retries | budget used |
| --- | --- | --- | --- |
| emulator, alone (fresh) | **PASS** 15/15, 216 s | 0 | 0 of 6 |
| emulator, alone (second run) | **PASS** 15/15, 231 s | 0 | 0 of 6 |
| emulator, 4 files sharing one process | **FAIL** 36/37 | — | exhausted |
| **production**, same sequence | **PASS**, round p50 1,976 ms / p95 2,190 ms / max 2,259 ms | **0** | **0 of 6** |

**Production takes zero retries at A2's load.** The adapter's contention budget is never entered.

## Forced contention — N concurrent `appendEvent` on one counter document

This is the load at which the budget is actually exercised. The counter document is what every
append in this design serialises on.

| N | backend | outcome | backoffs | worst attempt |
| --- | --- | --- | --- | --- |
| 64 | emulator | 64/64 resolved, 16.8 s | 0 | 0 of 6 |
| 256 | **emulator** | **247/256 REJECTED**, 138.6 s | 1,240 | **5 of 6 — exhausted** |
| 256 | **production** | **256/256 resolved**, 37.6 s | 333 | 4 of 6 — 2 unused |
| 512 | production | 243/512 rejected, 71.0 s | 1,895 | 5 of 6 — exhausted |

**At the identical 256-writer load the emulator drops 96% of writes and production drops none.**
The emulator is ~3.7× slower and breaks at roughly half production's concurrency. Production's own
limit sits between 256 and 512 concurrent writers on a single document — 12–25× the realistic
ceiling of this design, which is ~20 agents.

## Why the same bug showed up as three different tests

Three runs, three different failing tests — *"32 concurrent appends"*, *"A2 20 concurrent
claimTask"*, *"concurrent claims and appends together do not corrupt either"* — one error each time.
That is the signature of a **saturated shared backend**, not a defect in any one test: whichever
test is mid-flight when the emulator saturates is the one that fails.

The saturation has two routes into the suite, and the second was missed before:

1. accumulated degradation within one long-lived emulator process (already known, `310ca22`)
2. **`node --test` running files in parallel.** `--test-concurrency=1` is in the package scripts,
   but a bare `node --test a.ts b.ts c.ts d.ts` does not inherit it. That is precisely how order
   0042's failing run was produced, and how I reproduced it: 36/37, failing at
   `concurrency.test.ts:385`.

Run under the prescribed protocol — `store.test.ts` in its own emulator lifetime — the full set is
**37/37** (15 + 22).

## On `310ca22`

Order 0042 asked me to treat *"A2 was the harness, not the adapter"* as unsettled rather than as
established history. Re-examined rather than inherited, because it is a comfortable conclusion and
the chosen route had never actually passed the gate.

**It holds, and now has numbers instead of two clean runs.** One correction: that commit ruled out
test-file parallelism on the grounds that files were already serialised. They are — *in the package
scripts*. A direct `node --test` invocation is not covered, and that is the route both failing runs
took.

## What changed, and what deliberately did not

- **`attempts` is unchanged at 6.** Raising it until green is tuning to the test, and the evidence
  says the budget is not the defect: production absorbs A2 with the entire budget unused and
  absorbs 256 concurrent single-document writers with 2 attempts to spare.
- **The retry design is untouched** — structured-code detection and real-time backoff are both
  correct, as the order states.
- **`scripts/emul-suite.mjs` now refuses** to run `store.test.ts` alongside other files, and passes
  `--test-concurrency=1` unconditionally. The failure mode is no longer reachable by accident.
- **The suite says what it is worth**, in its own output: local green does not bound production, and
  local red may be local.

## One thing found on the way: `cap_ms: 2000` is dead configuration

`withContentionRetry` uses `backoffMs(attempt, { base_ms: 40, cap_ms: 2_000 })`. With 6 attempts
there are 5 backoffs, and the largest window is `40 × 2⁴ = 640 ms` — the 2,000 ms cap can never
bind. Confirmed empirically: observed maximum wait was **639 ms** on both backends.

Not changed, because changing it would alter behaviour without a stated reason and this order is
explicitly about not tuning. Recorded because it is a trap: anyone later raising `attempts`
believing the cap bounds the wait would get a much larger behavioural change than they expect —
attempt 6 would wait up to 1,280 ms, attempt 7 up to 2,000 ms, and only then would the cap engage.

## Not settled by this run

The withdrawn 1,955 ms contended-claim figure (order 0039) is worth revisiting: production's A2
round latency here is **p50 1,976 ms** for 20 concurrent claimants resolving, which is strikingly
close. That is suggestive, not a re-instatement — I have not confirmed the withdrawn figure measured
the same quantity, and it stays withdrawn until someone does.
