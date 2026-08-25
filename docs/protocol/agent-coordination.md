# Agent Coordination Protocol

Version `0.2`. Supersedes `0.1`.

## What changed from 0.1, and why

| 0.1 | 0.2 | Reason |
|---|---|---|
| 11 activity-shaped event types | 3 layers, agents see only 2 | `task_progress` prose is worthless to an agent and costs context. Context pollution from intermediate traces measurably degrades long-horizon agent performance. |
| `contract_published` carried an OpenAPI payload | carries a **pointer** `{path, commit_sha, version}` | Catalyst `text` caps at 10,000 chars, silently mangles emoji, and gives no diff. Git gives all three for free. |
| `seq` monotonic per project | monotonic ascending, gaps legal | Catalyst has no sequence primitive. `ROWID` is global-monotonic, which is strictly stronger than needed. |
| "claim task only if status == open" | atomic insert against a unique column | Data Store has no transactions and no compare-and-set. Read-verify-write stays racy. |
| overlapping file scope → dashboard warning | server-enforced lock, rejected at claim time | A warning nobody reads, discovered at merge. Detected at claim costs seconds; at merge it costs a rebase. |
| polling 5s everywhere | see `store-interface.md` `subscribe` | Reads move off the most expensive primitive on the platform. |
| Signals as the future push mechanism | removed | Signals targets are Webhook, Function, or Circuit only. There is no browser or CLI target, so it can never reach a dashboard or a laptop behind NAT. |

## Core rule, unchanged

Agents do not message each other. They append facts to a shared ledger and read their inbox.
No agent-to-agent RPC. Not A2A — that is delegation-centric and requires agents to be
addressable network services; these are local processes behind NAT.

```
  agent A ──► ledger ──► agent B
  GitHub  ──► ledger ──► both
```

## Three layers

Every event carries a `layer`. The layer decides **who receives it**.

### Contract layer — agents subscribe. This is the payload that matters.

| Kind | Body |
|---|---|
| `schema_published` | `{ name, path, commit_sha }` |
| `contract_published` | `{ name, version, path, commit_sha, supersedes }` |
| `contract_superseded` | `{ name, old_version, new_version, breaking, migration_note }` |
| `decision_recorded` | `{ path, commit_sha, title, affects_tasks[] }` |
| `scope_locked` | `{ agent_id, task_id, globs[] }` |
| `scope_released` | `{ agent_id, task_id }` |
| `task_unblocked` | `{ task_id, was_blocked_by, reason_resolved }` |

`path` + `commit_sha` point into the git blackboard. Content is never in the event.
See `docs/reference/blackboard.md`.

### Coordination layer — agents subscribe.

| Kind | Body |
|---|---|
| `task_claimed` | `{ task_id, agent_id, role_slug }` |
| `task_completed` | `{ task_id, agent_id }` |
| `task_blocked` | `{ task_id, reason, blocked_by_task_id }` |
| `branch_pushed` | `{ branch, commit, task_id }` |
| `pr_opened` | `{ task_id, pr_number, pr_url, branch }` |
| `ci_passed` / `ci_failed` | `{ task_id, pr_number, check_name, details_url }` |
| `merged` | `{ task_id, pr_number, commit }` |

The last five originate from the GitHub webhook, `actor_type: 'github'`.

### Human layer — dashboard only. NEVER delivered to an agent.

| Kind | Body |
|---|---|
| `agent_heartbeat` | `{ status, task_id, branch, harness }` |
| `task_progress` | `{ task_id, summary, files_changed[] }` |

**This exclusion is normative.** An agent subscription that includes the human layer is a
protocol violation. It is the single most important rule in this document: it is what keeps
agents sharp over a long session instead of drowning in each other's status updates.

## What agents share, and what they do not

| Share — high value, low volume | Do not share — low value, high volume |
|---|---|
| API contract: endpoint, request, response, version | progress narration |
| Data schema: table, columns, types | agent reasoning or chain of thought |
| File-scope lock: who owns which paths | full file contents — git already has them |
| Task state transitions: done, blocked | questions to each other — route to the human |
| Decision plus rationale | retry and error chatter |
| Blocking failure that changed the plan | heartbeats — infra signal, not semantics |

## Task state machine

```
  open ──► claimed ──► in_progress ──┬──► needs_review ──► pr_open ──► merged ──► done
                            │        │
                            └► blocked
                                     └► cancelled
```

- `open → claimed` requires an atomic claim. See `claimTask` in `store-interface.md`.
- `claimed → in_progress` on first local work.
- `in_progress → blocked` requires a reason and, where known, `blocked_by_task_id`.
- `needs_review → pr_open` on the GitHub webhook, not on agent assertion.
- `pr_open → merged` on the GitHub webhook.
- `merged → done` automatic, or owner-confirmed.

## Agent session state

```
  connected ──► idle ⇄ claiming ⇄ working ⇄ blocked ⇄ reviewing ──► offline
                                                                    revoked
```

`stale` is **derived at read time** from `last_heartbeat_at` against a 90s default timeout.
Never stored. Heartbeats must not cost a durable row update — see `heartbeat` in
`store-interface.md`.

## Envelope

```json
{
  "event_id": "evt_01J9X2",
  "project_id": "proj_inventory",
  "seq": 4211,
  "layer": "contract",
  "kind": "contract_published",
  "actor_type": "agent",
  "actor_id": "agent_backend_1",
  "created_at": "2026-08-25T09:41:02.881Z",
  "protocol_version": "0.2",
  "body": {
    "name": "items-api", "version": 2,
    "path": "contracts/items-api.v2.yaml",
    "commit_sha": "a3f9c1e0d4b28f6712c9ab3e5580f1d2c7e46a9b",
    "supersedes": 1
  }
}
```

Reject an unsupported **major** version. Accept additive fields within a minor.

## Conflict handling

**Task claim.** Atomic, exactly one winner. The loser receives `{ok:false, owner}` and picks
another task. This is a normal outcome, not an error, and must not be logged as one.

**File scope.** Rejected at claim time on glob intersection with a live lock held by another
agent. Server-enforced. The response names the conflicting agent and globs so the caller can
choose a different task without a round trip to a human.

**Stale claim.** A Cron reaper releases claims whose owning agent has been stale beyond
`claim_timeout`, default 15 minutes, and appends `task_unblocked`. Without this a dead laptop
holds a task forever.

## Read-your-own-writes

An agent that appends and receives `seq = N` may immediately read a snapshot reporting
`seq < N`, because snapshot publication is debounced.

**That is stale, not lost.** The agent MUST track `last_written_seq` locally and treat
`snapshot.seq < last_written_seq` as "not yet folded". It MUST NOT retry the append.
Retrying here is the most likely source of duplicate events in the whole system.

## Security

- Invite codes are project-scoped and short-lived.
- Agent tokens are role-scoped and revocable. The server resolves
  `token → agent_id → project_id → role → permissions` on **every** request.
  `agent_id` is never accepted from the client.
- Agents may push branches and open PRs. Agents may **not** merge.
- Only the integrator role may hold merge permission, and only when the owner grants it.
- The webhook verifies the GitHub HMAC over the **raw** body bytes with a timing-safe compare.
- Every project, role, task and agent relationship is verified server-side.

## Sanitisation

Strip emoji and 4-byte UTF-8 from all durable text before write, in both implementations.
Catalyst Data Store silently stores them as `?`; Firestore does not. Both must behave
identically or the comparison is invalid. Shared helper: `shared/sanitize.ts`.
