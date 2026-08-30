---
order:    0038
to:       firebase
issued:   2026-08-28
blocking: yes
---

# The comparison is closed. You are the product now. Build the vertical slice.

Decision 0001 is on the shared branch: **Firebase coordinates, git stores.** The user chose it on
the scoreboard, and the reason was yours — **you are the only route with a push subscriber.** 191 ms
against ~5 s and ~8.5 s polls is the difference between a dashboard that feels live and one that
refreshes.

Catalyst and route G stop competing. Route G's git blackboard becomes your durable layer, so its
work ships rather than losing.

## Stop measuring. Start building.

**No more G-series runs. F1–F12 is not the next thing either.** The next thing is a working loop.

### The vertical slice, and nothing wider

One agent claims a task, appends an event, and **the dashboard shows it move without a refresh.**
That single path proves the store, the subscriber, the dashboard wiring and the file contract at
once. Everything else waits.

1. **Consolidate onto the shared branch.** Bring your adapter across as
   `client/src/store/firebase.ts` and take **step 9** — the one-line store import in
   `client/src/App.tsx`. Both are per-build territory and yours to change. `components.tsx`,
   `tokens.css` and `store/types.ts` stay frozen: the dashboard must still render identically.
2. **Wire `store.freshness` honestly.** `mode:'live'` gets a steady dot and no counter. You have a
   real listener push, so this is the one place your route legitimately differs from the design's
   poll fallback — do not hardcode it, read it from the store.
3. **Build the minimal CLI bridge.** Only what the slice needs: drain `.agentic/outbox.jsonl` from
   `outbox.cursor`, publish via the store, advance the cursor **after** the publish succeeds. Append
   inbox lines for contract and coordination layers. **Human-layer events never reach `inbox.jsonl`**
   — that exclusion is the whole reason agents stay coherent over a long session.
4. **Prove it end to end** with a real agent-shaped writer: `echo` a JSON line into
   `outbox.jsonl`, and watch the card move in the browser.

### Carry these forward — they are production code now

- **Git operations get a deadline.** Route G found `git send-pack` wedging with no timeout: a daemon
  would sit on it forever, appear healthy, and publish nothing. Any git you shell out to gets a
  bounded retry and a counter.
- **Never sleep on an injected clock in a transport path.** Route G's retry slept on a `FakeClock`
  nobody advanced, so one transient socket error hung the run forever. Injected clocks are for
  staleness derivation and the reaper, never for a socket.
- **Never hand-walk or stringify an SDK response, and never treat "it didn't throw" as success.**
  Four bugs of that family across this project, three of which looked exactly like platform defects.
- **A positive control is what separates "the platform is broken" from "my reader is broken."** They
  are the same observation without one.

## Two things you owe that are now product bugs, not comparison rows

1. **Presence costs 1 read + 1 write per heartbeat — 48% of the daily write allowance at 10 agents.**
   That was an asymmetry; it is now **your ceiling**, and it is the worst part of the chosen design.
   Catalyst reached zero UPDATEs by making TTL expiry *itself* the staleness signal. Look at whether
   anything equivalent is available to you. If not, say so and record the ceiling.
2. **Your 1,955 ms contended figure is unvalidated** and may carry the same inflation as the
   unexplained 1,167 ms uncontended anomaly. Now it matters for a different reason: it is how long a
   user waits when two agents want the same task.

## Territory

`docs/**`, `shared/**`, `components.tsx`, `tokens.css`, `store/types.ts` stay frozen. Your adapter,
your `App.tsx` import line, your `package.json` deps, and the new CLI are yours. `docs/results/**`
and `docs/orders/**` remain coordinator-only.

Credentials by path only: `~/.config/multiplayer-agents/firebase-adminsdk.json`, never in the tree,
never in a commit, never in a report.

Report the slice working, or the first place it doesn't.
