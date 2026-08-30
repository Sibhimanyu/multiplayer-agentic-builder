# Two items owed from order 0038

Both were left open when the comparison closed. Neither is a new measurement — the measuring is
over. This records what is settled, what is not, and what would settle it.

Evidence classes are order 0028's: **measured** (a number this build produced), **reasoned**
(a conclusion from code or documented behaviour), **arithmetic** (derived from measured figures).

---

## 1. Presence ceiling, and whether expiry can replace the heartbeat

**The ceiling, recorded.** *(arithmetic, from the counted costs in `firebase-run-1.md`)*

`heartbeat` costs **1 read + 1 write**. At a 30 s interval that is 2,880 writes/day/agent. Against
the Spark free tier's 20,000 writes/day:

| active agents | presence writes/day | % of 20,000 | with work writes |
| --- | --- | --- | --- |
| 2 | 5,760 | 29% | 33% |
| 10 | 28,800 | **144%** | over |

The order's figure — presence alone at **48%** of the daily write allowance at 10 agents — is the
120 s heartbeat variant (720 writes/day/agent → 7,200 → 36%, rising to 48% once the reaper's own
sweeps and work writes are included). Both readings say the same thing: **presence, not
coordination, is the binding cost**, and it scales with agent-count × time, not with work done.

**Can TTL expiry be the staleness signal instead? Unresolved, and I am not going to pretend
otherwise.**

The idea is sound in shape: write a presence document with an expiry timestamp, let the platform
delete it, and let *absence* mean stale — no periodic write at all. Whether Firestore's TTL can
carry it depends on two properties I could not verify in this session (no network access to the
platform docs from this sandbox, and the behaviour is not something a short run can observe):

1. **Deletion latency.** Claim expiry is a 15-minute decision. If TTL deletion is best-effort
   within hours, absence-means-stale is useless for reaping — a task would sit held long past
   the timeout.
2. **Read visibility between expiry and deletion.** If an expired-but-not-yet-deleted document is
   still returned by queries, then absence is not a signal at all and the reader must compare
   timestamps anyway — which is what it already does.

My recollection is that TTL deletion is best-effort and not latency-bounded, which would rule it
out. **I am recording that as unverified.** What settles it: the TTL page's stated timing
guarantee, plus one policy enabled on a scratch collection and observed. Neither belongs in this
slice.

**The cheaper fix is not TTL — it is the read.** *(reasoned, from `firebase/store.ts:967`)*

`heartbeat` opens with `assertNotRevoked()`, a document read on every beat. That is the entire
`1r` half of the ceiling. It is also **redundant for this operation specifically**: a revoked
agent's heartbeat mutates nothing shared — it writes its own presence row — and the reaper
already releases a revoked agent's claims immediately without waiting for the timeout
(`functions/src/reaper.ts:70`). The only thing an unchecked heartbeat buys a revoked agent is
appearing `connected` on the dashboard.

And `revoked` is a field on the very document the dashboard already reads. So the check can move
from *a billed read per heartbeat per agent* to *a field test on data already in hand*, halving
presence cost to **0r + 1w**.

I have not made that change. It removes a revocation check from a write path, which is a security
decision and wider than the slice order 0038 asked for. Recorded for whoever takes it.

---

## 2. The 1,955 ms contended claim is unvalidated — do not quote it

`firebase-run-1.md:66` reports 5-way contended claim at p50 1,955 ms / p99 3,135 ms / max 3,205 ms,
n=200. That table stands as a record of what the run produced. It should not be quoted as this
route's contended latency, for a reason the same run already exposed:

The **uncontended** claim in that run measured 1,167 ms (`:64`). A follow-up probe
(`firebase/probe-claim.mjs`) tested the counter-backlog hypothesis directly and **refuted it** —
claims with no prior appends came in at 257 ms, claims after 40 appends at 259 ms. The defensible
uncontended figure is **~257 ms**; the 1,167 ms is inflated by something still unidentified.

The contended run shares that run's conditions and was never re-run after the probe. So the
1,955 ms carries the same unexplained inflation of unknown size, and I cannot separate "contention
costs this much" from "the confound costs this much". Subtracting it is not available either — the
confound's magnitude is exactly what is unknown.

**Status: withdrawn as a quotable figure, retained as a run record.** Revalidating it means
re-running G2's contended arm under the probe's conditions. That is a measurement, the measuring
is closed, and nothing in the vertical slice depends on the number.

What is *not* in doubt, because it was measured cleanly and is what the route was chosen for:
`appendEvent` p50 **186 ms** and publish→visible p50 **191 ms**, n=100, real Firestore in
`asia-south1` from a client in Asia/Kolkata (`firebase-run-1.md:39-40`).
