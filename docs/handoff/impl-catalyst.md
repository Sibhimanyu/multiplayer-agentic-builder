# Workspace 1 — Catalyst implementation (route C1, "Snapshot")

You are building the **Catalyst** half of a two-platform bake-off. A second agent is building
the Firebase half in parallel from the same Phase 0 spec. Do not coordinate with them. Do not
read their branch. The comparison is only valid if both are built independently.

Branch: `impl/catalyst`

## Read first, in this order

1. `docs/reference/store-interface.md` — the ten operations you implement. **This is the contract.**
2. `docs/protocol/agent-coordination.md` — protocol v0.2, three layers
3. `docs/reference/agentic-file-contract.md` — the CLI↔agent filesystem interface
4. `docs/reference/blackboard.md` — the git half
5. `docs/how-to/acceptance-checklist.md` — your definition of done
6. `docs/designs/dashboard.md` — tokens, already implemented in `client/`

## Your scope

Implement `CoordinationStore` for Catalyst, plus the CLI and functions around it.
**Do not touch `client/components.tsx`, `client/src/tokens.css`, or anything in `docs/`.**
Those are shared. If you believe a shared file is wrong, say so and stop — do not edit it.

## The stack, decided

| Concern | Product | Why |
|---|---|---|
| Dashboard hosting | **Slate** | Web Client Hosting is deprecated. Slate is Git-based with preview deploys. |
| Write endpoints | **Advanced I/O Functions** | Only type that can capture a raw body for GitHub HMAC. 30 s cap. |
| Ledger + claims | **Data Store** | `is_unique` gives atomic claim without transactions. |
| Read path | **Stratus** `snapshot.json` | Measured 34 ms vs 1,347 ms for git and 150× cheaper than a SELECT. |
| Presence | **Cache**, TTL 1 h | TTL expiry *is* the staleness signal. Never a Data Store UPDATE. |
| Reaper | **Cron Function** | Releases stale claims past 15 min. |
| Login | **Authentication** | Zoho SSO. |
| Routing | **API Gateway** | 100 k req/month free. |
| Contracts | **git** | See `blackboard.md`. |

**Not using, deliberately:** AppSail (that's route C2), Signals (no browser or CLI target),
Circuits and Integration Functions (US DC only), NoSQL (absent from the pricing reference,
cost unknown), Web Client Hosting (deprecated), Pipelines (GitHub Actions already exists).

## Platform constraints you must design around

These are verified, not guesses. Each one has bitten a real project.

| Constraint | What you must do |
|---|---|
| No multi-statement transactions | Claim via `INSERT` into `task_claims` with an `is_unique` `task_id` column; catch the violation. Never read-verify-write. |
| `is_unique` confirmed on `email` and `bigint`, unverified on `varchar` | **Probe this first.** If varchar rejects it, hash `task_id` to a `bigint` column, which is documented to support it. |
| ZCQL caps at 300 rows, 20 columns | Make 300 the explicit default in `readEvents`. `SELECT *` counts as one column. Log any cap you hit. |
| `varchar` hard cap 255, **silently clamped** | Use `text` for `pr_url`, titles, summaries. Never `varchar` for user or agent text. |
| `text` caps at 10,000 chars | Contracts never go in a column. Pointer only. Chunk long role prompts. |
| Booleans stored as strings; `"false"` is truthy in JS | Convert on read: `v === 'true' \|\| v === true`. A truthy `can_merge` is an agent merging when it must not. |
| **Emoji silently become `?`** | Strip in `shared/sanitize.ts` before every durable write. Must match Firebase behaviour exactly. |
| Free tier: **1,000 UPDATE/month** | A 20 s heartbeat exhausts that in 5.6 hours. Heartbeats go to Cache, not Data Store. Zero UPDATEs by design. |
| Free tier: 10 k SELECT, 5 k INSERT /month | Client reads hit Stratus, not Data Store. Debounce snapshot writes, 2 s leading edge. |
| 10 concurrent executions per function per env, then 429 | Return `StoreBusyError`; the CLI backs off with jitter. |
| Advanced I/O 30 s timeout | Nothing on the request path may block. Snapshot rebuild goes in an Event function. |
| `Stratus.putObject` defaults `overwrite:false` | Snapshot writes MUST pass `{ overwrite: true }`. |
| Event functions **silently terminated** on timeout | Log a heartbeat at start and end so you can tell a silent kill from success. |
| ZAID differs Development vs Production | Documented #1 cause of auth breaking after promotion. Read it from config, never hardcode. |
| Cache `delete()` leaves a null-valued key; `update()` without expiry resets TTL to 48 h | Always pass an explicit TTL. Treat a null value as absent. |

## Build order

1. `shared/store/memory.ts` + the conformance suite from checklist section A. **Do this first.**
   It is how you find interface mistakes before touching a cloud.
2. Probe `is_unique` on a `varchar` column. Record the answer in `docs/handoff/impl-catalyst-notes.md`.
3. Data Store tables: `events`, `task_claims`, `scope_locks`, `tasks`, `agents`, `members`,
   `roles`, `github_links`, `request_dedupe`.
4. Advanced I/O functions: `claim`, `append`, `events`, `connect`, `role-pack`, `github/webhook`.
5. Event function: snapshot builder → Stratus, debounced 2 s leading edge, `overwrite:true`.
6. Cron function: stale-claim and stale-agent reaper.
7. `store/catalyst.ts` implementing `CoordinationStore`. Run the same suite. It must pass.
8. CLI: `connect · status · claim · report · start`, outbox drain, blackboard push.
9. Wire `client/src/App.tsx` to `createCatalystStore`. One line.
10. Run the F1–F12 demo. Record every G-metric.

## Definition of done

Every box in `docs/how-to/acceptance-checklist.md` sections A, B, C, D, E, F, G, H.
Section G is the point of the exercise — record real numbers, not estimates.

Write `docs/handoff/impl-catalyst-notes.md` as you go: every constraint you hit, every
workaround, honest hours. Section G10 must be written **before** you look at the Firebase
build's numbers.
