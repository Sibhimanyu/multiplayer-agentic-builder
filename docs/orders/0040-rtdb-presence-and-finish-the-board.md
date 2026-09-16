---
order:    0040
to:       firebase
issued:   2026-09-11
blocking: yes
---

# Finish the board, then move presence to RTDB. A9 is frozen — read it first.

Direction from the user: complete and polish this route, finish the Kanban UI, and use **RTDB** for
the realtime layer. Catalyst is out of scope entirely — decision 0001 stands and the comparison
stays closed.

## Scope ruling on RTDB, so you do not over-apply it

**RTDB owns presence. Firestore keeps the ledger, claims and the doorbell.**

- **Presence → RTDB.** `onDisconnect()` is a server-side hook with no Firestore equivalent, and RTDB
  bills bandwidth rather than operations. That is the one change that attacks the write ceiling
  directly, which is the worst number in this design.
- **Doorbell → stays on Firestore.** `onSnapshot` is already a persistent WebChannel connection, not
  polling — it is where the measured **191 ms** comes from. Notifying on RTDB and then reading
  Firestore would add a round trip to a path that already works. Do not slow the live board down to
  use one more product.
- **Claims → stay on Firestore.** `runTransaction` is verified contended, 40 won / 160 lost. Do not
  rebuild a primitive that is already proven.

If measurement later contradicts any of this, say so — but do not widen the scope on intuition.

## A9 is frozen and it constrains the design

`shared/store/conformance.ts:287` — **A9** requires `AgentPresence.stale` to flip true 90 s after the
last heartbeat, to be false one second early, and to clear on a fresh heartbeat **with no repair
step**. Its comment is explicit: *"Derived, not stored."* The harness drives it with `advanceTime`,
a fake clock.

**Therefore `stale` stays derived from `last_heartbeat_at` in the adapter.** It may not be read from
RTDB server state, or A9 breaks under the fake clock.

`onDisconnect` is a **second, faster signal** for a genuinely dropped socket — it feeds the *offline*
ring in the dashboard, which the design already distinguishes from stale (green connected/working,
red blocked, grey offline). Two signals, different meanings:

| signal | source | means |
|---|---|---|
| `stale` | derived, `last_heartbeat_at` + 90 s | agent stopped reporting |
| `offline` | RTDB `onDisconnect` | socket actually dropped |

Read A9 in full before writing any of this. You found A14 that way and it stopped the presence fix
from being a deletion.

## Work, in order

### 1. Verify auth is enabled — do not assume

Last run failed on `auth/configuration-not-found` because Firebase Authentication was never
initialised. The user was asked to enable Anonymous sign-in. **Check it before building on it.** If
it is still off, say so immediately and do the UI work that does not need a live board rather than
stalling.

### 2. Finish the Kanban board

`docs/designs/dashboard.md` is the spec and its **locked patterns are not open to reinterpretation**.
Specifically:

- **Six columns**: Open, Claimed, In progress, Needs review, PR open, Merged — each with a count.
- **The detail panel overlays, never displaces.** `position:absolute; right:0; z-index:20`, board
  carries `padding-right:400px`. Displacing columns previously hid "PR open" and "Merged" entirely.
  That was a real bug; do not reintroduce it.
- **Agent presence is an avatar with a status ring on the card**, not a separate panel.
- **Freshness pill reads `store.freshness`** — `mode:'live'` gets a steady dot and no counter.
- **Empty columns get the dashed empty state**, never a blank.
- **No layout shift on refresh.** Stable keys; heights must not depend on load state.

Then work the **edge-case table** in that doc — all nine rows, including the 47-char title, the
90-char path truncating from the left, the blocked chain A→B→C showing the full chain, and 10 agents
collapsing to `+6`.

`components.tsx` and `tokens.css` stay frozen. If the design genuinely cannot be built without
touching them, stop and say which line and why.

### 3. Move presence to RTDB

Keep `listPresence` and `heartbeat` behind the same port signatures — the interface does not change,
only what backs it. The conformance suite must pass unmodified.

**Then reconcile the open number.** Entry 50 records a contradiction I could not resolve: presence
was reported as 48% of the daily write allowance, and later as 28,800 writes/day being *over* the
free tier, which at 20,000/day would be 144%. **Those cannot both be right.** The scoreboard row is
marked UNKNOWN. Measure it on RTDB and state the real figure with its units — bandwidth, not
operations, since that is now the meter.

## Rules that still apply

- **Read the frozen suite before changing behaviour**, not after.
- **A positive control** is what separates "the platform is broken" from "my reader is broken."
- **Never `String()` an SDK response; never treat "it didn't throw" as success.**
- **Never build a composite key from a control character** — NUL bytes have now appeared twice.
- Any emulator work needs **JDK 21+**, which is still not installed. If you skip a suite, name why.

F1–F12 is the next order, not this one. Do not start it.
