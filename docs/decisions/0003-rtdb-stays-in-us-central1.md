# 0003 — RTDB stays in us-central1

Status: **accepted**
Date: 2026-09-14
Decided by: the user, after the coordinator raised the region mismatch

## Decision

The Realtime Database instance stays where it was created:

```
https://multiplayer-agents-eec02-default-rtdb.firebaseio.com   (us-central1)
```

Firestore remains `asia-south1` (Mumbai). Presence therefore crosses regions; everything else does
not. **Not revisited** — RTDB region is fixed at creation, and Spark allows exactly one instance, so
this is settled unless the project moves to Blaze.

## Why it is fine

- **Cost is unaffected.** RTDB bills bandwidth and storage, not distance. Entry 56's figure —
  138.4 MiB/month, **1.4%** of the 10 GB allowance at 10 agents — holds unchanged.
- **Presence is not latency-critical.** A heartbeat every 30 s does not care about a 200 ms round
  trip, and `HEARTBEAT_INTERVAL_MS` was chosen for behaviour (two missed beats before stale), not
  for speed.
- **What a human would actually notice is nothing.** Presence updates lag the rest of the board by
  roughly 200 ms. The board's other data arrives over Firestore's 191 ms push. An avatar's status ring
  settling a fifth of a second after a card moves is imperceptible.
- **For a distributed team it may be better.** `us-central1` is more central to a global membership
  than Singapore would be — and the product's whole premise is people in different places.

## What it costs, and the one rule that follows

**Every presence figure must be labelled `us-central1`, and none of them is comparable to the
Firestore numbers.** Every other latency figure in this project is same-region by construction:
`asia-south1`, client Asia/Kolkata, deliberately best-case. Presence now is not.

This is entry 25's failure mode — a real number quoted against the wrong host — and it is now a
**standing condition rather than a mistake waiting to happen.** Presence latency does not go in a row
with `appendEvent`, claim, or publish→visible. It goes in its own row, with its region named.

The cost is to the comparison record, not to the product.

## Consequence

Wire `VITE_FIREBASE_DATABASE_URL` to the URL above. Do not attempt to recreate the instance. If the
project ever moves to Blaze, a second instance in `asia-southeast1` becomes possible — and at that
point the decision is worth re-taking, because the reason for this one is *"the cost of changing it
exceeds the benefit"*, not *"cross-region is correct"*.
