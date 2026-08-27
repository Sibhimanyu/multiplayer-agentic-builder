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
| 17 | **Service activation** | Several services require a **one-time browser session per project** before their API works at all. Stratus: `Create_Bucket` returns `OPERATION_NOT_ALLOWED` — *"User needs to be in session when accessing Stratus for the first time"* — while `Get_All_Buckets` succeeds and returns `[]`, so reads are permitted and only first-time creation is gated. There is **no `stratus` command in the CLI**, so no non-browser path exists. Documented for Slate, Signals and SmartBrowz too, so this is a platform pattern rather than one service's quirk. **Total manual gates for this route: 3** — project creation, Stratus activation, Slate activation. | **CORRECTED 2026-08-26 — not gate-free.** **2 manual gates:** project creation, and a **service-account key** downloaded from the console, because there is no Application Default Credential on the machine and `gcloud` is absent, so the Admin SDK cannot authenticate any other way. Everything else was 7 CLI commands in ~4 minutes. | probed live, both sides |
| 18 | Server-enforced file-scope locks | **Cannot be made atomic.** Without transactions, the glob-intersection check and the lock INSERT are separate operations, and `is_unique` on the lock key cannot stop two agents with *overlapping but non-identical* globs both passing the pre-check in the same instant. Mitigated by re-reading after insert and a **deterministic tie-break** (lower `lock_key` wins) so exactly one racer concludes it lost — a naive "on conflict, back off" would have both yield and **neither** hold the scope, which is worse than the race. A residual window remains that can be narrowed but not eliminated. | One `runTransaction`. Genuinely atomic. | probed live |
| 19 | **Observability of deployed code** | `Get_Logs` returns `[]` for every function at every level and window tried — a deployed function's console output is effectively **write-only**. Every wrong SDK init failed identically: `FAILURE`, `response_code: "Code_Exception"`, no message, nothing in the logs. Two deploy cycles were spent distinguishing `initialize(jobRequest)` from `initialize(context)` by elimination. Requires building a bespoke `/health` endpoint that surfaces state through Cache just to diagnose anything. | Cloud Logging works. Errors carry structured codes. | measured live |
| 20 | Scheduled work | A cron-type function is **unreachable programmatically**: HTTP invocation gives 403 `HTTP Execution is not supported`, `functions:execute` needs a local runtime binary, and the Job Scheduling API refuses it — *"The given function is not a job function."* A function's type is also **immutable**, so the deployed cron had to be deleted before a job function of the same name could deploy. And "a Cron Function" is really **three resources** — Job Pool, Cron, function — where the design named one. | One scheduled function. | measured live |
| 21 | **Stratus is the only service that blocks its own API** | Data Store, Functions, Cache and Job Scheduling all accepted their **first** API call on this identity with no console visit — nine tables, 63 columns, two functions, a job pool and a cron, all provisioned through the API. Stratus alone returns `OPERATION_NOT_ALLOWED` / *"needs to be in session when accessing Stratus for the first time"*, and it has survived one console visit. **An outlier is a platform finding, not a configuration mistake** — the project is demonstrably set up correctly. | No service gates its own API on a prior browser session. | measured across 5 services |
| 22 | **You cannot tell which identity you are acting as** | `catalyst whoami` reports a display name only — *"Sibhimanyu G undefined"* — with no email, and no CLI config exposes one. So when an error says a **session** is required, nobody involved can verify which identity needs it. A human is asked to open the console as a specific account while having no way to confirm from the tooling which account the API uses. This is why the Stratus gate has taken three attempts. | `firebase login:list` prints the account. A service-account key names its own `client_email`. | measured |
| 16 | Provisioning | **No `project:create` exists.** `iac:import` needs a zip from `iac:pack`, which needs a template from an asynchronous `iac:export` that delivers to the console. The MCP has no create-project tool. Console only. Then 2 CLI commands, 18 API calls (2 failing), ~95s, zero browser steps for everything after the project itself. | One CLI command, but the project still needed a console visit, and the billing link cannot be done by any CLI. | measured |
| 5 | Atomic append + idempotency together | Exists only because there are no transactions. `seq` allocation needs a retry loop, so the dedupe row cannot be written inside it, and the write order must be event-first-then-dedupe with orphan recovery on crash. | Nothing. `runTransaction` makes both writes atomic. | dry-run double: 12 concurrent appends, 1 passed, 11 failed |
| 6 | Presence / heartbeat | Cannot use a durable row UPDATE — the free tier is **1,000 UPDATEs per month**, which a 20s heartbeat exhausts in 5.6 hours. Requires Cache with a TTL, where key expiry *is* the staleness signal. | A field write on the agent doc. 20,000 writes/day free. | free-tier arithmetic |
| 7 | Realtime push to clients | None available. Signals targets are Webhook / Function / Circuit only — no browser, no CLI target. Requires polling a CDN snapshot, ~5s. AppSail WebSockets exist but cost ~$13/mo minimum and can never be free. | `onSnapshot`, sub-second, billed per document delivered on change. | product audit |
| 8 | Durable text fidelity | `varchar` silently clamps at 255; `text` caps at 10,000; **emoji and 4-byte UTF-8 are silently stored as `?`**. Requires a sanitiser on every durable write. | Full UTF-8, 1 MiB per document. | product audit |
| 9 | Sharing code across deploy units | Each function directory deploys independently, so `functions/_lib` must be vendored per directory at package time, with a drift guard and import-depth rewriting. | One deployable. | build |
| 10 | Spending safety | Transparent per-operation pricing with a $5/project floor. Cannot run away. | **No spending cap by default** on Blaze. Requires a manually-set budget alert, which `firebase-tools` cannot create — Cloud Billing budgets are console-only. | build |

## Correction: Firebase was never gate-free

Entry 17 originally read "None" for Firebase. That was **wrong and in Firebase's favour**, and it
was wrong because I inferred it from `firebase projects:create` existing rather than from anyone
completing a deploy.

Measured: Firebase needs **2** manual console gates — project creation, and a service-account key,
because the machine has no Application Default Credential and `gcloud` is absent so the Admin SDK
has no other way to authenticate. Catalyst needs **3**. The gap is one gate, not three.

Third correction in this register, and the second against the platform I was unconsciously
favouring. The pattern in all three: **a claim inferred from a capability existing rather than
from someone completing the task.**

## A workaround that must NOT be generalised

Entry 19 forced the Catalyst build to write a `/health` endpoint that surfaces reaper state
through Cache, because a failure existing only in an unreadable log is a failure nobody can
diagnose. That was the right fix for the class rather than the instance.

**It must not become a shared requirement.** Firebase has working Cloud Logging and needs none of
it. Mandating the compensation on both routes would make Firebase pay for a Catalyst deficiency
and would **hide the asymmetry inside the shared spec** — the exact opposite of what this register
is for. It would also distort G7 (adapter LOC) and G8 (build hours) in Catalyst's favour.

General rule: **a workaround for a platform deficiency stays in that platform's tree.** If it
lands in `shared/`, the deficiency stops being visible.

## Route G has data now — three rows where it beats both cloud routes

The table above is Catalyst versus Firebase. Route G (GitHub-only) is measured in
`docs/results/route-g-run-1.md`. Three findings belong here because route G does **better than
both**, which the two-column table cannot express:

| Guarantee | Catalyst | Firebase | **Route G** |
|---|---|---|---|
| Manual console gates to first deploy | **3** — project, Stratus, Slate | **2** — project, service-account key | **0.** One CLI command, zero accounts, zero billing, nothing blocked on a human. |
| Atomic claim | `is_unique` insert conflict, plus a **residual scope-lock race** it can narrow but not close | `runTransaction` | A **lease with an empty expected value**, needing no prior fetch — so a single round trip with **no read step and therefore no read-verify-write window at all** |
| Ownership check on release | application code | application code | **server-enforced for free** by pinning the lease to the owner's sha |
| Presence / heartbeat | Cache PUT with TTL, zero rows | one field write per beat | **one ref update, zero rows**, storage footprint exactly one ref per agent forever |

### Measured since — including where route G is WORSE

| Guarantee | Catalyst | Firebase | **Route G** |
|---|---|---|---|
| `seq` allocation cost | 1 extra SELECT per append | counter doc in the transaction | **O(N²).** Attempts equal the seq being claimed, so 12 concurrent allocations cost **78 push attempts plus 78 re-reads**. Correct and expensive — and the expense sits inside a retry loop where 0019 says it would otherwise be invisible. |
| Atomic append + idempotency (register entry 5) | write order event-then-dedupe, with orphan recovery | `runTransaction` | **Does not arise.** `--atomic` genuinely rolls back, measured both directions, so the event ref and its dedupe marker land in **one push**. Nothing to order, nothing to recover. |
| Server-enforced scope locks (**entry 18**) | **residual race, narrowable not closable** | one `runTransaction` | **CLOSED, window ZERO.** `--force-with-lease` with a *non-empty* expected value is a real compare-and-swap on a ref's value, so a generation ref becomes a serialisation point: read gen + locks, check intersections against exactly that set, then push the new lock **and** the gen bump in one atomic push whose lease pins gen to what was read. Anyone acquiring in between moves gen, the CAS fails, the whole push rolls back. No deterministic tie-break needed — there is no residual race to break a tie in. |

**Entry 18 was the largest asymmetry in this register and route G closes it outright.** Recording
that matters as much as recording where Catalyst suffers: the note above about not flattening
"needed a workaround" and "cannot be made correct" into one column cuts in this direction too.

`seq` ordering was route G's predicted weak spot and it **is** one — but on cost, not correctness.
Latency is still unmeasured. Do not read these rows as a verdict.

## The largest asymmetry so far

Entry 18 is bigger than the composite-key scheme in entry 2, and the difference in kind matters
more than the difference in size.

Entry 2 cost Catalyst a **naming convention** — annoying, fully solvable, provably correct once
built. Entry 18 costs it a **residual correctness window** that can be narrowed but not closed,
because the primitive required to close it does not exist on the platform. Firestore closes it
with one `runTransaction`.

When the final comparison is written, do not flatten "needed a workaround" and "cannot be made
correct" into the same column.

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
