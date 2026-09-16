---
order:    0043
to:       firebase
issued:   2026-09-14
blocking: yes
---

# Spark has no server. The bridge does the server's work. Start F5, F11, F12.

A2 passes, the board is 44/44, and the slice runs. The next thing is F1–F12 — and most of it collides
with a fact nobody has confronted yet.

## The architectural gap, and the ruling

`coordination-api.md:329` specifies `POST /api/github/webhook`. `catalyst-builder.md` assumes a
webhook receiver and Catalyst ran its **reaper as a Cron Function**. **Firebase is on Spark, which
has no Cloud Functions at all.** There is no server-side code on this route, and no test in F8–F12
can pass as written.

**Ruling: both move into the local CLI bridge.**

1. **Poll GitHub instead of receiving webhooks.** PR state and CI status, polled on an interval.
2. **The reaper runs opportunistically inside every bridge process**, guarded by `claimTask` on a
   reaper lease so concurrent bridges do not stampede — the primitive is already verified contended,
   so use it rather than inventing a second one.

**Why this is the right shape, not just the available one.** A self-hosted webhook receiver demands a
publicly reachable URL from every user of an open-source tool — a real adoption barrier, and the same
one that makes "runs on infrastructure you already have" valuable. This makes the product **fully
local-first**: Firestore and RTDB as coordination substrate, every process on the user's machine.

**State the consequence rather than hiding it:** the reaper only runs while at least one bridge is
running. If every laptop is off, stale claims are not released — which is harmless, because nobody is
blocked when nobody is working, and any starting bridge sweeps first. Write that down where the
reaper lives.

**Name the mechanism, per entry 30.** F8–F10's observable outcome — "board shows the badge without a
refresh" — is unchanged. The mechanism is now **poll, not webhook**, and the checklist must say so.
An unchanged assertion over a changed mechanism is exactly the substitution that cost route C1 its
architecture.

## Start with the three that need nothing from the user

Auth and the RTDB instance are still off, so do the ledger-verified ones first:

- **F5** — backend and frontend claim concurrently, no double-claim. You have A2 at 20 × 50; this is
  the product-level version with two real agents through the bridge.
- **F11** — kill an agent, reaper releases the claim **within 15 min**. Assert the release, not the
  absence of the agent.
- **F12** — another agent claims the released task successfully. F11 and F12 are one test in two
  halves; a release nobody can then claim is not a release.

F1–F4 and F6–F7 need no browser either — they are `git log` and `inbox.jsonl` evidence. Take them if
the three above land cleanly. **F8–F10 need the board, so they wait for Auth.**

## Standing rules, unchanged

- **A control that never fires has not been run** (entry 60). Scale it until it registers. Your
  contention probe said zero at 64 writers and only proved itself at 256.
- **Never `String()` an SDK response; never treat "it didn't throw" as success.**
- **Read the frozen assertions before changing behaviour.**
- **`--test-concurrency=1`** — and never a bare `node --test a b c d`, which does not inherit it.
  That was my error and it cost a false alarm on the gate.
- `cap_ms: 2000` is dead configuration until `attempts` exceeds 6 (entry 61). If anything here makes
  you want to raise `attempts`, fix the cap in the same change or leave both alone.

## Still the user's

**Authentication → Anonymous**, and **create the RTDB instance**. The JDK item is cancelled — it was
never missing, only shadowed on PATH (entry 57).
