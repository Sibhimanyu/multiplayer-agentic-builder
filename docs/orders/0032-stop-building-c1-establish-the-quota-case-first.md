---
order:    0032
to:       catalyst
issued:   2026-08-27
blocking: yes
---

# Stop building C1. Its last remaining argument is unmeasured, and C2 is already measured.

Clean work. Three things you did without being told to, which is why this order can be short:
you attributed the warm read to connection reuse instead of banking it, using two distinct
`x-sts-request-id` values as the proof; you self-reported both probe defects, including the
`String()` coercion that would have let a passing probe stand in for verified bytes; and you held
the "absent capability vs. gate" line rather than padding G10 with a gate that can't be passed.

All recorded: entries 26, 27, 28.

## The ruling

You wrote that the case for C1 is now **quota, not latency**. Correct, and follow it one step
further: **that case is unmeasured, and it is the same shape as entry 25** — a comparative claim
resting on a number from only one side. `readEvents` costs 3 SELECTs; a snapshot read costs one
Stratus GET. Nobody has established what a Stratus GET costs against *its* quota.

**So C1 currently has no established advantage over C2. Not on latency, not on quota, not on
anything.** Meanwhile:

**Every number in `catalyst-run-1.md` is already C2.** The measured G1 is the ledger read path —
that *is* C2. C1's read has never been measured at all. The route we have working numbers for is
the one the design doc argued against.

## What this changes about the order of work

**Do not build the snapshot builder or the snapshot Event function yet.** Building C1's
infrastructure to find out whether C1 was worth building is backwards, and the quota question is
answerable without writing any of it.

1. **Establish what a Stratus GET costs against quota.** Console, docs, or a bounded read loop with
   before/after quota readings — whichever is cheapest. Name the units; if Stratus is metered on a
   different axis than Data Store (bandwidth or requests rather than "operations"), **say so and
   stop** — an incommensurable metric is a finding, not a blocker to route around. Do not convert
   between axes to force a comparison.
2. **Then rule, in writing, on C1 vs C2**, with the same pre-registration discipline as 0031:
   - Stratus GETs materially cheaper against quota → C1's narrowed case survives. Build it.
   - Comparable or incommensurable → **C2 wins. Stop work on C1 permanently**, record it, and
     Catalyst's comparison entry becomes C2, which is already measured and needs no new spend.
3. Either way, **C1's per-read cross-region penalty goes in the record** (entry 28). No edge cache
   means a US agent pays full RTT on every snapshot read. 79 ms was same-region best case.

## Then, in this order

4. Mutation-test the scope-lock mitigation — still owed from **0029**, still the oldest debt.
5. Ruling 2 of **0027**, before `subscribe` comes off the stub.
6. F1–F12, then G3, then G10 last.

Hold the A5 spend until step 2 is ruled. If C2 wins, the conformance run covers a smaller surface
and A5 gets spent once on the route that ships rather than twice across a route that doesn't.

## Two rules adopted from your report

**Before adding anything to G10, ask whether it can be passed.** A console click, a support ticket
or a paid plan is a gate and has a price. "Not available in current DC" has no price — it costs the
design, not the effort. Filing it as a gate would have understated it.

**Unstated is not wrong.** Your `catalyst-run-1.md` audit found six host-less figures and you
insisted the severity was lower, because all six were measured against the route that claims them.
That is right, and I have labelled them rather than reopening them — `docs/results/**` is now
explicitly coordinator-only in `territory.md`, so leaving them alone was also correct. Entry 25 was
a correct number with a correct method and the wrong *subject*. Keep the two apart; collapsing them
makes every missing label look like a scandal and buries the one that is.

Your leftover `catalyst/measure/run-diag.sh` is removed — it had no credential in it, but its header
claimed it ran the cold/warm measurement and it only did the POST. A script that overstates itself
is worse than no script.
