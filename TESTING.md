# Testing

Tests are the only reason it is safe to let several agents write to one repository at once. This
file says what runs, where, and why the layout is the way it is.

## The two commands

```bash
npm test              # seconds. No emulator, no network, no Java.
npm run test:emulator # minutes. Firestore emulator, needs a JDK 21+.
```

and one that does everything, which is what CI runs:

```bash
npm run test:all      # typecheck:all && npm test && npm run test:emulator
```

## Typechecking

Four packages, four tsconfigs, and until order 0086 the root command covered one of them. That is
how `functions/` carried two real type errors for weeks while `npm run typecheck` stayed green:
the settings differ between the root and `functions/`, so the root was answering a different
question than anyone thought.

```bash
npm run typecheck          # root: shared/, cli/
npm run typecheck:firebase # firebase/ via tsconfig.firebase.json
npm run typecheck:functions
npm run typecheck:client
npm run typecheck:all      # all four
```

## The fast suite

`npm test` — everything that needs no backend:

| | |
|---|---|
| `shared/**/*.test.ts` | the ports, the fold, the rollup arithmetic, glob intersection |
| `cli/**/*.test.ts` | outbox, blackboard, MCP, chat, ship, role scope, and the meta-guards |
| `firebase/errors.test.ts` | gRPC status → shared error taxonomy. Pure mapping. |
| `functions/src/webhook.test.ts` | signature verification and delivery mapping. Its own header says "No emulator, no network". |

The last two used to sit inside the emulator suite and paid a full emulator startup for nothing.

It runs through `scripts/run-tests.sh`, not bare `node --test`, and that matters: a **cancelled**
test does not appear in the `fail` count. This build once printed `pass 61  fail 0  cancelled 2`
after thirty-five minutes of wall clock, and the two numbers anyone actually reads both looked
fine. The wrapper fails on cancelled and on todo, and refuses a run whose counts do not balance.

## The emulator suite

`npm run test:emulator` runs four groups, **each in its own emulator process**:

| Script | Files | Why separate |
|---|---|---|
| `test:conformance` | `firebase/store.test.ts` | The CoordinationStore port against Firestore. A2 alone performs 1,000 claim transactions. |
| `test:directory` | `firebase/directory.test.ts` | The ProjectDirectory port. |
| `test:stress` | `firebase/concurrency.test.ts` | Contention: 32 concurrent appends, absorbed by the adapter. |
| `test:integration` | `scoping`, `reaper`, `functions/src/api.test.ts` | Everything else that needs a backend. |

**The separation is measured, not tidiness.** Batched into one emulator, the conformance suite
failed at 106 s with `ABORTED: Transaction lock timeout` — contention retries exhausted by
accumulated degradation from the stress tests earlier in the same process. Run alone it passes in
219 s and 215 s, consistently. The stress suite has exactly the same problem for the same reason:
12/12 alone, and it took the claim test down with it when batched. Do not merge these to save four
emulator startups; you will buy back ninety seconds and lose the ability to trust a red run.

`scripts/emul-groups.sh` runs all four and prints a summary naming each. It does **not** chain
with `&&`: the previous `a && b && c && d` meant the first failure stopped the rest, so a flaky
stress group left the integration group's result neither green nor red but *absent* — and absent
reads as fine. The exit code is still non-zero if any group failed; it reports more, it gates the
same. The file lists live only in the `test:<group>` scripts, and the runner delegates to them,
so there is no second copy to drift.

To run one file:

```bash
scripts/emulator.sh 'scripts/run-tests.sh --test-timeout=300000 firebase/scoping.test.ts'
```

### Known failing: `32 concurrent appends ALL land` (`test:stress`)

**This currently fails roughly two runs in three, on this machine, in its own fresh emulator.**
Measured today: pass, fail, fail — including once with nothing else running. It is not the
batching problem described above; it fails in isolation too.

```
Error [StoreBusyError]: appendEvent: 10 ABORTED: Transaction lock timeout.
    at withContentionRetry (firebase/store.ts:370)
```

The test asserts that the adapter's own 6-attempt contention retry absorbs 32-way concurrent
appends to one project document, with no caller-side retry. On this emulator the budget is not
enough. Two readings, and this has **not** been resolved:

- **Emulator saturation.** `firebase/store.test.ts` already records that production absorbed the
  A2 load with all 6 retry attempts unused, and that "local green does NOT bound production;
  local red may be local." Plausible, and the same signature.
- **A genuinely marginal retry budget** that would also fail in production under this contention.

Settling it means running 32-way contention against real Firestore, which costs real writes — the
reason the suite is emulator-only in the first place. **The retry budget was deliberately not
raised to make the test pass**: that is a production parameter, and tuning it to satisfy a local
emulator would convert a real question into a green check.

Until it is settled, treat a red `stress` group as unresolved rather than as a known-good flake,
and read the other three groups' results, which is why the runner reports all four.

This test had never run before order 0086. It was in no npm script.

### Prerequisites

- **A JDK 21+.** `brew install openjdk`. `scripts/emulator.sh` finds one by *running* every
  candidate and reading its version, because `/usr/libexec/java_home -v 21+` will happily print a
  Java 8 path, and a 2014 Oracle applet JRE on `PATH` reports `1.8` while a modern JDK sits
  unused next to it.
- **`firebase-tools`**, and `npm ci --prefix firebase`.

### The port

The emulator wants 8080. If something else already holds it, `emulator.sh` moves to the first free
port in 8090–8140 and writes a throwaway `firebase.json` override beside the real one (the config
must live in the repo root, because `firestore.rules` is named relatively and `--config` resolves
it against the config's own directory).

If you set `FIRESTORE_EMULATOR_PORT` yourself it **refuses** instead of moving. You named a port,
so you meant it, and quietly using a different one is its own way of running against something you
did not expect. That refusal is load-bearing in the other direction too: two overlapping runs once
made the second one's emulator fail to bind while a port check said "ready", and the whole suite
executed against the first run's already-loaded backend. Results were silently wrong and it took a
while to notice.

## The meta-guards

`cli/every-test-runs.test.ts` tests the test setup itself. It exists because the repository had 22
test files and `npm test` ran 11 of them — not skipped, not disabled, just in no script anyone
ran. A suite that does not run reports nothing, and nothing looks exactly like passing.

1. **Every script names a file that exists.** `firebase`'s `test:own` listed
   `functions/src/reaper.test.ts`; the file is `firebase/reaper.test.ts`. `node --test` exits
   non-zero on a missing path, so the whole script died on its first line and stayed dead.
2. **Every test file is reachable from some script.** `firebase/directory.test.ts` was in none.
3. **The fast and emulator suites do not overlap.** Three `cli/` files were being re-run inside an
   emulator for no benefit.
4. **No test outside `firebase/` imports `firebase-admin` by bare specifier.** See below.

Each has a **control** asserting the scan found something, so a broken scan cannot pass by
matching nothing — the failure mode these guards exist to catch.

## The two-copies trap

`firebase-admin` is installed three times: root, `firebase/`, `functions/`. Node resolves a bare
specifier from the importing file's own directory upward, so a test under `functions/` gets a
different module instance than `firebase/store.ts` does. `FieldValue.increment()` from one is not
`instanceof` the transform class of the other, and the SDK reports the sentinel as an ordinary
object:

```
claimTask: Value for argument "data" is not a valid Firestore document. Couldn't serialize
object of type "NumericIncrementTransform" (found in field "rollup.counts.open").
```

which surfaced as a bare `502 !== 200` on a claim test and read exactly like a claim bug. It was
not — claiming works in production, where one deployed function has one copy.

**Import through `firebase/admin-sdk.ts`** from anywhere outside `firebase/`. It sits beside the
install it resolves and re-exports, so every caller gets the same instance `store.ts` uses. Guard 4
enforces it. Type-only imports are fine: they pull in no runtime module.

The packages are deliberately **not** npm workspaces. `functions/` ships its own `node_modules` to
Cloud Functions at deploy time, and hoisting would change what deploys.

## Writing tests

- **Drive the real thing.** `cli/ship.test.ts` runs against a real git repository with a real bare
  origin, because the whole claim of that module is what git does to a working tree. A mocked
  runner would assert that the right strings were passed to a function that never ran.
- **Assert a control.** Any test that scans, derives, or filters needs a companion assertion that
  the scan found something. A derived-requirement test that matches nothing passes silently; this
  repository has had that happen more than once, including twice in the same session.
- **Name the defect in the comment.** Every guard here says what broke, what it looked like from
  outside, and why the obvious reading was wrong. That is the part that survives.
- **Never weaken a test to make it pass.** If a suite is flaky, find the variable — the emulator
  batching above looked like adapter instability for a while and was not.

## CI

`.github/workflows/test.yml`, on every push and pull request. Two jobs: `fast` (typecheck + unit,
minutes) and `emulator` (four emulator lifetimes, up to an hour). Emulator debug logs upload as an
artifact on failure, because in CI the process is gone by the time you read the result.
