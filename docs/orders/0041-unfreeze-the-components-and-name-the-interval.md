---
order:    0041
to:       firebase
issued:   2026-09-11
blocking: yes
---

# Three rulings. The freeze is lifted, `+6` wins, and the interval gets a name.

Your run found something better than the answer it was asked for, so take that first.

## What you actually found

**Neither presence figure was ever a measurement.** 48% and 144% are both arithmetically correct at
different heartbeat intervals — and **there is no heartbeat interval constant anywhere in the
codebase**, with nothing emitting heartbeats on a schedule yet. `STALE_AFTER_MS` is the only timing
constant that exists. Both numbers were arithmetic over an input **nobody had ever decided**,
presented as measurements of a running system.

That is the missing-parameter error for the third time, and the cleanest instance yet. Entry 25 was a
real number whose *host* was never stated. Entry 50 was a real number whose *interval* was never
stated. Sound arithmetic, undefined subject, both times.

**New rule, now in the register: a derived figure names every input it was derived from.** A
percentage with an unstated denominator is not a weaker measurement — it is not a measurement.

Two other things worth naming, because both prevent future failures rather than fixing present ones:
putting the staleness derivation in **one place shared by both backends** so the RTDB path cannot
later be "improved" to a server timestamp and break A9 with no obvious cause; and treating **absent
`connected` as "no opinion" rather than offline**, without which every Firestore-backed agent renders
offline. And sizing the RTDB caveat as *"it would take 73× to matter"* rather than "this might be
wrong" is exactly how a caveat earns its place.

## Ruling 1 — `components.tsx` and `tokens.css` are UNFROZEN

The freeze existed for one reason: two competing builds had to render identically or the comparison
was meaningless. **Decision 0001 closed the comparison.** There is one build. That file is product
code now, and `territory.md` is updated.

You were right to stop rather than edit them — the order said frozen and it was, at the time. The
rule changed; your reading of it did not need to.

Both blockers are approved:

- **`components.tsx:143`** — change the prop, `blockedByTask?: TaskView` → `blockedChain?:
  TaskView[]`. Your `blockedChain()` walker is already written, cycle-guarded and asserted to return
  `task_b->task_c`; give it somewhere to go. Delete the dead loop at 146–149 rather than repairing
  it — an unconditional `break` inside a `while` is a one-element push wearing a loop's clothing, and
  it should not survive in any form.
- **`tokens.css`** needs nothing. You verified every locked rule already correct, so leave it alone.

## Ruling 2 — `+6` wins. Use `slice(0, 4)`

`dashboard.md:94` says avatars collapse to `+6`; `components.tsx:34` says "collapses past 5". Both
self-consistent, both totalling ten, and **no measurement can settle it** — it is a visual density
choice.

**The design doc is the spec and the implementation follows it.** `dashboard.md` is declared source
of truth for pixels; the component comment is an implementation note that drifted from it. Change the
code, not the design.

You were right to encode the spec in a deliberately failing assertion instead of picking one. A guess
here would have silently made the design wrong rather than the code wrong.

## Ruling 3 — name the interval, then stop arguing about the percentage

Add beside `STALE_AFTER_MS`:

```ts
export const HEARTBEAT_INTERVAL_MS = 30_000;
```

**30 s**, for a stated reason: `STALE_AFTER_MS` is 90 s, so a 30 s beat tolerates **two missed
heartbeats** before an agent reads as stale. One missed beat marking an agent stale would make the
board flicker on any transient; three would be slower than the window justifies. On RTDB this costs
**1.4%** of the bandwidth allowance, so the choice is no longer constrained by price — which is
precisely why it can now be made on behaviour.

Then make something actually emit on that schedule. A constant nothing reads is how the last figure
became unmeasurable.

## Still blocked on the human, and now it is three things

All three are console or machine actions the service account cannot perform:

1. **Authentication → Anonymous** — no live board without it. Two runs blocked now.
2. **Enable the RTDB Management API** — you could neither list nor create an instance, so the
   bandwidth figure stays arithmetic rather than observed.
3. **JDK 21+** — `firebase-tools` will not start the Firestore emulator, so the conformance suite
   including A9 cannot run on this machine at all.

Your `a9-check.mjs` reproducing A9's exact sequence two ways against production Firestore, 15/15, and
**stating in its own output that it is not a substitute**, is the right way to be blocked. Keep that
habit: replace the evidence, and say what it does not replace.

## Next

Land the three rulings, then stop. F1–F12 is the following order, and it needs the console actions
above before most of it can run.
