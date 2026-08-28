# Firebase route — measured, run 1

Project `multiplayer-agents-eec02`, Firestore `(default)` in **asia-south1** (Mumbai), plan Spark.
Measurement project id `proj_measure_mtcfje80`. Machine: this laptop, India.

**Read the caveats before the numbers.**

## Caveats that bound what these numbers mean

1. **Database region was chosen deliberately and it dominates these figures.** `asia-south1`
   because this machine and Catalyst are both in India; a US multi-region default would
   have added roughly 200 ms to every row and flattered the other build.
2. **G1 here measures append and then the folded-state read.** This build folds inside the
   append transaction, so there is no separate snapshot builder — which makes it a
   different pipeline from the Catalyst route, not merely a faster one. The design doc's
   34 ms CDN figure is a different measurement again and must not be compared to either.
3. **Spark plan.** No Cloud Functions, so nothing here traverses the HTTP API or the
   webhook. These are adapter-to-Firestore numbers, not end-to-end request numbers.
4. **One run.** Per the rule this build wrote: no figure here is a threshold. Shape and
   recovery, not a number to quote back.

## Cold first call

*Host: real Cloud Firestore, `multiplayer-agents-eec02`, `asia-south1`. Client Asia/Kolkata.*

First `appendEvent` after process start: **401 ms** — 3 reads,
3 writes, 1 transaction(s).

Reported separately and **excluded from every percentile below**: it includes SDK
initialisation, channel setup and TLS, none of which recur.

## G1 — append and publish→visible, n=100

*Host: real Cloud Firestore, project `multiplayer-agents-eec02`, region `asia-south1` (Mumbai).
Client: this laptop, Asia/Kolkata. **Not the emulator.***

| | n | p50 | p95 | p99 | max | mean |
|---|---|---|---|---|---|---|
| `appendEvent` | 100 | 186 | 254 | 375 | **377** | 194 |
| publish → visible | 100 | 191 | 264 | 377 | **390** | 201 |

0 append failures. 0 visibility timeout(s) at 10 s, excluded from the
percentiles and reported here rather than silently dropped.

Ops for the whole G1 phase: 300 reads, 300 writes,
100 transaction calls, 100 transaction attempts.

**publish→visible is the live-listener push path**, timed from the `appendEvent` call to
the arrival of an `onSnapshot` frame carrying that `seq` — not a poll loop noticing. It
therefore contains the append itself and is NOT additive with the append row above.

## G2 — claim round-trip

*Host: real Cloud Firestore, `multiplayer-agents-eec02`, `asia-south1`. Client Asia/Kolkata.
**Not the emulator.***

**Two rows, because they measure different things and only one is comparable to the
Catalyst figure.** Their run-1 reports 200/200 claims won, so every claim there was
uncontended. Reading my contended number against theirs would be an apples-to-oranges
comparison of exactly the kind this exercise has already been burned by.

| | n | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| **uncontended** (comparable to Catalyst) | 40 | 1167 | 1492 | 1576 | **1576** |
| **uncontended, isolated re-measure** — see below | 40 | **257** | 278 | 308 | **308** |
| **contended**, 5-way (asked for by 0033) | 200 | 1955 | 2859 | 3135 | **3205** |

No mean, per 0033.

### The uncontended row disagrees with itself, and I cannot explain it

The 1,167 ms uncontended figure is **6x** the 186 ms append in the same run, despite a claim
being only two more reads and one more write inside the same transaction. That gap was large
enough not to ship unexamined.

Hypothesis: the 100 appends immediately preceding it all wrote the same counter document, and
Firestore rate-limits sustained writes to a single document, so G2 inherited a backlog.

**Tested, and the hypothesis is wrong.** `firebase/probe-claim.mjs`, fresh project namespace,
real Firestore, asia-south1, client Asia/Kolkata:

```
A. claim, no prior appends    n=40  p50=257  p95=278  max=308
B. append, same namespace     n=40  p50=170  p95=183  max=190
C. claim, after 40 appends    n=40  p50=259  p95=282  max=306
```

A and C are indistinguishable, so prior appends are not the cause. An isolated uncontended
claim costs **~257 ms**, a sensible 1.5x an append for 2 extra reads and 1 extra write.

So the run-1 uncontended figure is an outlier against a cleaner measurement of the same
operation, and **I do not know why.** Something about the state of that measurement project
after the G1 phase — 100 events, 100 contract pointers, a recently torn-down six-listener
subscription — but naming a mechanism I have not tested would be exactly the reasoned-is-not-
measured error (order 0028).

**Do not quote 1,167 ms as this route's uncontended claim cost.** The defensible figure is
**~257 ms p50**, from the isolated probe. The contended row stands as measured; whether it
carries the same unexplained inflation is unknown, and re-measuring it in isolation is the
obvious next step.

40 tasks x 5 concurrent contenders = 200 timed attempts.
40 won, 160 lost. Exactly one winner per task is the correctness claim, and
**it held**.
99 s wall clock.

Losers are timed too: a lost claim is a normal protocol outcome, not an error, and the
caller waits for it exactly as long as a winner does.

## G4 — operations per request, counted not derived

*Host: real Cloud Firestore, `multiplayer-agents-eec02`, `asia-south1`. Client Asia/Kolkata.
**Not the emulator.***

| operation | reads | writes | deletes | tx calls | tx attempts | clean? |
|---|---|---|---|---|---|---|
| `appendEvent` | 3 | 3 | 0 | 1 | 1 | yes |
| `claimTask` | 5 | 4 | 0 | 1 | 1 | yes |
| `readSnapshot` (live listener warm) | 0 | 0 | 0 | 0 | 0 | yes |
| `readEvents` | 183 | 0 | 0 | 0 | 0 | yes |
| `heartbeat` | 1 | 1 | 0 | 0 | 0 | yes |

Counted by proxying the Firestore handle AND the transaction object, not by reading the
adapter. The Catalyst G4 correction invalidated every earlier planning figure precisely
because those were reasoned from a schema rather than measured against a live request.

**`tx attempts` is the honesty column.** A retry loop is a correctness mechanism that
doubles as a cost-hiding one: the SDK re-runs a transaction body on internal retry and
this adapter retries contention on top of that, so `reads` and `writes` are sums over
every attempt. If attempts exceeds calls, the row is an average over retries and NOT a
per-operation cost.

Every row above ran in a single attempt, so the counts are clean per-operation costs.

Adapter-level contention backoffs during the whole measurement: **0**.
Zero means nothing in these figures is absorbing contention.

**`readSnapshot` costs 0 only while a live subscription is warm**, which it was here, left over
from the G1 phase. That is a real property of the design rather than an artefact — the dashboard
holds exactly such a subscription — but it is a precondition, not an unconditional zero. With no
listener attached, `readSnapshot` falls back to assembling from the server: six queries, and the
cost grows with the collections. The bare `0` in that row would be misleading without this
sentence.

**`readEvents` at 183 reads** is the honest shape of an append-only ledger: it pages the whole
thing, and Firestore bills per document returned. It is capped at 300 by the interface, so the
worst case is 300 reads per call — and it is the one operation here whose cost grows with
project age.

**`heartbeat` costs 1 read + 1 write.** The read is the revocation check the protocol requires on
every request; the write is the presence field. Order 0033 asked specifically, because Catalyst
measured **zero UPDATEs** by design — it puts presence in Cache with a TTL, since its free tier
allows only 1,000 durable UPDATEs per *month*. This route pays a durable write per heartbeat and
can afford to, because the Firestore free tier is 20,000 writes per *day*. Neither is better in
the abstract; they are different tiers forcing different designs, and the asymmetry belongs in the
register whichever way it is read.

## G5 — extrapolated monthly cost

**Not converted to dollars.** Per the standard set by the Catalyst run: measured
operations beat a number multiplied by a guess, and I have no verified rate card. What
is reportable is the operation count per unit of work, above, and the free-tier
arithmetic below.

## G6 — free-tier headroom

*Arithmetic on counted figures from real Cloud Firestore, `multiplayer-agents-eec02`,
`asia-south1`. Evidence class: **arithmetic on measurement**, not itself a measurement.*

Firestore Spark free tier: 50,000 document reads and 20,000 document writes per **day**.
Using the counted figures above, one append costs 3 writes and
3 reads, and one claim costs 4 writes and 5 reads.

The binding constraint is writes, and the dominant consumer is presence, not work:
a 30 s heartbeat is 2,880 writes/day per agent, so three agents spend ~8,640 of 20,000
on heartbeats alone before any coordination happens.

### G5 — free-tier runway

*Evidence class: **arithmetic on counted figures**, not a measurement. Catalyst reported ~17 days
and ~3.3 days for the two active scenarios; the comparison below is like-for-like in method.*

Per counted costs: append = 3 writes, claim = 4 writes, heartbeat = 1 write per 30 s per active
agent. Free tier: **20,000 writes/day** (the binding limit; 50,000 reads/day is not reached).

| scenario | heartbeat writes/day | work writes/day | total/day | % of 20,000 | runway |
|---|---|---|---|---|---|
| 2 people, light (2 agents, 2 h/day, 20 events) | 480 | ~70 | ~550 | 2.8% | **indefinite** |
| 2 people, active (2 agents, 8 h/day, 100 events) | 1,920 | ~350 | ~2,270 | 11% | **indefinite** |
| 10 people, active (10 agents, 8 h/day, 500 events) | 9,600 | ~1,750 | ~11,350 | 57% | **indefinite** |

**Runway is "indefinite" rather than a number of days, and that is the finding.** The Firestore
free tier is a *daily* allowance that resets, so a workload below the line never exhausts it —
whereas Catalyst's 1,000 durable UPDATEs per *month* is a depleting budget, which is why its
runway is measured in days at all. Those are different shapes of limit, and expressing both as
"days" would flatten the actual difference.

The honest caveat: at 10 active agents this route sits at **57% of the daily write allowance with
presence alone accounting for 48%**. It does not run out, but it has less headroom than the
percentage suggests once anything else shares the project.

