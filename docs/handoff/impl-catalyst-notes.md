# impl/catalyst — build notes

Route C1 "Snapshot". Branch `impl/catalyst-v1`. This file is the report: every constraint
hit, every workaround, honest hours. Appended to as work proceeds, never rewritten.

Created under order 0001 / 0003, which authorise this path. `docs/` is otherwise off limits
to this workspace.

---

# Order 0003 — the `is_unique` probe result

**Question: does `is_unique: "true"` work on a `varchar` column in Catalyst Data Store?**

## Answer: YES. Probed against a real table. No `bigint` hash needed.

## Claim mechanism being built

**`varchar` + `is_unique`** — the preferred, simplest option in the handoff. The documented
`bigint`-hash-of-`task_id` fallback is **not needed** and is not being built.

`claimTask` inserts into `task_claims` with `task_id varchar(255) is_unique`, and catches
`error_code: "DUPLICATE_VALUE"` to return `{ok: false, owner}`. No read-verify-write anywhere.

## Where and when

| | |
|---|---|
| Org | `60083782173` |
| DC | `catalystserverless.in` (IN) |
| Project | `Project-Rainfall` `53069000000013030` — see caveat below |
| Environment | Development |
| Date | 2026-08-25 |
| Via | Catalyst MCP Data Store API (`CatalystbyZoho_*`) |

**Caveat on the project:** the handoff arrived with the Catalyst project ID unfilled
(`<paste>`), so there was no project designated for this build. The probe ran in
`Project-Rainfall`, an empty scratch project on the same test tenant (zero tables before,
zero after), in a throwaway table that was deleted immediately afterwards. `is_unique`
enforcement is a platform property, not a per-project one, so the answer holds for whichever
project this build is eventually pointed at. **A project ID is still needed for step 3.**

## 1. The table

Request — `CatalystbyZoho_Create_Table`:

```json
{ "table_name": "probe_is_unique_varchar", "table_scope": "GLOBAL" }
```

Response: `status: success`, `table_id: "53069000000049001"`.

## 2. The column spec

Request — `CatalystbyZoho_Create_Column`, `body` is an array:

```json
[
  {
    "data_type": "varchar",
    "column_name": "task_id",
    "max_length": 255,
    "is_unique": "true",
    "is_mandatory": "true",
    "search_index_enabled": "false",
    "audit_consent": "false",
    "description": "probe: does is_unique hold on a varchar column"
  }
]
```

Note the flags are the **strings** `"true"` / `"false"`, not JSON booleans. The API schema
requires them that way.

Verbatim response:

```json
{
  "table_id": "53069000000049001",
  "column_sequence": 5,
  "column_name": "task_id",
  "category": 2,
  "data_type": "varchar",
  "audit_consent": false,
  "max_length": 255,
  "is_mandatory": true,
  "description": "probe: does is_unique hold on a varchar column",
  "is_unique": true,
  "search_index_enabled": false,
  "column_id": "53069000000050001"
}
```

`is_unique: true` came back set. It was accepted, not silently dropped.

Supporting evidence from the API schema itself: `is_unique` is listed as **allowed and
required** for `varchar`, `int` and `bigint`, and is **not offered at all** for `text` or
`encrypted text`. That is a second reason `pr_url`, titles and summaries cannot be
uniqueness-constrained — they must be `text`, and `text` has no `is_unique`.

## 3. The enforcement test

First insert — `CatalystbyZoho_Insert_Rows`:

```json
[{ "task_id": "task_items_api", "agent_id": "agent_be01", "clamp_probe": "short" }]
```

Response: `status: success`, `ROWID: "53069000000052001"`.

Second insert, same `task_id`, different agent:

```json
[{ "task_id": "task_items_api", "agent_id": "agent_fe01", "clamp_probe": "duplicate attempt" }]
```

Verbatim response:

```json
{
  "status": "failure",
  "data": {
    "message": "Duplicate value for task_id. Please give a different value",
    "error_code": "DUPLICATE_VALUE"
  }
}
```

**Rejected, with a machine-readable `error_code`.** `claimTask` can catch exactly
`DUPLICATE_VALUE` and nothing else — no string-matching on a human-readable message, and no
catch-all that would swallow an unrelated failure as "someone else won the claim".

## 4. Four further results from the same table

| # | Probe | Result | Consequence for the build |
|---|---|---|---|
| P4 | Case sensitivity of the constraint | **Case-sensitive.** `TASK_ITEMS_API` inserted happily alongside `task_items_api`. | Task IDs must be normalised before the claim INSERT, or `Task_A` and `task_a` are two live claims on one task. |
| P5 | Batch INSERT containing one duplicate | **Atomic.** `[{fresh}, {duplicate}]` failed whole with `DUPLICATE_VALUE`, and the fresh row did **not** land (confirmed absent by ZCQL). | The event row and its `request_dedupe` row can go in one batched INSERT — no partial-append window, no compensating delete. |
| P6 | `varchar max_length: 300` | **Silently clamped to 255, twice.** DDL returned `max_length: 255` with `status: success` and no warning. A 303-char write returned `status: success` and stored **255** chars, tail dropped, no error. | Confirms the handoff constraint. Mitigation: the insert response echoes the **truncated** value, so the adapter can compare sent-vs-returned and log the loss. `shared/sanitize.ts` already clamps and logs before the write. |
| P8 | Emoji / 4-byte UTF-8 | **Not corrupted.** `"shipped it 🚀 done ✔ 𝕏"` written to a `varchar` and read back via ZCQL came back byte-intact. No `?` substitution. | Does **not** change the plan — the protocol requires both builds to strip so behaviour matches, and `shared/sanitize.ts` still strips. But G9 must record this honestly as a documented constraint that **did not reproduce** on this DC/tenant, not one that was worked around. |

## 5. P7 — ROWID is not monotonic. This contradicts a spec file.

Escalating rather than working around it, per `docs/orders/README.md`.

Insert order versus assigned ROWID, one table, one session:

| # | Insert (wall clock) | ROWID |
|---|---|---|
| 1 | 16:02:48 | 53069000000**052001** |
| 2 | 16:03:04 | 53069000000**044002** ← **lower than #1** |
| 3 | 16:03:16 (batch of 5) | …**053001**–**053005** |
| 4 | 16:03:24 | …**047002** ← **lower again** |
| 5 | 16:03:29 | …**051005** |
| 6 | 16:03:59 | …**054001** |
| 7 | 16:04:08 | …**047003** |

Within a single batched INSERT, ROWIDs are consecutive. Across separate INSERTs they come
from per-shard/per-block ranges and go **backwards**. `SELECT ... ORDER BY ROWID` is
therefore **not** chronological — verified directly, the ordered result set interleaves the
7th insert between the 4th and the 5th.

This breaks three published statements:

- `docs/reference/store-interface.md` — "`seq` source | `ROWID` (auto-increment bigint)"
- `docs/reference/store-interface.md` — "`readEvents` | ZCQL `ORDER BY ROWID LIMIT o,300`",
  feeding mandatory behaviour #4: "strictly ascending `seq`. Gaps are legal; reordering is
  not."
- `docs/protocol/agent-coordination.md` — "`ROWID` is global-monotonic, which is strictly
  stronger than needed." It is not global-monotonic.

`CREATEDTIME` is no substitute alone: millisecond resolution, and all five rows of the batch
carried one identical timestamp, so ties break "strictly ascending".

**Not designing around this, and not editing the shared docs.** The option that uses only
primitives verified above: a dedicated `seq bigint is_unique` column, where the append
function reads `MAX(seq)` for the project, inserts `max+1`, and re-reads on `DUPLICATE_VALUE`
— the same unique-constraint compare-and-set the claim uses, with a bounded retry. Gaps stay
legal, ordering becomes real, and it needs no primitive that has not been tested. **Awaiting
a decision before step 3.**

## 6. Cost of the probe, and a free-tier warning

1 table create, 3 column creates, 8 insert requests (11 rows), 3 ZCQL selects, 1 table
delete. Negligible in itself. Table deleted, project verified back to zero tables.

But note the shape of what is coming: **conformance test A5 alone needs 301 events ≈ 602
INSERTs per run**, against a 5,000/month free-tier INSERT budget. That is roughly 8 full
suite runs per month before A5 on its own exhausts it. Flagging early — it will dominate G6
(free-tier headroom) and it is a genuine platform difference, not a build artefact.

---

# Step 1 — `shared/store/memory.ts` + section A conformance suite

Done, and promoted to the shared branch by the coordinator as order 0002.

| File | Lines | What |
|---|---|---|
| `shared/store/types.ts` | 195 | The contract. Superset of `client/src/store/types.ts`, so a shared `Snapshot` is assignable to the client's without a mapper. |
| `shared/store/errors.ts` | 57 | `StoreError` / `StoreAuthError` / `StoreBusyError` / `StoreOfflineError` + `isRetryable`. |
| `shared/store/retry.ts` | 99 | Equal-jitter backoff. Auth errors are never retried. |
| `shared/store/memory.ts` | 711 | The in-process adapter. |
| `shared/store/conformance.ts` | 506 | Section A, A1–A15, adapter-agnostic. |
| `shared/store/memory.test.ts` | 108 | Memory harness + 4 memory-only properties. |
| `shared/sanitize.ts` | 117 | Emoji/4-byte stripping, varchar/text caps, `readBool`. |
| `shared/globs.ts` | 87 | Glob-vs-glob intersection for scope locks. |
| `shared/clock.ts` | 45 | Injectable clock + `FakeClock`. |
| `shared/log.ts` | 63 | Structured logger with a capture seam, so "it was logged" is assertable. |

1,988 lines, of which 614 are the suite and its harness. G7 (adapter LOC) will count
`catalyst.ts` alone — `memory.ts` is the reference, not the adapter.

`npm test` → 19/19 pass. `tsc --noEmit` → clean.

## Five interface mistakes the memory build found before any cloud was touched

This is the return on writing it first, as the handoff instructed.

1. **`subscribe` needed a server-side write path to be testable.** A11 ("survives a network
   drop") is untestable if the only way to append is the same client whose link is down —
   the first version of that test passed while proving nothing. The harness now requires
   `seedEvent()`, an append as *another* client. Every adapter must provide it.
2. **`layer` is derivable from `kind`, so accepting it from a caller is a hazard.** A caller
   that labels `task_progress` as `coordination` delivers human-layer chatter to every agent
   — the one rule the protocol calls its most important. `LAYER_OF` is now the authority and
   a mismatch throws rather than being silently corrected.
3. **`releaseScope(project, agent)` releases *all* of an agent's locks**, so locks cannot be
   keyed by agent alone. Stored as a list keyed by (agent, task).
4. **The ten operations cannot seed.** Presence needs `role_slug` / `member_label` /
   `initials` that no operation writes. Seeding is harness surface, not store surface.
5. **Section A needs four capabilities the interface does not expose**: seeding, ledger size,
   fault injection, a controllable clock. Named in `StoreHarness` so the Catalyst and
   Firebase harnesses meet an identical bar. No test skips — a skipped test is a box ticked
   without evidence.

## Deliberate choices worth flagging

- Every operation `await`s before its critical section, so A2's 20 concurrent claims
  genuinely interleave instead of passing trivially against a synchronous map.
- Appended events are deep-frozen: A6 (append-only) is structural, not a promise.
- `stats.durable_updates` stays 0 across 500 heartbeats. The free-tier constraint (1,000
  UPDATEs/month) is an assertion, not a comment.
- Glob intersection over-approximates. A false conflict costs one alternative task; a missed
  one costs the rebase the mechanism exists to prevent.

---

# Orders log

| Order | Status | Evidence |
|---|---|---|
| 0001 adopt the order channel | acknowledged | This notes file exists and is committed. Orders are now read at the start of every session via `git log --oneline origin/zoho-catalyst-app-builder -- docs/orders/`, read-only, no merge. |
| 0002 consume the shared foundation | done | Rebased onto `origin/zoho-catalyst-app-builder`. `npm test` 19/19, `tsc --noEmit` clean. `git diff origin/zoho-catalyst-app-builder HEAD -- shared/ package.json tsconfig.json` is **empty** — `shared/` is not forked. |
| 0003 record the `is_unique` probe | done | The whole first section of this file. Pushed before anything else was touched. |
| 0004 push after every commit | adopted | Order 0003's commit was pushed before the rebase was started, not batched. Standing practice from here. |

## One conflict resolved during the 0002 rebase

`package.json` conflicted add/add on a single line, the `description` field: this workspace
had written "Catalyst implementation (route C1)", the promoted foundation says "SHARED
foundation. Both impl branches consume this; neither may fork it."

**Resolved in favour of upstream**, by rule rather than preference — `package.json` is the
root workspace for `shared/`, and order 0002 freezes `shared/` to this workspace too.

The rest of commit `f5a7dce` was dropped by the rebase as already applied: its content *is*
the shared foundation, promoted verbatim. This branch is now the shared branch plus this one
notes file.

---

# Step 4a — `seq` allocation (order 0005)

`ROWID` is out; a dedicated `seq bigint is_unique` column allocated **globally** is in.
Built in `catalyst/lib/seq.ts`, tested in `catalyst/lib/seq.test.ts`, 10 tests, no cloud and
no project ID required.

## The correction the coordinator caught

My proposal read `MAX(seq)` **for the project**. Against a globally-unique column that
deadlocks, and I had not seen it: project A holds seq 6; project B computes
`MAX(seq WHERE project_id = B)` = 5, tries 6, gets `DUPLICATE_VALUE`, recomputes its own max
— still 5 — and tries 6 forever. Allocation is now global with no project filter, and the
filter moved to the read path. There is a named regression test for exactly this
(`REGRESSION: a project whose own max lags the global max does not spin`).

Second rule, same shape: on collision the candidate is **incremented, never re-read**.
Re-reading `MAX` after a collision reintroduces the spin under contention — every racer
re-reads the same value and re-collides. Incrementing walks each racer up its own ladder, so
N concurrent appends settle in N attempts worst case. Test: 20 concurrent allocators against
one unique index produce 20 distinct seqs, densely filling 101–120, nothing lost.

## `DUPLICATE_VALUE` is parsed, not pattern-matched loosely

`catalyst/lib/duplicate.ts` pulls the column name out of the message, because three unique
columns collide for three unrelated reasons:

| Column | Meaning | Correct response |
|---|---|---|
| `seq` | another append raced us | increment the candidate, retry |
| `idempotency_key` | the caller replayed | return the ORIGINAL seq, append nothing |
| `task_id` | another agent won the claim | `{ok: false, owner}` |

A catch-all that treated any `DUPLICATE_VALUE` as "someone else won" would answer a replayed
append with a fabricated claim loss. When the message does not parse, `column` is `null` and
the error is **rethrown rather than assumed to be `seq`** — a Catalyst message-format change
must surface loudly, not silently mis-route a retry into a duplicate event.

## Cost, for G4

**One extra SELECT per append**, always exactly one — asserted in the tests, not estimated.
Contention costs additional INSERT attempts but never additional SELECTs. Exhaustion at 20
attempts raises `StoreBusyError`, which is retryable, so the CLI backs off rather than
spinning.

## A frozen-file constraint hit while doing this

`package.json` is part of the shared foundation and frozen by order 0002. Its test script is
`node --test "shared/**/*.test.ts"`, which does not match this workspace's own tests, and
`tsconfig.json` includes only `shared/**`.

Not edited. Added `tsconfig.catalyst.json` instead — a **new** file, not a change to a shared
one — and this workspace's tests run explicitly:

```
npm test                                        # shared suite, 19/19
node --test "catalyst/**/*.test.ts"             # this workspace, 15/15
npx tsc --noEmit -p tsconfig.catalyst.json      # both trees
```

If the coordinator would rather the root scripts covered both trees, that is an order
request, not something to change unilaterally.

---

# Step 3 — the nine tables, declared and constraint-tested

`catalyst/schema/tables.ts` declares all nine tables from build order step 3. Declarative
rather than clicked, so the same definitions can be typechecked, asserted against the
platform's constraints, and replayed through `Create_Table` / `Create_Column` when a project
ID arrives. Nothing has been created in a cloud — that still needs the project ID.

`catalyst/schema/tables.test.ts` asserts the schema against the constraints rather than
against my intentions. **It immediately caught two real defects in my own first draft:**

1. **`events` had two unique columns**, `seq` and `event_id`. Two unique columns means an
   INSERT can fail two ways and the seq allocator, which retries only on `seq`, cannot tell
   them apart. `event_id` is minted *from* `seq`, so `unique(seq)` already implies it.
   Dropped the redundant constraint.
2. **`events.seq` tripped the composite-key rule** — correctly, since the rule exists to catch
   exactly that shape. `seq` is the deliberate exception: it is globally allocated by design
   (order 0005). Now an explicit, documented allowlist entry rather than an unstated exception.

## The trap that shaped half the schema: `is_unique` is GLOBAL, not per project

A unique column is unique across the whole **table**, not per project. So "one claim per task
per project" cannot be `unique(task_id)` — two projects that both have a task called
`task_api` would fight over one row, and the second project could never claim its own task.

Every per-project uniqueness constraint is therefore a **composite key column**:

| Table | Unique column | Shape |
|---|---|---|
| `task_claims` | `claim_key` | `<project_id>:<task_id>` |
| `scope_locks` | `lock_key` | `<project_id>:<agent_id>:<task_id>` |
| `tasks` | `task_key` | `<project_id>:<task_id>` |
| `members` | `member_key` | `<project_id>:<zuid>` |
| `roles` | `role_key` | `<project_id>:<role_slug>` |
| `events` | `seq` | globally allocated on purpose (0005) |
| `request_dedupe` | `idempotency_key` | uuid v4, already globally unique |
| `agents` | `agent_id` | server-minted, already globally unique |
| `github_links` | `repo_full_name` | `owner/repo`, already globally unique |

`compositeKey()` rejects a part containing a colon, because `"a:b" + "c"` and `"a" + "b:c"`
would otherwise produce the same key and let two different tasks collide on one claim row.

This is the same class of bug as the `seq` deadlock, and it is a real G9 entry: Firestore
needs none of this, because a transaction on a document path is naturally scoped.

## Zero UPDATEs by design

The free tier allows **1,000 UPDATEs per month**, so nothing is designed to be updated:

- `tasks` holds the task *definition*, written once. Status, branch, PR and CI are folded
  from the ledger and never stored — the schema test enforces that `tasks` has no `status`,
  `claimed_by`, `branch`, `pr_url`, `pr_number`, `ci` or `updated_at` column.
- Presence is a Cache key with a TTL, not a row. The test enforces that no table has a
  `heartbeat` column and no table is named for presence.
- `events` is append-only; the test rejects any column implying mutation.

Steady-state UPDATE count for this system is zero.

# Step 4a — the ZCQL layer

`catalyst/lib/zcql.ts`. Two things here are load-bearing.

**Injection.** The Data Store API takes a query *string*. There is **no parameter binding**,
and `project_id` / `task_id` / cursor values arrive from HTTP request bodies, so the escaper
is the entire boundary between a request and the ledger. `zqStr` doubles single quotes and
rejects backslashes and control characters outright rather than reasoning about them.
Identifiers are allowlisted, never escaped — an identifier that needs escaping is a bug, not
a value. Tested with real payloads (`proj' OR '1'='1`, a `DELETE`-appending tail), asserting
no unpaired quote survives, not merely that "a quote is present".

**The 300-row cap.** `selectEvents` requests one row *over* the limit so `has_more` is a
measured fact rather than a guess, and reports the cap to the caller instead of truncating
silently. `ORDER BY seq`, never `ROWID` — with a test that fails if `ROWID` ever reappears in
that statement.

`unwrapRows` centralises the `{ "<table_name>": {...} }` result wrapping the probe found. A
row keyed by the wrong table **throws rather than being skipped**: skipping it would be
precisely the invisible row loss the ROWID bug would have caused.

65 tests across this workspace, all green. Shared suite still 19/19.

---

# Step 4b — the GitHub webhook signature path (D1, D2, D3, D5, D6)

`catalyst/lib/webhook.ts` + 27 tests. No project ID needed; this is pure verification and
mapping logic, so it could be built while the ID is outstanding.

## The raw body is the whole point

HMAC is computed over the **raw request bytes**, never over a re-serialised object.
`JSON.parse` followed by `JSON.stringify` does not round-trip — key order, unicode escapes
and number formatting all shift — so signing the round-tripped form silently stops matching
for reasons that look like a misconfigured secret.

There is a test that proves this rather than asserting it: a hand-written raw body (not
`JSON.stringify` output) carrying insignificant whitespace, a trailing zero (`2.50`) and a
`\u00e9` escape. Round-tripped, it verifies **false**.

Writing that test caught a bug in the test itself first: the original raw body *was*
`JSON.stringify` output, so the round trip was a no-op and the test passed for the wrong
reason. The premise is now asserted explicitly (`the round trip must actually change the
bytes`) so it cannot silently degrade again.

This is also the concrete reason the stack requires **Advanced I/O functions** — the only
Catalyst function type that can hand you the raw body. Any JSON middleware that touches the
body before the verifier breaks D1 permanently.

## Timing-safe, and the malformed-input trap

`crypto.timingSafeEqual`, never `===` — a `===` on a hex digest leaks the length of the
matching prefix, which is enough to forge a signature one byte at a time. D3's evidence is
"code review + test", so the test is mechanical: it reads the module source and fails if
`timingSafeEqual` is absent or if digests are compared with `===`.

The trap underneath: **`timingSafeEqual` throws on a length mismatch**, so an attacker
sending `sha256=ab` would turn the verifier into a 500. The header is therefore shape-checked
(`/^[0-9a-f]{64}$/i`) before any decoding, and seven malformed headers are tested to confirm
none of them reaches the comparison.

## D5 mapping, and what is deliberately NOT mapped

| GitHub | Ledger kind |
|---|---|
| `push` | `branch_pushed` |
| `pull_request` `opened` / `reopened` | `pr_opened` |
| `pull_request` `synchronize` | `branch_pushed` |
| `pull_request` `closed` **with `merged: true`** | `merged` |
| `check_suite` `completed`, conclusion `success` / `failure` | `ci_passed` / `ci_failed` |

Two deliberate non-mappings, both of which would be wrong in a way a user would notice:

- **A PR closed without merging is dropped, not mapped to `merged`.** `merged` is the only
  field distinguishing an abandon from a merge, and a board showing "merged" for an
  abandoned PR is worse than showing nothing.
- **An inconclusive `check_suite` is dropped, not shown as failed.** `neutral`, `cancelled`,
  `skipped`, `stale` and `timed_out` are not verdicts. Mapping them to `ci_failed` would put
  a red badge on a task whose CI never ran.

Branch convention pinned here, since the docs require branch-to-task mapping without fixing
a format: **`<branch_prefix>/<task_id>`**, task id is the last segment, must match
`task_[a-z0-9][a-z0-9_-]*`. Lowercase only — the unique constraint is case-sensitive (P4).

## D6: nothing throws

Every unmappable case returns `{ok: false, reason}` for the caller to log and answer 204.
A throw becomes a 500, and a 500 teaches GitHub to retry and eventually disable the hook.
Tested with hostile payloads: no repository, a string where an object belongs, a null
`pull_request`, an empty event name.

D4's replay defence is keyed on `X-GitHub-Delivery` (`gh:<delivery_id>`), which GitHub reuses
across retries, so a replay is absorbed by the same idempotency path as any other duplicate
append. The end-to-end D4 assertion needs a reachable ledger and is not claimed yet.

---

# Step 4c — Advanced I/O handler skeletons

Six function directories under `functions/`, plus `functions/_lib/` for the shared plumbing.

**Status: skeletons, and labelled as such.** Request contract, authorisation, validation and
error mapping are written and tested; every Data Store call sits behind a port and is marked
`NOT WIRED`. Nothing can be deployed or verified without a project ID, and nothing here
claims otherwise.

The testable parts got real tests — 24 of them in `functions/_lib/auth.test.ts`.

## H4 — `agent_id` is never accepted from the client, verified by forging one

Two layers, because one was not enough:

1. `rejectServerOwnedFields()` **rejects** a body carrying `agent_id`, `actor_id`, `seq`,
   `event_id` or `created_at` with a 400. Rejected, not ignored — H4's evidence is "verified
   by forging one", so a forgery must be refused rather than quietly dropped.
2. A **mechanical test walks every handler's source** and fails if any of them reads
   `body.agent_id`. The forgery test only proves the helper works; this proves no handler
   bypasses it.

`actor_id` on every appended event comes from `principal.agent_id`, which is resolved from
the bearer token on every request.

## H3 — agents cannot merge, verified by attempting it

`requireMergePermission()` throws unless the role explicitly grants it. The test attempts a
merge as a backend role and asserts refusal, then asserts that `can_merge` values `"false"`,
`"FALSE"`, `"0"`, `""`, `"no"`, `undefined` and `null` all fail closed.

That list is the point. Data Store returns booleans **as strings** and `Boolean("false")` is
`true`, so a direct read would grant merge to every agent whose role explicitly forbids it.
Every fixture in the auth tests uses string booleans deliberately — a fixture using real
booleans would hide exactly the bug the code guards against.

## Error mapping decides what the client does next

| Error | Status | Why that status |
|---|---|---|
| `StoreAuthError` | 401 | the CLI **stops**; retrying a revoked token burns quota and never succeeds |
| `StoreBusyError` | 429 + `Retry-After` | the CLI backs off with jitter |
| `StoreOfflineError` | 503 | the CLI queues to its outbox and keeps working |
| `StoreError` | 400 | a bad request is not a server fault |
| anything else | 500 | the only thing that produces a 500 |

## Two ordering decisions worth recording

**Append writes the dedupe row FIRST**, carrying the seq it reserved. A crash between the two
writes leaves a dedupe row whose event is missing, and the replay path completes the write
with the *same* seq. The reverse order would let a crash produce two events for one request,
breaking A1 permanently. The orphan-completion path logs when it fires.

**The webhook parses JSON only after verifying**, and the pre-verification parse used to find
the repo is explicitly untrusted and used for routing only.

## A deploy question I cannot resolve yet

Catalyst deploys each function directory independently, so shared code in `functions/_lib/`
is either copied in at package time or published as a package. That is unresolved and on the
blocked list rather than silently assumed to work.

## Test counts

```
npm test                                        19/19   shared conformance suite
node --test "catalyst/**/*.test.ts" \
             "functions/**/*.test.ts"          116/116  this workspace
npx tsc --noEmit -p tsconfig.catalyst.json      clean
```

---

# Order 0006 — composite keys confirmed, and one deviation I had to fix

## Confirmed against the corrected mandatory behaviour 2

The composite scheme already matched the corrected wording for `task_claims` and
`scope_locks`, with `events.seq` exempt as the deliberate global. There is now a test that
asserts exactly the three tables the behaviour names.

## But it did NOT match for `request_dedupe`, and that was a real bug

I had reasoned `idempotency_key` was "globally unique already, so no composite needed" —
uuid v4 from the caller. The corrected behaviour names `request_dedupe` explicitly, and it is
right and I was wrong. The key is **client-supplied**. With `is_unique` table-global, a client
in project A sending a key that collides with project B's would make project B's append be
absorbed as a duplicate and return someone else's `seq`.

That is worse than the claim case. A claim collision is a denial of service — annoying,
visible, recoverable. This one is **silent cross-tenant event loss**: the append returns 200
with a plausible seq, and the event simply never exists.

Fixed: `request_dedupe.dedupe_key` is now `<project_id>:<idempotency_key>`, with the raw key
kept alongside for diagnostics. Tests assert two projects sharing one client-supplied key do
not collide.

**This forced a second change.** `deliveryIdempotencyKey` returned `gh:<delivery_id>`, and a
colon inside a composite part is exactly what `compositeKey()` rejects. It now returns
`gh_<delivery_id>`, with a test asserting it stays separator-free. The separator rule earned
its keep by catching a key format I had already written.

Third defect from "unique" meaning table-global, counting the seq deadlock and the claim key.
The standing rule in 0006 — treat any new `is_unique` column as global until a probe says
otherwise — is the right conclusion, and I would add: the failure mode gets quieter each
time. Deadlock, then denial of service, then silent data loss.

## G9 asymmetries — Catalyst paid, Firebase did not

Recording these plainly now so they are not smoothed over later:

| Guarantee | Catalyst cost | Firebase cost |
|---|---|---|
| Exactly-one claim, per project | composite key scheme across 5 tables, plus a builder that rejects the separator | none — a transaction on a document path is naturally scoped |
| Strictly ascending `seq` | global allocator, one extra SELECT per append, bounded retry loop | none — a counter doc inside `runTransaction` |
| Injection safety | hand-written escaper as the sole boundary, tested against attack payloads | none — the SDK is parameterised |
| Idempotency | client-supplied key must be project-scoped by hand | doc id = key, scoped by collection path |

Four guarantees, four places Catalyst needs a mechanism Firestore gets from its data model.
None of them is exotic; all four were found by probing rather than reading.

# Order 0006 section 3 — the `_lib` copy step

`catalyst/tools/sync-lib.ts`, plus 11 tests.

```
node catalyst/tools/sync-lib.ts           # write the copies (predeploy)
node catalyst/tools/sync-lib.ts --check   # verify, write nothing, exit 1 on drift
```

Copies land in `functions/<name>/_vendor/`, are gitignored, carry a `GENERATED FILE -- DO NOT
EDIT` banner naming their source, and are always overwritten wholesale. `functions/_lib` stays
the single source of truth.

Two details that would have bitten at deploy time:

1. **Imports are re-pointed.** A copy sits one level deeper than its source, so
   `../../shared/` becomes `../../../shared/`. Without that the copies compile as broken
   imports and it surfaces only at deploy — the worst moment to find out.
2. **`tsconfig.catalyst.json` excludes `_vendor`.** The copies are byte-identical to source,
   which is already checked, so including both would duplicate every declaration.

The guard covers three kinds of drift, each with a test that deliberately causes it: an
**edited** copy, a **missing** copy, and an **orphaned** copy whose source was deleted.
`--check` reports and never repairs — a check that quietly fixed things would let CI go green
on a working tree that still contains the edit.

---

# The schema dry run, and the bug it caught

`catalyst/testing/` — a Data Store double plus 23 tests that drive the **real** handlers
(`handleClaim`, `handleAppend`, `handleEvents`, `handleWebhook`) and the real ZCQL builders
through the declared schema. Only the Data Store underneath is a double.

The double reproduces the behaviours the probe **measured**, not the ones I assumed: global
case-sensitive `is_unique` with the verbatim `DUPLICATE_VALUE` payload, atomic batch inserts,
silent varchar clamping on DDL and write, booleans stored as strings, and **non-monotonic
`ROWID` allocation from per-shard blocks**. A fake that was merely "a map with unique keys"
would pass code the real platform breaks, which is worse than no fake at all. It refuses to
answer a ZCQL statement it does not recognise rather than returning `[]` and letting a typo
read as "no rows".

## It found a real bug in `append`, visible only under concurrency

Twelve concurrent appends: **one succeeded, eleven failed.**

The dedupe row was being written *inside* the seq retry loop. When attempt 1 lost the seq
race, attempt 2 re-ran the whole closure and re-inserted **the same dedupe row**, colliding
with a key it had itself written a moment earlier. Every contended append died on its own
previous attempt.

The obvious fix — hoist the dedupe insert out of the loop — is wrong in a worse way. The
dedupe row has to record the seq the event **actually** got, and that is not known until the
retry settles. Recording the first candidate would make a later replay return a seq belonging
to a **different event**: silent corruption, which beats a loud failure only in the sense that
nobody notices.

So the write order is now the opposite of what I originally argued for, and for a better
reason:

**Event first, carrying its `dedupe_key`. Then the dedupe row.**

- a seq collision retries the event insert alone, which touches exactly one unique column and
  therefore cannot collide with its own earlier attempt;
- the dedupe row is written once, with the settled seq;
- the crash window (event written, dedupe row missing) is recoverable **without an UPDATE**,
  because `events.dedupe_key` can be read back and the orphan's seq adopted.

`events.dedupe_key` is deliberately **not** unique — the unique guard stays on
`request_dedupe`, so the seq retry keeps exactly one column to fight over. That is the same
rule the schema test enforced back when it made me drop the redundant `unique(event_id)`.

There is also now a `lost_dedupe_race` path: if a concurrent request with the same
idempotency key wins the guard after we have already written our event, we report **the
winner's** seq rather than our own.

I would not have found this by reading the code, and it would have surfaced on the real
backend as "appends fail intermittently under load".

## What else the dry run covers

- exactly-one claim across 20 concurrent callers, and the loser told who owns it
- two projects claiming the same task name independently (the composite key earning its keep)
- two projects using the **same client-supplied idempotency key** without collision
- A1 replay, A4 strict ascent, dense seq under 12 concurrent appends
- events read back in `seq` order **while the fake's ROWIDs run backwards** — a regression to
  `ORDER BY ROWID` visibly reorders here
- a cursor walking the whole ledger with no gaps or repeats
- human-layer events withheld from agents but shown to the dashboard
- project isolation on read
- webhook end to end: signed push lands one event, replayed delivery appends nothing (D4),
  tampered body writes nothing (D2), unknown repo dropped with 204 and logged (D6)

Two of those tests failed for test-harness reasons first (a mis-scoped fixture and passing a
row where the API takes an array) — worth noting only because the API really does take an
array, so the double had the honest signature and my call site was wrong.

---

# Order 0008 — confirmed against the split mandatory behaviour 1

`store-interface.md` now splits behaviour 1 into 1a (the key is client-supplied, scope it per
project) and 1b (the record must store the seq the event ACTUALLY received). Both were
already implemented — 1a as `dedupe_key = <project_id>:<idempotency_key>`, 1b as the
event-first write order — but 1b was only covered implicitly, so it now has two named tests:

- **every dedupe row records the seq its event actually received.** Twelve concurrent
  appends, then for each dedupe row assert an event exists at that seq *and* carries the same
  `dedupe_key`. Not merely "some event at that seq" — that weaker check would pass while the
  rows were cross-wired.
- **a replay after contention returns the settled seq, not a candidate.** Warm the ledger so
  allocation starts contended, append, replay, assert the replayed seq belongs to a real
  event carrying the right key.

## A self-inflicted drift alarm, and what it says about the guard

Running the suite immediately after a rebase made `sync-lib --check` fail on twelve missing
copies. Not a real drift: `sync-lib.test.ts` deliberately deletes and corrupts the vendored
copies, and its cleanup left the tree empty. The very next `--check` then reported drift it
had caused itself.

Harmless but bad ergonomics — a red build that says nothing about the code under test. The
cleanup now re-syncs instead of clearing, so the tree is left valid. Worth recording because
the guard behaved *correctly*: the copies genuinely were missing, and "missing" is drift. The
defect was in the test's housekeeping, not the check.

---

# Order 0010 — `timed_out` corrected, territory check clean

## I had `timed_out` wrong, and the ruling is right

My mapping dropped `timed_out` along with `neutral`, `cancelled`, `skipped` and `stale`, on
the reasoning that an inconclusive result must not show a red badge. `timed_out` is not
inconclusive: it is a **conclusive terminal failure**, GitHub renders it with a red X, and
dropping it leaves the board silent while the agent goes on believing CI is still pending.
That is a worse outcome than a slightly generous label — silence reads as "not finished yet",
which is precisely the wrong belief.

The mapping is now a table rather than a pair of `if`s, so the whole allowlist is visible at
once:

| `conclusion` | Maps to |
|---|---|
| `success` | `ci_passed` |
| `failure` | `ci_failed` |
| `timed_out` | `ci_failed` |
| `neutral`, `cancelled`, `skipped`, `stale`, `action_required`, `null`/absent | drop |

Absent from the table means drop, so a conclusion GitHub adds later drops rather than
defaulting to failed. There is a test for that specific case (`quantum_undecided`), because
the failure mode of a permissive default is a red badge on a task whose CI never reported one.

D5b now has its four assertions plus a fifth: `merged` must be strictly `true`, and the string
`"true"` must not satisfy it either.

## Territory check — clean

```
git diff --stat origin/zoho-catalyst-app-builder HEAD -- \
  docs shared package.json tsconfig.json \
  client/src/components.tsx client/src/tokens.css \
  client/index.html client/tsconfig.json client/src/store/types.ts
```

One file: `docs/handoff/impl-catalyst-notes.md`, which `territory.md` lists as **per-build**
— it is this report. Everything else in the frozen set is byte-identical.

## The test-resolution axis, checked four ways

The Firebase build found its test files sitting under `shared/`, so root `npm test` reported
25 on its branch and 19 here — meaning "both builds pass the same tests" would have been
measured by two different commands while appearing to be one. That is the headline claim of
the whole exercise, and it would have been quietly false.

Confirmed clean here, checking both directions rather than just the obvious one:

1. The only test file under `shared/` is `shared/store/memory.test.ts`, **byte-identical** to
   the shared branch — I own no test there.
2. The root `test` script is character-for-character identical to the shared branch's.
3. `npm test` reports **19 on my branch and 19 on the shared branch**, verified by running it
   in a throwaway worktree of the shared branch rather than by inspection.
4. Neither command leaks into the other: root `npm test` picks up nothing from `catalyst/` or
   `functions/`, and my command does not re-run the shared conformance suite.

All eight of my test files live under `catalyst/` or `functions/`.

## Composite keys — staying with the separator rule

Firebase hit MB1a one field over from where it was predicted: its `event_id` derived from the
client-supplied key with no project in it, so two projects sharing a key produced two events
with one `event_id`. Its fix hashes each part separately and combines the digests, which makes
the `"a:b"+"c"` class structurally impossible rather than policed, and sidesteps the varchar
255 clamp.

Both approaches are permitted; a separator with no policing is what is forbidden. Staying with
the separator plus rejection, deliberately: it is tested, it has already caught two real
things (the `gh:` delivery key and the ambiguity itself), and it keeps rows **readable** — you
can look at a `task_claims` row and see which project and task it belongs to. The hash version
destroys that, which matters for a system whose failure mode is a human squinting at a claim
row wondering why an agent is blocked.

---

# Blocked on the coordinator

1. **Catalyst project ID** for this build — the handoff said `<paste>`. Needed for step 3.
2. **Demo GitHub repo** — also `<paste>`. Not needed until step 8.
3. **The ROWID/`seq` decision** (P7 above). Blocks step 3 (tables) and step 4 (`append`).

# Hours

| Session | Wall clock | Work |
|---|---|---|
| 1 | ~1.5 h | Spec read, `shared/` foundation, section A suite, `is_unique` probe |
| 2 | ~0.3 h | Orders 0001–0003: probe recorded, rebased onto shared foundation |

---

# Order 0015 — PROVISIONED. Every resource, verbatim.

## Catalyst

| | |
|---|---|
| Project name | `multiplayer-agents` |
| Project ID | `53069000000062004` |
| Org | `60083782173` |
| Environment | Development only |
| Domain | `multiplayer-agents-60083782173.development` |
| DC | `catalystserverless.in` |

Verified by `catalyst project:list --org 60083782173 -ni` before selecting — the ID in 0015
matches what the platform reports. `onam-utsavam` and `Project-Rainfall` were listed but
neither was read, written nor selected.

`catalyst project:use multiplayer-agents --org 60083782173 -ni` → "Successfully made project
active", **< 1 s**, wrote `.catalystrc`.

## Table IDs, verbatim

| Table | `table_id` |
|---|---|
| `events` | `53069000000057006` |
| `request_dedupe` | `53069000000063003` |
| `task_claims` | `53069000000063362` |
| `scope_locks` | `53069000000058006` |
| `tasks` | `53069000000061002` |
| `agents` | `53069000000064004` |
| `members` | `53069000000053012` |
| `roles` | `53069000000051019` |
| `github_links` | `53069000000055010` |

Nine tables, 63 declared columns, all created from `catalyst/schema/tables.ts` via
`toCreateColumnPayload` rather than typed by hand — the schema that was dry-run tested is
literally the schema that was provisioned.

**Table IDs are non-monotonic too**: 57006, 63003, 63362, 58006, 61002, 64004, 53012, 51019,
55010, created in that order. Same per-shard block allocation as `ROWID`. Anything that sorted
resources by ID would list them in a fictional order.

## GitHub

`gh repo create Sibhimanyu/inventory-tracker-catalyst --private` → **4 s**, one command, no
browser. `https://github.com/Sibhimanyu/inventory-tracker-catalyst`

## Provisioning cost

| Step | Cost |
|---|---|
| Verify + select project | 2 CLI commands, < 1 s |
| 9 × `Create_Table` | 9 API calls, ~40 s wall clock |
| 9 × `Create_Column` (batched per table) | 9 API calls + **2 failures**, ~50 s |
| GitHub repo | 1 command, 4 s |
| **Browser steps** | **zero** |

The project itself was created by the human before this order. There is no
`catalyst project:create` — the coordinator verified that wall independently.

## A new platform finding: column `description` has an undocumented charset

The first `Create_Column` call for `events` failed:

```json
{"status":"failure","data":{"error_code":"PATTERN_NOT_MATCHED",
 "message":"Please check whether the input values are correct"}}
```

Bisected in two calls. The columns were fine; the **`description` field** was rejected.
Confirmed by probe:

- `"Minted from seq. Deliberately not unique."` → **accepted**
- `"contract | coordination | human -- derived from kind, never trusted <caller>"` → **rejected**

So `|`, `<`, `>` and `--` are not accepted in a column description. The error names **neither
the field nor the offending character**, and `PATTERN_NOT_MATCHED` is identical whatever is
wrong — so a caller learns only "something in this payload". Descriptions are now generated
through a `[A-Za-z0-9 .,]` filter.

Two mitigating facts worth recording: the failure was **atomic** (no partial column creation —
`List_All_Columns` confirms `events` has exactly its 10 declared columns and the probe column
`probe_desc_dashes` does not exist), and it failed at DDL time rather than silently mangling
the value the way `varchar` clamping does.

## Confirmations from real provisioning

- `text` columns come back with `max_length: 10000` — the documented cap, now measured.
- `bigint` comes back `max_length: 19`.
- `is_unique: true` accepted on `varchar` **and** `bigint` in production use, matching the probe.
- `text` columns carry no `search_index_enabled` in the response, consistent with the API
  schema refusing it for that type.

---

# G-metrics — real numbers, measured 2026-08-26

All against the deployed function on `multiplayer-agents`, IN DC, from a laptop in
Asia/Kolkata. **Measurement discipline applied to my own numbers**: the first call of every
run is reported separately and never folded into the percentiles, because a cold start is a
real cost but one sample — averaging it in makes the warm p50 look worse *and* hides the cold
cost. Failures are counted, not dropped.

## G1 — publish → visible, n=100

| | append returns | publish → visible |
|---|---|---|
| p50 | **202 ms** | **318 ms** |
| p95 | **281 ms** | **419 ms** |
| p99 | 334 ms | 561 ms |
| min / max | 187 / 334 ms | 294 / 561 ms |
| mean | 211 ms | 330 ms |
| cold first call | 310 ms | 439 ms |
| failed | 0 / 100 | 0 / 100 |

**What "visible" means here, precisely.** A fresh reader polling `/events` sees the event.
This is the **ledger read path, not the folded-snapshot path** — the Stratus snapshot builder
is build-order step 5 and does not exist yet, so the 34 ms Stratus figure in the design doc is
*not* what this measures and these numbers must not be compared to it. Every one of the 100
was visible on the first read attempt, so the number is append + one round trip, with no
convergence delay to wait out.

## G2 — claim round-trip, n=200

| | |
|---|---|
| p50 | **127 ms** |
| p95 | **182 ms** |
| p99 | 409 ms |
| min / max | 113 / 1186 ms |
| mean | 139 ms |
| cold first call | 252 ms |
| won | 200 / 200 |

The `max` of 1186 ms against a p95 of 182 ms is the shape worth noting, not the number: one
sample in 200 took **9× the p95**. A single outlier is not a threshold and I am not treating it
as one, but a claim that occasionally takes over a second is a real user-visible stall, and it
is the kind of tail that a mean of 139 ms conceals completely.

Each of the 200 claims was a distinct task, so every one performed a real INSERT that won its
unique constraint. Wall clock for the whole run: 28 s. G1's 100 publishes plus 100 visibility
reads: 34 s.

## G4 — operations consumed, per action

Counted at the call sites in `functions/coordination/index.ts`, then cross-checked against the
durable rows the session left behind. `COUNT(ROWID)` confirms **201 `task_claims` + 101
`events` + 101 `request_dedupe` = 403 rows**, matching the computed INSERT total exactly.

| Action | SELECT | INSERT | Actions/month on the free tier |
|---|---|---|---|
| claim (won) | 2 | 1 | 5,000 |
| claim (lost) | 3 | 1 | 3,333 |
| **append (new)** | **5** | **2** | **2,000** |
| append (replay) | 3 | 0 | 3,333 |
| readEvents (partial page) | 3 | 0 | 3,333 |
| readEvents (full page) | 4 | 0 | 2,500 |
| webhook delivery (new) | 4 | 2 | 2,500 |
| webhook delivery (replay) | 2 | 0 | 5,000 |

### The finding: SELECT is the binding constraint, not INSERT

**Every authenticated request pays 2 SELECTs before its own work starts** — token → agent,
then project+role → permissions. The protocol requires that resolution on *every* request
("The server resolves `token → agent_id → project_id → role → permissions` on **every**
request"), so it cannot be cached without weakening the guarantee it exists to provide.

Consequence: an append costs **5 SELECTs and 2 INSERTs**, so the 10,000/month SELECT allowance
runs out at **2,000 appends** while the 5,000 INSERT allowance would have allowed 2,500. The
quota that binds is the one nobody designs against.

Every planning number in the earlier notes was framed around INSERTs. That framing was wrong,
and it was wrong because it was reasoned from the schema rather than measured from a request.

## G5 — extrapolated monthly cost

At 2 people, one active project, a working day of 8 h and the observed per-action costs:

| Scenario | Appends/day | SELECT/month | Verdict |
|---|---|---|---|
| 2 people, light (20 appends/day each) | 40 | ~6,000 | inside free tier |
| 2 people, active (60 appends/day each) | 120 | ~18,000 | **exceeds** free tier in ~17 days |
| 10 people, active | 600 | ~90,000 | free tier lasts ~3.3 days |

The 10-person figure is the one that matters for the comparison: this design does not fit the
Catalyst free tier at team scale, and the reason is the mandatory per-request auth reads rather
than the ledger writes.

**Not yet priced in dollars.** Converting to pay-as-you-go needs the rate card from
`catalyst-pricing`, and I would rather report the operation counts I measured than multiply
them by a rate I have not verified.

## G6 — free-tier headroom after this session

| Quota | Allowance | Used | Remaining |
|---|---|---|---|
| SELECT | 10,000/month | **1,260 (12.6%)** | 8,740 |
| INSERT | 5,000/month | **403 (8.1%)** | 4,597 |
| UPDATE | 1,000/month | **0** | 1,000 |

**Zero UPDATEs, by design and now confirmed in production.** Presence is a Cache key with a
TTL and task status is folded from the ledger, so nothing in the steady state issues one. The
`stats.durable_updates` assertion in the memory adapter turned out to describe the deployed
system accurately.

The A5 warning from earlier holds and is now quantifiable: one full conformance run against
this backend costs ~301 appends ≈ **1,505 SELECTs and 602 INSERTs**, which is 15% of the
monthly SELECT allowance for a single test run. Order 0005's "run it against the real backend
once" was the right call, and the reason is SELECTs rather than INSERTs.

---

# Step 5 — snapshot fold done, Stratus BLOCKED on a browser step

## `catalyst/lib/snapshot-fold.ts` — done, 16 tests

Pure: rows in, `Snapshot` out, no I/O and no clock of its own, so the Event function can be a
thin wrapper. Two rules in it are load-bearing rather than stylistic:

**Ordering is by `seq` and only by `seq`.** Order 0017 made `created_at` metadata, and on this
platform it carries second resolution, so a batch of events shares one timestamp. There is a
test with two events at the *same* timestamp in opposite `seq` order, asserting the higher
`seq` wins — a `created_at` sort would silently reorder them.

**`snapshot.seq` is the highest `seq` applied**, not a count of events read, because that is
the value a caller compares `last_written_seq` against to decide "stale, not lost".

Also folded correctly and tested: a claim moves an open task to `claimed` but does **not**
override a later lifecycle status; a republished v1 never overwrites v2; presence absent from
Cache means both `offline` and `stale`; `revoked` beats a live heartbeat while the *string*
`"false"` does not revoke; an unparseable JSON column is logged rather than silently becoming
an empty `file_scope` that reads as "this task locks nothing".

## The blocker: Stratus cannot be provisioned without a browser

```
CatalystbyZoho_Create_Bucket ->
{"status":"failure","data":{
  "message":"You are not allowed to perform this operation. User needs to be in session
             when accessing Stratus for the first time",
  "error_code":"OPERATION_NOT_ALLOWED"}}
```

Not a permissions misconfiguration and not transient. `Get_All_Buckets` **succeeds** on the
same credentials and returns `[]`, so reads are allowed and only first-time creation is
gated. The CLI has no `stratus` command at all, so there is no non-browser path.

**This is the first thing in the entire build that requires a browser.** Everything up to here
— project selection, nine tables, 63 columns, function deploy, 300 measured requests — was
CLI or API. Recorded for order 0015's "anything that required a browser" question, where the
answer was previously "zero".

### What it blocks, and what it does not

Blocked: `readSnapshot`, `subscribe`, and therefore A10, A11 and A13, plus the G1 re-measure
against the *folded snapshot* path rather than the ledger path.

Not blocked, and being built next: Cache presence (A9), the cron reaper, and the scope routes
(A7, A8). The Stratus write is behind a port, so when the bucket exists it is a wiring change
rather than a rewrite.

### What I need from a human

One browser action: open **Stratus** once in the Catalyst console for `multiplayer-agents`
(project `53069000000062004`, Development). After that first session the API is expected to
work, and I can create the bucket and everything downstream without further help.

I am not attempting a workaround. Substituting Filestore or Cache for the snapshot would
change the measured read path, which is the specific thing route C1 exists to test — the
comparison would then be measuring a design I invented to dodge a provisioning gate.

# Presence and scope locks — built, deployed, verified live

Both unblocked by not needing Stratus. `/heartbeat`, `/presence`, `/scope`, `/scope/release`
are live on the deployed function.

## Presence: Cache, and the two quirks that shaped the code

Verified live: `POST /heartbeat` → 204, then `GET /presence` returns
`{"status":"working","stale":false,...}`. **Zero Data Store writes on that path** — the whole
reason it exists, since 1,000 UPDATEs/month means a 20 s heartbeat from *one* agent would
exhaust the monthly allowance in 5.6 hours.

Two documented Cache behaviours are handled explicitly, each with a test:

- **`delete()` leaves the key present with a NULL value.** So "absent" has two
  representations, and a null must read as absent rather than as a zero-valued heartbeat. The
  double reproduces the quirk rather than asserting against a clean map.
- **A write without an explicit expiry resets the TTL to 48 hours.** Every write passes one,
  and the test counts TTL-less writes and asserts zero. A heartbeat that accidentally lived
  two days would show a dead agent as connected long after the laptop closed.

One more decision worth recording: a presence value with **no usable timestamp is treated as
absent, not as live**. Defaulting to "now" would make a dead agent look alive, which is the
wrong direction to fail — the entire purpose of the value is to decide whether someone is
still there.

## Scope locks: the atomicity gap, stated rather than papered over

Catalyst has no transactions, so the glob-intersection check and the lock INSERT **cannot be
one atomic step**. `unique(lock_key)` stops a duplicate lock for the same (project, agent,
task), but it cannot stop two *different* agents with overlapping globs both passing the check
in the same instant. Firestore does this in a single `runTransaction`. G9.

Three things narrow the window, and the third is the one that actually closes it:

1. The check reads immediately before the insert, so the window is one round trip.
2. After inserting, the lock set is **re-read and re-checked**.
3. If a conflicting lock landed during the window, the loser **releases its own lock** and
   reports the conflict — rather than both agents proceeding with overlapping scope.

The tie-break is **deterministic**: the lower `lock_key` wins. Both racers compute the same
comparison from the same data, so exactly one concludes it lost. Without that, both could
yield and *neither* would hold the scope — a worse outcome than the race itself, and there is
a test asserting exactly one of `a < b` / `b < a` holds.

Both sides of the race are tested by injecting a competing lock between the pre-check and the
re-check: one test where we hold the lower key and keep the lock, one where we do not and roll
our own lock back.

One deliberate fail-closed choice: an **unparseable `globs` column is treated as `['**']`**, a
lock on everything, so it conflicts loudly. Treating it as `[]` would silently disable the
check this table exists for.

---

# Step 6 — the reaper. Working, and it exposed a bug in the append path's cousin.

Verified live: three claims, **reaped 3, failed 0** — two `stale`, one `revoked` — with three
`task_unblocked` events at seq 102–104 each naming what was released and why. Claims table
empty afterwards, so F12 ("another agent claims the released task") has nothing standing in
its way.

## Resources

| | |
|---|---|
| Job pool | `coordination_jobs` / `53069000000057394` / 256 MB |
| Cron | `reap_stale_claims` / `53069000000055385` / every 5 min / Asia/Kolkata |
| Function | `reaper` / `53069000000061375` / **type `job`** |

## It is a JOB function, not a CRON function, and that was forced

The build order says "Cron Function". A `cron`-type function turned out to be **unreachable
programmatically**:

- HTTP invocation → `403 {"error_code":"INVALID_OPERATION","message":"HTTP Execution is not supported"}`
- `catalyst functions:execute` → needs a real node18 binary on PATH; this machine has node 26
- Job Scheduling API → `{"message":"The given function is not a job function."}`

A `job`-type function is both schedulable *and* triggerable on demand through the same API, so
it is the only variant that can be tested at all. Unlike the Stratus case this is **not** a
measured component — the reaper's schedule appears in no G-metric, and F11's criterion
("released within 15 min") is satisfied identically — so substituting was legitimate rather
than a workaround that corrupts a measurement. Recorded, not silent.

Cost of that discovery: the deployed `cron` function had to be **deleted** before a `job`
function of the same name could deploy, because type is immutable on a function.

Also worth noting: "a Cron Function" is really **three** resources — a Job Pool, a Cron, and
the function — where the design doc named one.

## Two SDK traps, and one of them cost two deploy cycles

**`initialize(context)`, not `initialize(jobRequest)` and not `initializeApp()`.** A job
handler receives `(jobRequest, context)` and only the *second* can initialise the SDK. The
SDK's `initialize` accepts an object carrying `headers` (Advanced I/O) or `catalystHeaders`
(Basic I/O); `jobRequest` has neither, so it throws `invalid_app_object`. The generated
`types/job.d.ts` says this outright — *"Context … the object used to initialize the Catalyst
sdk"* — and reading it would have saved both cycles.

**Every wrong form fails identically and invisibly**: `job_status: FAILURE`,
`response_code: "Code_Exception"`, no message, and **nothing retrievable from the logs API**.

## The observability problem, and what I did about it

`Get_Logs` returns `[]` for both of this project's functions, at every level and window I
tried. A deployed function's `console.log` is, as far as I can reach it, write-only. So a pass
that silently did nothing was indistinguishable from a pass that had nothing to do.

Fix: the reaper writes its pass summary — counts, ops, and the first three failure details —
to a Cache key, and `/health` returns it. That converted a blind debug loop into two readable
answers. The failure detail rides in `ReapResult` rather than only in a log line, because a
failure that exists only in an unreadable log is a failure nobody can diagnose.

## The actual bug: ZCQL ignores an aggregate's column alias

```
SELECT MAX(seq) AS max_seq FROM events
  -> {"events": {"MAX(seq)": "101"}}
```

**The alias is discarded** — the key is the raw expression — **and the value is a string.**

`catalyst/lib/zcql.ts`'s `readMaxSeq` already handled both, because it was written against a
measured response. The reaper had a **hand-rolled reimplementation** that read `max_seq`, got
`undefined`, defaulted to `0`, allocated seq 1, and collided with an event that has existed
since the first append.

The lesson is not about ZCQL. I duplicated logic that already existed in correct form, and the
duplicate was the broken one. The reaper now calls `readMaxSeq` and `allocateSeqAndInsert`
rather than its own copies — which also gives it the retry loop it was missing.

**Why this surfaced here and not in `append`:** `allocateSeqAndInsert` increments on collision,
so a broken `MAX(seq)` read would have been *absorbed* — walking up from 1 until it found a
free seq, correct but expensive. The reaper had no retry, so it failed loudly. A retry loop
made the same class of bug invisible in one place and fatal in another; the loud one is what
got it found. Worth remembering that the append path's correctness was never evidence its
`MAX(seq)` read worked.

---

# Step 7 — `catalyst/store/catalyst.ts`. Eight of ten operations working.

`CoordinationStore` over the deployed function. Eight operations work against the real
backend; `readSnapshot` and `subscribe` throw a named `NotProvisionedError`.

## Why they throw instead of falling back

Folding the ledger client-side would have worked. That is precisely the problem: it would
report a latency for a read path that is **not the one under test**, and route C1's entire
claim is about that path. A `subscribe` that fired once with an empty `Snapshot` would let A10
pass against fabricated state, which is worse than not implementing it.

`NotProvisionedError` is a distinct type rather than a generic `StoreError` so a caller can
tell "this capability was never provisioned" from "this call failed", and
`UNPROVISIONED_OPERATIONS` is exported so a harness reports rather than guesses. Neither
operation makes a network call, so nothing can look like it half-worked.

## Also added: `/claim/release`

`releaseTask` had no endpoint. Verified live end to end:

```
claim            -> {"ok":true}
release          -> {"ok":true,"released":true}
release again    -> {"ok":true,"released":false,"reason":"no_claim"}   idempotent
reclaim          -> {"ok":true}                                        F12's mechanism
```

Releasing a task you do not own is a **no-op, not an error** — an agent whose claim the reaper
already took should not see a failure it cannot act on. The ownership read-then-delete is not
atomic, and that is acceptable here in a way it is not for *acquiring*: the only racers are the
owner's own concurrent release and the reaper, and both are trying to reach the same state.

## The status mapping is the whole contract with the retry policy

| HTTP | Becomes | Because |
|---|---|---|
| 401 / 403 | `StoreAuthError` | the CLI **stops**; retrying a revoked token burns quota forever |
| 429 | `StoreBusyError` + `Retry-After` | backs off with jitter |
| 5xx | `StoreOfflineError` | queues to the outbox, keeps working |
| other 4xx | `StoreError` | a bad request is not a server fault |
| transport failure | `StoreOfflineError` | decides whether the write is **queued or discarded** |

Getting one of these wrong is worse than failing outright: a retried 401 loops forever, an
un-retried 429 drops a write. 22 tests drive it through an injected `fetch`, so the mapping is
verified without spending quota.

Three wire details are asserted rather than trusted: the token is in `X-Agent-Token` and
`Authorization` is **absent** (the gateway would eat the request), the idempotency key is a
header not a body field, and **`agent_id` is never sent at all** — it stays in the signature
only because the interface is shared with a backend where the caller does supply it.

## What the conformance run still needs

A1–A6, A12, A14, A15 are reachable now. **A7–A11 and A13 are not**: A9 needs the presence read
through the store (available), but A10, A11 and A13 need `subscribe`/`readSnapshot`. So the
single full run stays blocked on the Stratus gate, which is the right place for it — running
18 of 19 and calling it a pass would misreport the bar.

---

# Adapter smoke against the real backend — 12/12, and NOT a conformance run

`catalyst/measure/adapter-smoke.ts`. 16 requests, roughly 50 SELECT and 8 INSECT-equivalent
writes. Permitted by order 0020 as cheap reachable signal, and labelled in the file's own
header so it cannot be mistaken for the suite.

**Why it was worth running at all.** Three different things had been verified and I had
conflated them: the *endpoints* (curl), the *status mapping* (injected fetch, 22 tests), and
`catalyst/store/catalyst.ts` **against the real service** — which had never run. The middle one
passing says nothing about the third.

| Check | Shape | Result |
|---|---|---|
| append returns a seq | A1 | seq=108 |
| replay returns the ORIGINAL seq | A1 | `duplicate=true`, same seq |
| human-layer event withheld from an agent | protocol | 0 returned, none human-layer |
| emoji stripped before the write | A12 | `"blocked on the contract  waiting "` |
| readEvents strictly ascending by seq | A4 | 50 events, `has_more=true` |
| first claim wins / second answered | A3 | `{ok:true}` then `{ok:false, owner, claimed_at}` |
| reclaim after release succeeds | F12 | `{ok:true}` |
| acquireScope grants a disjoint glob | A8 | `{ok:true}` |
| heartbeat then presence is fresh | A9 | `status=working stale=false` |
| readSnapshot / subscribe refuse | gate | `NotProvisionedError` both |

## The one failure, and why it improved the check

First run: 10/11, with "emoji stripped" failing on an empty string. Not a bug — I appended a
**human-layer** `task_progress` event and read it back through an agent-audience read, which
correctly withheld it. The filter working was indistinguishable from the write failing, because
I had written a check that could not tell those apart.

Two changes came out of it. The emoji check now uses a **coordination-layer** kind so it can
read its own write back. And the accident became an assertion: *human-layer event withheld from
an agent* is now checked explicitly, which the protocol calls its most important rule and which
nothing here had verified against the real backend.

## What this deliberately does NOT cover

- **A10, A11, A13** — need `subscribe`/`readSnapshot`, blocked on the Stratus gate.
- **A2** — 50 rounds × 20 claimants is 1,000 claims, ~20% of both monthly allowances.
- **A5** — ~1,505 SELECTs, 15% of the monthly SELECT allowance.

A2 and A5 belong to the single full run, per order 0005. Running them now would spend ~30% of a
month's quota to learn the same thing twice.

## A gap in order 0020 worth flagging

The order says `NotProvisionedError` "lives in `shared/`" and it is now normative in
`store-interface.md` — but `shared/store/errors.ts` **does not contain it**. The spec mandates a
shared type the shared code does not provide.

My implementation is in `catalyst/store/catalyst.ts` and satisfies every stated requirement:
distinct type, `UNPROVISIONED_OPERATIONS` exported, no network call on either gated operation.
I have not added it to `shared/` because `shared/` is frozen and that needs an order — and if
Firebase and I each define our own, they diverge, which is the "two different suites" failure
in a different costume.
