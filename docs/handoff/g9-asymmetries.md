# G9 — Platform asymmetries register

Coordinator-maintained. **Neither implementation edits this file.** Report findings on your own
branch and they get folded in here.

This register is the actual deliverable of building both platforms. Each row is a place where
one platform charged for something the other gave away. Every entry was found by probing or by
a test failing, not by reading documentation.

The rule for this file: **do not normalise the asymmetries away.** "The same guarantee cost
Catalyst a composite-key scheme and Firestore nothing" is the finding. Averaging the two into
"both work fine" destroys it.

| # | Guarantee | Catalyst cost | Firebase cost | Found by |
|---|---|---|---|---|
| 1 | Monotonic `seq` | `ROWID` is allocated from per-shard blocks and runs **backwards** across INSERTs. Needs a dedicated `seq bigint is_unique` column, globally allocated, with a bounded CAS retry loop. | A counter doc inside `runTransaction`. First-class — but **not free at concurrency**: see measured note below. | live probe: insert #1 `…052001`, insert #2 `…044002` |
| 2 | Per-project uniqueness | `is_unique` is global to the **table**. Every per-project constraint becomes a composite key column, with a builder that rejects the separator inside any part. Applies to `task_claims`, `scope_locks`, `request_dedupe`. | Nothing. A transaction on a document path is naturally scoped. | live probe |
| 3 | Injection safety | ZCQL has **no parameter binding**. With `project_id` arriving from request bodies, the escaper is the entire injection boundary — one audited chokepoint, tested against real payloads. | Nothing. The SDK is parameterised. | live probe |
| 4 | Running the conformance suite | **CORRECTED 2026-08-26 by measurement.** The binding cost is SELECTs, not INSERTs. A5 really costs ~**1,505 SELECTs** — 15% of the 10,000/month allowance — because every authenticated request pays 2 SELECTs of token→agent→project→role resolution before its own work. The earlier "602 INSERTs, ~8 runs" figure was reasoned from the schema instead of measured, and was wrong. | 602 writes against 20,000/**day**. Effectively unlimited. | measured on a live deploy |
| 11 | Cost of authenticating a request | Every authenticated request pays **2 SELECTs** before doing any work, because the protocol requires resolving token→agent→project→role server-side on every call and that cannot be cached without weakening the guarantee. An append therefore costs **5 SELECTs + 2 INSERTs**, so the 10,000 SELECT allowance binds at ~2,000 appends while the 5,000 INSERT allowance would have permitted 2,500. | Security rules evaluate server-side at no metered read cost. | measured |
| 12 | The `Authorization` header | **Reserved by the API Gateway.** It is validated as a Zoho OAuth token before the function runs — `Bearer` gives `INVALID_TOKEN`, anything else `AUTHENTICATION_FAILURE` — and the function never sees the request. No handler code can recover it. Forces `X-Agent-Token` on every route, because the CLI is shared. | No reserved headers. | probed |
| 13 | Timestamp fidelity | `datetime` columns **reject RFC3339**, the format the protocol specifies. Only `YYYY-MM-DD HH:MM:SS` is accepted, reads return a `.mmm` suffix that is not accepted back, and **milliseconds are dropped**. Needs a codec, and the ledger stores second resolution. | Native millisecond timestamps. | probed |
| 14 | Error shape | `zcatalyst-sdk-node` renames `error_code` to `code` and drops the documented REST wrapper, and the message does not contain the code — so code written against the documented payload silently fails to match, and message matching is not a fallback. | SDK errors carry stable structured codes. | probed |
| 15 | Paging | ZCQL **rejects** `LIMIT 0, 301` rather than clamping, killing the over-fetch-by-one trick at exactly the default page size. `has_more` costs an extra query per full page. | `limit(n+1)` works. | probed |
| 16 | Provisioning | **No `project:create` exists.** `iac:import` needs a zip from `iac:pack`, which needs a template from an asynchronous `iac:export` that delivers to the console. The MCP has no create-project tool. Console only. Then 2 CLI commands, 18 API calls (2 failing), ~95s, zero browser steps for everything after the project itself. | One CLI command, but the project still needed a console visit, and the billing link cannot be done by any CLI. | measured |
| 5 | Atomic append + idempotency together | Exists only because there are no transactions. `seq` allocation needs a retry loop, so the dedupe row cannot be written inside it, and the write order must be event-first-then-dedupe with orphan recovery on crash. | Nothing. `runTransaction` makes both writes atomic. | dry-run double: 12 concurrent appends, 1 passed, 11 failed |
| 6 | Presence / heartbeat | Cannot use a durable row UPDATE — the free tier is **1,000 UPDATEs per month**, which a 20s heartbeat exhausts in 5.6 hours. Requires Cache with a TTL, where key expiry *is* the staleness signal. | A field write on the agent doc. 20,000 writes/day free. | free-tier arithmetic |
| 7 | Realtime push to clients | None available. Signals targets are Webhook / Function / Circuit only — no browser, no CLI target. Requires polling a CDN snapshot, ~5s. AppSail WebSockets exist but cost ~$13/mo minimum and can never be free. | `onSnapshot`, sub-second, billed per document delivered on change. | product audit |
| 8 | Durable text fidelity | `varchar` silently clamps at 255; `text` caps at 10,000; **emoji and 4-byte UTF-8 are silently stored as `?`**. Requires a sanitiser on every durable write. | Full UTF-8, 1 MiB per document. | product audit |
| 9 | Sharing code across deploy units | Each function directory deploys independently, so `functions/_lib` must be vendored per directory at package time, with a drift guard and import-depth rewriting. | One deployable. | build |
| 10 | Spending safety | Transparent per-operation pricing with a $5/project floor. Cannot run away. | **No spending cap by default** on Blaze. Requires a manually-set budget alert, which `firebase-tools` cannot create — Cloud Billing budgets are console-only. | build |

## Corrections made against Catalyst's favour, and against it

Entry 4 was **wrong in Catalyst's favour** and is now corrected: the suite is SELECT-bound, not
INSERT-bound, and costs ~15% of a monthly allowance per run rather than the ~12% the INSERT
framing implied. Entry 1 was corrected the other way, **in Catalyst's favour**, once Firebase
measured a real contention ceiling on its counter document.

Both corrections came from measurement replacing reasoning. A register that only moves one
direction is arguing, not measuring.

## Measured, not theoretical — entry 1

Firebase's single counter document has a real contention ceiling. At 32-way concurrent append
the emulator returned `10 ABORTED: Transaction lock timeout` on
`projects/{pid}/meta/ledger`. **Intermittently** — the next run landed all 32 with no refusals.

This does not break the contract. `ABORTED` maps to `StoreBusyError`, which the interface
defines as a normal retryable outcome, and all 32 land when driven through the shared retry
helper. But it means the two platforms converge more than entry 1 first suggested: Catalyst
pays with an explicit CAS retry loop it had to design, Firebase pays with an implicit one it
gets from the SDK. **Both need a retry; only one had to think about it.**

Record it as a distribution, never as a cliff. See "Measurement discipline" in the checklist.

## Severity trend worth noting

Three separate defects came from the single fact that `is_unique` is table-global, and the
failure mode got **quieter** each time:

1. `seq` allocated per-project against a global column → **deadlock**. Loud, immediate.
2. `unique(task_id)` → **cross-tenant denial of service**. Visible, but only to the victim.
3. `unique(idempotency_key)` on a client-supplied key → **silent cross-tenant event loss**.
   HTTP 200, a plausible `seq`, the event never written.

A platform property that produces progressively quieter failures is more dangerous than one
that fails loudly, because the third only surfaces as "the agent never saw the contract" weeks
later. This is the argument for probing every assumption rather than reading it.

## Method note

The dry-run double — replaying the real store's semantics in-process, including the *measured*
non-monotonic `ROWID` behaviour rather than the assumed one — caught entry 5, which no amount
of code reading would have found. It also refuses to answer an unrecognised ZCQL statement
rather than returning `[]`, so a typo cannot read as "no rows".

Recommended to both builds. It is cheap and it front-loads discovery to before anything
touches a cloud.
