---
order:    0033
to:       firebase
issued:   2026-08-27
blocking: yes
---

# Zero numbers, 13 orders behind. Numbers first — and not from the emulator.

You are the only route with **no measurements at all.** Catalyst has G1/G2/G4/G5/G6; route G has
17/17 on section A. This is a three-way comparison in which one side has never been timed, and that
is now the largest hole in the entire exercise — larger than any conformance gap.

Read orders **0020–0032** before working. Do not skim 0031 and 0032; they contain the rule that
would invalidate your numbers if you miss it.

## Read this before you measure anything

Your history shows the shared suite being pointed at an emulator, including one run against a
*foreign* emulator that produced a false A2 diagnosis you correctly retracted.

**Emulator numbers are not numbers.** Reporting them as G1–G6 would be exactly the error that just
cost route C1 its architecture — order 0031, register entry 25: a real figure, measured with a sound
method, against **the wrong system.** The Firestore emulator is in-process and has no network, no
replication and no contention model. It cannot produce a latency comparable to anything.

**Every G-series figure must come from real Firestore in the real project.** The emulator stays for
correctness tests, where it is the right tool, and never appears in a results table.

## Comparability — same-region on both sides

Catalyst's numbers are the IN data centre measured from Asia/Kolkata: same-region, best case. Yours
must match that shape or the comparison is worthless.

- Firestore in **`asia-south1`**, client in **Asia/Kolkata**.
- **Every figure names its host and region** — entry 25's rule, retroactive and non-negotiable. A
  table headed only "measured" is what caused this.
- If your database is not in `asia-south1`, **stop and report it** rather than measuring anyway or
  migrating it. A region mismatch is a finding; silently comparing across regions is not.

## Credentials

```
GOOGLE_APPLICATION_CREDENTIALS=~/.config/multiplayer-agents/firebase-adminsdk.json
```

Mode 600 in a 700 directory, scoped to `multiplayer-agents-eec02` only. **Never** copy it into the
worktree, never `cat` it, never put it in a commit or a report. The eight pre-existing Firebase
projects remain off-limits — not readable, not selectable.

## Work, in this order

1. **G1** — `appendEvent` p50/p95, and publish→visible, n=100. Report the cold first call separately
   and never fold it into the percentiles.
2. **G2** — claim round-trip, n=200, contended. Report p50/p95/**p99/max**. Catalyst's max was
   1,186 ms against a p95 of 182 ms and it was *not* averaged away; a claim that occasionally stalls
   over a second is user-visible. Do not report a mean.
3. **G4/G6** — operation cost per request, and quota consumption as a percentage of the free tier.
   Catalyst measured **zero UPDATEs** by design. State what your presence path costs — if it writes
   on every heartbeat, that is the asymmetry, and it belongs in the register whichever way it falls.
4. **G5** — free-tier runway for 2 people light, 2 active, 10 active. Catalyst got ~17 days and
   ~3.3 days for the latter two. Arithmetic is a valid evidence class; label it as such.
5. **Then** F1–F12, then G3, then G10.

## Methodology you missed, condensed

Read the orders for the reasoning; these are the operative rules.

| Rule | Order |
|---|---|
| Check edit **size** with `git diff --stat` before committing — a regex once silently deleted 999 lines | 0026 |
| Grep for NUL bytes pre-commit; two once survived into a template literal, compiled, and passed tests | 0026 |
| **`rc=0` is not a verdict.** Read structured fields, never exit codes, never matched error strings | 0027, 0019 |
| **Reasoned is not measured.** Label every claim's evidence class; a plausible mechanism is not a result | 0028 |
| **Mutation-test before claiming a race is closed** — separate the outcome claim from the causal claim | 0029 |
| **Every latency figure names its host.** Not just its evidence class | 0031 |
| **Absent capability ≠ gate.** A gate can be passed and costs effort; an absent capability costs the design | 0032 |

## One correction that was in your favour

Register entry 17 credited this route with **zero manual gates**. Wrong. It has **two** — project
creation, and a service-account key downloaded from the console, because there is no Application
Default Credential on this machine and `gcloud` is absent, so the Admin SDK cannot authenticate any
other way. Corrected 2026-08-26. Flagging it because errors that flatter your own route are the ones
you are least likely to catch, and a comparison that only corrects against you is not a comparison.

Do not run anything that incurs meaningful spend without saying so first. Billing is linked, which
means mistakes now cost money rather than failing closed.
