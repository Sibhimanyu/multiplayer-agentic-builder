# Acceptance Checklist

**Identical bar for both builds.** If the two implementations are not measured against exactly
this list, the comparison is worthless — you would be comparing two interpretations, not two
platforms.

Each item is pass/fail with stated evidence. "Looks right" is not evidence.

## A. Store interface conformance

Run the same suite against all three adapters: `memory`, `catalyst`, `firebase`.

| # | Test | Evidence |
|---|---|---|
| A1 | Same `idempotency_key` twice → same `seq`, `duplicate:true`, ledger grew by 1 | assertion |
| A2 | 20 concurrent `claimTask` on one task → exactly 1 `{ok:true}` | assertion, repeated 50x |
| A3 | Losing claimant receives `{ok:false, owner}`, not a thrown error | assertion |
| A4 | `readEvents` returns strictly ascending `seq` | assertion |
| A5 | `readEvents` caps at 300 even when asked for 1000, and logs the cap | assertion + log line |
| A6 | Appended event is never mutated or deleted by any later operation | assertion |
| A7 | `acquireScope` rejects intersecting globs and names the conflicts | assertion |
| A8 | `acquireScope` allows disjoint globs concurrently | assertion |
| A9 | `AgentPresence.stale` flips true after the 90s timeout with no heartbeat | fake clock |
| A10 | `subscribe` fires once immediately before any change | assertion |
| A11 | `subscribe` survives a simulated network drop and resumes from cursor | assertion |
| A12 | Emoji in durable text is stripped identically in all three adapters | assertion |
| A13 | Snapshot reporting `seq < last_written_seq` does **not** trigger a re-append | assertion |
| A14 | Revoked token → `StoreAuthError`, and the CLI stops rather than retrying | assertion |
| A15 | Rate-limited backend → `StoreBusyError` and jittered backoff, no tight loop | assertion |

## B. CLI

| # | Test | Evidence |
|---|---|---|
| B1 | `connect <invite>` writes `AGENTS.md` + full `.agentic/` tree | `ls` output |
| B2 | Generated tree matches `agentic-file-contract.md` byte-for-byte across both builds | `diff` of the two trees |
| B3 | `claim` on a taken task exits 0 with "owned by X", not an error | exit code + stdout |
| B4 | `report "msg"` appends one line to `outbox.jsonl` and nothing else | file diff |
| B5 | Outbox payload over 4 KiB goes to `outbox.d/` as one file, not appended | `ls outbox.d/` |
| B6 | Kill the CLI mid-publish → unsent lines re-send on restart, no duplicates in ledger | ledger count |
| B7 | Network down → agent keeps working, outbox grows, cursor unmoved | file sizes |
| B8 | Human-layer events never appear in `inbox.jsonl` | grep returns empty |
| B9 | `body.local` is populated and the file exists before the inbox line is appended | assertion |
| B10 | `status` prints freshness mode from `store.freshness`, not a hardcoded string | stdout |

## C. Git blackboard

| # | Test | Evidence |
|---|---|---|
| C1 | Agent writes `contracts/items-api.v2.yaml`, appends event; CLI commits, pushes, rewrites body as pointer | `git log` + event body |
| C2 | Published event body contains `commit_sha`, never the contract content | event JSON |
| C3 | Two agents publish two different contracts concurrently → both land, zero conflicts | `git log` |
| C4 | Push rejection triggers `pull --rebase` + retry, succeeds within 3 attempts | log |
| C5 | Consumer fetches the blob via sha-pinned CDN URL, not `git fetch` | network trace |
| C6 | v1 file is untouched after v2 is published | `git diff` empty for v1 |
| C7 | Agent never sees a commit sha in `.agentic/` | grep |

## D. Webhook

| # | Test | Evidence |
|---|---|---|
| D1 | Valid HMAC over the **raw** body verifies | assertion |
| D2 | Tampered body is rejected | assertion |
| D3 | Comparison is timing-safe, not `===` | code review + test |
| D4 | Replayed `X-GitHub-Delivery` appends nothing the second time | ledger count |
| D5 | `push`, `pull_request opened/synchronize/closed`, `check_suite completed` each map to the right event kind | 5 assertions |
| D6 | Unmappable repo → logged and dropped, never a 500 | log + status code |

## E. Dashboard

| # | Test | Evidence |
|---|---|---|
| E1 | Six columns match the task state machine | screenshot |
| E2 | Blocked agent identifiable in under 3 seconds by a first-time viewer | timed, 3 people |
| E3 | Detail panel **overlays**, never displaces columns; all six reachable while open | screenshot scrolled |
| E4 | Freshness indicator reads from `store.freshness` — "updated Ns ago" in poll mode, live dot in live mode | both screenshots |
| E5 | Empty column shows the dashed empty state, not a blank | screenshot |
| E6 | 47-char task title and a 90-char file path both truncate readably | screenshot |
| E7 | CI-failed badge visible without opening the card | screenshot |
| E8 | Design tokens match `docs/designs/dashboard.md` exactly | token diff |
| E9 | No layout shift when a poll returns new data | video or CLS metric |

## F. The demo — Inventory Tracker

Run identically on both. This is the headline result.

| # | Step | Evidence |
|---|---|---|
| F1 | Owner creates the project and connects the repo | screenshot |
| F2 | Owner invites 3 builders, assigns architect / backend / frontend | screenshot |
| F3 | Each builder runs `connect` then `start` on a separate machine or worktree | 3 terminals |
| F4 | Architect publishes schema + `items-api v1`, then exits | `git log` |
| F5 | Backend and frontend claim concurrently; no double-claim | ledger |
| F6 | Backend publishes `items-api v2` (breaking: qty string→integer) | `git log` |
| F7 | Frontend receives the pointer, reads the contract from disk, reports blocked | `inbox.jsonl` + ledger |
| F8 | Backend pushes a branch, opens a PR; webhook updates the board | screenshot |
| F9 | CI fails; board shows the badge without a refresh | screenshot |
| F10 | Owner merges on GitHub; board reaches `merged` | screenshot |
| F11 | Kill the frontend agent's laptop; reaper releases the claim within 15 min | ledger |
| F12 | Another agent claims the released task successfully | ledger |

## G. Measurements — the actual comparison

Record real numbers. These are the point of building both.

| # | Metric | How |
|---|---|---|
| G1 | Publish→visible latency, p50 and p95 | 100 contract publishes, timestamp both ends |
| G2 | Claim round-trip, p50 and p95 | 200 claims |
| G3 | Wall-clock cost of the full F1–F12 demo | stopwatch |
| G4 | Backend operations consumed by one 8-hour session, 3 agents | provider console |
| G5 | Extrapolated monthly cost at 2 people and at 10 people | G4 × provider rates |
| G6 | Free-tier headroom remaining after the demo | provider console |
| G7 | Lines of code in the adapter | `wc -l` |
| G8 | Total build hours | honest log |
| G9 | Every platform constraint hit, with the workaround | written list |
| G10 | Would you choose this again? One paragraph, written before seeing the other build's number | prose |

## H. Non-negotiables

Fail any of these and the build is not done, regardless of everything else.

- [ ] No silent failure anywhere. Every dropped, capped or truncated thing is logged.
- [ ] No catch-all error handling. Every caught error is named and handled or rethrown.
- [ ] Agents cannot merge. Verified by attempting it.
- [ ] `agent_id` is never accepted from the client. Verified by forging one.
- [ ] Concurrent claim test A2 passes 50 consecutive runs.
- [ ] Both `.agentic/` trees are byte-identical (B2).
- [ ] Both builds pass the same suite with only the adapter swapped.
- [ ] Every capped list logs what it dropped.
- [ ] Emoji behaviour is identical across adapters.
- [ ] `G10` written independently, before comparing.
