---
order:    0046
to:       firebase
issued:   2026-09-14
blocking: yes
---

# Wire RTDB, then get the board on a screen. Auth is reportedly on.

The project tier landed: `ProjectDirectory` 7/7 as a **second** port, `drydock new` working against
production, index 60/60, `PROJECT_ID` unhardcoded. Entries 65–67.

Three things from that run are now rules:

- **The emulator does not enforce indexes** (entry 65). Your suite passed while `drydock ls` failed in
  production. Worse than the contention divergence, because it is **silent and deterministic** — local
  green is not a weaker signal there, it is the wrong signal every time. Anything with a new query
  shape gets one production run before it is believed. Polling the *query* rather than the index API
  was right for the same reason.
- **A readiness probe must prove identity, not availability** (entry 66). You caught the gate running
  against a contaminated emulator because `until curl` went green when *something* answered. Third
  instance in this project of a true signal about the wrong subject. You reported the invalid run
  instead of substituting the green one — that is the second time in two orders.
- **Revoked members are retained and marked, never deleted** (entry 67), because deleting yields an
  identical `listProjects` result while orphaning every ledger entry that references the uid.

## 1. Wire RTDB — us-central1, and label it forever

**Decision 0003** is on the shared branch. The user was shown the region mismatch and chose to keep it:

```
VITE_FIREBASE_DATABASE_URL=https://multiplayer-agents-eec02-default-rtdb.firebaseio.com
```

Cost is unaffected — RTDB bills bandwidth, not distance — so entry 56's 1.4% holds. Presence is not
latency-critical, and the visible effect is an avatar ring settling ~200 ms after a card moves.

**The standing condition:** every presence figure carries **`us-central1`**, and **none of them goes
in a row with the Firestore numbers.** Every other latency figure here is same-region by construction
(`asia-south1`, client Asia/Kolkata, deliberately best-case). Presence is not. Entry 25's failure mode,
now a labelling rule rather than a trap.

Measure presence live and replace entry 56's arithmetic with an observed figure — that was the whole
reason the instance was needed.

## 2. Verify auth, then put the board on a screen

The user reports **Anonymous sign-in is enabled.** Verify it on **two independent surfaces**, as you
did when it was off — a claim from the console and a working `signInAnonymously` are different facts.

If it is live: **get the board rendering in a real browser and produce a screenshot.** This has been
blocked for four runs and has never been seen against live data.

A browser *is* available in this environment — the coordinator rendered the mock build at
`localhost:4173` and captured it. Your edge harness server-renders, which is why it asserted 60/60 and
still could not see a grid row stretching a 10.5 px label to 82 px. **Server-rendering asserts
presence; it never computes layout.** If a real browser is out of reach for you, say so and I will
capture it.

Known and already diagnosed, fix it while you are there: `.p-body` is a grid with `align-content:
normal`, so free height distributes into its rows and cascades into `.sect`. A 10.5 px label occupies
82 px and the panel wastes roughly 400 px. The fix is `align-content: start`, not padding tweaks.
`components.tsx` and `tokens.css` are unfrozen.

## 3. Then F1, F2, F3

They needed the board and the `connect` flow, both of which now exist.

- **F1** — owner creates the project and connects the repo. `drydock new` does this; F1 is the
  evidence, end to end.
- **F2** — owner invites 3 builders, assigns architect / backend / frontend. `addMember` and `setRole`
  exist on the directory port.
- **F3** — each builder runs connect then start in a separate worktree.

F8–F10 stay after these; they need PR and CI state flowing through the bridge's GitHub poll.

## Not this order

**Roles-as-capabilities and the client seat are next** and they are the user's actual vision — see
`docs/designs/project-tier.md`. Do not start them here. The client seat in particular has a property
worth getting right rather than fast: a client's words are human-layer, so they never reach any
`inbox.jsonl`, and **prompt injection from that seat is structurally impossible rather than policed.**

## Standing rules

Assert the artifact, not the return value; the rule, not the outcome. A control that never fires has
not been run, and a negative assertion needs proof the thing could appear. Gate suites get a
**verified-fresh** emulator — identity, not a port ping. `--test-concurrency=1`. `attempts` 6,
`cap_ms` 2,000.
