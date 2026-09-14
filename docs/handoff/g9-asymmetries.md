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

## Entry 57 — the JDK was never missing. It was shadowed on PATH.

Three runs reported the conformance suite unrunnable because `firebase-tools` "no longer supports
Java version before 21." **`openjdk 26.0.1` was already installed via brew the whole time.**
`java -version` reported 1.8.0_503 because a 2014-era Oracle *applet-plugin* JRE at
`/Library/Internet Plug-Ins/JavaAppletPlugin.plugin` sits earlier on PATH.

```
export JAVA_HOME="$(brew --prefix openjdk)/libexec/openjdk.jdk/Contents/Home"
export PATH="$JAVA_HOME/bin:$PATH"
```

The emulator then starts first try. **The diagnosis was one level off the truth** — "dependency
missing" rather than "dependency shadowed" — and it blocked the most important suite in the project
for three runs. Nobody ran `brew list`.

Second gotcha, recorded so it is not rediscovered: **`firebase emulators:exec` runs its script under
the CLI's own pkg-bundled Node**, which treats `--test` as a filename. Start the emulator standalone
and point `FIRESTORE_EMULATOR_HOST` at it instead.

## Entry 58 — A2 FAILS on the Firebase adapter, and A2 is the gate

The emulator suites ran for the first time. **36/37 pass. The failure is A2.**

Two runs failed two *different* tests — "32 concurrent appends" and "A2 20 concurrent claimTask, 50
consecutive rounds" — with the **identical** error:

```
StoreBusyError: 10 ABORTED: Transaction lock timeout.
  at withContentionRetry (firebase/store.ts:361)
```

One bug, two symptoms: **`withContentionRetry` exhausts its budget under sustained contention and
lets `StoreBusyError` escape**, which is precisely what both tests assert the adapter absorbs.

This matters more than an ordinary failure for three reasons. **A2 is the non-negotiable gate** this
project has used to qualify every route — route G passed it 20 racers × 50 rounds. **The chosen
route has never passed it.** And an earlier commit concluded *"A2 was the harness, not the adapter"*
after a foreign-emulator mix-up; that retraction is now itself in question, because with a correct
emulator A2 still fails, with a structured error rather than a harness artifact.

**Not yet established: whether production Firestore does this.** The emulator uses pessimistic
locking with a lock timeout; production uses optimistic concurrency. *"Transaction lock timeout"* may
be emulator-specific wording for an emulator-specific mechanism. **That is a hypothesis, and the
discriminating experiment is to run A2 against production — not to argue about it.**

What is *not* in doubt: the retry loop itself is well built. It detects contention by **structured
code, never message text** (a defect order 0017 already caught once), and it backs off on **real
time with an explicit comment** explaining that using the injected `FakeClock` would hang forever
under load and present as a load-dependent hang rather than a failure. The budget is the suspect,
not the design.

## Entry 55 — RESOLVED: neither presence figure was ever a measurement

48% and 144% are **both arithmetically correct**, at different heartbeat intervals — 120 s gives
36–48%, 30 s gives 144%. But the real finding is underneath that:

**There is no heartbeat interval constant anywhere in the codebase, and nothing emits heartbeats on
a schedule yet.** `STALE_AFTER_MS = 90_000` is the only timing constant that exists. Both figures
were arithmetic over an input **nobody had ever decided**, presented as measurements of a running
system.

This is the missing-parameter error, third instance and the cleanest one: entry 25 was a real number
whose *host* was never stated; entry 50 was a real number whose *interval* was never stated. In both
cases the arithmetic was sound and the subject was undefined.

**Rule: a derived figure names every input it was derived from.** A percentage with an unstated
denominator is not a weaker measurement — it is not a measurement.

Corrected framing for the Firestore row: **72–144% at 10 agents, over the free tier below ~43 s.**
A range, because the input is a choice rather than a fact. Fixed by order 0041 adding
`HEARTBEAT_INTERVAL_MS` beside `STALE_AFTER_MS`.

## Entry 56 — RTDB moves presence from 144% to 1.4%, and the meter is a different shape

Measured payload per presence record: **171 B**. Ten agents, 30 s beat, one dashboard:
**138.4 MiB/month = 1.4% of the 10 GB/month allowance** — the identical workload that costs **144%**
of Firestore's daily write cap.

**RTDB's meter is bytes downloaded, so cost scales with writes × listeners × payload, not with
writes.** Fan-out multiplies. That makes the win real but conditional: it is a bandwidth product, and
adding dashboards multiplies the bill in a way adding Firestore listeners does not.

Stated caveat, unprompted: these totals are **arithmetic over a measured payload.** Firebase bills
RTDB bandwidth inclusive of protocol overhead, which is not in the figure and could not be measured —
the RTDB Management API is disabled and the service account is denied `serviceusage.services.enable`.
It would take **73×** the computed volume to exhaust the allowance, so the conclusion survives a
large multiple. That is how a caveat should be sized: not "this might be wrong" but "here is how
wrong it can be before it matters."

### The design detail that prevents a future regression

The staleness derivation now lives in **one place shared by both backends**, explicitly so the RTDB
path cannot later be "improved" to a server timestamp and break A9 with no obvious cause. RTDB never
supplies `stale` at all.

And a subtle correctness catch: **absent `connected` means "no opinion", not offline** — otherwise
every Firestore-backed agent would render offline. `onDisconnect` arms once per agent per process
rather than per beat, because a round trip per beat is the one thing not to do on a bandwidth meter.

## Entry 52 — the presence fix could not be a deletion, because a frozen test says so

`heartbeat` must throw `StoreAuthError` for a revoked agent and must not retry it — conformance
**A14**, `shared/store/conformance.ts:429`, a frozen file both adapters run unmodified. The build
found that **by reading the suite before making the change**, not by breaking it and discovering why.

So the read became *cheap* rather than *absent*: cached 90 s, **heartbeat only**. Every other
operation still pays a fresh read, because those grant authority over shared state and a heartbeat
grants none. That is the property that makes the cache safe here and nowhere else.

**Only the allow is cached.** The first version cached both outcomes — fail-closed, which *looked*
safer — and thereby left a **re-instated** agent unable to heartbeat for the full 90 s. Caught by
`revocation-check.mjs` against real Firestore rather than by reading the code. Fail-closed is not
automatically correct; it was wrong in the direction nobody checks.

**Window, as ordered:** ≤90 s, three presence writes at a 30 s beat. The board is not fooled in the
meantime — both readers derive `status` from the agent document itself, so a revoked agent renders
as `revoked` throughout regardless of the cache. Asserted, 8/8 against real Firestore.

## Entry 53 — the emulator cannot run on this machine, and that is now a named blocker

`firebase-tools` refuses to start the Firestore emulator: **"no longer supports Java version before
21."** So `firebase/store.test.ts` and the conformance suite **cannot run here at all** until a JDK
21+ is installed.

Recorded because 0039 warned that skipped emulator suites must not become a habit, and the honest
answer turned out to be neither reluctance nor a sandbox quirk but a missing dependency. The build
verified the same behaviour against production Firestore instead — including A14's exact
revoked-then-heartbeat sequence — and left `client/sliceproof.mjs` in place to prove the full rules
chain under `emulators:exec` when the JDK exists, with a header stating that no latency figure may
ever come from it.

## Entry 54 — NUL bytes recurred, in the same project that already had them once

Two edits landed a literal NUL byte as a cache-key separator, making `store.ts` **binary to grep**.
Caught because grep called a TypeScript file binary — the same detection that caught it the first
time, and the second occurrence in this project.

Fixed by removing the separator entirely: `JSON.stringify([pid, agent_id])`, which has nothing to
police. **Rule: never build a composite key from a control character.** A separator that cannot
appear in a source file is not a clever choice; it is a landmine that survives compilation and
passes tests.

## Entry 50 — the presence read is 3× cheaper, and TTL was the wrong suspect

Entry 34 priced Firebase presence at **1 read + 1 write** per heartbeat, 48% of the daily write
allowance at 10 agents, and I assumed the fix — if one existed — would look like Catalyst's
TTL-expiry-as-signal.

**CORRECTED — my approval of this was arithmetically wrong. See the correction below before
reading the rest of this entry.**

**It is not the TTL. It is the read.** `heartbeat` opens with `assertNotRevoked()`, a billed read on
every beat, and that read is redundant *for this operation*: a revoked agent's heartbeat mutates only
its own row, and the reaper already releases revoked claims immediately. Relocating the check to a
field test on data already fetched gives **0 reads + 1 write** — halving the ceiling without removing
the check.

Recorded because I named the wrong remedy in the order. I asked whether a TTL equivalent existed;
the build looked at what the operation actually paid for instead of answering the question as asked.
It also declined to characterise the TTL question from memory, since `WebFetch` was not available —
left explicitly unverified rather than guessed.

### The correction: removing a read cannot reduce a write count

I approved this fix as taking presence "from 48% to ~24% of the daily **write** allowance." That is
wrong, and the build corrected it before it reached the scoreboard:

- **Reads and writes are separate Spark quotas.** Removing a read cannot move a write number.
- A heartbeat costs **one write before and one write after.** Writes are **unchanged**.
- At 10 agents on a 30 s beat: **reads 28,800 → 9,600** (58% → 19% of 50,000/day). **Writes 28,800 →
  28,800.**
- And it is not `0r`. A 90 s cache against a 30 s beat re-reads **every third beat** — `~0.33r + 1w`,
  not `0r + 1w`.

**Presence writes remain the binding constraint and remain over the free tier at ten agents.** The
worst number in the chosen design is still the worst number. The fix is worth having — a 3× read
reduction is real — but it does not touch the ceiling.

**OPEN, and it must be reconciled rather than smoothed:** entry 34 recorded presence as "**48% of
the daily write allowance**" at 10 agents, and this run reports 28,800 writes/day as being **over**
the free tier. At a 20,000/day Spark write limit that is 144%, not 48%. **Those two figures cannot
both be right.** Neither is being quietly adjusted to fit the other — the build owns reconciling
them, and until it does the presence ceiling is *unknown*, not 48% and not 144%.

**Entry 34's measurement of the mechanism stands (1r + 1w per beat); its percentage does not.**

## Entry 51 — the 1,955 ms contended claim is withdrawn as a quotable figure

It shares a run with the 1,167 ms uncontended anomaly that `probe-claim.mjs` already refuted
(~257 ms is defensible). It therefore carries an unexplained inflation of **unknown size that cannot
be subtracted out**. Withdrawn rather than corrected: there is no honest number to replace it with
until the contended case is re-measured in isolation.

The scoreboard's contended row for Firebase is now empty, not wrong.

## Entry 46 — NoSQL conditional insert HOLDS: Catalyst keeps atomicity in a database

The last candidate, and it works.

```
exactly one winner   200/200      zero winners 0      multiple winners 0
all five overlapped  200/200      (concurrency MEASURED, not assumed)
audit: 200 checked, 200 stored-matches-declared, 0 contradictions, 0 missing
winners n=200  p50 32  p95 40  p99 47  max 49 ms   (primitive only)
losers  n=800  p50 27  p95 35  p99 42  max 70 ms
```

Schema read back from the table's own definition before anything raced —
`partition_key: claim_key/S`, `additional_sort_keys: []`, `ttl_enabled: false` — **not** inferred
from a successful insert.

**Entry 43's arithmetic is void.** Claims leave Stratus Upload's 2,000/month, which was the single
strongest argument against this route.

**The 32 ms is NOT comparable to Firebase's 257 ms or route G's 2,182 ms** and must never be placed
in that row. Those are end-to-end client round trips; this is primitive-only from **five racers
inside one job invocation**, not five HTTP clients. The build reported it that way unprompted and
declined to file it as G2. **Contended G2 is still owed.**

### The gate that would have let a sort key through

The build's own schema check tested **seven hand-written spellings** of the sort-key field. The real
field is `additional_sort_keys` — **not among them.** It is empty, so the verdict was right and the
*reasoning* was not: a table *with* a sort key would have passed a check that appeared to be looking
for one. Rewritten to scan every field matching `/sort|range/i`, catch column lists declaring a sort
role, and **block rather than pass** on an unrecognised shape. Seven regression tests.

This is the false-pass shape one layer up — the guard against a false pass was itself capable of
one.

## Entry 47 — the platform answers "someone else owns this" with "retry", 91% of the time

**727 of 800 losers threw HTTP 500 rather than `CriteriaMismatch`.**

Safety is unaffected and was checked specifically: a 500'd write that had landed would appear as a
stored holder differing from the declared winner, and 200/200 matched.

But **a claim primitive must tell the caller which failure it hit.** "Someone else owns this task"
and "the service glitched, retry" demand opposite responses — the first must back off to another
task, the second must retry the same one. Catalyst answers the first with the second in 91% of
cases. Whether this is throttling wearing a 500 is **not established**, and the build declined to
characterise it.

Correctness passes; the contract is unusable as-is without a wrapper that distinguishes them, and
that wrapper cannot be written until the 500s are explained.

## Entry 48 — NoSQL has no published price, in a pricing table listing ten other services

The ceiling is lifted and **what replaces it is unknown.** No unit price, no free tier, no entry at
all. The route escaped its tightest meter into a service with no published meter — which is not the
same as cheap, and must not be reported as a win until priced.

## Entry 49 — three of the four "platform defects" this route found were its own bugs

The first NoSQL run reported **392 winners over 200 keys** — indistinguishable from the Data Store
CAS failure in entry 41, and entirely wrong. `insertItems` **resolves** with `CriteriaMismatch`
when the condition fails rather than rejecting, so every correctly-refused attempt scored as a win.
Then the audit reported all 200 rows missing; a raw audit **with a positive control** showed every
row present and the helper returning null *even for the control* — `NoSQLResponse` nests class
instances, so `Object.values` finds nothing while `JSON.stringify` renders them.

With the `[object Object]` read-backs from entries 27 and 45, that is **four bugs of one family**.

**Rule: never hand-walk or stringify an SDK response, and never treat "it didn't throw" as success.**

**The meta-finding is the valuable part.** All four failed *quietly* and all four looked exactly like
platform defects. Two genuine platform defects were found on this route (entries 37 and 41) and four
self-inflicted ones that presented identically. **The only thing that separated them was a positive
control** — a case that must succeed, run through the same code path. Without one, "the platform is
broken" and "my reader is broken" are the same observation.

## Entry 40 — Catalyst DOES have an atomic primitive, and it is not in the database

**Stratus `putObject` with `overwrite: false` holds: 200/200 tasks, exactly one winner, zero
violations.** 5 racers × 200 tasks, live service. Primitive-only p50 **36 ms**.

Reconciled twice against sources that were **not** the harness — the rule that a double proves
nothing, applied to the confirmation as well as the failure:

1. `Get_All_Objects` → `key_count 200, truncated false`.
2. **Stratus's etag *is* the content MD5**, so five sampled objects were hashed and each matched
   exactly the racer that had been told it won. That is durable proof of *which* racer won, not
   merely that one did.

**Eliminated, with the reason:** **Cache** — `put` overwrote an existing key with no contention at
all, so it cannot exclude a racer; no SETNX and no atomic increment on the SDK surface.

**Not probed, stated so nobody reads silence as absence:** **Circuits** — documented US-DC-only, this
project is IN. **Queue single-writer** — a queue is asynchronous and a claim is a synchronous
question; polling the outcome returns to the store that just failed. The build labelled that "an
argument, not a measurement," which is the correct filing.

## Entry 41 — Data Store compare-and-set fails WORSE than `is_unique`, and silently

`UPDATE … WHERE` CAS, same 5×200 contended shape: **17/200 tasks with exactly one winner, 658
winners reported.** Five racers each received `affected: 1` on the same row, MODIFIEDTIMEs 1 ms apart.

And here is what makes it worse than entry 37: **durable state is perfect.** 200 rows, exactly one
holder each. So **458 agents hold a claim they do not own, and no audit of the database can find
them.** With `is_unique` the duplicates at least existed as extra rows a `COUNT` would surface.

**A silent violation is worse than a visible one.** This is the strongest argument in the register
for measuring the reply *and* the durable state separately: either check alone passes here.

## Entry 42 — the free tier is a hard wall, not a billing threshold — and Catalyst is currently down

```
FREE_USAGE_LIMIT_REACHED
"You have exhausted the free tier allowance for Datastore - Fetch."
```

Every authenticated route spends 2 SELECTs resolving token→agent→project before its own work (G4),
so **every route on the Catalyst build is now failing.** Not degraded, not billed — refused.

**This corrects entry 38's framing, though not its ranking.** Entry 38 priced C2 at $92.71/month
against C1's $0.20 and treated the free tier as the point where money starts. It is not. At ~10,000
free SELECTs/month — about **3,333 authenticated requests** at 3 SELECTs each — C2 does not get more
expensive, **it stops**, and it takes every other Data Store consumer in the project down with it.

That is the same lesson as entry 35 from the other direction: **the *shape* of exhaustion matters
more than the price.** Firebase throttles on a daily allowance that resets. Catalyst hits a monthly
wall that does not, and one service's exhaustion becomes every service's outage.

## Entry 43 — the fix works, and it moves the route onto its scarcest resource

Adopting Stratus locks means every atomic guarantee — claim, scope lock, dedupe, `events.seq` —
leaves the database for object storage. The `CoordinationStore` contract and every handler above the
port boundary are unchanged, which is the port boundary earning its keep.

**But each atomic operation becomes one Stratus Upload, and Upload's 2,000/month free tier is the
tightest meter in the entire system.** Arithmetic, labelled as such, from measured G6 figures:

| | measured | free/month | share |
|---|---|---|---|
| Data Store INSERT | 403 | ~5,000 (403 = 8.1%) | 8.1% |
| **the same 403 as Stratus Uploads** | 403 | **2,000** | **20.2%** |

**Roughly 2.5× worse headroom, and `events.seq` needs one per event** — so a single conformance run
consumes a fifth of the monthly allowance. The route survives the correctness question and walks
straight into a quota question.

## Entry 44 — the strongest candidate is unprobed because it is console-gated

**NoSQL conditional insert** (`condition` + `attribute_exists` + `negate`) is the best candidate on
paper and was **not measured.** The service is reachable but has **zero tables**, there is no SDK
create-table, and **none of the 186 Catalyst MCP tools mentions NoSQL.** It is console-only.

The contended harness is written and would run unchanged against one console-created table. This is a
real hole in the probe, recorded as a hole rather than as an absence — and it is the third time on
this route that the blocking step has been a **browser session a human must perform** (entry 17:
project creation, Stratus activation, Slate activation).

## Entry 45 — `String()` on an SDK wrapper, twice now

An automated read-back reported **48 durable contradictions** that did not exist: `String()` applied
to a wrapper object yielded `"[object Object]"`. Caught before it became a finding and fixed to
unwrap explicitly.

**Second occurrence of the identical bug** — the `putObject` probe in entry 27 had `getObject`'s
return `String()`-coerced the same way, proving the *call* succeeded without proving the *bytes*
round-tripped. **Rule: never `String()` an SDK return value in a probe.** Assert on a named field, or
the probe reports the shape of your coercion instead of the state of the system.

## Entry 37 — THE HEADLINE: Catalyst's `is_unique` does not enforce under concurrent insert

**The Catalyst route's founding premise is false.** `impl-catalyst.md` chose Data Store because
"`is_unique` gives atomic claim without transactions." It does not.

```
5 agents racing ONE task, n=200 tasks, 1,000 requests
tasks with exactly one winner    31/200
tasks with a violation          169/200   =  84.5%
winners counted                    547    across 200 tasks
```

### Five independent confirmations

1. **Key construction excludes `agent_id`** — `claimKeyFor(project_id, task_id)` returns
   `compositeKey(project_id, task_id.toLowerCase())` (`functions/claim/index.ts:38`). Five agents
   racing one task therefore build the **identical** `claim_key`. Verified by the coordinator
   directly, because if the key had included `agent_id` the five rows would have been legitimately
   distinct and there would be no finding at all.
2. **Harness**: 547 winners across 200 tasks.
3. **Durable state**: `SELECT COUNT(ROWID) FROM task_claims` → **554 rows for 205 task ids**,
   agreeing exactly with the harness (547 + 7 from a smoke run). Not the handler misreporting one
   insert — the duplicate `claim_key` rows carry **different `agent_id`s**.
4. **Live metadata**: `List_All_Columns` confirms `claim_key` is `is_unique: true, is_mandatory:
   true` on the live table. The constraint is declared and ignored.
5. **The tell**: contended p50 **126 ms** against uncontended **127 ms**. Indistinguishable —
   because nothing was being excluded. A working constraint would have shown a loser path.

### Misread, not a broken promise — and the tell was in the same schema

`WebFetch`/`WebSearch` were not granted, so the public help pages were **not** opened and are not
characterised. Two offline sources, verbatim. The live `Create_Column` schema says `is_unique`:
**"Whether the column enforces unique values"** — a genuine enforcement claim. But in that same
schema `is_mandatory` reads **"NOT NULL constraint"**, naming its SQL guarantee, and `is_unique`
declines to name one. Zoho's official Data Store reference never mentions `is_unique` at all; its
only concurrency-adjacent guidance is that Data Store has no transactions and recommends
**optimistic concurrency**.

**Ruling: we misread it.** Zoho's wording invites the inference; it does not make it. Not a defect to
report as a broken promise — though the documentation gap is worth telling them about.

### The error shape, and it is the sharpest one yet

The build's day-one P2 probe tested **sequential** rejection — insert, then insert again, second one
fails — and recorded that as establishing the atomic primitive. **Sequential rejection and concurrent
mutual exclusion are different properties, and it tested the easy one.**

Worse: the dry run's "20 concurrent claims, one winner" **passed against a test double that enforced
correctly.** The test proved the mock was right. It could never have failed.

**Rule: a concurrency test that passes against a double proves nothing about the platform.** The
double encodes the behaviour you *assumed*; running it back confirms your assumption to itself. Any
claim of atomicity must be measured against the live service, contended, with durable state counted
afterwards.

**My share of this is larger than the build's.** I ruled on composite keys, on `is_unique` being
table-global, on cross-tenant DoS via `unique(task_id)` — four orders of detailed reasoning about
*what to make unique* — and never once asked whether the constraint was **enforced under
concurrency**. I carried "atomic claim without transactions" unexamined for 30-plus orders. The
build tested the wrong property; I never asked for the right one.

### Scope — what is NOT being claimed

The same primitive backs `events.seq`, `request_dedupe.dedupe_key`, `scope_locks.lock_key` and
`agents.agent_id`. The build listed them as **presumed affected and explicitly did not report them
as broken, because it only measured claims.** That is exactly right, and it is the discipline my own
claim-primitive over-generalisation (0023) should have taught earlier: measure the case you name.

### What it does to the comparison

| route | claim primitive | status |
|---|---|---|
| Firebase | `runTransaction` | **holds** — 40 won / 160 lost, exactly one winner per task |
| Route G | `push --force-with-lease` | **holds** — atomic server-side, 50/50 ×3 |
| **Catalyst** | `is_unique` on insert | **fails — 84.5% violation** |

**Two of three routes have a working atomic claim. Catalyst does not, via the mechanism it chose.**

**A2 cannot pass on this route as designed, and no adapter code fixes it.** The contended G2
distribution (winners p50 122, losers p50 129, all p50 126) **must not enter the scoreboard**: 84.5%
of those requests did not perform a claim. `task_claims` was truncated afterwards.

## Entry 38 — the Stratus quota ruling went C1's way, and the pre-registration is why it counts

0032 pre-registered the interpretation before anyone saw a number. The axes turned out
**commensurable** — both metered per request, so no conversion was needed:

| | free/month | per request |
|---|---|---|
| Stratus Download | 10,000 | $0.0000004 |
| Data Store SELECT | 10,000 | $0.00006 |

C1 read = 1 Download. C2 read = 3 SELECTs (measured, G4). **450× cheaper per read, 3× the free-tier
headroom.** One dashboard at the design's own 5 s poll for 30 days: **$0.20 vs $92.71.**

So **C1's narrowed case survives** — and it matters that this ruling favoured the route under
suspicion. A pre-registration that only ever confirms the coordinator's hunch is not a
pre-registration. This one could have gone either way and went against my expectation.

**It is also moot for now.** C1 and C2 share the broken claim primitive, so the ruling changes
nothing about what to build next. Two qualifiers so the 450× is never quoted bare: **Stratus Upload
is 2,000/month free — the tightest quota in the entire system**, and the cross-region penalty is
unchanged, since 79 ms was same-region best case with no edge cache to absorb RTT.

## Entry 39 — the relabel makes the subscriber gap 26×, not 1.7×

`publish → visible` is now **"ledger propagation, tight-loop floor, no subscriber"** in the doc
comment, the emitted `metric` field and the result key.

The number that matters is the one the old label hid: **`poll_ms` = 5,000 ms.** A real Catalyst
subscriber waits up to a full poll interval on top of propagation. Against Firebase's **191 ms**
listener push, the honest gap is **up to ~5.2 s versus 191 ms — roughly 26×**, not the 318-vs-191
that sat in the register. The old label omitted the poll interval entirely.

## Entry 30 — Firebase has numbers, and three of the four rows are not comparable to Catalyst's

First real-Firestore measurements, `asia-south1` (Mumbai) verified via `firestore:databases:get`
rather than inferred from the creation command, client Asia/Kolkata. No emulator figure in any
table. Spend $0.00, ~3% of the daily free allowance.

| | Catalyst | Firebase | comparable? |
|---|---|---|---|
| `appendEvent` p50 | 202 ms | **186 ms** | **no** — see entry 31 |
| publish→visible p50 | 318 ms | **191 ms** | **no** — see entry 33 |
| claim p50, uncontended | **127 ms** | 257 ms | yes |
| claim p50, contended | **not measured** | 1,955 ms | Catalyst owes this |
| presence write cost | **0 UPDATEs** | 1 read + 1 write | yes — see entry 34 |
| free-tier runway | 2 active ≈ 17 days | **indefinite** | **no** — see entry 35 |

Only two rows in that table survive as a like-for-like race, and they split: Catalyst wins the
uncontended claim, Catalyst wins presence. The two rows that looked like Firebase wins are both
measurement-shape artifacts.

## Entry 31 — G1 append is not a like-for-like race: Firebase skips a hop Catalyst cannot

Flagged by the Firebase build itself, caveat 3. **Spark plan means no Cloud Functions**, so nothing
in its numbers traverses an HTTP API or a webhook — these are **adapter→Firestore direct**. Catalyst's
202 ms is **client → Advanced I/O Function → Data Store**, an extra network hop plus a function cold
path, and 2 SELECTs of token→agent→project resolution before its own work (G4).

So `186 vs 202` does not mean "same operation, Firebase 8% faster." Firebase is doing **strictly
less work per call**, and Catalyst *cannot* drop the hop — Data Store has no client-reachable
fine-grained auth, which is why the function exists.

This is a real architectural asymmetry and it favours Firebase — fewer moving parts, one less
failure domain — but it is **not a latency win**, and reporting it as one would repeat entry 25's
error with the roles reversed.

## Entry 32 — G2 was never comparable, and Catalyst's contended case does not exist

The Firebase build caught this and it is the sharpest cross-route correction so far:
**`catalyst-run-1.md` reports "200/200 claims won."** If every claim won, no two claims ever
contended for the same task — so **Catalyst's 127 ms is the *uncontended* figure**, and it had been
sitting in the register opposite a number that was never its counterpart.

| | n | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| Catalyst, uncontended | 200 | **127** | 182 | 409 | 1,186 |
| Firebase, uncontended (isolated) | 40 | **257** | 278 | 308 | 308 |
| Firebase, contended 5-way | 200 | 1,955 | 2,859 | 3,135 | **3,205** |
| **Catalyst, contended** | — | **unmeasured** | — | — | — |

Exactly one winner per task held on the Firebase side: 40 won, 160 lost, no mean reported.

**Catalyst wins the uncontended claim, 127 against 257.** The contended row — the one that decides
whether a claim primitive is usable under real multi-agent load — has a number for one route only.
Until Catalyst measures it, the claim comparison is half-finished.

## Entry 33 — publish→visible is two different mechanisms, and Catalyst has no subscriber at all

Catalyst's `subscribe` **throws `NotProvisionedError`** (`catalyst/store/catalyst.ts:250`). There is
no push path on that route.

Its 318 ms came from `g-metrics.ts`: append, then a **tight read loop** — `for attempt < 20`, zero
backoff — hitting `/events` until the seq appears. The 116 ms delta over the 202 ms append is one
read round trip, so it typically became visible on the first attempt. That is an **honest floor for
ledger propagation** and the code comment says so plainly — but it is **not what any subscriber will
experience**, because the real `subscribe` polls at `poll_ms`, and a poll adds up to a full interval.

Firebase's 191 ms is a **live-listener push**, and it contains the append rather than adding to it.
It is what a real subscriber gets.

So the two figures answer different questions, and the production gap is **wider than 318 vs 191**,
not narrower. Neither number may be quoted without its mechanism.

The Firebase build reached this by correcting the identical error in itself: its first
publish→visible polled `readSnapshot`, which measures *how fast its own loop notices*. It called
that "the borrowed-number error in miniature," which is exactly right.

## Entry 34 — presence: 0 UPDATEs against 48% of a daily write allowance

Catalyst's design writes **zero UPDATEs** for presence — Cache TTL expiry *is* the staleness signal
— and G6 confirmed it in production. Firebase's `heartbeat` costs **1 read + 1 write** every beat. At
10 active agents that is **48% of the daily free write allowance on presence alone**, with total
writes at 57%.

Recorded because the Firebase build found it **in its own disfavour, on the exact axis order 0033
singled out**: its op counter wrapped only `runTransaction`, so the first run reported
`heartbeat: 0 writes`. That is false, and it flattered this route precisely where it was being
watched. Entry 17's correction was meant to encourage this and it worked.

## Entry 35 — G5 is incommensurable: a daily allowance that resets is not a budget that depletes

Firestore's free tier **resets daily**. Catalyst's 1,000 UPDATEs/month **depletes**. That is why
Catalyst's runway is expressible in days at all (2 active ≈ 17 days, 10 active ≈ 3.3 days) and
Firebase's is **indefinite** at all three scenarios.

**Reporting both as "days of runway" would flatten the actual difference into a fake ratio.** G5 as
specified assumed a depleting budget and only one route has one. Same shape as the Stratus quota
question in 0032: when the axes differ, say so rather than converting between them to force a
comparison.

The honest statement: **Firebase cannot be exhausted by this workload; Catalyst can.** But Firebase
can be *throttled* daily at 57% headroom for 10 agents, so it is not unlimited either — it fails
differently, not less.

## Entry 36 — an anomaly tested, disproven, and left unexplained

Firebase's first uncontended claim run gave p50 **1,167 ms**, 6× its own append despite being two
reads and one write more. It hypothesised counter-document backlog from the preceding 100 appends,
then **tested it**: claim with no prior appends 257, append in the same namespace 170, claim after
40 appends 259. A and C identical, so **the hypothesis is wrong.**

It reported the defensible figure (~257 ms), said "don't quote 1,167," and declined to name a
mechanism it had not established. That is 0028 and 0029 applied without being asked.

**Open:** whether the contended row carries the same unexplained inflation. If it does, 1,955 ms is
too pessimistic. Re-measuring contention in isolation is owed.

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
