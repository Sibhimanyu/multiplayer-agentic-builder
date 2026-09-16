---
order:    0042
to:       firebase
issued:   2026-09-14
blocking: yes
---

# A2 fails on your adapter. Find out whether production does it too — do not tune until it passes.

I unblocked the emulator and ran the four suites. **36/37 pass. The failure is A2.**

## First: the JDK was never missing

Three of your runs reported the suite unrunnable because `firebase-tools` needs Java 21+.
**`openjdk 26.0.1` was already installed via brew.** `java -version` reported 1.8.0_503 because a
2014-era Oracle *applet-plugin* JRE sits earlier on PATH.

```
export JAVA_HOME="$(brew --prefix openjdk)/libexec/openjdk.jdk/Contents/Home"
export PATH="$JAVA_HOME/bin:$PATH"
```

The emulator starts first try. **The diagnosis was one level off** — "missing" rather than
"shadowed" — and it blocked the most important suite in the project for three runs. Nobody, me
included, ran `brew list`. Entry 57.

Second gotcha: **`firebase emulators:exec` runs its script under the CLI's own pkg-bundled Node**,
which treats `--test` as a filename. Start the emulator standalone and set
`FIRESTORE_EMULATOR_HOST=127.0.0.1:8080`.

## The failure

Two runs, two *different* failing tests — "32 concurrent appends" and "A2 20 concurrent claimTask,
50 consecutive rounds" — same error both times:

```
StoreBusyError: 10 ABORTED: Transaction lock timeout.
  at withContentionRetry (firebase/store.ts:361)
```

**`withContentionRetry` exhausts its budget under sustained contention and lets `StoreBusyError`
escape** — exactly what both tests assert the adapter absorbs.

**A2 is the gate.** It is what qualified every route in this project; route G passed it at 20 racers
× 50 rounds. **The route we chose has never passed it.** And commit `310ca22` concluded *"A2 was the
harness, not the adapter."* With a correct emulator it still fails, with a structured error. **That
retraction is now in question** — treat it as unsettled rather than as established history.

## What I need, and the order matters

### 1. The discriminating experiment — measure it, do not argue it

**Does A2 fail against production Firestore?** The emulator uses pessimistic locking with a lock
timeout; production uses optimistic concurrency. *"Transaction lock timeout"* may be emulator-specific
wording for an emulator-specific mechanism — **that is a hypothesis, and it is exactly the kind this
project has been wrong about before.**

Run A2's exact sequence against production. Same racer count, same rounds, same adapter path. Report
both results side by side with the mechanism named, per entry 30's rule.

### 2. Pre-registered, before you see a number

- **Fails on production too** → a real adapter defect. Fix the budget *and* say what load it now
  survives, with the number.
- **Passes on production, fails on emulator** → an emulator artifact. Then the finding is that **A2
  cannot be validated locally**, which is a serious gap in its own right, and the suite must say so
  in its output rather than leaving a red test that gets learned-around.
- **Either way, do not raise `attempts` until it goes green.** That is tuning to the test. Any new
  budget needs a stated reason — what contention level it survives and why that level is the right
  one — the same standard as `HEARTBEAT_INTERVAL_MS`.

### 3. Do not touch what is already right

The retry loop detects contention by **structured code, never message text** — a defect order 0017
caught once already. And it backs off on **real time**, with a comment explaining that using the
injected `FakeClock` would hang forever under load and present as a load-dependent *hang* rather
than a failure. Both are correct. **The budget is the suspect, not the design.**

## Note for the record

I asked whether to install a JDK and the user said go ahead; the honest outcome was that no install
was needed. Recorded as entry 57 because "the dependency is missing" was believed for three runs on
the strength of an error message, and a one-line `brew list` refuted it. **An error message names a
symptom, not a cause** — the same shape as reading a 400's header as a property of the data path.

Do not start F1–F12. Auth and the RTDB Management API are still off, and both remain the user's to
enable.
