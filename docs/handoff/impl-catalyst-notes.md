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

---

# Order 0024 — gates verified. SLATE IS OPEN. STRATUS IS NOT.

Verified before building, as instructed. The two gates gave different answers, which is
exactly why 0024 asked.

## Slate — OPEN

```
CatalystbyZoho_List_All_Slate_Apps -> {"status":"success","data":[]}
```

An empty list, not `INVALID_URL_PATTERN`. By 0024's own signature table that means activated.
Confirmed without waiting for a deploy to tell me, which is the trap that order warned about.

## Stratus — STILL GATED. Identical signature.

```
CatalystbyZoho_Create_Bucket -> {"status":"failure","data":{
  "error_code":"OPERATION_NOT_ALLOWED",
  "message":"You are not allowed to perform this operation. User needs to be in session
             when accessing Stratus for the first time"}}
```

Byte-identical to the message from before the human's console visit. Three checks before
concluding that, because "reported activated" deserves more than one attempt:

1. **Does a bucket already exist?** `Get_All_Buckets` → `{"status":"success","data":[]}`.
   Reads succeed and return nothing, so activation did not create one and there is nothing to
   adopt. Reads succeeded before activation too, so a successful read is **not** evidence the
   gate cleared — worth stating, because it is the check most likely to be mistaken for one.
2. **Is the bucket NAME the problem?** The job pool earlier rejected a hyphen with
   *"must contain only alphanumeric and underscore"*, so a name error masquerading as a gate
   was plausible. Retried as `coordinationsnapshots`, plain alphanumeric, with minimal
   `bucket_meta`. **Identical error.** Not the name.
3. **Is it the payload?** Stripped `bucket_meta` to the required `type` alone. Identical error.

### The hypothesis I would check first

The MCP acts as **`sibhimanyu.g+t0@zohotest.com`**, the account that created the project. The
error is specifically about a *session*, so if the console visit happened under a different
Zoho account, the first-time session for the identity the API actually uses would still be
unmet. Worth confirming which account opened the console before assuming the activation failed.

I am not working around it, per the standing rule and my own earlier reasoning: the snapshot
read path is what route C1 exists to measure.

## What Slate being open does and does not unblock

It does **not** unblock much on its own. The dashboard is hosted on Slate, but a dashboard needs
`readSnapshot` and `subscribe`, and those need the bucket. Slate hosting an interface that
cannot read state is not progress worth claiming. So the queue is unchanged: bucket first.

## Done while verifying

- **`NotProvisionedError` now comes from `shared/store/errors.ts`** and my local copy is
  deleted. The shared signature is `(operation, resource)` rather than my `(capability,
  detail)`, and it carries both fields separately so a caller can name the operation and tell a
  human what to provision. `isRetryable` returns false for it, which my version did not
  guarantee — a provisioning gate does not clear because you asked twice.
- **A17 satisfied**: throws the distinct type, makes no network call (asserted by a request
  spy), declares `UNPROVISIONED_OPERATIONS` as an array rather than leaving it undefined, and
  is not retryable.
- **A16 satisfied live, both halves**, in the adapter smoke — now 13/13:
  - **A16a** human-layer `task_progress` appended, read as an agent → absent.
  - **A16b** coordination-layer event on the **same read path** → present, `seq=113`,
    `layer=coordination`.

  The second half is the one that matters. Absence alone cannot distinguish a working filter
  from a failed write, which is precisely the confusion that produced this row.

---

# Order 0025 — Stratus re-probe: STILL SHUT

One call, as instructed. No loop.

| | |
|---|---|
| Probed at | **2026-08-27T07:32:42Z UTC** |
| Call | `Create_Bucket` on `coordinationsnapshots`, project `53069000000062004`, Development |
| Result | `OPERATION_NOT_ALLOWED` — *"User needs to be in session when accessing Stratus for the first time"* |

Byte-identical to both previous attempts. The timestamp is recorded so whoever compares can
tell whether a second console visit preceded this probe or followed it — without that, "still
shut" is ambiguous about *when*.

Parked again. Not retrying in a loop, not working around it.

## On the coordinator's refinement of the identity hypothesis

Agreed, and it is a real narrowing rather than a restatement. The MCP identity created nine
tables and 63 columns through the API, so it demonstrably holds project-level rights — this was
never "wrong account entirely". The remaining explanation is that Stratus tracks first-time
access **per identity**, and the identity holding the browser session is not the identity making
the API call.

Two things I can add that narrow it further:

- **Every other service activated silently for this identity.** Data Store, Functions, Cache,
  Job Scheduling and Slate all accepted their first API call with no console visit. So the
  per-identity session requirement is **specific to Stratus**, not a general property of the
  platform, which makes it a genuine outlier rather than something we mis-set up.
- **`catalyst whoami` reports `Sibhimanyu G undefined`** — no email. The coordinator hit the
  same wall. So the CLI cannot tell anyone which identity it is acting as, which means a human
  cannot easily confirm they are opening the console as the right account. That is a real
  diagnosability gap and it is part of why this gate has taken three attempts: the error names a
  requirement nobody can verify they have met.

---

# Order 0030 — Stratus write probe. INCONCLUSIVE, and I could not answer either question.

Bucket adopted, not created. `Create_Bucket` deliberately not called, per 0030.

## The bucket exists, verified by listing

`Get_All_Buckets` at **2026-08-27T09:19:59Z** returned `coordinationsnapshots`, created
`Aug 27, 2026 02:38 PM` by `sibhimanyu.g+t0@zohotest.com`, url
`https://coordinationsnapshots-development.zohostratus.in`, `bucket_meta`
`{versioning:false, caching:{status:"Disabled"}, encryption:false, audit_consent:false}`.

That is the state change 0030 asked for: previously `[]`, now one bucket. It is **not**
evidence of write access — my own rule from 0025.

## 1. THE WRITE IS STILL UNVERIFIED. Not refused — unreachable from here.

**The MCP exposes no `putObject`.** The Stratus group has 18 tools and none of them writes an
object: `Copy_Object`, `Create_Bucket`, `Create_Upload_Signature`, `Delete_Bucket`,
`Delete_Objects`, `Delete_Objects_By_Prefix`, `Extract_Zip_Object`, `Generate_Signed_URL`,
`Get_All_Buckets`, `Get_All_Object_Versions`, `Get_All_Objects`, `Get_Object`,
`Get_Zip_Extraction_Status`, `Head_Bucket`, `Head_Object`, `Rename_Object`, `Update_Bucket`,
`Update_Object_Metadata`.

So the only two write paths available were both signature-based, and both failed.

### Attempt A — `Create_Upload_Signature` then REST PUT

Signature returned successfully. Decoded `stsPolicy`:

```json
{"signingtime":1787831966810,"expiration":3600,
 "action":["GetObject","PutObject"],
 "credentials":"60076397019-60085013690",
 "resource":["srn:::coordinationsnapshots-development/*"],
 "query":[],"headers":[],
 "body":{"content-type":"*","content-length":0}}
```

`action` includes `PutObject` and `resource` is a wildcard, so the grant looks right. But the
policy pins **`content-length: 0`**, and it did so **regardless of what I passed** — I called
`Create_Upload_Signature` twice, the second time with
`body: {"content-type":"application/json","content-length":24}`, and the returned policy was
identical on those two fields. The MCP tool appears to ignore the body it is given.

PUT verbatim result, at **2026-08-27T11:58:34Z**:

```
HTTP/1.1 400
Cache-Control: no-store
Content-Type: application/json;charset=utf-8
x-sts-request-id: ix2-36ba4979acc544349405f288a000bada

{"status":400,"code":"invalid_request_parameter"}
```

Identical 400 across four variations: nested key `probe/write-check.json` and flat
`writecheck.json`; with and without `Content-Type`; with and without `cache-control`,
`expires-after` and `overwrite` headers.

### Attempt B — `Generate_Signed_URL` then GET

Returned a URL in a **different shape** to the upload signature — note the `/_signed/` path
segment and a completely different parameter set:

```
https://coordinationsnapshots-development.zohostratus.in/_signed/writecheck.json
  ?organizationId=60085013690&stsDate=1787832024664
  &stsCredential=60076397019-60085013690&stsExpiresAfter=600
  &stsSignedHeaders=host&stsSignature=...
```

GET verbatim result, at **2026-08-27T12:00:38Z**:

```
HTTP/1.1 400
{"status":400,"code":"bad_request","message":"Signature didn't match. Request is tampered "}
```

### What this does and does not establish

It does **not** establish that `putObject` is broken, and I am not reporting it as such. It
establishes that **Stratus object writes are not reachable through the MCP's signature tools**
from this session. Two different signing schemes, two different failures.

The operation the snapshot builder will actually use is the **SDK's**
`stratus().bucket().putObject()`, called from inside a deployed function with the function's own
credentials and **no pre-signed URL involved**. That is a different code path from both attempts
above, and verifying it requires deploying code — which this bounded task explicitly forbids.
So the write remains **unverified**, and the honest status is *untested*, not *failing*.

## 2. THE CACHING QUESTION — the premise does not hold for this SDK

I could not run the live test, because it needs an object that exists. But reading the SDK
source answers the premise directly, and that is the better evidence anyway — same move as
`types/job.d.ts` earlier.

`zcatalyst-sdk-node@3.4.0`, `lib/stratus/bucket.js`, `putObject(key, body, uploadOptions)`
builds exactly these headers:

```js
const headers = { compress: uploadOptions?.compress || 'false', 'Content-Type': contentType };
if (uploadOptions?.ttl)       headers['expires-after'] = uploadOptions.ttl;
if (uploadOptions?.overwrite !== undefined) headers.overwrite = String(uploadOptions.overwrite);
if (metaData)                 headers['x-user-meta'] = metaData;
```

**There is no `cache-control` option and no `cache-control` header.** The upload options this
version supports are `contentType`, `metaData`, `compress`, `ttl`, `overwrite` and
`extractUpload`. The only cache-related API on the bucket is a bucket-level
`/bucket/purge-cache` operation.

So the premise — *cache-control is a per-object putObject header* — is **not true of this SDK
version**. Whether the Stratus REST layer would honour a `cache-control` header supplied by some
other writer is untested.

Consequences, stated carefully:

- My earlier flag that `caching: "Disabled"` threatens route C1's read path is **neither
  confirmed nor dismissed**. What has changed is the mechanism: I assumed the fix would be a
  per-object header, and that lever does not exist in the SDK.
- `overwrite` and `ttl` **do** exist, so 0030's requirement to pass `{overwrite: true}` on every
  put is satisfiable, and `expires-after` self-deletion is available.
- **G1 on the folded-snapshot path cannot yet be reported as designed.** The design claims a
  CDN-cached read; with bucket caching disabled and no per-object override in the SDK, whether
  that path is cacheable at all is an open question that must be settled before G1 is measured,
  not after.

One thing I deliberately did **not** treat as evidence: the 400 responses carry
`Cache-Control: no-store, max-age=0`. That is Stratus's own error-response header and says
nothing about how it serves a stored object.

## 3. No litter

`Get_All_Objects` on `coordinationsnapshots` returns
`{"key_count":0,"max_keys":1000,"truncated":false,"contents":[]}`. Nothing was created, so
nothing needed deleting, and `expires-after` was never exercised. The bucket is empty.

---

# Order 0031 — putObject WORKS. C1's cached read does not exist on this DC.

Section 5's order followed exactly. Every latency below names its host, per 0031's new rule.

## Step 1 — bucket before-state, verbatim

`Get_All_Buckets`, **2026-08-27T12:24Z**:

```json
{"bucket_name":"coordinationsnapshots",
 "project_details":{"project_name":"multiplayer-agents","id":"53069000000062004","project_type":"Live"},
 "created_by":{"zuid":60076397019,"email_id":"sibhimanyu.g+t0@zohotest.com",...},
 "created_time":"Aug 27, 2026 02:38 PM","modified_time":"Aug 27, 2026 02:38 PM",
 "bucket_meta":{"versioning":false,"caching":{"status":"Disabled"},"encryption":false,"audit_consent":false},
 "bucket_url":"https://coordinationsnapshots-development.zohostratus.in"}
```

`Head_Bucket` returns `{"data":[]}` — an empty body, so it is not a usable detail call. The
listing above is the before-state of record.

## Step 2 — `Update_Bucket` HAS the field. THE DATA CENTRE DOES NOT HAVE THE FEATURE.

The schema exposes exactly what was hoped for: `body.bucket_meta.caching.status`, enum
`["true","Disabled"]`. So the 0031 stop-condition ("no caching field → stop") did **not** apply,
and I called it — caching only, with `versioning:false`, `encryption:false`,
`audit_consent:false` restated at their existing values so a full-replace could not silently
change anything else.

Verbatim response:

```json
{"status":"failure","data":{
  "message":"Invalid operation. Bucket caching feature is not available in current DC.",
  "error_code":"FORBIDDEN"}}
```

**This is not a provisioning gate. It is an absent capability.** Bucket caching does not exist
in this data centre (`catalystserverless.in`, IN). No console click, API call or support ticket
in my reach changes it, and there is nothing to add to the gate count — a gate can be passed,
and this cannot.

After-state confirms the failed call changed nothing: `modified_time` still
`Aug 27, 2026 02:38 PM`, `caching.status` still `Disabled`.

## Step 3 — putObject WORKS. This was the biggest open question and the answer is yes.

`POST /diag/putobject` on the deployed function, **2026-08-27T12:27:49Z**, HTTP 200:

```json
{"step":"complete","ok":true,"put":true,"head":true,"get_body":"[object Object]",
 "delete":{"message":"Object Deletion scheduled."},
 "timings_ms":{"put":142,"head":111,"get":23,"delete":136}}
```

One key, `_diag/putobject-probe.json`, `{overwrite:true}`, read back, deleted. No parameter
variation — the first attempt succeeded, so the no-fishing bound never came into play.

Those four timings are **function → Stratus, both inside the IN DC**. They are *not* client
read latencies and must never be quoted as such. That mislabelling is the whole subject of
entry 25.

Two honest defects in my own probe: `get_body` came back `"[object Object]"` because I
`String()`-coerced whatever `getObject` returns rather than reading it as text, so the probe
proved the call *succeeded* without proving the *bytes* round-tripped. And `deleteObjects`
returns `"Object Deletion scheduled."` — asynchronous, so a delete confirmed by response is not
a delete confirmed by absence. I verified absence separately below.

So the earlier `Create_Upload_Signature` failures were about **that surface**, not about
Stratus writes. The SDK path from inside a function works on the first try.

## Step 4 — cold / warm / headers. The pre-registered reading, applied.

Read through a **pre-signed URL over plain HTTP**, which is the real client path: the bucket is
Authenticated, not Public. Measuring the SDK's `getObject` instead would have timed a
function-to-Stratus hop inside one DC and labelled it the client read — the same error as
inheriting GitHub's 34 ms.

**Host: `coordinationsnapshots-development.zohostratus.in`**, from a laptop in Asia/Kolkata.
**2026-08-27T12:30:14Z**. Two GETs only — no best-of-N, no warm-up laps.

| | value |
|---|---|
| cold | **79 ms** (HTTP 200) |
| warm | **20 ms** (HTTP 200) |
| `cache-control` | **`no-store`** |
| `pragma` | `no-cache` |
| `expires` | `Thu, 01 Jan 1970 00:00:00 GMT` |
| `etag` | `"9bf92b0e64750890894627cbf6454cdb"` |
| `age` / `x-cache` / `cf-cache-status` / `via` / `x-amz-cf-pop` | **all absent** |

### The verdict, per the pre-registration — and warm being faster does NOT change it

Warm is 20 ms against a cold 79 ms, which looks like the "warm ≪ cold" branch. It is not,
because that branch required **warm ≪ cold *with a cache header*** and there is no cache header
at all. Three pieces of evidence say the 59 ms came from connection reuse rather than a cache:

1. **`cache-control: no-store`, `pragma: no-cache`, `expires` at the epoch.** Stratus is
   explicitly instructing clients *not* to cache this object. That is the opposite of a
   cacheable read path.
2. **Two different `x-sts-request-id` values** — `ix2-756bfe9d…` cold and `ix2-8faf4502…` warm.
   Both requests reached the origin and were served there. A cache hit would not mint a second
   origin request id.
3. **`connection: keep-alive`, `keep-alive: timeout=20`.** The second GET reused an established
   TCP+TLS connection, which is exactly the handshake cost that disappears.

**So: C1's read is a plain origin object GET.** Stating it as 0031 requires, without softening:

> **C1's advantage over C2 was never established.** The 34 ms that justified choosing C1 was
> GitHub's CDN. Stratus, measured for the first time here, serves this object from origin at
> **79 ms cold / 20 ms warm-connection**, with caching *explicitly disabled by the response* and
> *unavailable in this data centre at all*.

**C2 is live again, and on this evidence it is probably the better Catalyst route.** C1's whole
premise was a cached CDN read. That read does not exist here, so C1 is paying for a snapshot
builder, an Event function, a bucket and a third moving part in order to obtain an origin GET —
while C2's plain Data Store read needs none of it. C1 would still win on *operation cost* (a
snapshot read is one object GET against `readEvents`'s 3 SELECTs, and the SELECT quota is the
binding constraint per G4), so the case for C1 is now **quota, not latency**. That is a much
weaker and much narrower claim than the one in the design doc, and it should be re-argued rather
than assumed.

One thing that **does** survive: **ETag is present**, so the `readSnapshot(etag)` → 304 design
is implementable. That was the other half of the design's read story and it is intact.

## Step 5 — audit of `docs/results/catalyst-run-1.md` for host-less figures

**Two tables, six figures, no host named in either.**

- **G1**: `appendEvent` 202/281 ms, `publish → visible` 318/419 ms.
- **G2**: claim 127/182/409 ms, max 1,186 ms.

All six were measured against
`multiplayer-agents-60083782173.development.catalystserverless.in/server/coordination` from a
laptop in Asia/Kolkata to the IN DC. That host is recorded in these notes but **not in the
results file's tables**.

Being precise about the severity, because it is *not* the same defect as entry 25: these figures
were measured on the route that claims them, so they are not borrowed — the host is *unstated*,
not *wrong*. Attaching it is a labelling fix. The 34 ms was a different and worse thing: correct
number, correct method, **wrong subject**. Conflating the two would overstate this finding.

I have not edited `docs/results/` — it is coordinator-owned.

## Bucket left as found

`Get_All_Objects` after both probes: `{"key_count":0,"max_keys":1000,"truncated":false,
"contents":[]}`. Both probe keys deleted, `bucket_meta` unchanged from the before-state.

The `/diag/putobject` and `/diag/readpath` routes remain deployed and are authenticated like
every other route. They should be deleted once G1 is settled; they are recorded here so they are
not forgotten.

---

# Orders 0032 + 0034 — `is_unique` DOES NOT HOLD UNDER CONCURRENCY

Three debts. The second one produced a finding that outranks everything else in these notes,
including its own order, so it is first.

## THE HEADLINE: the claim primitive does not provide mutual exclusion

**5 agents, 5 distinct tokens, racing for one task. n=200 tasks, 1,000 requests.**
**2026-08-28T04:21:56Z**, host `multiplayer-agents-60083782173.development.catalystserverless.in`.

```
tasks with exactly one winner   31/200
violations (0 or >1 winners)   169/200
transport failures                0
winners counted                 547   across 200 tasks
```

**An 84.5% violation rate.** On average 2.7 of the 5 racers were each told `{"ok":true}` for the
same task.

### Verified against durable state, not just my harness

My harness could have been miscounting, so I checked the table:

```
SELECT COUNT(ROWID) FROM task_claims  ->  554
```

554 rows for 205 distinct task ids (200 + a 5-task smoke run). The two sources agree exactly —
547 + 7 = 554. **349 rows exist that the schema says are impossible.** Two examples, verbatim:

```
proj_inventory:task_race_mtcg2082_2  agent_race02  ROWID ...098033
proj_inventory:task_race_mtcg2082_2  agent_race04  ROWID ...101027
proj_inventory:task_race_mtcg2082_4  agent_race01  ROWID ...096026
proj_inventory:task_race_mtcg2082_4  agent_race03  ROWID ...103030
```

And the constraint is genuinely declared on the live table — `List_All_Columns` on
`task_claims` reports `claim_key`, `varchar(255)`, **`is_unique: true`**, `is_mandatory: true`.

So this is not my handler misreporting and not a schema drift. **Catalyst Data Store's
`is_unique` rejects duplicates sequentially but does not enforce them under concurrent insert.**

### Why this is a route-level finding, not a row-level one

The original handoff's stack table says: *"Ledger + claims | Data Store | `is_unique` gives
atomic claim without transactions."* That premise is false in the only case that matters. My
day-one probe (P2) proved rejection **sequentially**, and I recorded it as establishing the
atomic primitive. It did not. Sequential rejection and concurrent mutual exclusion are different
properties and I tested the easy one.

That is the same defect class as everything else in this register — a probe that could not
distinguish the passing case from the failing one — and it sat undetected for the whole build
because **every claim test I ran was uncontended**. The dry run's "20 concurrent claims produce
exactly one winner" passed against a *double* that enforced uniqueness correctly. The double was
faithful to the documented behaviour; the platform is not.

**Scope, stated precisely.** I measured this for `task_claims`. The identical mechanism backs
every other atomic guarantee on this route:

| Guarantee | Column | Measured? |
|---|---|---|
| exactly-one claim (A2) | `task_claims.claim_key` | **measured — FAILS at 84.5%** |
| idempotent append (A1) | `request_dedupe.dedupe_key` | not measured, same mechanism |
| strictly ascending seq (MB4) | `events.seq` | not measured, same mechanism |
| scope locks (A7) | `scope_locks.lock_key` | not measured, same mechanism |
| agent identity | `agents.agent_id` | not measured, same mechanism |

I am **not** reporting those four as broken. They share the mechanism, so they are *presumed
affected and unverified* — which is exactly the distinction this register keeps insisting on.

**A2 cannot pass on this route as designed.** No amount of adapter code fixes it, because the
platform primitive the design selected does not have the property the design requires.

### The latency numbers, which are now secondary

Reported because 0034 asked, and with no mean per its instruction:

| | n | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| winners | 547 | 122 ms | 140 ms | 188 ms | 230 ms |
| losers | 453 | 129 ms | 155 ms | 205 ms | 246 ms |
| all attempts | 1,000 | 126 ms | 144 ms | 196 ms | 246 ms |

Wall clock 27 s. Winners and losers are reported separately because they are different
operations — a loser returns as soon as the constraint rejects it, a winner waits for its INSERT
to commit — and averaging them would be a third measurement-shape artifact.

**These figures should not go in the scoreboard.** A claim latency is only meaningful for an
operation that performs a claim, and 84.5% of these did not. The contended row that 0034 asked
for cannot be filled by this route until the primitive works.

Notably the contended p50 of 126 ms is *indistinguishable* from the uncontended 127 ms — which
is itself the tell. A working exclusive-claim primitive should show contention somewhere in the
distribution. This one shows none, because it was not excluding anything.

**Quota spent:** 2,000 SELECT (2 auth × 1,000 requests) and 1,000 INSERT attempts, of which the
platform committed 554. That is 20% of the monthly SELECT allowance and 20% of INSERT.
`task_claims` was truncated afterwards.

## Debt 1 — order 0032: the Stratus quota question. THE AXES ARE COMMENSURABLE.

0032 anticipated that Stratus might be metered on a different axis and told me to stop rather
than convert. **It is not.** Both are metered **per request**, from
`catalyst-pricing/references/pricing-basics.md` (verified May 2026):

| | free tier / month | unit price | unit |
|---|---|---|---|
| **Stratus Download** | **10,000 requests** | $0.0000004 | per request |
| **Stratus Upload** | **2,000 requests** | $0.000005 | per request |
| **Data Store SELECT** | **10,000 requests** | $0.00006 | per request |
| Data Store INSERT | 5,000 requests | $0.0001 | per request |

Same axis, same unit, no conversion required.

### The comparison

- **C1 read** = 1 Stratus Download. The signed URL is per-key and reusable until it expires, so
  at a 600 s expiry and 5 s polling the auth SELECTs amortise across ~120 polls — negligible.
- **C2 read** = 3 SELECTs (2 auth + 1 events query), measured in G4.

| | per read | free-tier reads/month |
|---|---|---|
| C1 snapshot GET | $0.0000004 | **10,000** |
| C2 `readEvents` | $0.00018 | **3,333** |

**C1 is 450× cheaper per read and has 3× the free-tier headroom.** At the design's own polling
rate — one dashboard at 5 s for 30 days, 518,400 reads — that is **$0.20 against $92.71**.

### The ruling

The interpretation was **pre-registered by the coordinator in 0032 §2, before anyone had seen
these numbers**, so this is their rule applied rather than one I wrote after the fact:

> *Stratus GETs materially cheaper against quota → C1's narrowed case survives.*
> *Comparable or incommensurable → C2 wins.*

450× and 3× headroom is materially cheaper on any reading. **By the pre-registered rule, C1's
narrowed quota case survives.**

**But it survives into a route whose claim primitive does not work.** That is the more important
fact, and it is why this ruling changes nothing about what to build next. C1 vs C2 is a choice
between two read paths on a foundation that has just failed underneath both of them — the claim
primitive is shared by C1 and C2 alike. Deciding the read path now would be optimising the roof
of a building whose foundation is the open question.

Two things that qualify the C1 win even on its own terms, recorded so nobody quotes the 450×
alone:

- **C1's write side has the tightest quota in the system.** Every rebuild is 1 SELECT + 1
  Stratus Upload, and Upload's free tier is **2,000/month** — a fifth of the read allowance and
  the smallest number in the whole pricing table for this design.
- **The cross-region penalty is unchanged (entry 28).** 79 ms was same-region best case with no
  edge cache, and bucket caching is unavailable in this DC, so a US agent pays full RTT on every
  snapshot read with nothing to absorb it.

## Debt 3 — publish→visible is relabelled

Now **`ledger propagation, tight-loop floor, no subscriber`**, in the code comment, the emitted
`metric` field and the result key, with the mechanism stated inline:

```
metric: 'ledger propagation, tight-loop floor, no subscriber'
mechanism: 'poll with zero backoff; subscribe throws NotProvisionedError;
            a real subscriber adds up to poll_ms on top of this'
```

The 318 ms is a floor that polling can never beat, not a latency anything experiences. `subscribe`
throws `NotProvisionedError`, so this route has no push path at all, and a real subscriber polling
at `poll_ms` = 5,000 ms would add up to a full interval. Against Firebase's listener push it
flattered this route by omitting the poll interval entirely — the borrowed-number error in a new
costume: right number, wrong mechanism.

## What I did not do

Did not build the snapshot builder or the Event function (0032). Did not start F1–F12. Did not
run A5 — and the case for holding it is now stronger than when 0034 wrote it, because A2 cannot
pass and a conformance run would spend ~1,505 SELECTs to discover that.

---

# Order 0035 — Catalyst HAS an atomic primitive. It is not in the database.

Four mechanisms probed contended against the live service, 5 racers × 200 keys each. Three
fail. One holds perfectly. The one that holds is **Stratus object storage**, and both of the
Data Store mechanisms — the unique constraint and the conditional UPDATE — fail.

## 1. What Zoho actually promises for `is_unique`

**Access note first, so the sourcing is legible.** `WebFetch` and `WebSearch` were not granted
in this session, so I could not open `docs.catalyst.zoho.com`. Everything below is quoted from
two offline sources that are Zoho's own: the **live Catalyst API's machine-readable tool
schema**, and the **official Zoho Catalyst plugin skill bundle v2.0.0**. The public help pages
remain unread and I am not going to characterise them.

### Verbatim, from the live `CatalystbyZoho_Create_Column` schema

Tool description:

> "Creates a new column in the specified table with the defined data type, constraints, and
> properties such as mandatory, unique, or search indexing."

The `is_unique` property, identically on all three data types that accept it (`varchar`, `int`,
`bigint`):

> `is_unique`: "Whether the column enforces unique values"

And, for contrast, the property beside it:

> `is_mandatory`: "Whether the column requires a value (NOT NULL constraint)"

### Verbatim, from `catalyst-datastore/references/datastore-basics.md` (Zoho plugin v2.0.0)

The word "unique" appears **once** in the entire Data Store reference, and it is about a
different thing:

> "`ROWID` — unique row identifier (bigint, auto-increment)"

`is_unique` is never mentioned. Not in Column Types, not in Common Errors, not anywhere. The
only concurrency-adjacent section is this one, quoted in full:

> ## Transactions
>
> Data Store does NOT support multi-statement transactions.
>
> **Workarounds:**
> - Use single ZCQL statements for bulk operations
> - Use optimistic concurrency: read `MODIFIEDTIME`, verify before writing
> - Use Circuits for multi-step workflows with saga patterns — **US DC only**; Circuits is not
>   available in EU, AU, IN, JP, SA, or CA data centers

### The ruling, in 0035's own terms

**Not documented as concurrency-safe. We misread it, and the register says so in those words.**

There is no sentence anywhere promising that `is_unique` holds under concurrent writes. There
is no mention of a UNIQUE constraint, of atomicity, of isolation, or of locking. The one
paragraph that touches concurrency says the opposite of what we assumed: no transactions, and
the suggested workaround is *optimistic concurrency* — read, then verify before writing — which
is what you recommend when the store will not serialise for you.

Two things worth being precise about, since the order said not to paraphrase toward a
convenient reading:

- **"enforces unique values" is an enforcement claim, and it is stronger than "advisory."** It
  is not nothing. Read on its own it is easy to hear as a UNIQUE constraint.
- **But `is_mandatory` names its SQL constraint and `is_unique` does not.** "requires a value
  (NOT NULL constraint)" against "enforces unique values" — one line reaches for the database
  guarantee, the neighbouring line declines to. That asymmetry is visible in the same schema,
  and I did not notice it.

So: Zoho's wording invites the inference. It does not make it. **My composite-key rulings
across four orders assumed an enforcement guarantee that no document states**, and the failure
is a misread, not a false promise. It is not a defect worth reporting to Zoho as a broken
guarantee — though the gap between "enforces unique values" and what actually happens under
five concurrent inserts is worth reporting to them as documentation that misleads.

## 2. Every primitive probed, and every one I did not

| Mechanism | Tested how | Contended result | Durable state |
|---|---|---|---|
| Data Store `is_unique` INSERT | live, 5×200 (entry 37) | **31/200** exactly-one | 554 rows for 205 keys |
| Data Store CAS `UPDATE…WHERE` | live, 5×200 | **17/200** exactly-one | 200 rows, 1 holder each |
| Cache put-if-absent | sequential inventory | **eliminated before spending** | n/a |
| Stratus `putObject overwrite:false` | live, 5×200 | **200/200 exactly-one** | 200 objects, MD5 5/5 |
| NoSQL conditional insert | **NOT PROBED** | — | — |
| Circuits | **NOT PROBED** | — | — |
| Queue single-writer | **NOT PROBED** | — | — |

### The inventory pass, and the asymmetry that makes it legitimate

Before spending on any contended run I ran one cheap sequential pass
(`POST /diag/atomic/inventory`). Its licence is narrow and worth stating, because getting this
backwards is exactly what produced entry 37:

- **Sequential rejection proves nothing about concurrency.** That was the original mistake. My
  day-one P2 probe rejected a duplicate insert sequentially and I recorded it as establishing an
  atomic primitive. It did not.
- **Sequential acceptance, however, is decisive in the negative.** A mechanism that cheerfully
  overwrites an existing key when there is *no contention at all* cannot exclude a racer under
  contention. There is nothing left for concurrency to break.

So the inventory may eliminate a candidate. It may never promote one to "works" — everything it
promotes goes to a contended live run.

### Cache put-if-absent — ELIMINATED, no contended run needed

`segment.put(key, 'FIRST', 1)` then `segment.put(key, 'SECOND', 1)`. The second call **did not
throw**, returned a normal cache record, and `getValue` afterwards returned `"SECOND"`.

`put` is an unconditional write. There is no SETNX here. The SDK segment surface is exactly
`put / update / getValue / get / delete` — no put-if-absent, no add-only, and **no atomic
increment either**, so the increment variant the order asked about does not exist to be tested.
Eliminated on the cheap pass, which saved 1,000 requests.

### Data Store compare-and-set — FAILS, and it fails silently

The cheapest possible adoption path: same service, same tables, no new dependency. A row is
seeded `holder='FREE'`, and each racer runs the classic conditional update:

```sql
UPDATE cas_probe SET holder = '<agent>' WHERE cas_key = '<key>' AND holder = 'FREE'
```

The inventory first confirmed the mechanism can even report a verdict — a matching UPDATE
returns the changed row (`affected=1`), a non-matching one returns `[]` (`affected=0`). They are
distinguishable, so a caller *can* be told whether it won. Promoted.

**2026-08-28T05:09:47Z**, host `multiplayer-agents-60083782173.development.catalystserverless.in`:

```
shape: 5 agents racing for ONE key, n=200 keys = 1000 attempts
keys with EXACTLY ONE winner    17/200
keys with ZERO winners           0
keys with MORE THAN ONE winner 183          <-- 91.5%
transport failures               0
winners  n=658
```

Verbatim from one key, five racers, all five told they won:

```
cas_mtchsme3_2: 5 winners
 {"won":true,"affected":1,"raw":[{"cas_probe":{...,"MODIFIEDTIME":"2026-08-28 10:39:47:715",
   "cas_key":"cas_mtchsme3_2","holder":"agent_race01",...}}]}
 {"won":true,"affected":1,"raw":[{"cas_probe":{...,"MODIFIEDTIME":"2026-08-28 10:39:47:716",
   "cas_key":"cas_mtchsme3_2","holder":"agent_race02",...}}]}
 ... three more, all affected:1
```

Two MODIFIEDTIMEs one millisecond apart on the same row, each returned to a different caller as
that caller's own successful update. The `WHERE holder = 'FREE'` guard is evaluated
non-atomically — read, then write, with no row lock in between.

**And this is worse than entry 37, in the way that matters most.** Durable state afterwards:

```
SELECT COUNT(ROWID) FROM cas_probe                       -> 200
SELECT cas_key, holder FROM cas_probe WHERE cas_key='cas_mtchsme3_2'
                                                         -> holder = agent_race04
```

**200 rows. Exactly one holder each. The table is perfect.** And 658 racers were told they won,
so **458 agents hold a claim they do not own and nothing in the data shows it.** With
`is_unique` the duplicates were at least visible as extra rows — a durable-state audit caught
it. Here an audit passes: 200 keys, 200 holders, no anomaly. The entire failure lives in what
the platform told the callers, and it is invisible after the fact.

Latency, no mean, winners and losers separate:

| | n | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| winners, end to end | 658 | 122 | 145 | 230 | 284 |
| losers, end to end | 342 | 115 | 141 | 233 | 330 |
| winners, primitive only | 658 | **24** | 35 | 49 | 61 |

"Primitive only" is timed inside the handler around the ZCQL call alone, excluding HTTP and the
2-SELECT auth path. Those are not what is being measured, and reporting only the end-to-end
number would have attributed the platform's request overhead to the primitive.

### Stratus conditional put — HOLDS, 200/200

`putObject(key, body, { overwrite: false })`. The SDK documents `overwrite` as "Whether to
overwrite an existing object", and order 0030 had already established that a put over an
existing key fails without it. The inventory confirmed a real refusal with a real error:

```
statusCode: 409
message: {"status":409,"code":"key_already_exists",
          "message":"key is already associated with another object in the bucket"}
```

**2026-08-28T05:10:42Z**, same host:

```
shape: 5 agents racing for ONE key, n=200 keys = 1000 attempts
keys with EXACTLY ONE winner   200/200
keys with ZERO winners           0
keys with MORE THAN ONE winner   0
transport failures               0
wall clock 28s
```

| | n | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| winners, end to end | 200 | 133 | 153 | 264 | 346 |
| losers, end to end | 800 | 130 | 152 | 244 | 345 |
| winners, primitive only | 200 | **36** | 45 | 78 | 225 |

**Durable state, two independent sources, neither of them my harness.**

`Get_All_Objects` on the prefix, through the Catalyst MCP:

```
prefix "_race/mtchtxl8/"  key_count 200  truncated false   (200 distinct keys)
```

200 keys raced, 200 objects, 200 declared winners. Exact reconciliation.

Then the stronger check, because *exactly one winner* is necessary but not sufficient — a
service could hand out one success and still let a rejected racer's bytes land. **Stratus
returns an etag, which is the MD5 of the stored content**, so the winner's claim can be checked
against the bytes without trusting any code of mine:

| key | etag returned by Stratus | = MD5 of | racer told "you won" | |
|---|---|---|---|---|
| `0.txt` | `4aa3856e8b5c70ff884520d1066623af` | `agent_race01` | agent_race01 | ✓ |
| `1.txt` | `9120f1ebd4fa0d3360ab02c78fbeaaba` | `agent_race04` | agent_race04 | ✓ |
| `2.txt` | `21238c127b6c539ae2f35207f0034f62` | `agent_race02` | agent_race02 | ✓ |
| `3.txt` | `c3ef8813f7aa83b9f76fbf8360a5d835` | `agent_race05` | agent_race05 | ✓ |
| `4.txt` | `4aa3856e8b5c70ff884520d1066623af` | `agent_race01` | agent_race01 | ✓ |

Five for five. Every object holds exactly the racer the platform told it had won.

**Catalyst has an atomic compare-and-set. It is in the object store, not the database.**

### A void run, recorded because it looked like a finding and was my bug

A second Stratus pass was run to add automated per-key read-back. It reported *48 durable
contradictions* and, from key 48 onward, zero winners. **Both are mine, and neither is a
platform finding.** The read-back called `String()` on `getObject`'s return, which is a wrapper
object, not a Buffer — so all 48 "stored values" were the literal text `[object Object]`. The
run is void. The reconciliation above was redone against Stratus's own content MD5 instead,
which is better evidence anyway. `readbackStratus` now unwraps explicitly and reports the
object's shape on failure rather than a stringified placeholder, so the next failure here reads
as a bug rather than as a data mismatch.

This is the second time in two orders that a mechanical mistake of mine produced an
impressive-looking negative result. Both were caught by asking "is this the platform or is this
me?" before writing it down, which is the only reason neither reached the register as a finding.

### The reason that run died at key 48

```
FREE_USAGE_LIMIT_REACHED
"You have exhausted the free tier allowance for Datastore - Fetch.
 Please set up a payment method to continue using this resource."
```

**The Catalyst free tier is a hard wall, not a billing threshold.** The service stops. It does
not meter into an invoice. Every authenticated route on this build spends 2 SELECTs resolving
token → agent → project, so **every route except `/health` is currently down**, including the
ones I would need to re-run G2.

**This corrects entry 38.** That entry priced C2's ledger read at $92.71/month against C1's
$0.20 and treated the difference as money. It is not only money: at 3,333 free reads a month C2
does not get more expensive, it **stops**, and takes every other Data Store consumer in the
project down with it, because the quota is per-project and not per-caller. The ranking in entry
38 stands and gets sharper; the framing was wrong.

### What I did NOT probe, stated so nobody reads silence as absence

**NoSQL conditional insert — the strongest candidate on paper, and untested.**
`INoSQLInsertItem` carries an optional `condition`, and `INoSQLConditionFunction` supports
`function_name: 'attribute_exists'` with a `negate` flag — a genuine DynamoDB-style conditional
put. If it works it would beat Stratus outright: typed, queryable, and on a different meter.

I could not test it. `app.nosql().getAllTable()` returns `[]` — the service is reachable and the
project has **zero tables**. The Node SDK exposes only `getTable`, `getAllTable` and `table`;
there is **no create-table method**. And **none of the 186 tools in the Catalyst MCP surface
mentions NoSQL** — I listed all of them to check. A NoSQL table can only be created from the
console.

This is a real hole in the answer and I am not going to paper over it. The harness is written
and generic; one console-created table with a partition key would let it run unchanged.

**Circuits — not probed.** `app.circuit()` is present on the SDK, but Zoho's own Data Store
reference says Circuits is "**US DC only**; not available in EU, AU, IN, JP, SA, or CA data
centers." This project is in the **IN** data centre — confirmed independently by the console URL
the org API returns, `https://console.catalyst.zoho.in/baas/60083782173/index`. Ruled out on
documentation plus a checkable fact, not on a measurement, and it is also console-provisioned.

**Queue single-writer — not probed, and reasoned rather than measured.** `lib/queue` exists
(queue / topic / consumer). A single-consumer queue would serialise writes, but it does not
answer the caller: a claim is a synchronous question — *do I own this task?* — and a queue is
asynchronous. Making it a claim primitive needs a second round trip to poll the outcome, and
that read would go back to the Data Store, whose answers are exactly what has just been shown
untrustworthy. Also console-provisioned. **This is an argument, not a measurement**, and it
should be read as one.

**Cache atomic increment — nothing to probe.** The SDK segment surface has no increment method.

## 3. The ruling

**0035 branch 1 applies: an atomic primitive exists, so the route is not eliminated.** It is
`putObject(key, body, { overwrite: false })` on Stratus — 200/200 under contention, reconciled
against durable state twice.

I am recording this against my own expectation. I went into this pass expecting to write the
other ruling, and the sentence "Catalyst cannot support atomic claim" would have been the more
striking result. It is not what the measurements say.

**But the primitive is in the wrong service, and that is the finding, not a footnote.** Every
atomic guarantee this route needs — exactly-one claim, monotonic `seq`, idempotent append, scope
locks, agent identity — has to move out of the database and into object storage. The database
keeps only what it can be trusted with: bulk reads and replay.

### The rewrite cost, honestly

An **estimate**, and flagged as one — I could not run it, because the Data Store quota wall
means no authenticated route currently works.

- **New:** a `stratus-lock` module — acquire is one conditional put, release is one delete,
  expiry rides `expires-after`. Small, and it replaces logic that already exists.
- **Changed:** claim, scope-lock, request-dedupe and seq allocation all swap their backing
  primitive. `seq` is the least disruptive: allocate-on-collision against `seq/<n>` is exactly
  the increment-on-collision loop already built and tested, pointed at a different store.
- **Dropped:** four `is_unique` columns come off the schema, and the composite-key design
  reasoning behind them — four orders of it — becomes moot. `<project_id>:<task_id>` stays, but
  as an object key, where the table-global-uniqueness problem it was invented to solve does not
  exist.
- **Unchanged:** the `CoordinationStore` contract, the conformance suite, every handler above
  the port boundary. The adapter seam that made this bearable was worth building.

**The quota cost of the fix is the part to look at hardest.** Every claim becomes one Stratus
Upload, and **Stratus Upload's free tier is 2,000/month — the tightest quota in the system**,
against Data Store INSERT's 5,000. Adopting the primitive that works moves the route onto the
scarcest meter it has. And per the wall above, that ceiling stops the service rather than
billing for it. Route C would be correct and would run out sooner.

### Owed, and blocked

**Contended G2 has not been re-run against the adopted primitive.** 0035 asks for it and I have
not done it: adoption is a code change, and the quota wall means I cannot exercise any
authenticated route to verify one. The Stratus figures above are the primitive measured
directly; they are not G2. Recorded as owed rather than quietly folded into the Stratus numbers,
which would be the same borrowed-number error in a third costume.

Held as instructed: **F1–F12 unstarted, A5 unspent.**

### Cleanup

`cas_probe` table dropped. The `_race/` prefix deleted from `coordinationsnapshots`. The four
`/diag/atomic/*` routes remain deployed and are authenticated like every other route; they
should be deleted once the primitive question is closed, and are recorded here so they are not
forgotten alongside `/diag/putobject` and `/diag/readpath`.

---

# Order 0037 — NoSQL conditional insert HOLDS. Atomicity stays in a database.

**200/200 exactly one winner, durable state reconciled 200/200, and all five racers verified in
flight together on every round.** Catalyst has an atomic compare-and-set in a database after
all. Pre-registered branch 1 applies and entry 43's arithmetic is void.

Three of my own bugs had to be found and fixed on the way to that number, and the first version
of this run reported a confident, completely wrong result. That story is in §4 because it is
the more transferable finding.

## 1. The table's own schema, read back before anything was raced

0037's mandated first operation. **Not inferred from a successful insert** — read from the
definition, via `nosql().getTable(id).toJSON()`:

```json
{
  "type": "TABLE",
  "name": "claim_probe",
  "id": "53069000000101123",
  "status": "ONLINE",
  "partition_key": { "column_name": "claim_key", "data_type": "S" },
  "additional_sort_keys": [],
  "global_index": [],
  "ttl_enabled": false,
  "api_access": false
}
```

**No sort key.** The primary key is `claim_key` alone, so five racers build the identical
primary key and exactly one insert can survive. The console gate was set correctly.

**And the gate I wrote to check this had a hole.** My first version tested seven hand-written
spellings — `sort_key`, `sortKey`, `range_key`, and so on. The real field is
**`additional_sort_keys`**, which was not among them. It is empty, so the verdict was right;
the reasoning was not. A table *with* a sort key would have sailed through a check that
appeared to be looking for exactly that. Rewritten to scan every field whose name matches
`/sort|range/i` and block on any populated one, to block on any column list declaring a sort
role, and to **block rather than pass when it does not recognise the shape at all** — the
failure mode of guessing here is a green result that means nothing. Seven named regression
tests, including one that feeds it the real definition and one that feeds it the same
definition with `additional_sort_keys` populated.

## 2. Reaching NoSQL without spending a Data Store read

Data Store is still at `FREE_USAGE_LIMIT_REACHED`, so every authenticated HTTP route returns
`STORE_ERROR` — the 2-SELECT token→agent→project resolution cannot run. 0037 forbids working
around that by weakening auth, and I have not.

I first checked whether the schema could be read without any function at all. **Three official
read paths, none of which exposes NoSQL:**

| Path | Result |
|---|---|
| Catalyst MCP | 186 tools in 22 feature groups — Datastore, Stratus, Cache, ZCQL, JobScheduling… **no NoSQL group** |
| Catalyst CLI | `ds:import` / `ds:export` for Data Store; **no nosql command** |
| `catalyst iac:export` | project template with 18 component types; **NoSQL is not one of them** |

So the SDK inside a deployed function is the only way in.

**The answer to 0037's question is: yes, via a job function, and that is not a weakening.** A
job is invoked through the Job Scheduling API under Catalyst's own platform credentials —
stronger auth than an agent token, not weaker — and this route already ships one, the reaper.
So `nosqlprobe` is a job. It touches no Data Store, it authenticates the way Catalyst
authenticates jobs, and results come back through a Cache key because `Get_Logs` returns `[]`
for every function in this project. That Cache-key pattern is the reaper's, not a new one.

**The honest cost of that choice.** The five racers run inside ONE function invocation rather
than as five HTTP clients, which is a different shape from every other primitive measured on
this route. Two consequences, both handled rather than waved away:

- **End-to-end latency from this probe is not comparable to the other rows** and is not
  reported as such. Only the primitive-only figure is quoted.
- **The concurrency is measured, not assumed.** If an SDK connection pool serialised the five
  calls, a non-atomic primitive would look perfect. So every attempt records its own start and
  end and the run reports how many rounds had all five intervals mutually overlapping.
  **200/200.** They genuinely raced.

## 3. The contended conditional insert

`insertItems({ item, condition: { function: attribute_exists(claim_key), negate: true } })` —
5 racers × 200 tasks, one task per round, live service.
**2026-08-29T06:54:13Z**, job `nosql_race3_0037`, 12.2 s.

```
rounds completed                 200
keys with EXACTLY ONE winner     200/200
keys with ZERO winners             0
keys with MORE THAN ONE winner     0
rounds where all five overlapped 200/200
```

**Durable state, audited separately from the reply** — the pair that caught Data Store CAS
returning `affected:1` to five racers over one correct row, where either check alone passed:

```
keys checked                     200
stored holder MATCHES the declared winner   200
stored holder CONTRADICTS it                  0
missing                                       0
```

Latency, primitive only, no mean:

| | n | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| winners | 200 | 32 | 40 | 47 | 49 |
| losers | 800 | 27 | 35 | 42 | 70 |

An earlier corrected run (`nosql_race2_0037`) independently produced 200/200 as well, and five
of its keys were reconciled by a **separate audit job reading raw responses with a positive
control** — two rows written minutes earlier by the diagnostic, to prove the read path worked
before concluding anything from an empty result. All five race keys held exactly the declared
winner; both control rows read back correctly.

### The serious caveat: 91% of losers are HTTP 500, not a refusal

```
loser_error_codes: { "CriteriaMismatch": 73, "threw:INTERNAL_SERVER_ERROR": 727 }
```

Verbatim, repeated identically across samples:

```
statusCode 500, code INTERNAL_SERVER_ERROR,
"Internal server error has occurred. Please try again after some time"
```

**Safety is not affected and I checked that specifically**: if any 500'd attempt had actually
written, some key's stored holder would differ from its declared winner. 200/200 match, so no
500'd racer's write landed.

**But a claim primitive has to tell a caller *which* kind of failure it hit.** "Someone else
owns this task" and "the service broke, retry" demand opposite responses, and here the
platform answers the first situation with the second 91% of the time. An agent that retries a
500 would hammer a task it has already lost. The correct client behaviour — treat
`INTERNAL_SERVER_ERROR` on a conditional insert as *probably* a lost race — is exactly the
kind of guess this register exists to avoid. **Recorded as an open risk, not priced in.**

Whether the 500 is throttling wearing a 500's clothes is **not established.** The message says
"try again after some time", which reads like throttling, but I did not test it and I am not
going to characterise it. 1,000 conditional inserts in 12 s is ~83/s against a table created
minutes earlier with no provisioned-throughput setting I can see.

## 4. Three bugs of mine, one shape

The first contended run reported **392 winners over 200 keys and 114 keys with multiple
winners** — a result that looked exactly like the Data Store CAS failure and would have been a
second damning finding. It was wrong, and every part of it was mine.

**Bug 1 — a refusal does not throw.** I counted `won` as "the call did not reject".
`insertItems` **resolves** when the condition is not met, with
`create: [{ status: "CriteriaMismatch" }]` and `size: 0`. So every attempt the platform
*correctly refused* was scored as a win. Found by a bounded five-step diagnostic that did a
plain insert, read it back, conditionally inserted onto the existing key, conditionally
inserted onto a fresh key, and read that back — reporting each raw response with no
interpretation. Steps 3 and 4 settled it in one run. Fixed: a win is now positive confirmation
of the literal string `"Success"`, and any unrecognised status is its own category that can
never become a win.

**Bug 2 — hand-walking an SDK response.** The audit then reported all 200 rows missing. They
were not missing: the raw audit showed every row present with the right holder, and
`holder_via_helper` returning `null` for all of them **including the positive control**. The
response is a `NoSQLResponse` whose nested items are themselves class instances, so
`Object.values()` over them finds nothing while `JSON.stringify` renders them perfectly. Fixed
by normalising through `JSON.parse(JSON.stringify(res))` first, which invokes every nested
`toJSON` on the way down.

**Bug 3 — the sort-key gate hole**, in §1.

These join the `[object Object]` read-back from order 0035, and the shape is now unmistakable
enough to write as a rule:

> **Never hand-walk or stringify an SDK response object, and never treat "it didn't throw" as
> success. Normalise through JSON and confirm the platform's own status string.**

Every one of these failed *quietly* and produced output that looked precisely like a platform
defect. The only thing that caught all four was asking "is this the platform or is this me?"
before writing anything down — and in three of the four cases the answer was me. The
diagnostic-with-a-positive-control is the tool that settles it, and it should be reached for
first, not third.

## 5. The ruling — pre-registered branch 1

**NoSQL conditional insert holds under contention. Catalyst keeps atomicity in a database, and
entry 43's arithmetic is void: claims no longer consume Stratus Upload's 2,000/month.**

That was the strongest argument against this route and it is gone. Route C has a claim
primitive that is correct, in a database, queryable, and typed.

**What replaces the Stratus meter is unknown, and I will not invent it.** NoSQL does not appear
in the Catalyst pricing reference **at all** — no unit price, no free-tier line, in a table
that lists Data Store, Cache, Stratus, Slate, SmartBrowz, Zia, QuickML and seven others. So I
can say entry 43's ceiling is lifted; I cannot yet say what the new ceiling is. Web access was
not available this session to check the public pricing page. **Open question, flagged, not
estimated.**

Two things that do **not** change:

- **The route still cannot run today.** Data Store remains exhausted, and identity resolution
  — token → agent → project — lives there. Moving claims to NoSQL does not free the route from
  Data Store, so entry 42's transitive-takedown point stands unchanged and is if anything
  sharper: the service with the only working in-database atomic primitive is reachable, while
  the route that would use it is not.
- **Contended G2 against the adopted primitive is still owed.** These are figures for the
  primitive measured directly, from a job, in a different shape. They are not G2 and must not
  be filed as G2 — that would be the borrowed-number error in a fourth costume.

## 6. State left behind

`claim_probe` holds roughly 400 rows from the two valid races plus 3 diagnostic rows; the table
was created for this purpose and there is no bulk-delete on the NoSQL surface I can reach. The
`nosql:control` Cache key is set to `HOLD`, so an accidental job trigger reads the schema and
stops rather than racing. `nosqlprobe` remains deployed; it is a diagnostic and should be
deleted alongside the `/diag/*` routes once the primitive question is closed.

Held as instructed: **F1–F12 unstarted, A5 unspent.**
