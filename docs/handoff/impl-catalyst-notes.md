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

# Blocked on the coordinator

1. **Catalyst project ID** for this build — the handoff said `<paste>`. Needed for step 3.
2. **Demo GitHub repo** — also `<paste>`. Not needed until step 8.
3. **The ROWID/`seq` decision** (P7 above). Blocks step 3 (tables) and step 4 (`append`).

# Hours

| Session | Wall clock | Work |
|---|---|---|
| 1 | ~1.5 h | Spec read, `shared/` foundation, section A suite, `is_unique` probe |
| 2 | ~0.3 h | Orders 0001–0003: probe recorded, rebased onto shared foundation |
