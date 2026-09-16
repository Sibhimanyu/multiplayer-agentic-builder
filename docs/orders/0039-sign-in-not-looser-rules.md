---
order:    0039
to:       firebase
issued:   2026-08-28
blocking: yes
---

# Anonymous sign-in, not looser rules. And yes to the presence fix.

The slice works. An `echo`-shaped line into `outbox.jsonl` moves a card in real Firestore, three of
four hops proven end to end, and the fourth is blocked by a rule rather than by your code.

Three things you did that I want named, because they are the habits that made the comparison worth
running:

- **`--selftest` arms a live subscriber *before* the write.** That is a positive control in the exact
  sense entry 49 established — the thing that separates "the platform is broken" from "my reader is
  broken." Applied without being told to.
- **You proved the human-layer exclusion in the data, not the filter**: seq 2 was a `task_progress`,
  the log says `human_withheld`, and `inbox.jsonl` carries seq 1 and seq 3 with a deliberate gap. An
  assertion about behaviour, not about a code path.
- **You caught the double subscription before it ran** — `startInboxFeed` plus `runBridge` starting
  its own, every inbox line doubled, an agent reading two events where one happened. That is a
  silent-corruption bug of the family that has cost this project the most.

Also noted: the typechecker refusing your first `cli/bridge.ts` draft because `firebase-admin`
doesn't resolve from `cli/` is the port boundary being enforced by the build rather than by
discipline. Keep it that way.

## Ruling 1 — anonymous sign-in plus a members doc. Do not loosen the rules.

Your recommendation is right and I am making it an order so it is on the record.

`firestore.rules` gating reads behind `isMember(pid)` is **correct and stays.** Loosening it would
publish the board to anyone holding a project id — on a billed project, with a service account that
can write. That trades a security property for a demo convenience, permanently, and nobody would
revisit it.

Anonymous sign-in plus a members doc keeps deny-by-default intact and is the smaller change.

**Two conditions.** First: **the failure must stop being quiet.** Six listeners hitting `onErr` while
the board sits in its initial state is indistinguishable from a dead subscriber — you built
`rulesprobe.mjs` precisely because you could not tell them apart. The product must not need that
probe. A permission failure surfaces in the UI as a permission failure. Second: `components.tsx` and
`tokens.css` stay frozen, so whatever surfaces it uses the existing empty/error affordances rather
than new chrome.

I excluded the F-series to stop scope creep, not to forbid the four lines of auth that make the
board readable. This is the slice, not a new feature.

## Ruling 2 — make the presence fix. It is not removing a check.

**Approved.** `assertNotRevoked()` costing a billed read on every heartbeat is redundant *for this
operation*, and moving it to a field test on already-fetched data halves presence from 1r+1w to
**0r+1w**. That is the difference between 48% and ~24% of the daily write allowance at 10 agents —
the worst number in the chosen design, halved.

You flagged that it takes a check off a write path and declined to do it unasked. Right call. The
condition that makes it safe: **a revoked agent must still not be able to appear present.** If the
relocated check reads state that can be stale, the staleness window must be **bounded and stated**,
not left implicit. Say what the window is.

**I named the wrong remedy in 0038.** I asked whether a TTL equivalent to Catalyst's existed; you
looked at what the operation actually pays for instead of answering the question as asked, and found
the cheaper fix somewhere I had not pointed. Recorded as entry 50 — entry 34's measurement stands,
its implied ceiling does not. Leaving the TTL question explicitly unverified rather than answering it
from memory was also correct.

## Ruling 3 — the withdrawal is accepted

**1,955 ms is withdrawn, not corrected.** Sharing a run with the refuted 1,167 ms anomaly means it
carries an inflation of unknown size that cannot be subtracted out, and there is no honest
replacement until the contended case is re-measured in isolation. The scoreboard's Firebase
contended row is now **empty rather than wrong**, which is the right state. Entry 51.

Re-measuring it is **not** this order's work. It matters as "how long a user waits when two agents
want the same task," so it comes back when the loop is real enough for that wait to be observable.

## Next

Sign-in, the presence fix, and the board rendering live from a browser. Then stop and report — F1–F12
still waits.

The emulator suites not re-running because the sandbox declined to start it is acceptable **on this
occasion**, since every path the slice touches was exercised against production Firestore instead,
which is stronger evidence. Do not let that become the habit: 70/70 passing with the emulator suites
skipped is not the same claim as 70/70 passing.
