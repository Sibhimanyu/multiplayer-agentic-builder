# The three-route scoreboard

Assembled by the coordinator 2026-08-28, first point at which all three routes had numbers.
Every figure below names its **host** and its **mechanism**, because four of the six rows in the
first version of this table were wrong on mechanism while every one of them named its host
correctly (entries 25, 30, 33).

Sources: `catalyst-run-1.md`, `firebase-run-1.md`, `impl-github-notes.md`. Where a route owes a
row, the cell says so rather than borrowing a neighbour's.

## Read this first: correctness outranks every latency row below

| route | claim primitive | contended? | result |
|---|---|---|---|
| **Route G** | `push --force-with-lease` | 20 racers × 50 rounds | **holds** — 50/50, ref agreed with reply 50/50 |
| **Firebase** | `runTransaction` | 5 racers × 200 tasks | **holds** — 40 won / 160 lost, one winner each |
| Catalyst | `is_unique` on INSERT | 5 × 200 *(never contended before)* | **FAILS — 84.5%**, 547 winners / 200 tasks |
| Catalyst | Data Store CAS `UPDATE…WHERE` | 5 × 200 | **FAILS WORSE, SILENTLY** — 658 winners, durable state *perfect* |
| Catalyst | **Stratus `overwrite:false`** | 5 × 200 | **holds** — 200/200, etag=MD5 confirmed the *right* winner |
| Catalyst | NoSQL conditional insert | **not probed** | console-gated: zero tables, no SDK, no MCP tool |

**Catalyst's chosen primitive does not work.** The design selected Data Store because "`is_unique`
gives atomic claim without transactions"; it does not enforce under concurrent insert. Its CAS
fallback is worse — 458 agents held claims they did not own while the table looked perfect, so no
database audit could find them.

**A working Catalyst primitive does exist, in object storage.** That keeps the route alive but moves
every atomic guarantee out of the database and onto Stratus Upload, whose 2,000/month free tier is
the tightest meter in the system.

## Latency — route G loses every row, and not narrowly

| row | Catalyst | Firebase | Route G | comparable? |
|---|---|---|---|---|
| `appendEvent` p50 | 202 ms | **186 ms** | 3,262 ms | **NO** — Firebase is on Spark, so no Cloud Functions: adapter→Firestore **direct**. Catalyst pays client→function→Data Store + 2 SELECTs of auth resolution. Firebase does strictly less work per call. |
| claim p50, uncontended | **127 ms** *(broken primitive)* | 257 ms | 2,182 ms | **YES** |
| claim p50, contended | **owed** | 1,955 ms *(unvalidated)* | 4,532 ms | partly — Catalyst cannot produce it until quota resets |
| publish→visible, **floor** | 318 ms | n/a | 7,599 ms | **YES**, to each other only — both tight read loops with zero backoff and **no subscriber** |
| publish→visible, **subscriber** | ~5,200 ms *(poll 5,000)* | **191 ms** *(listener push)* | 8,551 ms *(poll 5,000)* | **mechanism differs** — push vs poll. This is the row a human watching a dashboard actually feels. |

The floor/subscriber split is the single most important correction in the register. "Catalyst 318 vs
Firebase 191" sat in the table for two runs looking like a 1.7× gap. Catalyst's `subscribe` throws
`NotProvisionedError` and its real poll interval is 5,000 ms, so the honest gap is **~26×**. Route G
volunteered the same split before being asked.

## Cost — route G wins, and this is the row that matters

| row | Catalyst | Firebase | Route G |
|---|---|---|---|
| claim write cost | 1 Stratus Upload *(2,000/mo free)* | 1 transaction: reads + writes | **1 git push, ZERO metered requests** |
| presence write cost | **0 UPDATEs** *(Cache TTL is the signal)* | 1 read + 1 write **per beat** | **0 durable rows, 0 metered** *(timestamp in the ref name)* |
| presence at 10 agents | 0% | **48% of the daily write allowance** | 0% |
| auth overhead per request | **2 SELECTs**, every call | none measured | none |

`git push` and `git fetch` appear in **none** of the fifteen rate-limit resources GitHub exposes.
Route G's write path is unmetered outright — no other route can say that.

## Quota exhaustion — three different shapes, and "days of runway" fits only one

| route | shape | consequence |
|---|---|---|
| Catalyst | **monthly, depleting, HARD WALL** | `FREE_USAGE_LIMIT_REACHED` — **refused, not billed.** Every authed route spends 2 SELECTs, so one service's exhaustion is every service's outage. **This build is down right now.** |
| Firebase | **daily allowance that resets** | cannot be exhausted by this workload; 57% of daily writes at 10 agents, so it throttles rather than stops |
| Route G | **rolling hourly bucket that refills** | exceeding it is a 403 that clears within the hour |

G5 was specified as "days of runway," which presumes a depleting budget. **Only one route has one.**
Converting the other two into days would have manufactured a ratio out of three incompatible
mechanisms — the same error as pricing C2 at $92.71/month when the real behaviour is that it *stops*.

## Route G cannot honour its own advertised freshness

`readSnapshot` at the design's advertised 5,000 ms poll is **5,040 requests/hour against a 5,000
limit — over by 0.8%.** The binding constraint on route G is **the dashboard, not the agents.** Found
by route G, against route G.

## What is still open — none of this is settled

1. **Catalyst's Stratus-lock adoption is unverified.** The primitive holds in isolation; the adopted
   code path has never run contended, because the Data Store quota wall blocks it.
2. **NoSQL conditional insert is unprobed** — the strongest candidate for keeping atomicity in a
   database. Needs one console-created table; the harness is already written.
3. **Firebase's 1,955 ms contended figure is unvalidated** — its uncontended run showed an
   unexplained 1,167 ms that a tested-and-disproven hypothesis could not account for, and the same
   inflation may be present here.
4. **Route G's A5 is not re-verified** since its ranged-read change. "Section A 17/17" was true
   *before* that change; only A1/A4/A6 have been re-established.
5. **Route G has an unresolved contradiction in its own data**: `appendEvent` measures flat 3.3 s in a
   tight loop, but A5 — which *is* a tight loop of `appendEvent` — ran ~60 min against a 17 min
   baseline. One of those two is not measuring what it appears to. Being instrumented, not reasoned
   about.

## The coordinator's reading

**The three routes fail differently, and the choice is which failure you can absorb.**

- **Catalyst** is fastest on the rows that work, and its zero-UPDATE presence design is genuinely the
  best of the three. But its chosen primitive is broken, its working primitive sits on its scarcest
  meter, its free tier refuses rather than bills, and it is the only route whose blocking steps
  repeatedly require a human in a browser (four so far).
- **Firebase** is the only route with a working push subscriber — **191 ms against 5,200 and 8,551** —
  a primitive verified contended, and a quota that resets rather than walls. Its costs are real:
  presence at 48% of the daily write allowance for 10 agents, and its latency numbers skip a function
  hop the others pay.
- **Route G** owns the cost column outright and has the most rigorously verified primitive of the
  three, but loses every latency row by more than an order of magnitude and cannot meet its own
  freshness spec.

On the measurements as they stand, **Firebase is the strongest coordination layer and route G the
strongest durable store** — which is close to the split the original design proposed, for reasons the
design did not know. Catalyst's place depends entirely on open item 2.

**Two findings are worth more than the platform choice**, and both are reportable to Zoho: `is_unique`
does not enforce under concurrency while the schema calls it *"enforces unique values"*, and Data
Store CAS reports success to every racer while writing exactly one row. The second is the more
serious — a silent violation an audit cannot detect.
