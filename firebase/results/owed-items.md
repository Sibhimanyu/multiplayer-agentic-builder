# Owed items

> **Order 0040 update.** Item 1's open number is now **resolved** — see
> *"Resolving 48% vs 144%"* at the end. Run `node firebase/presence-cost.mjs` to reproduce every
> figure below.

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

> **Status after order 0039: the presence fix is made.** See the correction below — it does not
> do what the ruling said it would do, and the difference matters for the scoreboard.

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

### Correction: this saves READS, not writes. The 48% does not move.

Order 0039 approved the fix as "the difference between 48% and ~24% of the daily **write**
allowance at 10 agents". That is not what it does, and the number should not be recorded that way.

A heartbeat costs **1 write before the change and 1 write after it.** Removing a read cannot
reduce a write count. Reads and writes are separate Spark quotas — 50,000 reads/day and 20,000
writes/day — and the 48% figure is a percentage of the *write* quota, which the fix does not touch.

What actually changes, at 10 agents on a 30 s beat *(arithmetic)*:

| quota | before | after | of quota |
| --- | --- | --- | --- |
| reads/day | 28,800 | 9,600 | 58% → **19%** |
| writes/day | 28,800 | 28,800 | **144% → 144%** (unchanged) |

Not zero reads, either: the check is cached for 90 s against a 30 s beat, so it re-reads on every
third beat rather than never. `0r + 1w` is the ideal; `0.33r + 1w` is what is implemented, for the
reason in the next paragraph.

So the fix is worth having — it takes reads from the majority of the read quota to a fifth of it —
but **presence writes remain the binding constraint and remain over the free-tier limit at ten
agents.** The only things that move that number are a longer heartbeat interval or not writing
every beat. The worst number in this design is still the worst number in this design.

### And it could not be a deletion: conformance A14

`shared/store/conformance.ts:429` (A14) requires `heartbeat` to throw `StoreAuthError` for a
revoked agent and to not be retried. That file is frozen and both adapters run it unmodified, so
deleting the check was never available. The read was made **cheap instead of absent**: cached for
90 s, for `heartbeat` only. Every other operation still pays a fresh read, because those grant
authority over shared state and a stale allow there would be a real hole.

**Only the allow is cached; a deny never is.** The first version cached both, which is fail-closed
and looks safer, but it left a *re-instated* agent unable to heartbeat for the full 90 s. That was
caught by `firebase/revocation-check.mjs` against real Firestore, not by reading the code.

**The staleness window, stated as ordered:** at most **90 s** (`REVOCATION_CACHE_MS`, set equal to
`STALE_AFTER_MS`) between an agent being revoked and its heartbeat refusing — at most three further
presence writes at a 30 s beat. The board is not fooled during that window: both readers derive
`status: revoked ? 'revoked' : …` from the agent document itself, so a revoked agent renders as
`revoked` throughout regardless of what the cache believes. Verified as part of the same check.

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

---

## Resolving 48% vs 144% — order 0040

Entry 50 recorded two presence figures that cannot both be right: **48%** of the daily write
allowance, and **28,800 writes/day**, which against 20,000/day is **144%**. The scoreboard row was
marked UNKNOWN.

**They are both arithmetically correct. They assume different heartbeat intervals.**

| interval | writes/day/agent | at 10 agents | % of 20,000/day |
| --- | --- | --- | --- |
| 30 s | 2,880 | 28,800 | **144%** |
| 45 s | 1,920 | 19,200 | 96% |
| 60 s | 1,440 | 14,400 | 72% |
| 120 s | 720 | 7,200 | 36% → **48%** once reaper sweeps and work writes are added |

**The real reason the row is UNKNOWN is that the input was never decided.** There is no heartbeat
interval constant anywhere in `shared/`, `cli/` or `firebase/`, and nothing in this build emits
heartbeats on a schedule yet — that is F-series work. Neither figure was ever a measurement; both
are arithmetic over the same measured per-op costs with a different assumption plugged in.

And the interval is not free to choose. `STALE_AFTER_MS` is 90 s, so an agent must beat several
times inside that window or it flickers stale between beats. At the usual timeout/3 that is 30 s —
the expensive end. Even 60 s, the loosest interval that still gives two beats per window, is 72%.

**So the Firestore row should not be a single number.** It should read: *presence alone consumes
72–144% of the daily write allowance at 10 agents depending on interval, and is over the free tier
at any interval below ~43 s.* A range with a floor near the cap, not one figure.

## The RTDB figure, with units

RTDB does not meter operations at all. It meters **bytes downloaded** (database → client), storage,
and simultaneous connections. A heartbeat *write* is therefore not itself billed; what is billed is
every listener receiving it, so cost scales with **writes × listeners × payload**, not with writes.

Presence record as `RtdbPresence.write()` sends it: **171 B** *(measured — serialised and counted by
`firebase/presence-cost.mjs`)*.

| agents | dashboards | updates/day | download/month | % of 10 GB/mo |
| --- | --- | --- | --- | --- |
| 2 | 1 | 5,760 | 27.7 MiB | 0.3% |
| 10 | 1 | 28,800 | 138.4 MiB | **1.4%** |
| 10 | 5 | 28,800 | 692.1 MiB | 6.8% |

**Headline:** 10 agents on a 30 s beat with one dashboard open is **138.4 MiB/month downloaded, 1.4%
of the 10 GB/month free allowance.** The identical workload is 144% of Firestore's daily write cap —
i.e. over it. Storage is ~1.6 KiB for 10 agents (a fixed-size node per agent, not a log, so it does
not grow with time) against 1 GB; connections are 1 per agent + 1 per dashboard against a cap of 100.

**Caveat, stated not buried.** These totals are *arithmetic* over a *measured* payload. Firebase
bills RTDB bandwidth inclusive of protocol and encryption overhead, which is not in these numbers
and which I could not measure. Expect the real per-update figure to be meaningfully higher. The
conclusion survives a large multiple — it would take **73×** the computed volume to exhaust the
allowance.

**Not measured, and why.** `firebase/rtdbconfig.mjs` reports the Firebase Realtime Database
Management API is disabled on this project, and the service account is denied
`serviceusage.services.enable`, so I could neither list nor create an instance. Enabling it is a
console action. `presence-cost.mjs --live` is written to measure the real thing once it exists.

---

What is *not* in doubt, because it was measured cleanly and is what the route was chosen for:
`appendEvent` p50 **186 ms** and publish→visible p50 **191 ms**, n=100, real Firestore in
`asia-south1` from a client in Asia/Kolkata (`firebase-run-1.md:39-40`).
