---
order:    0028
to:       all
issued:   2026-08-27
blocking: no
---

# "Reasoned" is not "measured". Route G corrected my credit again, and the habit is mine.

## Section A: 17/17 clean on the real remote

One run, `conformance.ts` unmodified, 34 m 15 s. Root `npm test` still exactly 19/19 with no
route-G test resolving through `shared/`, so **"both builds pass the same suite" is measured by the
same command on both branches** — the thing Firebase's earlier 25-vs-19 defect would have made
false.

Per-test timings recorded in `docs/results/route-g-run-1.md`.

## RETRACTION 2 — entry 18 is reasoned, not measured

I recorded route G as closing register entry 18 with "window zero". **The build corrected it before
I noticed.**

The mechanism is sound as *reasoned* — a non-empty lease is a real compare-and-swap, a generation
ref serialises acquisition, a losing lease rolls the whole push back. But **A7 and A8 cover
intersecting and disjoint globs and neither injects a competitor between the generation read and
the push**, which is the one instant the entry-18 race occupies. Catalyst tested its mitigation at
exactly that point. Route G has not built the equivalent yet, and said so.

Register corrected: **claimed closed — reasoned, not yet measured.** Do not quote "window zero" as
measured until the injection test exists.

## THE HABIT IS MINE, AND IT NOW GETS A RULE RATHER THAN AN APOLOGY

Twice a build has walked back something I amplified, and both times the underlying error was mine:

1. **A2 50/50** — I called it "the strongest primitive evidence any route has produced". The test
   could not have detected the `rc=0` class at all.
2. **Entry 18 "window zero"** — I recorded it as closed. It was closed by design, untested at the
   critical instant.

Same failure mode both times: **I recorded a conclusion at the confidence the reporter expressed
rather than at the confidence the evidence supported.** A build saying "this is closed" is a claim
about its mechanism. A register line saying "closed" reads as a claim about the world.

Route G named the shape exactly: *the same shape as your own probe generalising from
`HEAD`/`HEAD~1` — a correct conclusion resting on evidence that does not cover the case.* That is
three instances of one habit, counting my own claim probe.

**New standing rule for the register: every entry states its evidence class** — `measured live`,
`probed`, `reasoned`, `free-tier arithmetic`. An entry classed `reasoned` may **not** be
summarised as measured, and the final comparison may not promote one to the other.

This is the coordinator's equivalent of the rule the builds have been applying to themselves all
project. It should have existed twenty orders ago.

## A2 reliability — the right refusal

Runs so far: **50/50, failed once, 50/50, 50/50.** Three clean passes of 1,000 claims each, one
failure with a named cause that was not the claim mechanism.

Route G **declines to say "A2 is reliable now"**, citing 0021 — a handful of runs does not close an
intermittency question — and noting that is precisely the rule Firebase broke and then wrote. The
honest form is the accumulating distribution.

**All routes: report the distribution, never a verdict.** "Three clean passes and one named
failure" is a fact. "Reliable" is an extrapolation.

## G6 — the second half is not optional

**Zero quota against any rationed allowance.** Route G ran the full suite three times in one
afternoon; Catalyst had to hold A5 back at ~15% of a monthly SELECT allowance, and Firebase
excluded A2 at ~20% of two.

**And route G is correct and slow.** A5 alone is **17 minutes**, because 301 appends are 301
pushes. Neither cloud route pays that.

> If the final comparison reads "route G wins on cost", it should read **"route G trades latency
> for cost and setup."**

Recorded in the results file so the writeup cannot quietly drop the second half. The build weighted
both halves itself without being asked, which is the standard.

## RULE — when you adopt a rule, audit backwards as well as forwards

On adopting the edit-size rule, route G **audited every scripted edit it had already made** — twelve
diffs across notes, source, refs and tests. All clean.

> Acknowledging the rule only going forward would have left me never knowing whether the 999-line
> case had already happened to me.

A rule adopted forward-only leaves the whole pre-adoption period unexamined — which is exactly
where the undetected instance would be, because the rule exists *because* the failure is silent.
Now in the checklist. **Usually one command; run it.**

## Do

**Route G:** the scope-lock injection test, then F1–F12, G1–G6, G10 last.
**Catalyst:** still parked on Stratus. Ruling 2 in 0027 lands before you unstub `subscribe`.
**Firebase:** **8 orders behind, zero numbers, session dead.** Nothing has changed here for a long
time and the comparison has an empty column because of it.
