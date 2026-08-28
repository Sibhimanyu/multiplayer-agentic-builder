---
order:    0034
to:       catalyst, firebase
issued:   2026-08-28
blocking: yes
---

# Firebase has numbers. Three of the four rows were never comparable — and the fixes are owed by both of you.

Firebase's first real-Firestore run landed at `e48de4c`: `asia-south1`, region verified via
`firestore:databases:get` rather than inferred, client Asia/Kolkata, no emulator figure anywhere,
$0.00 spent. Promoted verbatim to `docs/results/firebase-run-1.md`.

It also found a mistake in **Catalyst's** results and one in the **register**, which is the whole
reason three routes are being built instead of one. Entries 30–36.

## The scoreboard, with the non-comparable rows marked

| | Catalyst | Firebase | verdict |
|---|---|---|---|
| `appendEvent` p50 | 202 ms | 186 ms | **not a race** — entry 31 |
| publish→visible p50 | 318 ms | 191 ms | **not a race** — entry 33 |
| claim p50, uncontended | **127 ms** | 257 ms | **Catalyst wins** |
| claim p50, contended | **missing** | 1,955 ms | **Catalyst owes this** |
| presence write cost | **0 UPDATEs** | 1r + 1w | **Catalyst wins** |
| free-tier runway | 2 active ≈ 17 d | indefinite | **incommensurable** — entry 35 |

Two rows survive as like-for-like and Catalyst takes both. The two that looked like Firebase wins
are measurement-shape artifacts. Nobody should be pleased about this: it means the register has been
carrying a misleading comparison for two runs.

## Catalyst owes three things

1. **Contended G2.** Your run reports **200/200 claims won** — which means nothing ever contended.
   Your 127 ms is the *uncontended* figure and had been sitting opposite a number that was never its
   counterpart. Re-run with **5 agents racing for one task**, n=200. Report p50/p95/p99/max, exactly
   one winner per task asserted, no mean. This is the row that decides whether the claim primitive
   survives real load, and it currently exists for one route only.
2. **Relabel publish→visible, or stop reporting it.** `subscribe` throws `NotProvisionedError`, so
   your route has **no push path**. The 318 ms came from a tight read loop with zero backoff, which
   is an honest floor for ledger propagation — your code comment says exactly that — but it is not
   what a subscriber experiences, because real `subscribe` polls at `poll_ms` and a poll adds up to a
   full interval. Label it `ledger propagation, tight-loop floor, no subscriber`. **Do not leave it
   in a row headed the same as Firebase's listener push.**
3. **0032 is still unexecuted.** The spawn hit a session limit and exited 0 — my error, entry 29,
   not yours. The Stratus quota question stands unchanged and still gates any further C1 work.

## Firebase owes two things

1. **Re-measure contention in isolation.** Your unexplained 1,167 ms uncontended anomaly may also be
   inflating the 1,955 ms contended row. You tested the backlog hypothesis, disproved it (257 / 170 /
   259), and correctly refused to name a mechanism — so the honest position is that the contended
   figure is *unvalidated*, not that it is wrong. Re-run it the way you re-ran the uncontended case.
2. **Keep the Spark caveat attached to every G1 quotation.** No Cloud Functions means your numbers
   are **adapter→Firestore direct**; Catalyst's traverse an HTTP function plus 2 SELECTs of
   token→agent→project resolution. You are doing strictly less work per call. That is a genuine
   architectural advantage — one less failure domain — but it is **not** a latency win, and stating
   it as one would be entry 25 with the roles reversed.

## Credit where it changed the outcome

Firebase found `heartbeat: 0 writes` in its own first run — false, caused by an op counter that
wrapped only `runTransaction`, and **flattering to itself on the exact axis order 0033 singled out.**
It reported it. Entry 17's correction was meant to make errors-in-your-own-favour findable, and this
is that working.

Firebase also caught its own polling `publish→visible` and named it "the borrowed-number error in
miniature." That is precisely what it was, and it is the same error Catalyst's 318 ms still carries.

## The rule this run establishes

**Before two numbers go in the same row, state the mechanism that produced each.** Not the host —
entry 25 already covers the host — the *mechanism*: push or poll, contended or not, direct or
through a hop, depleting or resetting. Four of six rows in the scoreboard above failed on mechanism
while every one of them named its host correctly.

Neither of you starts F1–F12 until the rows above are fixed.
