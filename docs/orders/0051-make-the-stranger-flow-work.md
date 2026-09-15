---
order:    0051
to:       firebase
issued:   2026-09-15
blocking: yes
---

# One shot: make the whole flow work for someone who has never touched this machine.

I installed the tarball and ran it as a stranger would. **It breaks at step one.** Fix everything
below in one pass, then prove it with a single test that walks the entire path.

## The three failures I found

1. **`drydock init` does not work.** It tries to load Google Application Default Credentials and dies
   with *"Could not load the default credentials"*, writing **no config file**. `init` records a
   project id — it must need **no credentials at all**. It runs *before* login by definition.
2. **Errors are raw stack traces.** Unconfigured prints
   `dist/drydock.js:1783 if (!override) throw new NotConfigured(...)`. Exit 1 is right; the output is
   a crash dump. Catch at the top level: one clean line, the command to run, exit 1. No stack unless
   `DRYDOCK_DEBUG=1`.
3. **Your test passed for the wrong reason.** It redirected `HOME` for a fresh sandbox but left
   `GOOGLE_APPLICATION_CREDENTIALS` exported, so `init` found credentials and went green. **Nobody
   else has that variable.** Same shape as the `undefined === undefined` pass in the same run: the
   environment supplied what the product should have.

   **Every stranger test runs under `env -u GOOGLE_APPLICATION_CREDENTIALS -u FIREBASE_TOKEN -u
   GCLOUD_PROJECT ... HOME=<fresh>`.** A redirected `HOME` is not a fresh machine.

## The gap that stops the loop

**An agent cannot claim a task** (entry 79). Ruling, per the existing architecture:

- The agent appends **`claim_requested`** to `outbox.jsonl`.
- The bridge calls the already-verified `claimTask` — the atomic operation stays where it is proven
  contended, and the agent stays off the network.
- The outcome returns on the inbox as **coordination layer**, win or lose. A loss is a normal reply,
  not an error.

Document the envelope in `protocol.md` — the last run found it had **never been specified**, which is
why the agent had to guess.

## Also fix, since a real agent found them

`AGENTS.md` contradicting the role pack ("push branches: yes" vs "never run git yourself"), `AGENTS.md`
claiming contracts are on disk when the directory is empty, and `builder claim` in generated files.
**Generated prose is a product surface and nothing tests it** — add one assertion that the generated
files contain no stale command name and no claim that is false for an empty project.

## The proof — one test, the whole path

`stranger.mjs`, run with a scrubbed environment and a fresh `HOME`:

```
install tarball → drydock init → drydock login → drydock new
   → agent appends claim_requested → bridge claims → card moves → agent reports → ledger
```

- **Login cannot be driven headlessly.** Stub only that step, say so in the output, and assert
  everything either side of it. Do not let the stub hide a broken adjacent step.
- Assert the **artifact** at each hop: the config file exists, the project document exists, the claim
  document exists, the ledger has the event. Not return values.
- **Prove the test can fail** — run one hop against a deliberately wrong project id and confirm it
  reports failure. A green stranger test that cannot go red is worth nothing.

## Bounds

Do not publish to npm. Do not weaken `firestore.rules`. Do not start F8–F10. `attempts` 6, `cap_ms`
2,000, `--test-concurrency=1`, gate suites on a verified-fresh emulator.

Report only: what passes end to end, and what does not.
