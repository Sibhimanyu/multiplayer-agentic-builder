# Firebase build notes — route F, Firestore

Written as I went. Constraints hit, workarounds, honest hours. This is the deliverable the
handoff asks for; it is a new file, not an edit to any shared doc.

**G10 was written before looking at the Catalyst build's numbers, and before reading anything
on `impl/catalyst`.** I have not read that branch.

---

## Status summary

**139 tests, 138 pass, 0 fail, 1 honest skip.** `npm test` runs all of it; `npm run typecheck`
is clean across the root, `functions/` and `client/`, and both builds produce artifacts.

| Suite | Result |
|---|---|
| `shared/store/memory.conformance.test.ts` | 18/18 |
| `shared/store/firestore.conformance.test.ts` (emulator) | 17 pass + 1 skip |
| `functions/src/api.test.ts` (emulator) | 18/18 |
| `functions/src/reaper.test.ts` (emulator) | 9/9 |
| `functions/src/webhook.test.ts` | 17/17 |
| `cli/outbox.test.ts` | 20/20 |
| `cli/blackboard.test.ts` (real git) | 14/14 |
| `cli/client.test.ts` | 17/17 |
| `shared/store/republish.test.ts` | 8/8 |

| Section | State |
|---|---|
| A — store conformance | **Pass.** memory 18/18. Firestore 17 pass + 1 honest skip (A13, see below). |
| B — CLI | **Pass.** B1, B2, B4–B7, B9 in `cli/outbox.test.ts`; B3, B10 in `cli/client.test.ts`; B8 at the API. |
| C — git blackboard | **Pass.** C1–C7, 14/14 against real git and a real bare remote. |
| D — webhook | **Pass.** D1–D6, 17/17. |
| E — dashboard | **Not verified.** Needs a deploy + screenshots. Store is wired; code path untested against a live project. |
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

## A13: the one skipped box, and why it is a skip and not a pass

A13 asks that a snapshot reporting `seq < last_written_seq` does not trigger a re-append.

On Catalyst that window is real and load-bearing: the snapshot writer is an Event function
debounced 2 s, so a caller genuinely can append, get `seq = N`, and immediately read a snapshot
at `N - 1`.

On Firestore **the window does not exist**. `readSnapshot` reads the same listener cache the
fold wrote, inside the same transaction boundary, so `seq` cannot trail the ledger. There is no
way to make the adapter exhibit the condition, so the emulator run reports:

```
﹣ A13 ... # A13 skipped on firestore: Firestore has no debounced snapshot publication to lag
```

The caller-side rule is still tested, because the CLI shares it across both builds — see
`decideRepublish` in `shared/store/republish.test.ts`, which also proves there is no input for
which the caller republishes.

I want to be explicit that this started as a **false green**. The first version of the
conformance harness returned `null` for a missing capability and let the test `return` early,
which node reports as a PASS. A13 read green against Firestore for a test that never ran. That
is exactly the failure mode the checklist warns about, so `needCap` now throws a `SkipTest` that
`withTarget` converts into a real `t.skip(reason)`.

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

---

## G7 — lines of code in the adapter

Measured two ways, because the raw `wc -l` is dominated by comments in this codebase.

| File | `wc -l` | code only |
|---|---|---|
| **`shared/store/firestore.ts`** (the adapter) | **941** | **711** |
| `shared/store/memory.ts` (the control) | 545 | 423 |
| `client/src/store/firestore.ts` (browser, read-only) | 358 | 241 |
| `firestore.rules` | 134 | 63 |

Shared, written once and reused by both builds:

| File | code only |
|---|---|
| `shared/store/types.ts` | 215 |
| `shared/store/fold.ts` | 179 |
| `shared/globs.ts` | 95 |
| `shared/sanitize.ts` | 56 |
| `shared/store/errors.ts` | 41 |
| `shared/store/prepare.ts` | 39 |
| `shared/store/retry.ts` | 33 |

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

**E1–E9** need a deployed dashboard and screenshots. The store is wired (`App.tsx` is the
one-line change the file anticipated) and the client typechecks and builds, but no code path has
run against a live project.

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
