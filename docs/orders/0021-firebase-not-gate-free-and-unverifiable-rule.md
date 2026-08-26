---
order:    0021
to:       all
issued:   2026-08-26
blocking: no
---

# Firebase was never gate-free — my error. Plus the rule three findings converged on.

## CORRECTION — register entry 17 was wrong in Firebase's favour

I had Firebase down as needing **zero** manual gates. Measured, it needs **two**: project
creation, and a **service-account key from the console** — because the machine has no Application
Default Credential and `gcloud` is absent, so the Admin SDK has no other way to authenticate.

Catalyst needs three. **The gap is one gate, not three.**

I got it wrong the same way twice before: **a claim inferred from a capability existing rather
than from anyone completing the task.** `firebase projects:create` exists, so I wrote "None"
without waiting for a deploy to finish. Third correction in this register, second against the
platform I was unconsciously favouring.

## THE UNIFYING RULE — unverifiable is not true

Three separately-found rules have converged, so the general form is now stated once in the
checklist.

Firebase found three of its own scripts reporting success from an unverified premise, **all
failing permissively**:

- a provisioning script concluded *"the name is free"* from a **failed parse**
- a test runner read `fail` and **ignored `cancelled`**
- a readiness probe asked *"is anything listening on 8080"* rather than *"is **my** backend
  listening"*, so overlapping runs silently shared one backend

Together with "missing is drift" and "a permissive default is invisible until it misfires":

> **Any check that cannot distinguish "verified true" from "could not verify" must fail.**

Not warn, not default, not proceed. Applies to guards, allowlists, readiness probes, parsers, and
any script whose exit code something else reads.

## A CORRECTION THAT REVERSES AN EARLIER REPORT — and this is the valuable part

Firebase previously reported A2 as flaky. **It has retracted that.** Every failure was its own
harness:

- the readiness probe collision above, so runs shared a backend
- teardown killed the process group without waiting for the socket, so back-to-back runs bound
  nothing and failed 13/15 in ~400 ms — which looked exactly like instability
- and it treated **two runs as sufficient on an intermittency question**, which is precisely the
  error it had itself written the rule about

Clean: 15/15, A2 in 206 s, plus an earlier 218 s. Two clean passes, every failure now with a named
cause that is not the adapter. **There is no evidence A2 is unstable.**

Retracting your own prior report is worth more than the finding it replaces. An uncorrected
"A2 is flaky" would have sat in the final comparison as a platform property when it was a
`kill -TERM` that did not wait for a socket.

## RETRY MASKING — order 0019 item 2 landed, and on the harness

`counts.transactions += 1` fired once per `runTransaction` **call**, but the SDK re-executes the
body on internal retry and the wrapper counted every attempt's reads and writes. So a row reading
"6 reads per append" was **indistinguishable from "2 reads, retried three times"**.

Fixed by counting body **executions** separately. G4 now carries `tx attempts` and `clean?`
columns, states in bold when figures are retry-inflated upper bounds, and reports adapter
contention backoffs for the whole run where zero means nothing is absorbing contention.

That is exactly what 0019 asked for, and it found a real defect in the instrument rather than the
thing being measured.

## SUB-OPERATION — the same shape as the `MAX(seq)` defect

```ts
const seq = ((snap.exists ? (snap.get('seq') as number) : 0) ?? 0) + 1;
```

`?? 0` collapsed three situations into one: fresh project (0 correct), counter document whose
`seq` field is missing or renamed (**0 silently restarts the ledger and duplicates every seq ever
issued**), and `seq` not a number. Extracted and both bad cases now throw, verified across eight
inputs.

Its own note is the right conclusion: A4 would probably have caught every event carrying `seq` 1,
but *"happens to fail loudly is luck, and the luck lasts until something downstream absorbs it."*

## REGION EQUALISATION — now required, and record it

Firebase was deliberately placed in `asia-south1` rather than accepting a US multi-region
default, because this machine and the Catalyst DC (`catalystserverless.in`) are both in India. A
US default would have added ~200 ms to every Firebase row and **flattered Catalyst's figures**.

Now in the checklist: region choice is permanent, determines G1 and G2, and must be stated
explicitly in your results file. A comparison where one route is 200 ms further away is not
measuring the platform, it is measuring the map.

## THE SHORTCUT REFUSAL WAS RIGHT, AND THE BOUNDARY WAS DRAWN CORRECTLY

`firebase-tools`' config holds a cloud-platform scoped refresh token the Admin SDK would accept —
but it reaches **all nine projects**, including the eight under standing orders as off-limits.
Declined on least privilege.

And it said this is not something a coordinator can authorise. **Correct.** I cannot widen access
to a person's unrelated projects, and a peer asking me would not make it authorised. It went to
the human, which is the only place it could go.

Also right: refusing to quote the 70–90 ms permission-**denied** round trips as latency. They are
a floor on network RTT and nothing more.

## Do

Nothing blocking. Both routes are now stalled on one console action each, both with the human.
