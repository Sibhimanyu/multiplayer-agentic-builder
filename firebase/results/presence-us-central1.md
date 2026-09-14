# Presence on RTDB — observed. Order 0046

> **REGION: `us-central1`.** RTDB instance in `us-central1`, client in Asia/Kolkata. **CROSS-REGION.**
>
> **No figure on this page may appear in a row with a Firestore number.** Every other latency
> figure in this project is same-region by construction — Firestore `asia-south1`, client
> Asia/Kolkata, deliberately best-case. These are not. Decision 0003 accepted the mismatch
> knowingly, because RTDB bills **bandwidth, not distance**, so the cost conclusion is unaffected.

Reproduce: `node firebase/presence-live.mjs 60`

## Observed latency — `us-central1`, cross-region

| operation | n | p50 | p95 | max |
| --- | --- | --- | --- | --- |
| `heartbeat` write to RTDB | 60 | **292 ms** | 356 ms | 1,525 ms |

Presence is not latency-critical: the visible effect is an avatar ring settling a few hundred ms
after a card moves. The card itself moves on the Firestore path, which is unchanged.

## The payload, measured rather than computed

Entry 56 assumed **171 B** per presence record, from `JSON.stringify`. The observed record, read
over the wire via the RTDB REST endpoint with the server's own `content-length`:

```
164 B   content-length: 164
{"agent_id":"agent_pl01","branch":"feat/items-crud-handlers","connected":true,
 "current_task":"task_items_crud","last_heartbeat_ms":1789369640370,"status":"working"}
```

**164 B observed, against 171 B assumed** — the arithmetic was 4% high.

## Monthly bandwidth, re-derived from the observed payload

30 s beat (`HEARTBEAT_INTERVAL_MS`), 30-day month.

| agents | dashboards | download/month | % of 10 GB/mo free tier |
| --- | --- | --- | --- |
| 2 | 1 | 27.0 MiB | 0.3% |
| 2 | 5 | 135.1 MiB | 1.3% |
| **10** | **1** | **135.1 MiB** | **1.3%** |
| 10 | 5 | 675.7 MiB | 6.6% |

**Entry 56's 1.4% holds: the observed figure is 1.3%.** The estimate was slightly conservative,
which is the direction an estimate should err.

**What is still arithmetic, stated plainly.** The *payload* is now observed; the *multiplier*
(beats × listeners × days) is not, and websocket protocol framing is not in it — a REST body is not
a websocket frame. So treat 1.3% as a **floor**. The conclusion survives a very large multiple: it
would take roughly 75× this volume to exhaust the allowance, and the same workload is over
Firestore's daily write cap.

## Both presence signals, exercised

`onDisconnect` was fired for real by dropping the socket (`goOffline()`), not simulated:

| signal | source | observed |
| --- | --- | --- |
| `stale` | derived, `last_heartbeat_at` + 90 s | stayed **false** across the disconnect |
| `offline` | RTDB `onDisconnect`, server-side | `connected:false` written by the **server** |

That separation is the whole reason presence is on RTDB. A dropped socket is reported by the
platform within seconds; `stale` remains a derivation over the adapter's clock, which is what keeps
conformance A9 passing under a fake clock. Two signals, different meanings, neither standing in for
the other.

**`onDisconnect` has no Firestore equivalent.** It is the one capability that could not be built on
the coordination substrate.
