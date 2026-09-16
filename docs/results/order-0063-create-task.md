# Order 0063 — tasks can now be created, and the rollup was never landing

Date: 2026-09-16
Branch: `work`

## What the order asked for, and what it got

| asked | delivered | evidence class |
|---|---|---|
| `createTask` on the port, with conformance coverage | `CoordinationStore.createTask`, A16–A18 | **tested** (memory + Firestore adapters) |
| an event kind on the COORDINATION layer | `task_created` in `LAYER_OF` | **tested** (A16 asserts the layer) |
| `flotilla task <title> --kind <role>`, in `--help` | `cli/index.ts` + `firebase/flotilla-main.ts` | **tested** at the arg-parsing seam; the network path is *not* end-to-end tested |
| rollup counters must move on it | `commitRollup` unchanged in shape; delta only | **verified against production** |
| fix the probe and RUN it | `firebase/rollup-probe.mjs`, run against real Firestore | **verified against production** |
| state an opinion on where tasks come from | `docs/decisions/0005-work-appears-by-triage.md` | opinion, not built |

## The thing the order did not ask for, because nobody knew

**The rollup has never landed in Firestore. Not for `task_created`, not for anything.**

`commitRollup` wrote:

```ts
tx.set(this.proj(pid), { 'rollup.counts.open': FieldValue.increment(1) }, { merge: true });
```

with a comment asserting that "a set/merge with dotted keys creates the nested shape". **It does
not.** In the Node admin SDK only `update()` interprets a dotted key as a field *path*; `set()`
treats it as a literal field *name*. Measured, not reasoned about:

```
set({'rollup.last_seq': 7}, {merge:true})   ->  {"rollup.last_seq": 7}   get('rollup') === undefined
set({rollup: {last_seq: 7}}, {merge:true})  ->  {"rollup": {"last_seq": 7}}
```

So every project document written since Order 0062 carried top-level fields *called*
`"rollup.counts.open"` and nothing named `rollup` at all — and `client/src/store/directory.ts`
reads `p.get('rollup')`, so the projects index has been reading an unwritten field the entire time.

**`shared/store/rollup.test.ts` was green throughout.** The arithmetic was never what was broken.
This is the artifact rule in one defect: a pure function passing says nothing about whether the
field exists in Firestore, and the index reads the field, not the function.

**Nothing caught it because the probe that would have caught it had never run.** It failed on its
first append against an event kind that did not exist. The order was right that the probe's
`task_created` was invented; chasing it found the missing operation, and *running* it found this.

### The fix

A nested object with `merge: true`, which keeps both properties the dotted form was chosen for.
Verified against real Firestore, all three:

- it **creates** the project document when it does not exist (so `update()` is still not an option)
- `merge: true` **deep-merges** map fields: writing `rollup.counts.open` left `rollup.counts.claimed`
  and the sibling `project_name` untouched
- `FieldValue.increment` **composes** inside it: five concurrent transactions incrementing one
  counter all landed (1 → 6, none lost)

## The two invariants the order said must survive

**Counters move by delta, O(1).** `createTask` goes through the same `planAppend` /
`commitAppend` / `commitRollup` path as every other operation. `taskBefore` is null for a task
that does not exist, so `rollupDelta(null, after)` increments `open` by one and touches nothing
else. It reads exactly one task document — the one the event names — so there is no recount and no
second write path that could grow one. Verified in production: `open` moved 1 → 2 → 3 across three
creates in one run and equalled a fresh recount of the tasks collection at every step.

**The index reads 1 query + 3 reads per project.** Untouched. `listProjects` is one
`collectionGroup` query over memberships plus, per project, the project document, the members
collection and the agents collection. `createTask` adds nothing to that path; it only makes the
`rollup` field the index already reads actually exist.

## Production probe, final run

`scripts/run-rollup-probe.sh` against `multiplayer-agents-eec02`, throwaway namespace, cleaned up:

```
PASS  a project with no events has no rollup at all (absent, not zeroed)
PASS  createTask created three tasks against real Firestore
PASS  a created task is a real open card in the tasks collection -- open/backend
PASS  last_activity is set -- 2026-09-16T10:23:00.249Z
PASS  last_seq tracks the ledger -- 7
PASS  counts match a recount of the tasks collection
PASS  blocked matches the recount -- 1 vs 1
PASS  (control) a deliberately corrupted counter IS caught by that same comparison
PASS  unblocking decrements the blocked counter -- 1 -> 0
PASS  and still matches a recount
PASS  a replayed append does not double-count
PASS  a repeated createTask reports the existing task rather than creating one -- status open
PASS  and it does not move a single counter
PASS  an id omitted by the caller is derived from the title -- task_wire_the_webhook
PASS  and open STILL equals a recount after every create in this run -- 3 vs 3

ROLLUP PROBE PASSED
```

The probe was wrong in **three** ways, all found by running it, all recorded in its header rather
than quietly fixed:

1. `task_created` was not a kind. (Named by the order. Now real.)
2. Every append omitted `layer`, which `planAppend` rejects. The kind error hid it — fixing only
   the kind would have moved the failure one line down. The layer is now derived from `LAYER_OF`
   so the probe cannot disagree with the contract about it again.
3. It blocked a task straight out of `open`, which the fold refuses (`open -> blocked` is not a
   legal transition), so "unblocking decrements" was measuring a counter that had never been
   incremented. It now claims the task first, as a real agent does.

A fourth, in the probe's own checks: `JSON.stringify` compared two objects built in different key
orders, reporting a red check on two identical sets of numbers. Sorted now.

## Controls — a control that never fires has not been run

**The production control fires on every run.** Step 4 corrupts the stored counter and confirms the
same comparison catches it. Note it was *weak* on the broken run: both sides were empty, so it
would have "passed" against anything. It also wrote its corruption in the same dotted form as the
bug, so after the fix it would have corrupted nothing. Both fixed; it now corrupts the nested
field where the rollup actually lives.

**A16–A18 were mutation-tested**, not merely observed green. Each mutation was applied, the suite
run, and the source restored:

| mutation | result |
|---|---|
| `createTask` stops checking for an existing task | A17 red (1 fail) |
| `task_created` moved to the human layer | A16, A17, A18 all red (3 fails) |
| a new task is born `claimed` instead of `open` | A16, A17 red (2 fails) |

**A18 survived the third mutation, and that is reported rather than hidden.** A18 asserts that a
created task is claimable and that a second claimant loses; a task born `claimed` is still
claimable (`claimed -> claimed` is a legal transition and the snapshot renders the same status
either way). A16 is the test that pins the initial status. The three tests overlap deliberately but
they are not redundant, and A18 is not a status test.

**The first production run of the probe is itself the control for the rollup fix.** It ran against
the broken code and returned 4 FAILs naming the exact symptom (`counts {} vs {open:1,...}`,
`last_seq undefined`). The check is known to be capable of failing because it did.

## Tested vs verified against production

**Tested** (node `--test`, no network):

- A1–A18 conformance against the **in-memory** adapter — 34 pass, 0 fail, 0 cancelled, 0 todo
- A1–A18 conformance against the **Firestore** adapter on the emulator — 18 pass, 0 fail,
  0 cancelled, 0 todo (41 min wall clock; A2 alone is 41 min on an emulator that saturates at
  ~½ production's concurrency, which the harness prints as a calibration note)
- `rollupDelta` arithmetic including replay-equals-recount and its own dropped-delta control
- `flotilla task` argument parsing, `--kind` validation and `--help`

**Verified against production** (real Cloud Firestore, `multiplayer-agents-eec02`):

- `createTask` creates a real open card in the `tasks` collection
- the id is derived from the title when the caller omits one
- a repeated `createTask` returns the existing task and moves no counter
- the rollup `counts`, `blocked`, `last_activity` and `last_seq` fields exist, are nested, and
  equal a recount of the tasks collection
- unblocking decrements
- a replayed append does not double-count
- `set` + dotted keys vs `set` + nested object semantics
- `FieldValue.increment` composing across five concurrent transactions

**Neither** — stated plainly because the distinction is the point:

- **`flotilla task` has not been run end to end against the deployed write function.** The command,
  the `create_task` op, the `triage` gate and `store.createTask` are each exercised, but no run has
  gone CLI → HTTPS function → Firestore. The first person to try it is doing the integration test.
- **The `triage` capability gate on `create_task` has not been exercised against a real role
  policy.** It is the same `hasCapability` call every other op uses, and the capability already
  existed, but "a client seat is refused" has not been observed.
- **A16–A18 against the Firestore adapter run on the emulator, not production.** This repo
  distrusts the emulator for exactly this kind of claim (entry 65), which is why the probe exists.
