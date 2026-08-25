# Workspace 2 — Firebase implementation (route F, "Firestore")

You are building the **Firebase** half of a two-platform bake-off. A second agent is building
the Catalyst half in parallel from the same Phase 0 spec. Do not coordinate with them. Do not
read their branch. The comparison is only valid if both are built independently.

Branch: `impl/firebase`

## Read first, in this order

1. `docs/reference/store-interface.md` — the ten operations you implement. **This is the contract.**
2. `docs/protocol/agent-coordination.md` — protocol v0.2, three layers
3. `docs/reference/agentic-file-contract.md` — the CLI↔agent filesystem interface
4. `docs/reference/blackboard.md` — the git half
5. `docs/how-to/acceptance-checklist.md` — your definition of done
6. `docs/designs/dashboard.md` — tokens, already implemented in `client/`

## Your scope

Implement `CoordinationStore` for Firestore, plus the CLI and the webhook function.
**Do not touch `client/components.tsx`, `client/src/tokens.css`, or anything in `docs/`.**
Those are shared. If you believe a shared file is wrong, say so and stop — do not edit it.

## The stack, decided

| Concern | Product | Why |
|---|---|---|
| Dashboard hosting | **Firebase Hosting** | 10 GB storage, 360 MB/day transfer free. |
| Ledger, claims, presence | **Cloud Firestore** | 50 k reads + 20 k writes **per day** free. |
| Atomic claim | **`runTransaction`** | First-class, auto-retrying. No workaround needed. |
| Notification | **`onSnapshot`** | Sub-second. Billed per document delivered on change, not per unit time. |
| Webhook | **one Cloud Function** | Requires the Blaze plan. |
| Login | **Firebase Auth** | 50 k MAU free. |
| Contracts | **git** | See `blackboard.md`. Identical to the Catalyst build. |

**Not using, deliberately:** Realtime Database (single JSON tree, 100 simultaneous connections
on Spark, no real query model — Firestore is the right product here).

## Things to get right

You have far fewer platform constraints than the Catalyst build. That is the finding, not a
reason to be sloppy. The risks here are different.

| Concern | What you must do |
|---|---|
| **Blaze plan required** for Cloud Functions | Spark lists Cloud Functions as "Not applicable". Attach billing. It will still cost $0 at this volume. |
| **No spending cap by default** | Set a budget alert before writing any code. A runaway listener or a hot loop in a contributor's CLI generates a real, uncapped bill. Document the cap in your notes. |
| Listener billing is per document delivered | Do not attach a listener to the whole `events` collection. Scope to the snapshot doc plus a bounded tail. |
| Reconnect after >30 min offline | Firestore rebills the query as new. Handle it; don't leak listeners. |
| `seq` monotonicity | Firestore has no auto-increment. Use a counter doc in the same transaction as the append, or derive from commit order. Must satisfy A4: strictly ascending. |
| Idempotency | Use the idempotency key as the document ID. A repeat write is then naturally a no-op — but you must still return the original `seq` with `duplicate:true`. |
| **Emoji** | Firestore accepts full UTF-8; Catalyst silently mangles it. You must still run `shared/sanitize.ts` so behaviour is **identical**. Diverging here invalidates the comparison. |
| Security rules | Deny all by default. Clients never write the ledger directly — writes go through your API. `agent_id` is never accepted from a client. |
| `freshness` | Return `{ mode: 'live', stale_ms: 0 }`. The dashboard renders a steady dot instead of a counter. Do not fake a poll counter. |

## Build order

1. `shared/store/memory.ts` + the conformance suite from checklist section A. **Do this first.**
   Same file the Catalyst build writes — whichever workspace lands it first, the other reuses it.
2. Set a Firebase budget alert. Record the threshold in your notes.
3. Firestore collections: `projects/{pid}/{events,tasks,agents,claims,locks,contracts,members,roles}`.
4. Security rules: deny all, then allow exactly what's needed.
5. `store/firestore.ts` implementing `CoordinationStore`. Run the same suite. It must pass.
6. Cloud Function: `githubWebhook`. Raw body for HMAC, timing-safe compare, delivery-id idempotency.
7. Optional Firestore-triggered function to fold snapshot state, if it simplifies reads.
8. CLI: `connect · status · claim · report · start`, outbox drain, blackboard push.
9. Wire `client/src/App.tsx` to `createFirestoreStore`. One line.
10. Run the F1–F12 demo. Record every G-metric.

## Definition of done

Every box in `docs/how-to/acceptance-checklist.md` sections A, B, C, D, E, F, G, H.
Section G is the point of the exercise — record real numbers, not estimates.

Write `docs/handoff/impl-firebase-notes.md` as you go: every constraint you hit, every
workaround, honest hours. Section G10 must be written **before** you look at the Catalyst
build's numbers.

**You will almost certainly finish first.** That is expected — the estimate is ~4 hours against
~1 day. Do not use the spare time to polish beyond the checklist; a fair comparison needs both
builds at the same bar, not one gold-plated.
