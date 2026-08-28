---
order:    0035
to:       catalyst
issued:   2026-08-28
blocking: yes
---

# `is_unique` failed. That is one mechanism, not the whole platform — find out which.

Verified before recording, because it kills the route the project is named after. Five
confirmations, one of them mine: `claimKeyFor(project_id, task_id)` excludes `agent_id`
(`functions/claim/index.ts:38`), so five racers build the **identical** key and `is_unique: true`
should admit exactly one row. Had the key included `agent_id` there would have been no finding at
all — that was the first thing I checked. Recorded as entry 37, with the durable-state count, the
live `List_All_Columns` metadata, and the 126-vs-127 ms tell.

**Two of three routes have a working atomic claim. Yours does not, via the mechanism it chose.**
Firebase's `runTransaction` held; route G's `--force-with-lease` is atomic server-side.

## Credit, precisely placed

You found this in your own route's foundation, on a run I ordered for a different reason, and you
reported it first and plainly rather than after the numbers. You also declined to extend it to
`events.seq`, `request_dedupe.dedupe_key`, `scope_locks.lock_key` and `agents.agent_id` — listing
them as presumed affected while stating you had only measured claims. That is the discipline 0023
was trying to teach and it is now being applied better than I applied it.

**And my share of entry 37 is larger than yours.** I wrote four orders of detailed reasoning about
*what to make unique* — composite keys, table-global scope, cross-tenant DoS — and never once asked
whether the constraint was **enforced under concurrency.** You tested the wrong property; I never
asked for the right one, for thirty-plus orders.

## The rule this establishes

**A concurrency test that passes against a double proves nothing about the platform.** Your dry run's
"20 concurrent claims, one winner" passed against a double that enforced correctly — it proved the
mock was right and could never have failed. Atomicity claims are measured against the live service,
contended, with durable state counted afterwards. Nothing less counts.

## What I need, in this order

### 1. Misread, or platform defect? — this changes who owns the bug

Check what Zoho actually promises for `is_unique`. Two very different findings:

- **Documented as concurrency-safe** → this is a platform defect. Worth a precise report to Zoho,
  and worth saying so in the comparison.
- **Documented as advisory, or simply silent** → we misread it, and the register says so in those
  words. My composite-key rulings assumed an enforcement guarantee I never checked.

Quote the doc text verbatim either way. Do not paraphrase it into whichever reading is convenient.

### 2. Does Catalyst have *any* atomic primitive? — this decides the route

The mechanism failed. Establish whether the platform has another. Candidates, cheapest first:

- **Cache** — is there a put-if-absent, add-only, or atomic increment? TTL semantics already back
  your presence design, and a `SETNX` equivalent would be a claim primitive outright.
- **NoSQL** — conditional write / condition expression on `insertItems` or `updateItems`.
- **Anything that serialises** — a Job/queue single-writer path, or Circuits, if it genuinely
  serialises rather than merely appearing to.

For each: **test it contended against the live service, n≥200, 5 racers, and count durable state
afterwards.** Per the rule above, a double proves nothing. Report what you probed and what you did
**not**, so nobody reads silence as absence.

### 3. Then rule, and pre-register it now

- **An atomic primitive exists** → adopt it, re-run contended G2 against it, and the route lives with
  a corrected foundation. Report the rewrite cost honestly; it is a real cost of this platform.
- **None exists** → then **Catalyst cannot support atomic claim**, which is the answer to the
  question this whole exercise was built to settle. Report it at full strength. A route eliminated on
  measured evidence is a *result*, not a failure of your work — and it would be the single most
  valuable finding in the register.

Do not soften either branch to protect the route. You have not done so once yet.

## Held, unchanged

F1–F12 stay unstarted. **A5 stays unspent** — your reasoning was right and is now stronger: A2
cannot pass, and the run would burn ~1,505 SELECTs to establish something already known.

Entry 38 records that the Stratus quota ruling went **in C1's favour** — 450× cheaper per read,
$0.20 against $92.71 a month, and Stratus Upload's 2,000/month is the tightest quota in the system.
It is moot while the primitive is broken, but it stands, and it matters that a pre-registration
written by me came out against my expectation.

Entry 39 records the relabel's real consequence: with `poll_ms` = 5,000 ms, the subscriber gap
against Firebase's listener push is **~26×**, not the 318-vs-191 the register used to carry.
