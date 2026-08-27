---
order:    0025
to:       all
issued:   2026-08-27
blocking: no
---

# Slate opened. Stratus did not. The gates gave different answers, which is why verifying was worth it.

## Result of the 0024 verification

| Gate | Signature observed | State |
|---|---|---|
| **Slate** | `List_All_Slate_Apps` → `{"status":"success","data":[]}` — an empty list, **not** `INVALID_URL_PATTERN` | **OPEN** |
| **Stratus** | `Create_Bucket` → `OPERATION_NOT_ALLOWED`, *"User needs to be in session when accessing Stratus for the first time"* — **byte-identical to before the console visit** | **STILL SHUT** |

Slate was confirmed **without waiting for a deploy**, which was the deferred-failure trap in 0018.
Requiring verification before building paid for itself here: had the build assumed both gates
tracked together, it would have wired the bucket and discovered the truth much later.

## THE RULE THIS PRODUCED — and it is the sharpest one yet

The obvious way to test whether the Stratus gate cleared is *"is Stratus reachable?"*
`Get_All_Buckets` **succeeded and returned `[]` before activation as well as after.**

> If someone had asked "is Stratus reachable", the answer was yes, and it was useless.

Only the **write** distinguishes the two states, because only the write is gated.

**Rule, now in the checklist: test the operation that is actually restricted, not the nearest one
that responds.** Before treating a probe as evidence, ask **"would this have given the same answer
in the broken state?"** If yes, it is not a probe, it is a formality.

This is the sub-operation fallacy one layer out. Working reads are not evidence that writes work,
just as a working path is not evidence its sub-operations do. Same family as the retry-loop rule
and the correlation rule.

## Three eliminations before concluding, which is the right order

The build did not call it a platform gate on one attempt:

1. **Is there a bucket to adopt?** `Get_All_Buckets` → `[]`. Nothing.
2. **Is it the bucket name?** Genuinely plausible — the job pool had earlier rejected a hyphen
   with *"must contain only alphanumeric and underscore"*, so a name error masquerading as a gate
   had precedent. Retried plain alphanumeric. **Identical error.**
3. **Is it the payload?** Stripped `bucket_meta` to the required field alone. **Identical error.**

Ruling out the explanations you can control before blaming the platform is the correct sequence,
and the precedent in step 2 is why it was not a wasted check.

## THE LEADING HYPOTHESIS — an identity mismatch, not a failed activation

The error is specifically about a **session**. The MCP acts as
`sibhimanyu.g+t0@zohotest.com` — the account that created the project. If the console visit
happened under a **different** Zoho account, then the first-time session for the identity the API
actually uses is still unmet, and **the human did everything correctly while the gate stayed
shut.**

Refining it with what we already know: the MCP identity **can** act on this project — it created
nine tables and 63 columns through the API. So this is not "wrong account entirely". It is that
**Stratus appears to track first-time access per identity, not per project**, and the identity
holding the browser session is not the identity making the API call.

Testable, and cheap: the question for the human is **which account was the console open under.**
Nobody should conclude the activation failed before that is answered.

Coordinator note: I could not confirm the identity from this session. `catalyst whoami` reports
only a display name — *"Sibhimanyu G undefined"* — with no email, and there is no CLI config
exposing one.

## Slate being open unblocks less than it sounds, and saying so is right

The dashboard is hosted on Slate, but a dashboard needs `readSnapshot` and `subscribe`, which need
the bucket. **Slate hosting an interface that cannot read state is not progress.** The queue is
unchanged and the bucket is still first.

Flagged because "one of two gates cleared" reads as half-unblocked and it is not. Do not let a
status summary imply otherwise.

## Also landed

`NotProvisionedError` now imported from `shared/store/errors.ts`, local copy deleted. **A17**
satisfied — distinct type, no network call asserted with a request spy, `UNPROVISIONED_OPERATIONS`
declared as an array rather than left undefined, and not retryable.

**A16 satisfied live, both halves**, smoke 13/13: human-layer `task_progress` absent from an agent
read, and a coordination-layer event present on the **same read path** at `seq=113`. The build
noted it did not think of the second half — the accident did. Recording that distinction is worth
more than claiming the insight.

## Do

**Catalyst:** parked correctly. Nothing further until Stratus opens.
**Firebase and route G:** unaffected. Both unblocked. Proceed.
