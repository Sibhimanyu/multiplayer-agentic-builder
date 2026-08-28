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
| 23 | **The MCP cannot write a Stratus object at all** | 18 Stratus tools exposed and **none of them writes an object.** Both signature paths fail from outside a function: `Create_Upload_Signature` returns a policy pinning `content-length: 0` **regardless of the body passed** — called twice with different lengths, identical policy — and the REST PUT returns `400 invalid_request_parameter` across four variations. `Generate_Signed_URL` + GET returns `400 "Signature didn't match. Request is tampered"`. The write is therefore **untested, not failing**: the real path is the SDK's `putObject` from inside a deployed function, which needs deployed code to exercise. | Admin SDK writes from anywhere with a service-account key. | probed, 4 variations |
| 24 | **No per-object cache control in the Node SDK** | The REST docs list `cache-control` as a `putObject` header, but `zcatalyst-sdk-node@3.4.0` builds only `compress`, `Content-Type`, `expires-after`, `overwrite` and `x-user-meta`. **There is no `cache-control` option and no such header.** The only cache API is a bucket-level `purge-cache`, and the console exposes no caching toggle — only General Settings and Bucket CORS. So with `bucket_meta.caching: "Disabled"`, **whether route C1's snapshot read is cacheable at all is an open question**, and it must be settled before G1 is measured rather than after. | `Cache-Control` set freely on Hosting; Firestore reads are SDK-cached client-side. | SDK source + console |
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
| Server-enforced scope locks (**entry 18**) | residual race, narrowable not closable — **mitigation tested from both sides by injecting a competitor between pre-check and re-check** | one `runTransaction` | **MEASURED. Window closed by TWO mechanisms — one designed, one incidental — both now pinned.** Injected-competitor tested: B acquires `src/**` from inside A's transport at the instant A finishes reading the locks it is about to reason about; A pushes a stale generation holding `src/api/**` — overlapping, not identical, the case `is_unique` cannot catch — A is rejected, its conflict **names** agent B and carries `src/**`, exactly one lock survives. With a control, so a reject-everything implementation could not pass. **Do not read this as "closed by compare-and-swap":** mutation testing showed the CAS alone is not what closes it. See below. The mechanism: `--force-with-lease` with a *non-empty* expected value is a real compare-and-swap on a ref's value, so a generation ref becomes a serialisation point — read gen + locks, check intersections against that set, push the new lock **and** the gen bump in one atomic push whose lease pins gen to what was read. A competitor acquiring in between moves gen, the CAS fails, the whole push rolls back. **But A7 and A8 cover intersecting and disjoint globs and neither injects a competitor between the generation read and the push, which is the specific race entry 18 is about.** Catalyst tested its mitigation at exactly that point; route G has not yet built the equivalent. Do not quote "window zero" as measured until it does. |

**Entry 18 was the largest asymmetry in this register and route G's mechanism appears to close it.**
Recording that matters as much as recording where Catalyst suffers — the note about not flattening
"needed a workaround" and "cannot be made correct" into one column cuts in this direction too.

### Entry 18 is closed by two mechanisms, and only one was designed

Route G mutation-tested its own adversarial test and found it did **not** discriminate:

| Mutant | Result |
|---|---|
| generation ref still pushed, **CAS lease removed** | **test PASSED** |
| generation ref **removed from the push entirely** | test FAILED |

The second mutant proves the test is not vacuous — it genuinely detects an open window. The first
is the finding: **the CAS is not what closes it.** Two independent mechanisms do.

1. **The explicit CAS lease** — designed, and what was originally reported.
2. **Generation commits being orphans** — *accidental*. `mkObject` builds commits with
   `commit-tree` and no parent, so pushing one over an existing generation ref is a
   **non-fast-forward** and the server rejects it.

That second mechanism is the **descendant rule appearing for the third time** in this project —
underneath the coordinator's `HEAD`/`HEAD~1` claim probe, underneath route G's own `rc=0` finding,
and now doing load-bearing work nobody designed it to do.

**Mechanism 2 is fragile in a plausible direction.** Chaining generation commits for auditability
is an obvious future improvement, and it would make every plain push a fast-forward and evaporate
mechanism 2 entirely. The CAS would still hold, so nothing would break *yet* — but the live test
passes either way, so a **later** regression dropping the CAS would go undetected. Two protections,
one test, no attribution.

Both are now pinned offline in `scope-invariants.test.ts`, and the pins were mutation-tested too:

| Mutant | Orphan test | CAS tests |
|---|---|---|
| CAS removed | passes | **both fail** |
| generation commits chained | **fails** | both pass |

Each mutant caught by exactly the test that owns it. That is attribution, and it is what should
have existed before the window was first called closed.

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

## Entry 29 — the coordinator made the rc=0 error while enforcing it

Order 0032 was issued, pushed, and spawned. The spawned process printed

```
You've hit your session limit · resets 7:20pm (Asia/Calcutta)
```

and **exited 0**. The task notification read `completed (exit code 0)`. Total work performed: none.
`impl/catalyst-v1` never moved off `71c5b59`, the worktree stayed clean, and for a short while the
order looked delivered.

This is **order 0027's rule, verbatim, applied to me**: `rc=0` is not a verdict; read structured
fields, never exit codes. I have issued that rule four times to two builds. My own orchestration
took a subprocess exit status as evidence of work — and a spawn harness returns 0 on a total no-op,
which is precisely the failure the rule exists to catch.

Worth being exact about the shape: this is not "the tool lied." The exit code faithfully reported
that the *process* terminated normally. It was never a claim about the *task*. Reading it as one is
the same substitution as reading a 400's `Cache-Control` header as a property of the data path
(entry 24) — a true signal about the wrong subject. Third instance of that shape in three orders.

**Rule: a spawned run's result is verified by artifact, never by exit status.** Specifically —
did the branch head move, did the files change, and does the output contain a quota or limit
message? Check all three before reading a single word of the report as a finding.

Entry 27's `putObject` result survives this: it was verified against a moved head (`71c5b59`), a
recorded bucket before/after, and self-reported probe defects — not against an exit code.

## Entry 26 — Stratus bucket caching does not exist in the IN data centre

`Update_Bucket` **does** expose `bucket_meta.caching.status` (enum `["true","Disabled"]`), so this
was called rather than skipped. The platform refused:

```json
{"message":"Invalid operation. Bucket caching feature is not available in current DC.",
 "error_code":"FORBIDDEN"}
```

Bucket state before and after is byte-identical, `modified_time` unchanged.

**This is an absent capability, not a provisioning gate, and the distinction is load-bearing:** a
gate can be passed — by a console click, a support ticket, a paid plan — so it costs *effort* and
belongs in G10. This cannot be passed at all, so it costs *the design*. Adding it to the gate count
would have understated it by implying a price existed.

**Rule:** before adding anything to G10, ask whether it can be passed. If not, it is not a gate.

## Entry 27 — `putObject` works; the write path was never broken

First attempt from inside the deployed function, no variation needed. `put` 142 ms, `head` 111 ms,
`get` 23 ms, `delete` 136 ms — **function→Stratus inside one DC, not client latencies.** The earlier
`Create_Upload_Signature` and `Generate_Signed_URL` failures were about those surfaces, not about
Stratus writes. "Untested, not failing" was the correct call and it held.

Two defects in the probe, self-reported rather than buried: `getObject`'s return was `String()`-
coerced to `"[object Object]"`, so the probe proved the *call* succeeded without proving the *bytes*
round-tripped; and `deleteObjects` returns `"Object Deletion scheduled."`, so absence was verified
separately instead of trusting the response. Both are the same error as reading an exit code — a
success-shaped response is not a verified outcome.

## Entry 28 — C1's cached read does not exist, so C1's case is now quota, not latency

Host named, per the entry-25 rule: **`coordinationsnapshots-development.zohostratus.in`**, client in
Asia/Kolkata, pre-signed URL (the bucket is Authenticated, so this is the real client path).

| cold | warm | cache headers |
|---|---|---|
| **79 ms** | **20 ms** | **none** |

`cache-control: no-store`, `pragma: no-cache`, `expires` at epoch; `age`, `x-cache`,
`cf-cache-status`, `via` all absent.

Warm being 4× faster does **not** satisfy the pre-registered "warm ≪ cold" branch, which required a
cache header. Three things attribute the 59 ms to connection reuse: Stratus explicitly forbids
caching, **two distinct `x-sts-request-id` values prove both requests reached the origin**, and
`keep-alive: timeout=20` is exactly the handshake that vanished. This is the 0029 discipline applied
without being asked — a faster number is not a mechanism.

**Verdict, per the pre-registration and unsoftened: C1's read is a plain origin object GET, and
C1's advantage over C2 was never established.** C1 pays for a snapshot builder, an Event function
and a bucket to obtain a read C2 gets with none of them.

**C1 retains one narrower argument: operation cost.** One object GET against `readEvents`' 3
SELECTs, and SELECT is the binding quota per G4/G6 (1,260 SELECT = 12.6% of quota, against 403
INSERT = 8.1%). ETag is present, so `readSnapshot(etag)` → 304 survives.

**But "C1 wins on quota" is not yet measured either, and it is the same shape as entry 25** — a
comparative claim resting on a number for only one side. Stratus's own quota consumption per GET is
unknown. Until it is measured, C1 has *no* established advantage over C2, on any axis.

### And 79 ms is the best case, which cuts the same way

Client and DC were both in India. Absent CDN caching there is **no edge to absorb cross-region
RTT**, so an agent in the US pays the full round trip on *every* snapshot read, uncached, forever.
Edge caching is precisely what would have made a single global snapshot viable. Neither of us
measured this, and it makes C1's read worse than 79 ms suggests rather than better.

## Entry 25 — route C1's headline number was borrowed from route G

This is the most serious bookkeeping error found so far, and it is mine.

`blackboard.md` measured three things on this machine: `git ls-remote` 1,347 ms, `git fetch`
1,354 ms, and "HTTPS GET of a static CDN object" **34 ms**. The URL five lines below identifies
that object: **`raw.githubusercontent.com`**. So the 34 ms is *GitHub's CDN* — it is **route G's
read path, measured on route G's infrastructure.**

`impl-catalyst.md` then restated it as `Read path | Stratus | Measured 34 ms`, and from there it
propagated into the design doc, the checklist, and order 0018 as the reason **route C1 was chosen
over route C2**.

**Stratus has never been timed. Not once.** The number that justified the platform choice was
measured on a competing platform.

Order 0017 caught the weaker version of this ("the Stratus builder does not exist, so 34 ms is not
what was measured"). Nobody caught that the number was not merely *unmeasured* but **borrowed from
a different vendor**. Unmeasured invites "so measure it." Borrowed means the comparison was
circular: C1 beat C2 on a figure C1 had never earned.

### Why it survived so long

It read as a measurement because it *was* one — the ms figure was real, the method was sound, the
table said "measured on this machine." Everything was true except the subject. A provenance field
naming the host would have caught it on the day it was written; "measured" alone did not.

**Unstated is not the same as wrong.** The `catalyst-run-1.md` audit found six figures across two
tables naming no host — but all were measured against the route that claims them, so they were
*mislabelled*, not misattributed. Entry 25 was a correct number with a correct method and the wrong
subject. Keep the two severities apart; collapsing them would make every missing label look like a
scandal and bury the one that is.

**Rule, retroactive to every number in this register:** a latency figure carries the *host it was
measured against*, not just its evidence class. `34 ms` is not a fact about CDNs in general. Audit
backwards per the 0026 rule — any figure that names no host is suspect until one is attached.

### What follows for the comparison

- G1 for route C1 on the folded-snapshot path is **open**, and entry 24 says the design's cacheable
  read may not even be reachable through the SDK.
- **If it isn't, C1's advantage over C2 was never real** — and C2, plain Data Store reads, may have
  been the better route all along. That is a result. Report it at full strength; do not bury it.
- The existing measured G1 covers the *ledger* path and was correctly labelled. It stands.

## Coordinator discipline — record what was measured separately from what was reasoned

**Twice now a build has had to walk back something I amplified**, and both times the underlying
error was mine, not theirs:

1. Route G's A2 **50/50** — I called it "the strongest primitive evidence any route has produced".
   The build then found the test could not have detected the `rc=0` failure class at all.
2. Route G's **entry 18 "window zero"** — I recorded it as closed. The build then pointed out the
   mechanism is reasoned, not adversarially tested, because nothing injects a competitor at the
   one instant the race occupies.

The failure mode is the same both times, and it is mine: **I recorded a conclusion at the
confidence the reporter expressed rather than at the confidence the evidence supported.** A build
saying "this is closed" is a claim about its mechanism; a register entry saying "closed" reads as a
claim about the world.

**Standing rule for this file: every entry states its evidence class.** `measured live` /
`probed` / `reasoned` / `free-tier arithmetic`. An entry whose class is `reasoned` may not be
summarised as though it were measured, and the final comparison must not promote one to the other.

**Extended 2026-08-27: `measured` is not sufficient either — an entry also needs ATTRIBUTION.**
Entry 18 was measured *and* the measurement did not establish which mechanism produced the result.
An entry naming a cause ("closed by compare-and-swap") is a stronger claim than an entry naming an
outcome ("window closed"), and only mutation testing separates them. Where an entry names a cause,
it must say how the cause was isolated.

Route G named the shape of my error precisely: *the same shape as your own probe generalising from
`HEAD`/`HEAD~1` — a correct conclusion resting on evidence that does not cover the case.* That is
now three instances of one habit, so it gets a rule rather than another apology.

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
