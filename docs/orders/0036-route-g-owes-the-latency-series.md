---
order:    0036
to:       route-g
issued:   2026-08-28
blocking: yes
---

# You own the only claim primitive with no asterisk. Now the latency series.

Section A is 17/17, provisioning was **1 CLI command and 0 console steps**, and your A2 caveat about
`rc=0` went on to catch the same error class in two other places — including one of mine. But
**G1–G5 do not exist for this route**, and the scoreboard now has rows for Catalyst and Firebase with
a blank column where yours goes.

## First, something that came out in your favour

Catalyst's contended claim run found `is_unique` violating on **84.5%** of tasks (entry 37), and the
tell was that its results said "200/200 claims won" — every claim winning means nothing ever
contended. I re-checked **your** A2 against that same suspicion.

**Yours is genuinely contended and it holds.** `rounds=50 agents=20`: 20 racers per round, and PASS
required all three of exactly one rc=0, the ref pointing at **that winner's** commit rather than *a*
commit, and all 19 losers reporting `rejected`. That is correlation not count, and it is the shape
Catalyst's test lacked.

| route | claim primitive | contended? | verdict |
|---|---|---|---|
| **Route G** | `push --force-with-lease` | **20 racers × 50 rounds** | **holds** |
| Firebase | `runTransaction` | 5 racers × 200 tasks | holds |
| Catalyst | `is_unique` INSERT | never contended until now | **fails, 84.5%** |
| Catalyst | Data Store CAS | 5 × 200 | **fails worse — silently** |
| Catalyst | Stratus `overwrite:false` | 5 × 200 | holds, but see below |

Catalyst's only working primitive turned out to be in **object storage, not the database**, and each
claim costs one Stratus Upload against a 2,000/month free tier — the tightest meter in that system.
Your primitive costs a git push against no per-operation quota at all. **Say that plainly in G4/G5;
it is the strongest thing this route has.**

## What I need: G1–G5, every figure carrying host and mechanism

Two rules learned the hard way, both retroactive:

- **Entry 25 — every latency figure names the host it was measured against.** A 34 ms figure measured
  on `raw.githubusercontent.com` was quoted for two runs as a *Stratus* number and was the stated
  reason one route beat another. That host was yours. Never let a number travel without it.
- **Entry 30/33 — before two numbers go in one row, name the mechanism.** Push or poll, contended or
  not, direct or through a hop, depleting or resetting. Four of six scoreboard rows failed on
  mechanism while every one of them named its host correctly.

1. **G1** — `appendEvent` p50/p95, n=100, host named. Then publish→visible **with its mechanism in the
   label**. Catalyst's 318 ms turned out to be a tight read loop with zero backoff while its real
   `subscribe` polls at 5,000 ms; Firebase's 191 ms is a genuine listener push. If yours polls, the
   label says poll and states the interval. If it reads the CDN, the label says which host.
2. **G2** — claim round-trip as a **distribution**, not a pass count. Your A2 proves correctness;
   this is latency. p50/p95/p99/max, contended, no mean. Catalyst's max was 1,186 ms against a p95 of
   182 ms and was deliberately not averaged away.
3. **G3, G4** — operation cost per request. For you this is GitHub API calls and git operations; name
   the rate limit that binds and how close a realistic run comes to it.
4. **G5** — free-tier runway for 2 people light, 2 active, 10 active. **Expect this to be
   incommensurable and say so if it is.** Firestore resets daily and is effectively indefinite;
   Catalyst depletes monthly and hits a **hard wall** — `FREE_USAGE_LIMIT_REACHED`, which is why that
   build is down right now, refused rather than billed. If GitHub's limit is a per-hour bucket that
   refills, that is a **third** shape and "days of runway" does not apply. Do not convert between
   shapes to force a comparison — 0032's rule.

## Three rules from other routes that apply to you

- **A concurrency test that passes against a double proves nothing.** Catalyst's "20 concurrent
  claims, one winner" passed against a test double that enforced correctly — it proved the mock was
  right and could never have failed.
- **Never `String()` an SDK or CLI return value in a probe.** It happened twice on Catalyst; once it
  reported 48 durable contradictions that did not exist. Assert on a named field.
- **Measure the reply and the durable state separately.** Data Store CAS returned `affected: 1` to
  five racers while the table held exactly one correct row — either check alone passes.

G10 stays last. Do not start it.

Report every figure with host and mechanism, and say explicitly which of your rows are comparable to
the other two routes and which are not.
