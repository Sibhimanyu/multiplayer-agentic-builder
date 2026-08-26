# Catalyst route — measured, run 1

Recorded by the coordinator from the Catalyst build's report, 2026-08-26. Branch
`impl/catalyst-v1`, tip `474b7c7`.

**Read the caveats before the numbers.** Both were flagged by the build itself.

## Caveats that bound what these numbers mean

1. **G1 measures the LEDGER read path, not the folded snapshot.** The Stratus snapshot builder
   is step 5 and does not exist yet. The design doc's "34 ms CDN vs 1,347 ms git" figure is
   **not** what was measured here and these numbers must not be compared against it.
2. **G2's max was 1,186 ms against a p95 of 182 ms** — one sample in 200, 9x the p95. Not a
   threshold, and not something to average away: a claim that occasionally stalls over a second
   is user-visible, and the mean of 139 ms hides it completely.

## G1 — append and publish→visible, n=100

| | p50 | p95 |
|---|---|---|
| `appendEvent` | 202 ms | 281 ms |
| publish → visible | 318 ms | 419 ms |

0 failures. Cold first call reported separately, never folded into the percentiles.

## G2 — claim round-trip, n=200

| p50 | p95 | p99 | max |
|---|---|---|---|
| 127 ms | 182 ms | 409 ms | **1,186 ms** |

200/200 claims won. 28 s wall clock.

## G4 — operation cost per request

**This corrects every earlier planning figure, including mine.**

Every authenticated request pays **2 SELECTs before its own work**, because the protocol
requires resolving token → agent → project → role server-side on every call, and that cannot be
cached without weakening the guarantee.

```
append  =  5 SELECT  +  2 INSERT
```

So the **10,000 SELECT/month allowance binds at ~2,000 appends**, while the 5,000 INSERT
allowance would have permitted 2,500. Every prior estimate — mine in the platform audit, and
the build's own A5 warning — was framed around INSERTs and was therefore wrong. It was wrong
because it was reasoned from the schema rather than measured against a live request.

A5's real cost is ~**1,505 SELECTs**, 15% of the monthly allowance. The run-it-once ruling in
order 0005 was right, for a different reason than either of us gave.

## G6 — free tier consumed by this run

| Operation | Used | % of monthly free tier |
|---|---|---|
| SELECT | 1,260 | 12.6% |
| INSERT | 403 | 8.1% |
| **UPDATE** | **0** | **0%** |

INSERT total measured by `COUNT(ROWID)`, not estimated: 201 + 101 + 101 = 403, matching the
computed total exactly.

**The zero-UPDATE design holds in production.** That was a design constraint imposed because the
free tier allows only 1,000 UPDATEs per month; it is now confirmed rather than assumed.

## G5 — free-tier runway

| Scenario | Runway |
|---|---|
| 2 people, light | fits within the free tier |
| 2 people, active | exceeds it in ~**17 days** |
| 10 people, active | exhausts it in ~**3.3 days** |

**Deliberately not converted to dollars.** That needs a rate card the build had not verified,
and measured operations are worth more than a number multiplied by a guess.

## Provisioning

2 CLI commands, 18 API calls (2 failed), ~95 s, **zero browser steps** — for everything after
the project itself, which could only be created in the console.

Nine tables, 63 columns, generated from `catalyst/schema/tables.ts` rather than hand-typed.

Incidental finding: **table IDs are non-monotonic too** — 57006, 63003, 63362, 58006, 61002 —
the same shard-block allocation as `ROWID`.

## Not done, and not a matter of trying harder

- **A1–A15 real-backend run:** A1/A2/A3/A4/A12/A14 reachable today. A7–A11 and A13 need
  `readSnapshot`, `subscribe`, `heartbeat` and the scope routes, which need the Stratus snapshot
  builder (step 5) and Cache presence. Neither exists.
- **F1–F12:** needs the CLI, step 8. Not built.
- **G3:** is the wall clock of F1–F12, so blocked on the same thing. So is the 8-hour /
  3-agent part of G4.
- **G10:** deliberately unwritten. It goes last, before seeing anything from another build.
