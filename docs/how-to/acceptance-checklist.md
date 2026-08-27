# Acceptance Checklist

**Identical bar for both builds.** If the two implementations are not measured against exactly
this list, the comparison is worthless — you would be comparing two interpretations, not two
platforms.

Each item is pass/fail with stated evidence. "Looks right" is not evidence.

## A. Store interface conformance

Run the same suite against all three adapters: `memory`, `catalyst`, `firebase`.

| # | Test | Evidence |
|---|---|---|
| A1 | Same `idempotency_key` twice → same `seq`, `duplicate:true`, ledger grew by 1 | assertion |
| A1b | Under concurrency, every idempotency record **correlates**: an event exists at that `seq` **and carries the same key**. Not "an event exists at that seq" — see the rule below. | assertion, 12 concurrent |
| A1c | A replay after contention returns the **settled** `seq`, belonging to a real event with the right key | assertion, warmed ledger |
| A2 | 20 concurrent `claimTask` on one task → exactly 1 `{ok:true}` | assertion, repeated 50x |
| A3 | Losing claimant receives `{ok:false, owner}`, not a thrown error | assertion |
| A4 | `readEvents` returns strictly ascending `seq` | assertion |
| A5 | `readEvents` caps at 300 even when asked for 1000, and logs the cap | assertion + log line |
| A6 | Appended event is never mutated or deleted by any later operation | assertion |
| A7 | `acquireScope` rejects intersecting globs and names the conflicts | assertion |
| A8 | `acquireScope` allows disjoint globs concurrently | assertion |
| A9 | `AgentPresence.stale` flips true after the 90s timeout with no heartbeat | fake clock |
| A10 | `subscribe` fires once immediately before any change | assertion |
| A11 | `subscribe` survives a simulated network drop and resumes from cursor | assertion |
| A12 | Emoji in durable text is stripped identically in all three adapters | assertion |
| A13 | Snapshot reporting `seq < last_written_seq` does **not** trigger a re-append | assertion |
| A14 | Revoked token → `StoreAuthError`, and the CLI stops rather than retrying | assertion |
| A15 | Rate-limited backend → `StoreBusyError` and jittered backoff, no tight loop | assertion |
| A16 | **Human-layer event withheld from an agent-audience read, against the REAL backend.** Append `task_progress`, read as an agent, assert absent; then append a coordination-layer event and assert present. Both halves required — absence alone cannot distinguish a working filter from a failed write. | assertion, live |
| A17 | An unprovisioned operation throws `NotProvisionedError`, not `StoreError`, and makes **no network call** | assertion + no-request spy |

## B. CLI

| # | Test | Evidence |
|---|---|---|
| B1 | `connect <invite>` writes `AGENTS.md` + full `.agentic/` tree | `ls` output |
| B2 | Generated tree matches `agentic-file-contract.md` byte-for-byte across both builds | `diff` of the two trees |
| B3 | `claim` on a taken task exits 0 with "owned by X", not an error | exit code + stdout |
| B4 | `report "msg"` appends one line to `outbox.jsonl` and nothing else | file diff |
| B5 | Outbox payload over 4 KiB goes to `outbox.d/` as one file, not appended | `ls outbox.d/` |
| B6 | Kill the CLI mid-publish → unsent lines re-send on restart, no duplicates in ledger | ledger count |
| B7 | Network down → agent keeps working, outbox grows, cursor unmoved | file sizes |
| B8 | Human-layer events never appear in `inbox.jsonl` | grep returns empty |
| B9 | `body.local` is populated and the file exists before the inbox line is appended | assertion |
| B10 | `status` prints freshness mode from `store.freshness`, not a hardcoded string | stdout |

## C. Git blackboard

| # | Test | Evidence |
|---|---|---|
| C1 | Agent writes `contracts/items-api.v2.yaml`, appends event; CLI commits, pushes, rewrites body as pointer | `git log` + event body |
| C2 | Published event body contains `commit_sha`, never the contract content | event JSON |
| C3 | Two agents publish two different contracts concurrently → both land, zero conflicts | `git log` |
| C4 | Push rejection triggers `pull --rebase` + retry, succeeds within 3 attempts | log |
| C5 | Consumer fetches the blob via sha-pinned CDN URL, not `git fetch` | network trace |
| C6 | v1 file is untouched after v2 is published | `git diff` empty for v1 |
| C7 | Agent never sees a commit sha in `.agentic/` | grep |

## D. Webhook

| # | Test | Evidence |
|---|---|---|
| D1 | Valid HMAC over the **raw** body verifies | assertion |
| D2 | Tampered body is rejected | assertion |
| D3 | Comparison is timing-safe, not `===` | code review + test |
| D4 | Replayed `X-GitHub-Delivery` appends nothing the second time | ledger count |
| D5 | `push`, `pull_request opened/synchronize/closed`, `check_suite completed` each map to the right event kind | 5 assertions |
| D5a | `check_suite` conclusion mapping is **exactly** the table below. Both builds identical. | 9 assertions |
| D5a-unknown | A conclusion **not in the table** drops. Test with a synthetic value GitHub has not invented. | assertion |
| D5b | `pull_request closed` maps to `merged` only on strict `merged === true` | 5 assertions: `true` / `false` / `undefined` / `null` / **string `"true"`** |
| D6 | Unmappable repo → logged and dropped, never a 500 | log + status code |

## E. Dashboard

| # | Test | Evidence |
|---|---|---|
| E1 | Six columns match the task state machine | screenshot |
| E2 | Blocked agent identifiable in under 3 seconds by a first-time viewer | timed, 3 people |
| E3 | Detail panel **overlays**, never displaces columns; all six reachable while open | screenshot scrolled |
| E4 | Freshness indicator reads from `store.freshness` — "updated Ns ago" in poll mode, live dot in live mode | both screenshots |
| E5 | Empty column shows the dashed empty state, not a blank | screenshot |
| E6 | 47-char task title and a 90-char file path both truncate readably | screenshot |
| E7 | CI-failed badge visible without opening the card | screenshot |
| E8 | Design tokens match `docs/designs/dashboard.md` exactly | token diff |
| E9 | No layout shift when a poll returns new data | video or CLS metric |

## F. The demo — Inventory Tracker

Run identically on both. This is the headline result.

| # | Step | Evidence |
|---|---|---|
| F1 | Owner creates the project and connects the repo | screenshot |
| F2 | Owner invites 3 builders, assigns architect / backend / frontend | screenshot |
| F3 | Each builder runs `connect` then `start` on a separate machine or worktree | 3 terminals |
| F4 | Architect publishes schema + `items-api v1`, then exits | `git log` |
| F5 | Backend and frontend claim concurrently; no double-claim | ledger |
| F6 | Backend publishes `items-api v2` (breaking: qty string→integer) | `git log` |
| F7 | Frontend receives the pointer, reads the contract from disk, reports blocked | `inbox.jsonl` + ledger |
| F8 | Backend pushes a branch, opens a PR; webhook updates the board | screenshot |
| F9 | CI fails; board shows the badge without a refresh | screenshot |
| F10 | Owner merges on GitHub; board reaches `merged` | screenshot |
| F11 | Kill the frontend agent's laptop; reaper releases the claim within 15 min | ledger |
| F12 | Another agent claims the released task successfully | ledger |

## G. Measurements — the actual comparison

Record real numbers. These are the point of building both.

| # | Metric | How |
|---|---|---|
| G1 | Publish→visible latency, p50 and p95 | 100 contract publishes, timestamp both ends |
| G2 | Claim round-trip, p50 and p95 | 200 claims |
| G3 | Wall-clock cost of the full F1–F12 demo | stopwatch |
| G4 | Backend operations consumed by one 8-hour session, 3 agents | provider console |
| G5 | Extrapolated monthly cost at 2 people and at 10 people | G4 × provider rates |
| G6 | Free-tier headroom remaining after the demo | provider console |
| G7 | Lines of code in the adapter | `wc -l` |
| G8 | Total build hours | honest log |
| G9 | Every platform constraint hit, with the workaround | written list |
| G10 | Would you choose this again? One paragraph, written before seeing the other build's number | prose |

### Equalise the region, and record that you did

**Latency comparisons are invalid unless both routes are the same distance from the machine
running them.** Firebase was deliberately placed in `asia-south1` rather than accepting a US
multi-region default, because this machine and the Catalyst DC (`catalystserverless.in`) are both
in India. A US default would have added roughly 200 ms to every Firebase row and **flattered
Catalyst's figures**.

Region choice is permanent on both platforms and it determines G1 and G2. State yours explicitly
in your results file. A comparison where one route is 200 ms further away is not measuring the
platform, it is measuring the map.

### Measurement discipline

**Do not report a single-run figure as a threshold.** Contention limits are probabilistic, not
cliffs. "The ceiling is 32 concurrent" is one run; the honest form is "refusal becomes probable
above roughly a dozen concurrent appends, and the documented retry clears it" plus the observed
distribution across N runs.

Anyone quoting a hard number has measured once. Report the shape and the recovery.

**An intermittent test is worse than a failing one.** A failing test is information. A test that
is red under load and green otherwise converts an open question into noise, and it will be
re-run until it passes and then trusted. Same failure as asserting count instead of
correlation: it cannot reliably distinguish the bug from the fix.

If a test's outcome depends on load, either assert the property that holds under **all** loads,
or pin the load. Never both leave it variable and treat a green run as evidence.

**A retry loop is a cost-hiding mechanism as well as a correctness one.** Found the hard way:
a broken `MAX(seq)` read returned `undefined`, defaulted to 0, and allocated `seq` 1 — colliding
with the first event ever written. The append path has an increment-on-collision retry, so it
**absorbed** the bug: correct output, silently more expensive, walking up from 1 until it found a
free slot. The identical bug in a path *without* a retry loop failed loudly and was found in
minutes.

Two consequences, and the second binds every route:

1. **A measured path working is not evidence that its sub-operations work.** Success told the
   build nothing about whether its `MAX(seq)` read was correct.
2. **Any measured path containing a retry loop must have its per-operation cost verified
   independently** — by instrumenting attempt counts, or by exercising the same sub-operations
   through a path with no retry. Otherwise a G4 figure is a lower bound presented as a
   measurement.

Both builds have retry loops on the append path. Audit them before reporting G4 as final.

**Assert the contract, not your expectation of it.** A retryable refusal under contention is
the contract working. Asserting "all N succeed" against a store whose interface defines
`StoreBusyError` as a normal outcome is asserting that the contract is not the contract. Assert
instead: whatever refuses refuses **retryably**, nothing that landed shares a `seq`, and the
same N all land when driven through the shared retry helper with per-key correlation.

## `check_suite` conclusion mapping — normative

Ruled 2026-08-25. Both builds MUST implement exactly this. A divergence here is worse than a
missing badge, because a divergence is far harder to notice than an absence.

| `conclusion` | Maps to | Reason |
|---|---|---|
| `success` | `ci_passed` | |
| `failure` | `ci_failed` | |
| **`timed_out`** | **`ci_failed`** | A timeout is a **conclusive terminal failure**, not an inconclusive one. GitHub renders it with a red X. Dropping it leaves the board silent while the agent believes CI is still pending — a worse outcome than a slightly generous label. |
| `neutral` | drop | explicitly neutral by definition |
| `cancelled` | drop | a human stopped it; not a code failure |
| `skipped` | drop | did not run |
| `stale` | drop | superseded by a newer run |
| `action_required` | drop | needs a human, not a failure signal |
| `null` / absent | drop | genuinely inconclusive |

Order 0006 said "an inconclusive `check_suite` must not map to `ci_failed`". That wording was
imprecise: `timed_out` is not inconclusive. The rule is **conclusive failures map, everything
else drops.**

Why dropping `timed_out` was worse than it sounds: to an agent, **silence reads as "not
finished yet"**. Dropping a terminal failure does not merely lose information, it installs the
wrong belief.

**Implement this as an allowlist table with an explicit default-drop, not a chain of `if`s**,
so the whole allowlist is visible at once. Then test a conclusion GitHub has not invented yet:
absent from the table must mean drop, so a future value cannot default into a red badge on a
task whose CI never reported one. A permissive default is invisible until it misfires.

The string `"true"` assertion in D5b matters on Catalyst specifically, where booleans are
stored as strings and `"false"` is truthy in JS. It is the shape a JSON quirk actually takes.

## Composite key construction — either rule, never neither

Two correct approaches. Pick one per build and be consistent. What is forbidden is
concatenating with a separator and not policing it.

**A. Separator with rejection.** `"proj_01:task_items_crud"`, and the builder rejects any part
containing the separator, so `"a:b"+"c"` cannot collide with `"a"+"b:c"`.
*Pro:* the stored value is human-readable, so a row is debuggable on sight.
*Con:* the collision class exists and must be actively policed.

**B. Hash each part separately, then combine the digests.** Both operands become fixed-length
hex, so there is no separator to police and the collision class **cannot exist**.
*Pro:* eliminates the class by construction, and the fixed length sidesteps Catalyst's
silent `varchar` 255 clamp entirely.
*Con:* the stored value is opaque; you cannot tell which project or task a row belongs to
without a lookup.

Either way, assert it: `scopedKey("a:b","c") !== scopedKey("a","b:c")`.

This is **not** a platform asymmetry — both approaches are available to both builds.

## Testing rule: assert correlation, not count

**A test that cannot distinguish the bug from the fix is worse than no test**, because it
converts an open question into false confidence.

Worked example, from A1b. The weak assertion is "for each idempotency record, some event exists
at that `seq`". That **passes while the records are cross-wired to the wrong events** — which is
exactly the corruption mandatory behaviour 1b exists to prevent. The counts are right; the
correlation is wrong.

The correct assertion pairs the two: an event exists at that `seq` **and** carries the same
key. Apply this shape wherever a test checks that two things were written consistently:

- A2 exactly-one claim: assert the winner's `agent_id` matches the row, not just that one
  call returned `ok:true`.
- A7 scope conflict: assert the returned conflict names the actual holder, not merely that a
  conflict was returned.
- D4 webhook replay: assert the ledger contains the original event, not just that the count
  did not increase.

Ask of every assertion: *would this still pass if the values were correct in number but wired
to the wrong records?* If yes, it is not testing the thing you care about.

## Substitution rule: only when nothing measured changes

Two substitution requests, two different answers, and the test that separates them is worth
stating.

**Refused — Stratus.** Bucket creation is browser-gated, and substituting Filestore or Cache for
the snapshot was rejected because **the measured read path *is* route C1.** Snapshot-via-CDN at
34 ms against 1,347 ms for git is the reason C1 was chosen over C2. Substituting would have
produced a number that looks like evidence for a design nobody chose.

**Permitted — Cron → Job function.** A cron-type function is unreachable programmatically: HTTP
invocation returns 403 `HTTP Execution is not supported`, `functions:execute` needs a runtime
binary the machine lacks, and the Job Scheduling API refuses it with *"The given function is not
a job function."* A Job function was substituted, and nothing measured changed: the reaper's
schedule appears in no G-metric, and F11's criterion — released within 15 minutes — is satisfied
identically either way.

**The rule.** A substitution is permitted if and only if **nothing measured or claimed changes.**
The burden is on whoever substitutes: name what would change, and show that it does not. Record
it either way. If the answer is "I am not sure whether this changes a measurement", the answer is
no — stop and ask.

## Verifying the parts is not verifying the whole

Found late and worth stating: three things had been separately verified — the endpoints via
`curl`, the status→error mapping via an injected fetch, and the adapter against the real
service. Only the first two had actually run. **The adapter had never been exercised against the
live backend at all**, and it was being reported as done on the strength of the other two.

The middle one passing says nothing about the third. This is the mirror of the retry-loop rule:
that one says a working path is not evidence its sub-operations work; this one says working
sub-operations are not evidence the path works. **Both directions need their own test.**

## An assertion that cannot tell success from a specific failure is not an assertion

The worked example, found by accident and now a permanent test. An "emoji is stripped" check
failed on an empty string. Not a bug: the check appended a **human-layer** `task_progress` event
and read it back through an **agent-audience** read, which correctly withheld it.

So *the filter working* and *the write failing* produced the **identical observation**.

Two fixes came out of it, and the second is the important one:

1. The emoji check now uses a coordination-layer kind, so it can read its own write back.
2. **"Human-layer event withheld from an agent" is now A16, asserted against the real backend.**

That second point closes a real gap. The protocol calls that exclusion its most important rule —
the thing that keeps agents coherent over a long session — and **nothing had verified it live
until an accident did.** A16 requires both halves: assert the human-layer event is absent *and*
that a coordination-layer event is present, because absence alone cannot distinguish a working
filter from a broken write.

## Timestamp every gate re-probe

"Still shut" is ambiguous about **when**. If a human's console visit lands at 07:40 and the probe
ran at 07:32, the result says nothing about it — and whoever compares the two later cannot tell.

Record the UTC instant of every gate re-probe alongside the verbatim error. Cheap, and it is the
difference between a result and an anecdote.

## Check the SIZE of a mechanical edit, not just its result

A scripted fix to a notes file looked correct and had **deleted 999 lines** — a DOTALL regex
matched too greedily. `git diff --stat` caught it before the commit.

> I checked the *result* of the mechanical edit and it looked right, when what I needed to check
> was its *size*.

Same family as the retry loop hiding a cost and a successful read not being a probe: the
observation made could not distinguish *"fixed one line"* from *"fixed one line and deleted a
thousand"*.

**`git diff --stat` is the correlation check for edits.** Run it before every commit that a script
or regex produced, and read the line counts rather than glancing at the file.

## The check you reach for first is often the one that cannot answer

A worked case, and it is the sharpest instance of the unifying rule below.

Stratus bucket creation is gated on a first-time browser session. The obvious way to test whether
the gate cleared is *"is Stratus reachable?"* — and `Get_All_Buckets` **succeeded and returned
`[]` before activation as well as after.** A successful read was never evidence of anything.

> If someone had asked "is Stratus reachable", the answer was yes, and it was useless.

Only the **write** distinguishes the states, because only the write is gated.

**Rule: test the operation that is actually restricted, not the nearest one that responds.** A
neighbouring call succeeding is not evidence about the call you care about — it is the
sub-operation fallacy again, one layer out: working reads are not evidence that writes work, any
more than a working path proves its sub-operations do.

Before treating a probe as evidence, ask: **would this have given the same answer in the broken
state?** If yes, it is not a probe, it is a formality.

## The unifying rule: unverifiable is not true

Three separately-discovered rules have converged, so state the general form once.

- **Missing is drift** — a guard must treat *absent* as a violation, not as "nothing to check".
- **A permissive default is invisible until it misfires** — an allowlist needs an explicit
  default-drop, tested with a value nobody has invented.
- **Tooling that reports success from an unverified premise** — three real cases, all failing
  permissively:
  - a provisioning script concluded "the name is free" from a **failed parse**
  - a test runner read `fail` and **ignored `cancelled`**
  - an emulator readiness probe asked "is anything listening on 8080" rather than "is **my**
    backend listening", so overlapping runs silently shared one backend

**The general form: any check that cannot distinguish "verified true" from "could not verify"
must fail.**

Not warn, not default, not proceed. The failure mode is always the same shape — the check reports
success, the premise was never established, and nothing surfaces until something downstream
depends on it. Applies to guards, allowlists, readiness probes, parsers, and any script whose exit
code is read by something else.

## Guard rule: missing is drift

A consistency guard must treat **absent** as a violation, not as "nothing to check". If the
`_lib` drift guard had stayed quiet about missing copies to avoid a false positive from a
test's own cleanup, it would have been broken in the direction that matters — a deploy with no
vendored library would have passed.

When a guard fires on something your tooling caused, fix the tooling. Do not soften the guard.

## H. Non-negotiables

Fail any of these and the build is not done, regardless of everything else.

- [ ] No silent failure anywhere. Every dropped, capped or truncated thing is logged.
- [ ] No catch-all error handling. Every caught error is named and handled or rethrown.
- [ ] Agents cannot merge. Verified by attempting it.
- [ ] `agent_id` is never accepted from the client. Verified by forging one.
- [ ] Concurrent claim test A2 passes 50 consecutive runs.
- [ ] Both `.agentic/` trees are byte-identical (B2).
- [ ] Both builds pass the same suite with only the adapter swapped.
- [ ] Every capped list logs what it dropped.
- [ ] Emoji behaviour is identical across adapters.
- [ ] `G10` written independently, before comparing.
