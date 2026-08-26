---
order:    0019
to:       all
issued:   2026-08-26
blocking: yes
---

# The Cron→Job substitution is upheld. And a retry loop hides cost.

## RULING — the substitution was correct and the line is in the right place

A cron-type function is unreachable programmatically: 403 `HTTP Execution is not supported`,
`functions:execute` needs a local runtime binary, and the Job Scheduling API refuses it with
*"The given function is not a job function."* A Job function was substituted.

**Upheld.** And the distinction drawn from the Stratus refusal is exactly right, so it is now the
rule:

> A substitution is permitted **if and only if nothing measured or claimed changes.** The burden
> is on whoever substitutes: name what would change, and show that it does not. If the answer is
> "I am not sure whether this changes a measurement", the answer is **no** — stop and ask.

- **Stratus: refused.** The measured read path *is* route C1. Substituting would have produced a
  number that looks like evidence for a design nobody chose.
- **Cron → Job: permitted.** The reaper's schedule appears in no G-metric and F11's criterion —
  released within 15 minutes — is satisfied identically.

Now in `acceptance-checklist.md`. Two requests, two different answers, one test.

## THE MOST USEFUL FINDING SO FAR, and it is about method, not the platform

ZCQL **ignores an aggregate's column alias**. `SELECT MAX(seq) AS max_seq` returns
`{"events":{"MAX(seq)":"101"}}` — keyed by the raw expression, value a string.

`readMaxSeq` in the shared ZCQL layer already handled both shapes, because it had been written
against a *measured* response. The reaper carried a **hand-rolled reimplementation** that read
`max_seq`, got `undefined`, defaulted to 0, allocated `seq` 1, and collided with the first event
ever written.

Root cause named honestly by the build: duplicated logic that already existed in correct form,
and the duplicate was the broken one.

**Now the part that binds every route.**

`allocateSeqAndInsert` increments on collision, so a broken `MAX(seq)` read gets **absorbed** —
it walks up from 1 until it finds a free slot. Correct output, silently more expensive. The
identical bug in the reaper, which has no retry loop, **failed loudly and was found in minutes.**

Two consequences:

1. **A measured path working is not evidence that its sub-operations work.** The append path
   succeeding said nothing about whether its `MAX(seq)` read was correct.
2. **A retry loop is a correctness mechanism that doubles as a cost-hiding mechanism.** Any
   measured path containing one must have its per-operation cost verified independently — by
   instrumenting attempt counts, or by exercising the same sub-operations through a path with no
   retry. Otherwise a G4 figure is a **lower bound presented as a measurement.**

**Both builds have retry loops on the append path. Audit them before reporting G4 as final.**

Catalyst's G4 of 5 SELECT / 2 INSERT per append **stands** — the shared `readMaxSeq` was verified
against the real response shape. But it would not have been caught if it had been wrong, and that
is the point.

**Firebase: you have `withRetry` on the append path.** Instrument attempt counts and confirm your
per-operation figures are not absorbing a defect.

## Observability is worse than previously reported — register entry 19

`Get_Logs` returns `[]` for every function at every level and window tried. A deployed function's
console output is effectively **write-only**. Every wrong SDK init failed identically —
`FAILURE`, `response_code: "Code_Exception"`, no message, nothing in the logs — and two deploy
cycles went to distinguishing `initialize(jobRequest)` from `initialize(context)` by elimination.

Worth noting for everyone: the generated `types/job.d.ts` stated outright that `Context` is *"the
object used to initialize the Catalyst sdk"*. **Reading the generated types would have saved both
cycles.** When a platform's runtime errors are opaque, its type definitions are the next-best
oracle and they are already on disk.

## A workaround that must NOT be generalised

The fix — a `/health` endpoint surfacing reaper state through Cache, with failure detail riding
in `ReapResult` rather than only a log line — was right, and the reasoning is right: a failure
existing only in an unreadable log is a failure nobody can diagnose.

**It stays in the Catalyst tree.** Firebase has working Cloud Logging and needs none of it.
Mandating it on both routes would make Firebase pay for a Catalyst deficiency, **hide the
asymmetry inside the shared spec**, and distort G7 and G8 in Catalyst's favour.

General rule, now in the register: **a workaround for a platform deficiency stays in that
platform's tree.** If it lands in `shared/`, the deficiency stops being visible — and visibility
is the entire deliverable.

## Also recorded

Register entry 20: a function's type is **immutable**, so the deployed cron had to be deleted
before a job function of the same name could deploy. And "a Cron Function" is really **three
resources** — Job Pool, Cron, function — where the design named one.

## Do

**All:** rebase. Audit your append path's retry loop for masked per-operation cost before
reporting G4 as final.
**Catalyst:** proceed to `store/catalyst.ts` with `readSnapshot` and `subscribe` explicitly
stubbed and marked. The Stratus and Slate console visits are with the human.
**Firebase:** instrument `withRetry` attempt counts. Report G1–G6 in the same shape as
`docs/results/catalyst-run-1.md`, caveats above the numbers.
