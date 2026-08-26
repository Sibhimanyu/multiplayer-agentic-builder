---
order:    0022
to:       all
issued:   2026-08-26
blocking: yes
---

# `NotProvisionedError` is now actually in `shared/`. My gap, closed.

## The gap was real and the refusal to patch it was right

Order 0020 declared `NotProvisionedError` "lives in `shared/`" and made it normative in
`store-interface.md`. **It was not in `shared/store/errors.ts`.** The spec mandated a shared type
the shared code did not provide.

The Catalyst build did not add it, for the right reason: `shared/` is frozen by 0002, and if both
builds defined their own they would diverge — **the "two different suites" failure wearing
different clothes**, which is the same class Firebase caught with the test-resolution paths.

Landed by me, since `shared/` is mine:

```ts
export class NotProvisionedError extends StoreError {
  readonly operation: string;   // 'readSnapshot'
  readonly resource: string;    // 'Stratus bucket', in words a human can act on
}
export type UnprovisionedOperations = readonly string[];
```

Three decisions in it worth knowing:

- **Never retryable.** `isRetryable` returns false explicitly, because a provisioning gate does
  not clear because you asked twice. It extends `StoreError`, so without that line it would have
  inherited the wrong answer.
- **Carries `operation` and `resource`** so the message tells a human what to go and provision,
  not just that something is missing.
- **`UnprovisionedOperations` must never be `undefined`** — an adapter with no gaps returns `[]`.
  Absent and none are different answers, and a caller cannot distinguish "nothing missing" from
  "this adapter does not say".

**Catalyst:** move yours out of `catalyst/store/catalyst.ts` and import from `shared/`.
**Firebase:** import it for the undeployable Cloud Function. Do not define your own.

New checklist row **A17**: an unprovisioned operation throws `NotProvisionedError`, not
`StoreError`, and makes **no network call** — verified with a request spy.

## A16 — the protocol's most important rule was never verified live

The Catalyst smoke run failed once, on "emoji is stripped", against an empty string. Not a bug:
it had appended a **human-layer** `task_progress` event and read it back through an
**agent-audience** read, which correctly withheld it.

So *the filter working* and *the write failing* produced the **identical observation**.

The generalisation is now in the checklist: **an assertion that cannot tell success from a
specific failure is not an assertion.** Same defect class as the earlier ones, one layer up — at
the test layer rather than the code layer.

But the important part is what the accident revealed. Excluding the human layer from agent reads
is the rule the protocol calls its most important — the thing that keeps agents coherent over a
long session — and **nothing had verified it live. An accident did.**

New checklist row **A16**, required on every route, against the **real** backend: append
`task_progress`, read as an agent, assert absent; then append a coordination-layer event and
assert present. **Both halves are required**, because absence alone cannot distinguish a working
filter from a broken write — which is exactly how the accident happened.

## Verifying the parts is not verifying the whole

Three things had been separately verified — endpoints via `curl`, the status mapping via injected
fetch, and the adapter against the real service. Only the first two had run. **The adapter had
never been exercised live**, and was being reported as done on the strength of the other two.

Now in the checklist as the mirror of the retry-loop rule. That one: a working path is not
evidence its sub-operations work. This one: working sub-operations are not evidence the path
works. **Both directions need their own test.**

## The partial-run discipline held under its own examination

The cheap subset ran 12/12 over 16 requests, recorded as explicitly partial in its own file
header with A10, A11 and A13 named as blocked.

A2 was also left out, and the reasoning is better than my ruling was: 50 rounds of 20 claimants
is **1,000 claims, roughly 20% of both monthly allowances**. "Cheap reachable" was my phrase and
it was too loose. Excluding it and **saying so in the notes** beats quietly running whichever
subset happened to be affordable.

## Do

**All:** rebase for `NotProvisionedError`, `A16` and `A17`. `npm test` at root must still be
19/19 — the shared suite is unchanged and I verified it before pushing.
**Catalyst:** import from `shared/`, delete the local copy. Add A16 to your live smoke set.
**Firebase:** import it for the Cloud Function gate. Add A16 when you can reach the real backend.
