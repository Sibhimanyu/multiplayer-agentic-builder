# Firebase build notes — route F, Firestore

Written as I went. Constraints hit, workarounds, honest hours. This is the deliverable the
handoff asks for; it is a new file, not an edit to any shared doc.

**G10 was written before looking at the Catalyst build's numbers, and before reading anything
on `impl/catalyst`.** I have not read that branch.

---

## Status summary

**Rebased onto the shared foundation per Order 0002.** `shared/` is byte-identical to
`origin/zoho-catalyst-app-builder`; my own `memory.ts` and my own section-A suite are deleted.
The adapter is measured by `shared/store/conformance.ts` **unmodified**.

| Suite | Result |
|---|---|
| `npm test` — the SHARED gate | 24 pass, 1 skip, 0 fail |
| `npm run test:firebase` — their suite, my adapter | **15/15** |
| `functions/src/api.test.ts` (emulator) | 18/18 |
| `functions/src/reaper.test.ts` (emulator) | 9/9 |
| `functions/src/webhook.test.ts` | 17/17 |
| `cli/outbox.test.ts` + `blackboard.test.ts` + `client.test.ts` | 51/51 |
| `shared/store/firebase-errors.test.ts` | 5/5 |

Typecheck clean in both scopes: `tsconfig.json` (shared) and `tsconfig.firebase.json`
(cli + functions). Client builds.

A2 ran at the **full 50 rounds of 20 concurrent claims — 1,000 transactions** — in 222 s
against the emulator.

| Section | State |
|---|---|
| A — store conformance | **Pass.** memory 18/18. Firestore 17 pass + 1 honest skip (A13, see below). |
| B — CLI | **Pass.** B1, B2, B4–B7, B9 in `cli/outbox.test.ts`; B3, B10 in `cli/client.test.ts`; B8 at the API. |
| C — git blackboard | **Pass.** C1–C7, 14/14 against real git and a real bare remote. |
| D — webhook | **Pass.** D1–D6, 17/17. |
| E — dashboard | **Mostly verified, against the emulator.** E1/E3/E5/E6/E7/E9 renderable from `npm run seed:demo`. E2 needs three timed first-time viewers, E4 needs both builds, E8 needs a token diff. |
| F — the demo | **Not run.** Deploy-gated. |
| G — measurements | G7/G8/G9 recorded below. **G1–G6 not measured** — they need a live project. |
| H — non-negotiables | 8 of 10 verified by test. Two need both branches / a deploy (see below). |
| Reaper (F11/F12 mechanism) | **Pass**, 9/9, with an injected clock instead of a 15-minute wait. |

### Nothing is deployed

Two blockers, both stated back to the requester rather than guessed at:

1. **The Firebase project ID was given as the literal string `<paste>`.** Unfilled. Same for
   the demo GitHub repo.
2. **The budget alert could not be verified from this environment.** `gcloud` is not installed,
   and `firebase-tools` has no budget command at all — Cloud Billing budgets are a GCP
   surface that firebase-tools does not expose. So "confirm my budget alert is set before
   deploying anything" could not be discharged, and per the instruction, nothing was deployed.

Also worth flagging: the `firebase` CLI on this machine is authenticated as a **personal**
account, and none of the 8 projects it can see looks like this bake-off.

Everything below was therefore produced against the **Firestore emulator** and real local git.
Where a number would be different in the cloud, it says so.

---

## A13: it now PASSES, and the earlier note about skipping it is superseded

**Superseded by Order 0002.** The shared harness contract requires every adapter to provide
`faults.freezeSnapshot`, so A13 runs against Firestore rather than being skipped, and it passes.

That is the better outcome and I was wrong to reach for a skip first. A13 is testing the
CALLER's rule — "stale, not lost; never re-append" — and that rule is shared, so it should be
asserted against both adapters even though only one of them exhibits the window naturally.
`FirestoreStore.setSnapshotFrozen` pins the reported snapshot seq without touching the ledger,
so a frozen snapshot is genuinely stale rather than lossy, which is exactly the condition under
test. Recorded plainly: **on this platform the lag is induced, not observed.**

The paragraphs below are kept because the underlying platform fact is still true and still
worth knowing.

### The original note (still accurate as a platform fact)

A13 asks that a snapshot reporting `seq < last_written_seq` does not trigger a re-append.

On Catalyst that window is real and load-bearing: the snapshot writer is an Event function
debounced 2 s, so a caller genuinely can append, get `seq = N`, and immediately read a snapshot
at `N - 1`.

On Firestore **the window does not exist**. `readSnapshot` reads the same listener cache the
fold wrote, inside the same transaction boundary, so `seq` cannot trail the ledger. There is no
way to make the adapter exhibit the condition naturally.

Worth recording as a process lesson regardless: in my own (now deleted) harness this started as
a **false green** — a missing capability returned `null` and the test `return`ed early, which
node reports as a PASS. A13 read green for a test that never ran. A checklist box that is green
because its assertion never executed is worse than a red one, and the shared harness avoids the
whole category by making the capability mandatory rather than optional.

---

## G9 — every platform constraint hit, with the workaround

Ordered by how much time each one cost.

### 1. Firestore transactions forbid all reads after any write

**Cost: the single biggest bug in the build.** `claimTask` needs to write the claim document
*and* append `task_claimed` atomically. The natural shape —

```ts
tx.create(claimRef, {...});         // write
await this.appendInTx(tx, ...);     // reads inside
```

— fails with `Firestore transactions require all reads to be executed before all writes`. It
took out A2, A3 and A6 together.

**Workaround:** split the append into a read phase and a write phase — `planAppend()` does every
`tx.get`, returns a discriminated-union plan, and `commitAppend()` buffers only writes. Every
caller now reads everything, then writes everything.

**This was found by A2 against the emulator, not by reading the docs.** A memory-only test suite
would have shipped it, because in-process JS has no such rule. That is the strongest argument in
this build for the conformance suite being adapter-agnostic and actually run against the backend.

### 2. There is no auto-increment, and the obvious fix is a throughput ceiling

`seq` must be strictly ascending (A4). Firestore has no sequence primitive.

**Workaround:** a counter document at `projects/{pid}/meta/ledger`, read and incremented inside
the same transaction as the append. That yields gap-free, strictly-ascending `seq`.

**The constraint this buys:** that one document is now the write-throughput ceiling for the
entire ledger. Firestore sustains roughly **one write per second per document**, so ledger
appends cap at ~1/s. At the volume this protocol targets — `blackboard.md` says facts change 5
to 30 times a day — that is irrelevant. At 100 appends/second it would need a sharded counter,
and `seq` would lose gap-freeness (which the protocol permits: "gaps are legal"). Worth writing
down because it is invisible until it is not.

### 3. Heartbeats are a real fraction of the free write tier

The store interface warns about Catalyst here (1,000 Data Store UPDATEs per **month**, which no
heartbeat interval survives). Firestore's constraint is different but not nothing:

| interval | 1 agent/day | 3 agents/day | % of 20k/day free writes |
|---|---|---|---|
| 20 s | 4,320 | 12,960 | **65%** |
| 30 s | 2,880 | 8,640 | 43% |
| 60 s | 1,440 | 4,320 | 22% |

A 20-second heartbeat spends two thirds of the daily free write budget on presence and leaves
almost nothing for actual work.

**Workaround:** the CLI heartbeats at **30 s**, which keeps a 3× margin under the 90 s stale
timeout while costing 2,880 writes for a realistic 8-hour, 3-agent session. Not a workaround for
a platform bug — just arithmetic that has to be done deliberately rather than discovered.

### 4. Document IDs cannot contain `/`, and the natural idempotency key does

The handoff suggests using the idempotency key as the document ID so a repeat write is naturally
a no-op. That works right up until the key is a scope key:

```
scope:proj_inventory:agent_be01:task_items_crud:functions/**
                                                        ^^ illegal in a doc id
```

**Workaround:** the document ID is `sha256(idempotency_key)`, with the original key stored as a
field. Keeps the free no-op property, always a legal ID. The original-`seq`-on-duplicate
requirement still needs an explicit read — the platform gives you the no-op, not the answer.

### 5. Listeners bill per document delivered, so never listen to the ledger

An `onSnapshot` on an append-only `events` collection re-delivers on every append, forever, and
the dashboard does not render the ledger — it renders the fold.

**Workaround:** `subscribe` attaches six listeners — project meta, the `seq` counter document,
`tasks`, `agents`, `locks`, `contracts` — and **none** to `events`. `seq` comes from one counter
document instead of one document per event.

This created a second-order problem: six listeners each fire an initial snapshot, so a naive
implementation delivers six partial frames on connect and A10 ("fires **once** immediately")
fails. Fixed with a readiness gate — the first frame is withheld until all six have delivered,
then never gated again. An empty collection still delivers an initial empty snapshot, so the
gate cannot deadlock on a fresh project.

### 6. Reconnect after ~30 minutes offline is rebilled as a new query

Called out in the handoff, and there is genuinely nothing to do about the billing. What you
*can* control is not **also** leaking the old listener.

**Workaround:** `resubscribe_after_offline_ms` (default 25 min) logs when a listener has been
down past the point where the saving is gone, and every unsubscribe path tears down all six
listeners unconditionally, including when one of them throws. A leaked `onSnapshot` keeps
billing after the component that created it is gone, and it is invisible until the invoice.

### 7. An admin-SDK write during a network partition does not fail fast — it hangs

Found by A11, and it hung the whole test suite for five minutes before I noticed.

I wanted A11 to test a *real* dropped socket rather than a mock, so the SDK is pointed at a
small TCP proxy (`shared/store/testing/tcp-cutter.ts`) that can be severed on demand. With the
wire cut, `appendEvent` **never settles** — the admin SDK retries the RPC indefinitely rather
than surfacing `UNAVAILABLE`. Unlike the web SDK, there is no local write queue and no
`disableNetwork()` to reach for.

**Consequence for real code, not just the test:** every call in `cli/client.ts` carries an
`AbortController` deadline (15 s default). Without one, a CLI run against a partitioned backend
hangs until something kills it — and "offline is normal, the agent keeps working" becomes "the
agent stops".

**Consequence for the test:** A11 no longer awaits the in-flight write. It races it, asserts no
frames arrive during the outage, heals the wire, and accepts either outcome (completed on
reconnect, or `StoreOfflineError` and re-drained from the outbox). A hang is the only failure.

### 8. `firebase emulators:exec` cannot run this repo's tests

`firebase-tools` ships as a `pkg` binary with **Node 20.18.2 embedded**, and the embedded loader
intercepts the command: `node --test foo.ts` fails with
`Cannot find module '/…/--test'`. Node 20 also cannot strip TypeScript types.

**Workaround:** `scripts/emulator.sh` starts the emulator itself, polls the port, runs the
command under the real `node`, and tears down on exit.

### 9. The Firestore emulator needs JDK 21+, and `java_home -v 21+` lies

`firebase-tools` 15 refuses Java < 21. This machine's default `java` is 1.8 (an Oracle
applet-plugin JRE) which shadows Homebrew's JDK 26. Worse:

```
$ /usr/libexec/java_home -v 21+
/Library/Internet Plug-Ins/JavaAppletPlugin.plugin/Contents/Home   # <- that is 1.8
$ echo $?
0
```

It exits 0 and ignores the version filter. My first version of the script trusted it and
"found" Java 8.

**Workaround:** `scripts/emulator.sh` version-checks every candidate by actually running it.
Trusting where a JDK came from is not the same as knowing what it is.

### 10. Two `@types/express-serve-static-core` copies break the handler signature

`firebase-functions` bundles its own copy. Adding `@types/express` for `Request`/`Response`
produces a structurally-incompatible second copy and `onRequest` stops accepting its own
handler, with a 12-line error about `IRouterMatcher` and `PathParams`.

**Workaround:** drop `@types/express` entirely and let the handler parameters be inferred.

### 11. Deploying TypeScript that imports `.ts` specifiers

The repo runs `.ts` directly under node's type stripping, so every relative import is written
`./foo.ts`. Cloud Functions cannot strip types, and a plain `tsc` emit preserves those
specifiers, so the function dies on cold start with `MODULE_NOT_FOUND`.

**Workaround:** `allowImportingTsExtensions` + `rewriteRelativeImportExtensions`, with
`rootDir: ".."` so `shared/` compiles into the deploy artifact — Cloud Functions only uploads
the `source` directory, so shared code outside `lib/` would simply be missing at runtime.

A related trap: an `exclude` glob starting with `**` **cannot traverse upward** out of the
tsconfig directory, so `"**/*.test.ts"` alone left `../shared`'s test files in the artifact —
including the TCP-cutting proxy. Both spellings are needed.

### 12. A first-publish race on the blackboard branch (git, not Firebase)

Found by C3, which races two concurrent first-publishes. When the blackboard branch does not
exist yet and two agents both create it as an orphan, the loser's push is refused with
`[remote rejected] … (reference already exists)` — which my rejection detector did not
recognise, so it threw instead of recovering.

And rebasing would have been **wrong**: the loser's HEAD is an orphan commit with no common
ancestor, so there is nothing to rebase onto.

**Workaround:** classify the two push failures separately. `non-fast-forward` → rebase and
retry. `reference already exists` → restart the attempt loop, which re-fetches and resets the
worktree onto the now-existing branch. A sequential test would never have caught this.

### 13. The reaper cannot act "as the owner" — my own design mistake, caught by test

Not a platform constraint. Recording it because it is the kind of bug that would have looked
fine in review and been discovered during the F11 demo.

The reaper originally released a stale claim by calling `releaseTask(pid, task_id, agent_id)`,
on the reasoning that one code path for "a claim goes away" beats a privileged second one. That
broke in two ways at once:

1. **Double-append.** `releaseTask` appends its own `task_unblocked` attributed to the agent, so
   a reaper that called it *and* appended its own reap event put **two** `task_unblocked` events
   on the ledger for one release.
2. **A revoked agent's claim could never be reaped.** `releaseTask` calls `assertNotRevoked`,
   which throws for precisely the agent whose claim most needs releasing — the reaper caught the
   `StoreAuthError` and recorded the claim as "kept" forever.

**Fix:** a separate `reapClaim()` that deletes the claim and appends exactly one
system-attributed event in one transaction, and does not consult the agent's token state. The
reaper's authority does not come from the agent, and modelling it as if it did was the error.

### 14. Not a constraint, but a decision worth recording: no Firestore-triggered fold

The build order lists an optional Firestore-triggered function to fold snapshot state. I did not
write one. `appendEvent` folds into the task documents inside the same transaction as the
append, so the state is already correct when the transaction commits. A trigger would be a
second writer of the same state, running after the fact, with its own retry semantics and its
own bill — to produce something that is already right.


### 15. An in-process conformance suite cannot time a network adapter

Found by adopting the shared foundation. `conformance.ts` settles with four `setImmediate`
turns, which is exactly right for the memory adapter and structurally impossible for a
network one: six Firestore listeners cannot complete an initial load in four microtasks.

A10 and A11 were the two that broke, and they broke for different reasons.

**A10 "fires once immediately".** Fixed in the adapter, not the test: `subscribe` now delivers
the first frame **synchronously when the listener cache is already warm**. That is not a test
accommodation — a second dashboard panel subscribing to a project the page is already watching
should render from memory rather than pay a round trip and show a blank frame to learn what it
already knows. The harness keeps one warm subscription open and awaits convergence after each
seed, so "warm" is true by the time a test subscribes.

**A11 "must not be fed while its link is down".** Gating store METHOD calls is not enough. An
`onSnapshot` stream is already open by the time `setOffline` fires and it keeps delivering, so
a subscriber would go on being fed while its own reads failed — which is not what a dropped link
looks like. The harness now suspends *delivery* too, buffers the newest frame, and on restore
delivers either the buffer or current state. The fallback matters: without it a reconnecting
subscriber stays blind until something else happens to be written, which on an idle project is
hours, and "stayed blind" is precisely what A11 exists to catch.

Neither fix touched `conformance.ts`. The general lesson is that a shared suite for two
platforms needs a settle primitive the harness can define, because "has it arrived yet" is a
question only the adapter can answer.

### 16. Two builds can pass the identical suite and still disagree about the board

Raised as an order request rather than fixed unilaterally.

`conformance.ts` pins the ten operations. It says nothing about what `task_claimed` does to a
`TaskView`. So the fold — the ledger-to-board projection — is unpinned, and two builds can be
100% green on the same file while disagreeing about what the dashboard shows. That gap does not
surface until F1–F12, where it looks like a UI bug in whichever build is behind.

My fold is `shared/store/firebase-fold.ts`, deliberately named as mine and left outside the
promoted foundation because Order 0002 froze `shared/`. Nothing in it is Firebase-specific.
**It should be promoted to `shared/store/fold.ts`.**

### 17. The shared glob engine normalises an unsupported pattern instead of refusing it

Also raised rather than worked around. `shared/globs.ts` `normalizeGlob` treats a negation or
brace pattern as a literal, so a scope lock on one protects nothing and `acquireScope` still
returns `ok: true`. That is a silent failure, which non-negotiable H forbids.

I validate in my own API layer so the Firebase build is safe, but **the two builds will diverge
on this input** until the check moves into `shared/globs.ts`. Recording it here because a
divergence I introduced deliberately is still a divergence, and the comparison has to know.

### 18. A standing rule and my own handoff disagree about `client/`

**Flagged for the coordinator, not worked around.**

`docs/orders/0001` says: *never edit `docs/`, `client/` or `shared/` without an order*.
`docs/handoff/impl-firebase.md` build order step 9 says: *wire `client/src/App.tsx` to
`createFirestoreStore`. One line.* Both cannot be followed.

I followed the handoff, because step 9 is the whole point of the dashboard existing and the
alternative is a board that renders nothing. What I have touched under `client/`:

| Path | Why |
|---|---|
| `src/App.tsx` | the one-line store swap step 9 asks for (4 lines with its comment) |
| `src/store/firestore.ts` | new — my adapter, the file step 9 names |
| `package.json` + lock | adds the `firebase` dependency the adapter needs |
| `.env.example` | new — documents the web config |

`client/src/components.tsx` and `client/src/tokens.css` are **untouched**, and I have added
nothing to `client/tsconfig.json` — the `import.meta.env` typing is a triple-slash reference
inside my own file precisely so the shared tsconfig stays identical for both builds.

If the coordinator would rather this arrived as an order first, say so and I will move it.

### 19. Push discipline is a real failure mode, and I hit it

Order 0004 names this session. I committed the entire build — adapter, CLI, functions, dashboard
wiring — and ended the turn without pushing, leaving 23 further uncommitted paths behind.

Not a platform constraint, but it belongs in an honest log: the coordinator's only view of this
workspace is the pushed branch, so unpushed work is indistinguishable from work that does not
exist. Worse, my own branch had **zero commits** at the point Order 0002 told me to rebase — the
whole build was working-tree only, and a rebase would have destroyed it. Committing first was
what made the order safe to execute at all.



### 20. The counter-document ceiling is real, and it is load-dependent

Upgraded from theoretical to **measured**. G9.2 recorded that a single counter document inside
every append transaction caps ledger throughput. Under 32 concurrent appends the emulator
returned `10 ABORTED: Transaction lock timeout` on `projects/{pid}/meta/ledger` — the SDK's
internal transaction retries exhausted, surfacing as `StoreBusyError`.

Three things worth separating here.

**The adapter was right.** `ABORTED` maps to `StoreBusyError`, which the contract defines as a
normal retryable outcome. A raw `appendEvent` refusing under heavy contention is the adapter
behaving exactly as specified.

**My test was wrong.** It asserted all 32 appends resolve, which is asserting that the contract
is not the contract. Rewritten to assert what must actually hold: whatever refuses refuses
*retryably*, nothing that landed shares a `seq`, and the same 32 all land when the caller
honours the retry contract via the shared `withRetry`.

**It is load-dependent, not a hard number.** The next run landed all 32 with zero refusals. So
the original test was not merely wrong, it was *intermittently* wrong — red under load and green
otherwise, which is the worst failure mode a test can have. That intermittency was the real bug.

For G4, when a live project exists: the number to record is not "the ceiling is 32". It is that
contention refusal is probabilistic above roughly a dozen concurrent appends, and that the
documented recovery clears it. Anyone quoting a hard figure has measured one run.

### 21. "Verify by running" caught a defect that reading could not

Order 0011 formalised this and it is downstream of my own worst mistake, so it belongs here.

My test files sat under `shared/`, so root `npm test` reported **25 tests on this branch and 19
on the other**. From inside either branch everything looked correct: the script was fine, the
suite passed, the config matched. The divergence was invisible from within a single branch and
only appeared when the same command ran in both places.

"Both builds pass the same tests" is the headline claim of this whole exercise, and it would
have been measured by two different commands — quietly false, with nothing failing to reveal it.

`scripts/xcheck.sh` now runs root `npm test` in a throwaway worktree and compares counts. It
references the **shared branch** rather than the other build's: that branch is the normative
source for root `package.json` and `tsconfig.json`, which both builds are frozen to, so matching
it proves both builds match each other transitively — and it keeps this workspace off the other
implementation's branch entirely, which is a standing instruction here. Counting another
branch's output would have been permissible; it was not necessary.

An absent or unparseable count fails the check rather than passing it. Missing is drift.


### 22. An advisory retry hint silently defeated exponential backoff

The best bug of the session, and entirely mine. Transferable to any adapter, so it is written
for a reader who is not on Firestore.

The shared `withRetry` prefers a server-advised wait over its own curve:

```ts
const advised = err instanceof StoreBusyError ? err.retry_after_ms : undefined;
const wait = advised ?? backoffMs(attempt, policy);
```

That is reasonable — if a backend says "come back in 3 seconds", believe it. My adapter mapped
Firestore's `ABORTED: Transaction lock timeout` to `StoreBusyError` with a **constant**
`retry_after_ms: 250`, which looked like helpfully passing on a hint and was actually an
override. Observed in a failing run:

```
delays: [250,250,250,250,250,250,250]
```

Flat. No growth, no jitter. Eight attempts spanning under two seconds, and every contending
caller retrying **in lockstep every 250 ms** — recreating the collision each time. Precisely the
failure the shared retry's own header comment warns about, produced by the thing meant to
improve it.

`backoffMs` was never broken; I checked it in isolation and it grows 125→250→500→1000→…→cap
correctly. The bug was the interaction, which is why neither file looks wrong on its own.

**The rule:** a `retry_after_ms` is appropriate only when the backend genuinely knows when to
come back — a rate limit with a reset window. For *contention*, the only useful advice is
"spread out and grow", and supplying any constant actively prevents that. Firestore never
returns a reset window, so the correct hint is none at all.

### 23. Contention belongs to the adapter, not to every caller

Downstream of 22, and it fixed an intermittent failure in the SHARED suite.

`ABORTED` is legal and retryable per the contract, so surfacing it is defensible. But the
consequence was that A2 — 20 concurrent claims, 50 rounds — went intermittently red here while
being perfectly green on a backend where a lost claim is a *value* rather than a retryable
error. `conformance.ts` writes no retry loop, and it should not have to.

That is a platform difference leaking through the seam, which is the one thing the seam exists
to prevent. So transient contention is now absorbed inside the adapter: one
`withContentionRetry` chokepoint wraps every `runTransaction`, retries only contention (never a
quota error — retrying that burns more of what ran out), and surfaces `StoreBusyError` only once
contention is sustained. `tx_attempts: 1` disables it, which is how the ceiling test still
observes the raw behaviour.

The general shape: **if a guarantee is in your contract, absorb the platform's noise below the
seam rather than exporting it to every caller and to the shared suite.**

### 24b. An injected clock is not a general "make waiting fake" seam

Found by probing, immediately after writing 23, and it is the worst-shaped defect of the
session even though it never fired: a **latent load-dependent hang**.

`withContentionRetry` backed off through the injected `Clock`. The conformance harness injects
a `FakeClock`, whose `sleep()` resolves only on `advance()` — and nothing advances it during a
transaction. So the first time contention actually fired under the shared suite, the run would
hang forever waiting for a tick nobody was going to send.

It passed 63/63 immediately before I found it, because contention happened not to occur that
run. That is what makes it worse than an intermittent failure: an intermittent test at least
produces an assertion to read. This would have produced a stuck process, under load, with no
output — and the obvious next move would have been to raise the test timeout.

The confusion was mine and it is worth naming precisely. The clock is injected so that
**staleness derivation is testable** (A9 needs 90 seconds to pass in a millisecond). It is not
a seam for "all waiting in this file". A production backoff must use real time regardless of
what clock the tests hand it; the two concerns share a word and nothing else.

Fixed with a real `setTimeout`, plus a regression test that forces 24-way contention under a
FakeClock that is never advanced — if the backoff ever routes through the injected clock again,
that test hangs and the suite times out instead of passing.

**The prediction was then confirmed by the very next run, on the pre-fix code.** I had already
found and fixed it by probing, but a serialised run of the previous commit was still in flight,
and it reproduced the symptom exactly:

```
✖ 32 concurrent appends ALL land once the caller honours the retry contract (900002.887542ms)
  'test timed out after 900000ms'
✖ concurrent claims and appends together do not corrupt either (900003.336ms)
  'test timed out after 900000ms'

ℹ pass 61   ℹ fail 0   ℹ cancelled 2      duration_ms 2098379
```

Note the shape, because it is the whole point. **`fail 0`.** Two tests `cancelled`, thirty-five
minutes of wall clock, and a summary line that does not say "failure" anywhere. The two counts
that would make someone look — pass and fail — both read fine. And the stated reason is *test
timed out*, whose obvious remedy is to raise the timeout, which would have buried this
permanently under a green suite.

**Three serialised runs, and the evidence is in the disagreement between the first two.**

| run | code | result |
|---|---|---|
| 1 | pre-fix | `63/63 pass`, 0 cancelled — contention did not fire |
| 2 | **identical pre-fix code** | `61 pass, 0 fail, 2 cancelled` — two tests timed out at 900 s each |
| 3 | post-fix | `64/64 pass`, 0 fail, 0 cancelled. The same two tests: **56.5 s** and **7.0 s** |

Runs 1 and 2 executed the same commit and disagreed. That disagreement *is* the finding: the
defect was load-dependent, so a single green run proved nothing, and I had one before I went
looking. Had I stopped at run 1 — which is the natural thing to do, since it was green — this
would have shipped.

Run 3's new regression test also earns its place rather than passing trivially: it logged
`adapter absorbed 30 contention backoff(s) under FakeClock` and finished in 18 s. Thirty real
backoffs, every one of which would have hung on the first under the old code.

Method note: **the test that would have caught this is the test that only fails under
contention**, which is exactly the test I could not rely on. Probing `FakeClock.sleep()`
directly, in four lines, found it in seconds:

```
after 200ms real time, FakeClock.sleep(50) resolved: false
```

When a guarantee depends on a component's behaviour, check the **component** rather than
waiting for the integration to disagree with you. The integration took thirty-five minutes to
say something less useful.

### 24c. `fail 0` is not "no problems", and now the gate says so

Acted on rather than merely noted, because the near-miss above turned on it.

`node --test` does exit non-zero on a cancelled test, so a bare `npm test` would have caught
it. But the number a human reads — in CI output, in a summary comment, in a pasted screenshot —
is `fail`. `fail 0` alongside `cancelled 2` is a summary that reads as success to anyone
skimming, and skimming is the normal case.

`scripts/run-tests.sh` now wraps every suite in this build and fails loudly on `cancelled > 0`
and `todo > 0`, printing all six counts on one line:

```
run-tests: tests=51 pass=51 fail=0 cancelled=0 skipped=0 todo=0
run-tests: OK
```

Its message for a cancelled test names the trap explicitly: *do not raise the timeout without
first establishing what is not finishing.* That is the move that would have buried the hang.

One honest correction while writing it. I also added a balance check (`pass + fail + cancelled
+ skipped + todo == tests`) believing it was what caught the hang — it is not. 61 + 0 + 2 does
balance to 63. What catches a hang is checking `cancelled` directly. The balance check is kept
for a different failure, a test landing in no bucket at all, and the script says so rather than
being credited with a catch it would have missed.

### 24. `node --test` parallelises FILES, and a shared emulator cannot take it

The last of the intermittency, and it had nothing to do with the adapter at all.

`node --test` runs test *files* concurrently by default. Every emulator-backed file here
contends the same emulator, so the 32-way contention test was saturating it while the shared
conformance suite was mid-run — and A1 or A2 would fail with a lock timeout caused entirely by
a different file. Diagnosing it as an adapter problem twice was my own error; the tell was A1
taking 10 seconds when it normally takes 400 ms.

`--test-concurrency=1` on every emulator suite. It costs wall-clock (the batch is now ~7
minutes, dominated by A2's 1,000 transactions) and buys determinism, which is the right trade
given rule 2 from G9.20: an intermittent test is worse than a failing one.

Worth stating as a general point rather than a Firestore one: **any test suite sharing one
external resource must serialise at the file level**, and the default is against you.



### 25. Detecting a condition by message text, and the fix that was worse

Order 0017 ruling 1b made structured-only error matching normative after the Catalyst SDK
renamed `error_code` to `code`. It asked both builds to audit for message matching. Mine had
exactly one instance, and it was load-bearing:

```ts
const contended = mapped instanceof StoreBusyError && /aborted|contention|lock/i.test(mapped.message);
```

That worked *only* because `mapFirestoreError` composes the message from Google's own wording.
Two ways it breaks:

- **Reword and it silently stops.** If Google changed "Transaction lock timeout" to "Transaction
  conflict detected", contention would stop being retried and would start surfacing to every
  caller again — reinstating the intermittent shared-suite failure that took three runs to pin
  down in the first place.
- **A quota error whose text contains "lock" would be retried.** That is the one thing the retry
  must never do: retrying an exhausted quota consumes more of the thing that ran out.

Both demonstrated rather than argued:

```
reworded message, code still 10 -> isContention: true    (old regex: false)
quota whose TEXT contains lock  -> isContention: false   (old regex: TRUE, and retried)
```

**And the first fix was worse than the bug.** I wrote `mapped.cause_code === 'ABORTED'`, because
the shared `StoreError` has a `cause_code` field. But `StoreBusyError`'s constructor accepts it
and does not forward it — it passes only `{ backend_message }` to `super`. So `cause_code` is
permanently `undefined` on a busy error, `contended` would have been permanently false, and
contention retry would have been silently disabled altogether. Caught by reading the frozen
file rather than trusting the field existed.

Fixed with a local `FirestoreBusyError extends StoreBusyError` carrying `grpc_code`.
`instanceof StoreBusyError`, `isRetryable` and `.name` are all unchanged, so nothing downstream
— including the shared suite — can tell. **Order request:** `StoreBusyError` should forward
`cause_code`; both builds need to branch on a structured reason and ruling 1b makes it normative.

### 26. Nested retry layers multiply, and I built one

The most expensive defect of the session in wall-clock terms: two tests ran for **36 minutes**
and were cancelled.

When contention retry moved *into* the adapter (6 attempts, 40 ms–2 s backoff), the tests kept
their caller-side `withRetry(..., { attempts: 8 })` — written earlier, when the adapter did no
retrying at all. The effective ceiling became **8 × 6 = 48 attempts** with compounding backoff.

The arithmetic is obvious once stated, and that is the point: nothing failed, nothing warned, the
suite just got slower until it hit a timeout. Retry is the kind of thing that composes silently
and multiplicatively.

**Rule: retry belongs at exactly one layer.** When you move it down, delete it above. If both
layers legitimately need it, the inner one must not retry what the outer one will.

### 26b. A long-lived emulator degrades, and the last test in the batch pays for it

A2 — the headline exactly-one-claim test, 1,000 transactions — failed at 106 s with `ABORTED:
Transaction lock timeout` when batched after the concurrency stress tests. Run alone it passes
in **219 s and 215 s**, twice, consistently.

So it was neither my code nor test-file parallelism. Files were already serialised with
`--test-concurrency=1` (finding 24). The cause is **accumulated degradation inside one emulator
process**: by the time A2 ran, the same Java process had absorbed 32-way append storms, mixed
claim/append contention and several hundred documents. Whichever test runs last under the most
accumulated load is the one that fails, which is why this looked like an adapter regression.

**The tempting fix was to raise the adapter's contention retry budget until A2 went green.** That
would have been a number picked from a degraded backend and read as a property of the platform —
precisely the single-run-threshold error this build wrote a rule against, committed against its
own headline test. The adapter is fine on a healthy backend; the harness was contaminating it.

Fixed structurally: the shared conformance suite now runs in **its own emulator lifetime**
(`npm --prefix firebase run test:conformance`), and this build's own stress tests in another
(`test:own`). Beyond making the suite green, that matters because the shared suite is the one
artefact required to be comparable across both builds — its numbers are worthless if they depend
on what this build happened to run beforehand.

`tx_attempts` stays at 6. If production Firestore ever surfaces contention to callers, the retry
budget is the knob — but I have no production data, and tuning it from emulator-degradation data
would be inventing a threshold.

### 27. `created_at` is metadata — audited, already compliant

Ruling 2, checked rather than asserted. Nothing sorts, pages or deduplicates on `created_at`:
`readEvents` is `orderBy('seq', 'asc')` and the fold sorts `a.seq - b.seq`. A grep for
`created_at` near any ordering, cursor or dedupe construct returns nothing.

This build is explicitly *not* being degraded to match Catalyst's second-resolution datetime
columns, so it keeps native millisecond `created_at` as metadata while `seq` stays authoritative
for ordering. Register entry 13.

### 28. The suite gate earned its keep on its first real red

`run-tests.sh` was added after a hang reported `fail 0 / cancelled 2`. Its first genuine failure
was this one:

```
run-tests: tests=66 pass=63 fail=1 cancelled=2 skipped=0 todo=0
run-tests: FAIL -- 1 failing test(s)
run-tests: FAIL -- 2 CANCELLED test(s). A cancelled test is usually a hang or a timeout...
```

Three separate defects in one run — a broken direct call to `resolveAgent`, and two tests
cancelled by the multiplicative retry — and it named all three instead of showing a mostly-green
count.

---

## Provisioning, measured (order 0015)

**Project ID: `multiplayer-agents-eec02`** — display name `multiplayer-agents`. They differ:
Google appended `-eec02` because the plain name was globally taken. Every CLI and SDK call needs
the ID.

The human created the project in the console. I verified that first-hand rather than on
assertion — eight projects were catalogued on this account at the start of this session,
`projects:list` now returns nine, and the ninth is this one.

### What one CLI-driven session provisioned

| Step | Command | Result |
|---|---|---|
| select | `firebase use` | instant |
| web app | `firebase apps:create web` | 9 s |
| Firestore API | *enabled implicitly by the rules deploy* | ~75 s to propagate |
| Firestore DB | `firestore:databases:create --location asia-south1` | ok |
| rules + indexes | `firebase deploy --only firestore:rules,firestore:indexes` | ok |
| hosting | `firebase deploy --only hosting` | live |
| demo repo | `gh repo create` | instant |

**7 CLI commands, 0 console steps, ~4 minutes** of wall clock from an existing empty project to a
live dashboard with deployed security rules. For the register: the Catalyst CLI has no
`project:create` at all, so the comparable figure there is not a slower number, it is *no CLI
path*.

Two honest deductions from that headline, though:

1. **The project itself was created by a human in the console.** `firebase projects:create` does
   exist and would have made it 8 commands and 0 console steps — but that is not what happened
   here, so the measured figure covers provisioning *into* an existing project.
2. **Blaze and the budget alert remain console-only**, so the end-to-end number is 7 CLI commands
   plus 2 console steps that no tool can perform. Register entry 10, fourth confirmation.

### A correction I was one command from shipping

I was about to report "enabling the Firestore API is a console step; firebase-tools cannot do
it", on the strength of **three consecutive 403s**. It was wrong.
`firebase deploy --only firestore:rules` prints `missing required API firestore.googleapis.com.
Enabling now...` and does enable it. The 403s were propagation lag; a fourth attempt 25 seconds
later succeeded.

One retry separated a true finding from a false one, in precisely the area where I had spent the
session telling the coordinator to verify rather than assume. The coordinator had even warned
that the project took ~20 s to appear in `projects:list`. Same lesson, and I nearly missed it
twice.

### `asia-south1` is a measurement decision, not a default

The database location is **permanent** and it directly determines G1 and G2. This machine is in
India and Catalyst is a Zoho product served from India, so a nearby region is the like-for-like
comparison. Accepting the US multi-region default (`nam5`) would have added roughly 200 ms of RTT
to every Firestore figure and flattered Catalyst on all of them — a measurement artefact dressed
as a platform difference. Recorded here because it cannot be changed afterwards.

### First real latency numbers, such as they are

The live rules check does seven round trips to `asia-south1` from this machine:

```
read tasks   201 ms / 71 ms      WRITE event  164 ms
read events   71 ms / 69 ms      WRITE claim  207 ms
read agents   69 ms / 83 ms      read invites  91 ms
```

**These are permission-denied round trips, not successful operations, so they are not G1 or G2.**
They are useful only as a floor on network RTT: roughly **70–90 ms warm, ~200 ms cold**. Quoting
them as latency results would be exactly the single-run-threshold error I wrote a rule against.

### Deny-all verified against the live backend

Not a rules review — seven operations attempted as an unauthenticated client against the deployed
project, all seven denied: reading tasks, events and agents; **writing** an event and a claim;
reading invites; and reading outside `/projects` entirely.

That is the "clients never write the ledger" half of non-negotiable H verified in production
rather than in the emulator. `npm --prefix firebase run check:live-rules`, and it fails on zero
probes as well as on any allowed operation — missing is drift, applied to the guard.

### The blocker on G1–G6, and why I did not work around it

The conformance suite needs the **admin** SDK, which needs credentials `firebase login` does not
provide. There is no ADC on this machine and `gcloud` is absent, so the sanctioned path is a
service-account key — a console step.

A shortcut exists and I declined it. `~/.config/configstore/firebase-tools.json` holds a refresh
token with `https://www.googleapis.com/auth/cloud-platform` scope, which the Admin SDK's
`refreshToken` credential would accept. That credential can reach **all nine projects on the
account**, including the eight unrelated ones I am under standing orders never to touch. Loading
it into a test process that performs 1,000+ concurrent writes, when a per-project service account
costs one console click, is the wrong trade. Least privilege wins over convenience even when the
convenience is mine.

---

## G9 asymmetries — guarantees Catalyst paid for and Firestore did not

Orders 0005 and 0006 are explicit that these must be recorded on **both** sides and not
normalised away. They are the clearest thing this exercise has produced so far, because in each
case the *requirement is identical* and only the cost differs. I did not discover any of them —
the Catalyst workspace probed them — and that is worth stating plainly: three of the four are
spec bugs that only surfaced because someone ran the thing against a real backend.

| Guarantee | What Catalyst had to build | What Firestore cost |
|---|---|---|
| Atomic claim, scoped per project | Composite key columns (`"proj_01:task_items_crud"`) plus a builder that rejects a separator inside any part, because `is_unique` is **table-global** — a bare `unique(task_id)` lets project A's claim block project B's identically-named task forever | **Nothing.** A transaction on a document path is naturally scoped: `projects/{pid}/claims/{task_id}` cannot collide across projects because the path already contains the project. |
| Injection safety | ZCQL has **no parameter binding at all**. With `project_id` arriving from request bodies, one hand-written escaper is the entire injection boundary, and it needs its own audited chokepoint and tests asserting no unpaired quote survives | **Nothing.** The SDK is parameterised; there is no query string to escape. There is no equivalent exposure to test. |
| Strictly ascending `seq` | A dedicated `seq bigint is_unique` column allocated **globally**, with an insert-retry-on-`DUPLICATE_VALUE` loop it had to design, after `ROWID` turned out to run *backwards* across inserts | A counter document read and incremented inside the same `runTransaction`. **Corrected downward after measurement:** this is not "no retry loop" — the SDK retries internally and, past a contention ceiling, gives up and surfaces `ABORTED`. Both platforms need a retry. Only one had to think about it. |
| Running the conformance suite | A5 needs 301 events ≈ 602 INSERTs against a **5,000/month** free-tier budget — about **8 runs a month** before A5 alone exhausts it, so A5 must be excluded from routine real-backend runs | 602 writes against **20,000/day**. Effectively unlimited; the full suite runs freely on every change. |

**One of these shrank, and it shrank because of my own measurement.** The row above originally
claimed the counter document cost Firestore nothing — first-class primitive, no retry loop. That
was wrong, and the 32-way contention test is what proved it wrong (see G9.20). Firestore's retry
is real; it is just implicit, inherited from the SDK rather than designed. The honest difference
is not "retry versus no retry", it is **who had to think about it**.

I am recording that prominently rather than quietly editing the cell, because a comparison whose
asymmetries only ever grow in one direction has stopped measuring and started arguing. The most
useful thing my own testing did to this table was make one of its rows smaller.

Two of these deserve more than a table row.

**The `ROWID` finding is the most serious defect anyone has found, on either build.** It was
not an ordering nit: a reader that had consumed up to cursor `052001` would never be delivered
an event that landed at `044002`. That ships as an intermittent "the frontend agent never saw
the contract" bug, reproducing about one time in three and looking exactly like a network
fault. Firestore's counter-doc approach was never exposed to it — not because I was careful,
but because `runTransaction` exists.

**The suite-cost asymmetry is a fairness problem, not just a cost one.** If one build can run
its full conformance suite on every change and the other can afford it eight times a month,
the two are not being developed under the same conditions however identical the file is. Worth
weighing when reading any "both builds pass the same suite" claim, including mine.

### And one place where Firestore's cost is the higher one

For balance, because the table above is one-sided and a one-sided table is usually an
incomplete one. Firestore's free tier is metered in **writes per day**, and presence is a
write. A 20-second heartbeat spends 65% of the daily budget on three agents doing nothing.
Catalyst's constraint here is worse in kind (1,000 durable UPDATEs per *month*, which no
interval survives, forcing presence into Cache with a TTL) — but Firestore's is the one that
looks affordable right up until you do the arithmetic, and nothing in the platform warns you.
See G9.3.

---

## G7 — lines of code in the adapter

Measured two ways, because the raw `wc -l` is dominated by comments in this codebase.

Re-measured after the Order 0002 adoption. The adapter grew slightly: it lost its private
prepare/logger/clock helpers to the shared foundation but gained the inlined validation needed
to match `memory.ts` byte-for-byte, plus the snapshot-freeze seam A13 requires.

| File | code only |
|---|---|
| **`shared/store/firebase.ts`** (the adapter) | **794** |
| `shared/store/firebase-fold.ts` (mine; should be shared — see G9.16) | 179 |
| `client/src/store/firestore.ts` (browser, read-only) | 241 |
| `firestore.rules` | 63 |

The number to compare against Catalyst is **794**, and it must be read alongside the shared
foundation both builds now consume rather than on its own — a comparison of adapter size in
isolation flatters whichever build pushed more logic into shared code. That is exactly what
Order 0002 changed: the scaffolding is no longer part of either build's number.

The shared foundation (`shared/store/types.ts`, `memory.ts`, `conformance.ts`, `errors.ts`,
`retry.ts`, `sanitize.ts`, `globs.ts`, `clock.ts`, `log.ts`) is written once by the other
workspace and consumed unchanged here, so it belongs to neither build's count.

CLI and functions:

| File | code only |
|---|---|
| `cli/index.ts` | 461 |
| `cli/agentic.ts` | 296 |
| `cli/blackboard.ts` | 269 |
| `cli/outbox.ts` | 224 |
| `cli/client.ts` | 205 |
| `functions/src/api.ts` | 241 |
| `functions/src/webhook.ts` | 183 |
| `functions/src/authority.ts` | 123 |
| `functions/src/reaper.ts` | 118 |
| `functions/src/index.ts` | 115 |

Tests, including the shared conformance harness: **2,680 lines**.

The number to compare against Catalyst is **711**, and it should be compared alongside the
shared 658 lines that both builds reuse. A comparison of adapter size alone would flatter
whichever build pushed more logic into shared code.

---

## G8 — build hours, honest

**Roughly 5 hours of wall-clock work**, against the handoff's ~4 hour estimate.

Where it went, in rough order of cost:

| Item | Share |
|---|---|
| Store interface + memory adapter + conformance suite (A1–A15) | ~1 h 15 |
| Firestore adapter, including the read-before-write refactor | ~1 h |
| CLI: file contract, outbox, blackboard, client, commands | ~1 h 15 |
| Functions: webhook, authority, API, reaper | ~45 min |
| Emulator/JDK/build-toolchain fights (constraints 8, 9, 10, 11) | ~30 min |
| Glob intersection engine | ~15 min |

The estimate was fair. What it did not price in was that roughly 10% of the time went to
toolchain problems that have nothing to do with Firestore — the JDK version, the `pkg`-embedded
Node, the duplicate express types. Those would have cost the same on any platform.

The single largest *avoidable* cost was constraint 1 (read-before-write), and it was only
avoidable in hindsight: the fix took twenty minutes once A2 pointed at it.

---

## What is NOT measured, and why

**G1 publish→visible latency, G2 claim round-trip, G3 demo wall-clock, G4 operations consumed,
G5 extrapolated cost, G6 free-tier headroom.** All six need a live project. Reporting emulator
numbers as if they were cloud numbers would be worse than reporting nothing — the emulator has
no network, no quota accounting and no billing surface, so its latencies are wrong by roughly
an order of magnitude and its operation counts do not appear in any console.

The one emulator number worth recording as a **floor, not a result**: A2's full 50 rounds of 20
concurrent claims — **1,000 claim transactions** — completed in **218.4 s**, i.e. ~4.4 s per
round of 20 concurrent claims, or **~218 ms per claim** against a local emulator with no
network. Real cloud round-trips will be materially slower, and this number includes no quota
accounting. **Do not put it in the G2 comparison table** — it is evidence that A2 passes at full
scale, not a latency result.

**E1–E9 turned out NOT to be deploy-gated**, which was my error. They needed the dashboard to be
able to reach the emulator, nothing more. `client/src/store/firestore.ts` now honours
`VITE_FIRESTORE_EMULATOR`, and `scripts/seed-demo.ts` drives F4–F9 through the real adapter and
the real ledger to produce a board with:

```
seq 12  tasks 6  agents 4  contracts 2  locks 2
needs_review  task_api_docs      agent_qa000004
pr_open       task_items_crud    ci=failed agent_be000002
blocked       task_items_ui      agent_fe000003
open          task_items_detail / task_qa_smoke / task_schema
```

That is six columns with a genuinely empty one (E5), a CI-failed badge on a card (E7), a blocked
card with a reason and a blocker, a long title (E6) and two live scope locks. The fixture folds
from events rather than writing board rows directly — a hand-written `TaskView` renders
identically and proves nothing.

Still genuinely blocked: **E2** needs three first-time viewers timed, **E4** needs both builds
side by side, **E8** needs a token diff against the design doc.

**F1–F12** is the whole demo, deploy-gated.

### H: two boxes not yet verifiable

- *Agents cannot merge* — **verified by attempting it**, four ways, in `functions/src/api.test.ts`
  (including from an agent that genuinely holds `grant_merge: true`).
- *`agent_id` is never accepted from the client* — **verified by forging one**, including the
  case where the forged value is the caller's own correct `agent_id`, which is still refused.
- *Both `.agentic/` trees byte-identical (B2)* — cannot be verified from this branch alone. What
  I can assert is the half in my control: the generator names no backend, and the test scans the
  output for `firestore|firebase|catalyst|zcql|stratus|appsail|onSnapshot|runTransaction` and
  fails on any hit. The actual `diff` needs both trees.
- *Both builds pass the same suite with only the adapter swapped* — true for this build's two
  adapters (memory and Firestore run the identical `conformance.ts`). The third leg needs the
  Catalyst adapter.

---

## Interface problems found by writing memory first

The handoff says to write `shared/store/memory.ts` first because it finds interface mistakes
before either cloud build starts. It did. Recorded because it is evidence for the practice:

1. **`releaseScope(project_id, agent_id)` takes no `task_id`**, so an agent can hold exactly one
   lock set. Not stated in the interface, but it is forced by the signature. The lock map is
   keyed by `agent_id` in both adapters as a result.
2. **`subscribe` must fire even when the snapshot is behind `from_seq`.** The spec says "fires
   once immediately with current state"; the tempting reading is "fire only if there is
   something new", which leaves the dashboard blank until the next write — on an idle project,
   possibly hours.
3. **The etag cannot be keyed on `seq` alone.** A heartbeat changes presence without advancing
   `seq`, so a `seq`-keyed etag freezes the agent rail permanently. Both adapters hash presence
   into the etag.
4. **`Snapshot` in `store-interface.md` lacks `project_name` and `repo_url`**, which
   `client/src/store/types.ts` requires and the dashboard renders. I treated the client file as
   authoritative and made the shared type a superset. Flagging rather than editing: `docs/` is
   shared and I was told not to touch it. **Someone should reconcile these two files.**
5. **A `task_completed` from an agent cannot mean `done`.** Agents cannot merge, and `done` is
   downstream of `merged`. The fold maps it to `needs_review` instead.
6. **`branch_pushed` on an unclaimed task needs to keep the branch.** The state machine refuses
   `open → in_progress`, but refusing the whole event throws away the branch name — the only
   link between the task and any later PR or CI event. The fold now records the branch
   unconditionally and logs only the declined transition. Found by a log line in a passing test,
   which is an argument for reading the logs of green tests.

---

## G10 — would I choose this again?

*Written before seeing the Catalyst build's numbers, and before reading that branch.*

Yes, for this workload, without much hesitation — but the reason is narrower than "Firestore is
good", and one line item would make me stop and think if the project grew.

What actually earned it: `runTransaction` and `onSnapshot` are first-class, so the two hardest
requirements in the spec — an atomic claim with exactly one winner, and sub-second notification
— are the platform doing its job rather than me building a mechanism. A2 passes 50 consecutive
rounds of 20 concurrent claims with no workaround anywhere in the claim path, and `freshness`
returns `{ mode: 'live', stale_ms: 0 }` honestly instead of a poll interval I picked. Those are
the two places where a coordination system is either correct or it is theatre, and I did not
have to be clever in either one. The compensating cost is that the constraints move somewhere
less visible: the free tier is metered in **writes per day**, and a 20-second heartbeat quietly
spends two thirds of it on presence — that is arithmetic you have to do before you write the
CLI, not after, and nothing in the platform warns you. Add that the Blaze plan has **no
spending cap by default**, only alerts, and the honest summary is that Firestore made the
concurrency easy and moved the risk onto the bill.

The thing I would genuinely reconsider at scale is the `seq` counter document. Strictly
ascending sequence numbers on a platform with no sequence primitive means one hot document
inside every append transaction, which caps the whole ledger at roughly one write per second.
That is fine at 5–30 facts a day and it is a redesign at a hundred a second. If I were choosing
again for a bigger system I would push back on the *protocol* rather than the platform, and ask
whether strict ascension is worth that ceiling when the spec already permits gaps.

One meta-observation that has nothing to do with which platform won: the single worst bug in
this build — reads-after-writes inside a transaction — was invisible to the memory adapter and
would have shipped if the conformance suite had not been run against the real backend. Whatever
the comparison says, the practice of writing the in-memory adapter first *and then actually
running the same file against the cloud* is the part I would keep.
