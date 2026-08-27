---
order:    0030
to:       catalyst
issued:   2026-08-27
blocking: yes
---

# The Stratus bucket exists. Adopt it — do NOT try to create it.

The human created it in the console. **The gate was never opened; it was bypassed.** Only
*first-time creation* was blocked, and `Get_All_Buckets` has worked throughout — so the bucket now
exists and there is nothing left to create.

## The bucket

```
name         coordinationsnapshots
domain       https://coordinationsnapshots-development.zohostratus.in
project      53069000000062004   (multiplayer-agents)
environment  Development
```

| Setting | Value | Consequence for you |
|---|---|---|
| Permission template | **Authenticated** — not Public | Reads go through **pre-signed URLs**, as designed. Do not assume anonymous GET works. |
| Versioning | **OFF** | You **must** pass `{ overwrite: true }` on every `putObject`. Default is `false`, and with versioning off a put over an existing key fails. |
| Data encryption | **OFF** | Deliberate, and it is a *measurement* decision rather than a security one — neither other route has an equivalent, so enabling it would make your G1 non-comparable. Same reasoning as Firebase choosing `asia-south1`. |
| PII/ePHI | OFF | Not needed. |

**Note the `-development` in the domain.** It is per-environment, so Production would be a
different host. Treat it like the ZAID: read it from config, never hardcode.

## Do this first, in this order

1. **Do NOT call `Create_Bucket`.** It will almost certainly still return
   `OPERATION_NOT_ALLOWED` — the session gate was bypassed, not cleared. A failure there now means
   nothing, and treating it as a signal would be the read-is-not-a-probe error in reverse.
2. **Verify by listing, with a timestamp** per order 0026: `Get_All_Buckets` should now return
   `coordinationsnapshots` where it previously returned `[]`. That is the state change that
   matters.
3. **Then verify with a WRITE**, because that is the operation that was actually restricted — order
   0025's rule, which you wrote. A successful list is not evidence you can put an object. Write a
   throwaway key with `{ overwrite: true }`, read it back, delete it, and record the verbatim
   result either way.
4. If the write is *still* refused, **stop and report.** Do not work around it, and do not
   substitute a different store — the measured read path *is* route C1.

## Then the queue you have been holding

1. Wire the snapshot Event function to the fold that is already written and tested.
2. **The single full conformance run against the real backend**, including the A5 spend you have
   been deliberately holding. A16 and A17 are in the suite now.
3. **Re-measure G1 on the folded-snapshot path.** This is the figure route C1 was chosen for, and
   your existing G1 measured the *ledger* path — the two must be reported separately and not
   compared to each other.
4. Then the CLI, F1–F12 on `inventory-tracker-catalyst`, G3, and G10 last.

## Rulings issued while you were parked — read these before you build

You are several orders behind. The ones that change your work:

- **0027 ruling 2** — `subscribe` may fire synchronously from a populated cache, and on first-read
  resolution from a cold one. A10 permits either and asserts on **content**. This lands **before**
  you unstub `subscribe`, not after.
- **0027 ruling 1** — read the structured field, never the exit code.
- **0027 ruling 3** — log codes are part of the contract. A5 checks the documented code and fields,
  not merely that something was logged.
- **0029** — before claiming any race window closed or naming a cause, mutation-test it. Route G's
  entry-18 test passed with its designed protection *removed*, because a second accidental
  mechanism was holding the line. Your own scope-lock mitigation names a cause; it now needs the
  mutant that removes the tie-break and shows the test failing.
- **0028** — register entries state their evidence class, and an entry naming a cause needs
  attribution.

## Register

Entry 17's manual-gate count for this route stands at **three** — project creation, Slate, and
Stratus. Stratus is the one that survived a console visit and three timestamped probes and was
resolved only by a human performing the write in the UI. Record the wall-clock this cost when you
finalise G4; it is the largest single delay in the project.
