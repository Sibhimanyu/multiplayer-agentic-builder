# Coordination Store Interface

This is the contract both implementations must satisfy. Ten operations. Nothing else in the
system may talk to a backend directly.

The Catalyst build and the Firebase build implement this file and nothing more. Everything
above it (CLI, dashboard, webhook logic, protocol) is shared and written once.

## Design rule

`subscribe` expresses **"notify me when this changes"**, not "poll" or "listen". Catalyst
implements it as a poll loop over `readSnapshot`; Firestore implements it as `onSnapshot`.
Callers must never know which.

Do **not** hide the freshness difference. Expose it as metadata so the dashboard can render
honestly, see `freshness` below.

## Types

```ts
type ProjectId = string;   // proj_<slug>
type AgentId   = string;   // agent_<8 hex>
type TaskId    = string;   // task_<slug>
type Seq       = number;   // monotonic, ascending, gaps permitted

type EventKind =
  // contract layer — agents subscribe, this is the payload that matters
  | 'schema_published' | 'contract_published' | 'contract_superseded'
  | 'decision_recorded' | 'scope_locked' | 'scope_released' | 'task_unblocked'
  // coordination layer — agents subscribe
  | 'task_claimed' | 'task_completed' | 'task_blocked'
  | 'branch_pushed' | 'pr_opened' | 'ci_passed' | 'ci_failed' | 'merged'
  // human layer — dashboard ONLY, never delivered to an agent
  | 'agent_heartbeat' | 'task_progress';

type Layer = 'contract' | 'coordination' | 'human';

interface Event {
  event_id:   string;
  project_id: ProjectId;
  seq:        Seq;
  layer:      Layer;
  kind:       EventKind;
  actor_type: 'owner' | 'member' | 'agent' | 'github' | 'system';
  actor_id:   string;
  created_at: string;          // RFC3339, server clock
  // For contract-layer events this is a POINTER, never the content.
  // See docs/reference/blackboard.md
  body: Record<string, unknown>;
}

interface Snapshot {
  project_id: ProjectId;
  seq:        Seq;             // highest event seq folded into this snapshot
  generated_at: string;
  tasks:      TaskView[];
  agents:     AgentPresence[];
  locks:      ScopeLock[];
  contracts:  ContractPointer[];
}

interface TaskView {
  task_id: TaskId; title: string; kind: 'frontend'|'backend'|'qa'|'docs'|'devops';
  status: 'open'|'claimed'|'in_progress'|'blocked'|'needs_review'|'pr_open'|'merged'|'done'|'cancelled';
  claimed_by: AgentId | null;
  branch: string | null; pr_url: string | null; pr_number: number | null;
  ci: 'passed'|'failed'|'pending'|null;
  depends_on: TaskId[]; blocked_by: TaskId | null; blocked_reason: string | null;
  file_scope: string[];        // globs
  updated_at: string;
}

interface AgentPresence {
  agent_id: AgentId; role_slug: string; member_label: string;
  harness: 'claude-code'|'codex'|'manual';
  status: 'connected'|'idle'|'working'|'blocked'|'reviewing'|'offline'|'revoked';
  current_task: TaskId | null; branch: string | null;
  last_heartbeat_at: string | null;
  stale: boolean;              // derived, see heartbeat()
}

interface ScopeLock { agent_id: AgentId; task_id: TaskId; globs: string[]; acquired_at: string; }

interface ContractPointer {
  name: string;                // "items-api"
  version: number;             // 2
  path: string;                // "contracts/items-api.v2.yaml"
  commit_sha: string;          // 40 hex, pins an immutable blob
  supersedes: number | null;
  published_by: AgentId; published_at: string;
}

interface Freshness {
  mode: 'poll' | 'live';
  stale_ms: number;            // worst-case staleness. poll: interval. live: 0
}
```

## The ten operations

```ts
interface CoordinationStore {
  readonly freshness: Freshness;

  // ---- ledger ----------------------------------------------------------
  /**
   * Append one event. MUST be idempotent on idempotency_key: a repeat returns
   * the ORIGINAL {event_id, seq} and appends nothing.
   * Never mutate or delete an appended event.
   */
  appendEvent(
    project_id: ProjectId,
    event: Omit<Event,'event_id'|'seq'|'created_at'|'project_id'>,
    idempotency_key: string,          // uuid v4 from the caller
  ): Promise<{ event_id: string; seq: Seq; duplicate: boolean }>;

  /** Ascending by seq. `limit` MUST default to 300 and MUST be capped at 300. */
  readEvents(
    project_id: ProjectId,
    since_seq: Seq,
    limit?: number,
  ): Promise<{ events: Event[]; next_cursor: Seq; has_more: boolean }>;

  // ---- claims (atomic) -------------------------------------------------
  /**
   * MUST be atomic. Exactly one concurrent caller wins.
   * Loser gets { ok:false, owner } — this is a normal outcome, not an error.
   * Implementations: Catalyst = INSERT into a task_claims table whose task_id
   * column is is_unique, catch the violation. Firestore = runTransaction.
   */
  claimTask(project_id: ProjectId, task_id: TaskId, agent_id: AgentId)
    : Promise<{ ok: true } | { ok: false; owner: AgentId; claimed_at: string }>;

  /** Idempotent. Releasing a task you do not own is a no-op, not an error. */
  releaseTask(project_id: ProjectId, task_id: TaskId, agent_id: AgentId): Promise<void>;

  // ---- file scope locks ------------------------------------------------
  /**
   * Server-enforced, NOT advisory. Reject on glob intersection with a live lock
   * held by a different agent and return the conflicts.
   * A dashboard warning is not sufficient — see docs/protocol/agent-coordination.md.
   */
  acquireScope(project_id: ProjectId, agent_id: AgentId, task_id: TaskId, globs: string[])
    : Promise<{ ok: true } | { ok: false; conflicts: ScopeLock[] }>;

  releaseScope(project_id: ProjectId, agent_id: AgentId): Promise<void>;

  // ---- presence --------------------------------------------------------
  /**
   * MUST NOT cost a durable row UPDATE per call. Catalyst free tier allows only
   * 1,000 Data Store UPDATEs per MONTH — a 20s heartbeat exhausts that in 5.6 hours.
   * Catalyst: Cache PUT with a TTL; expiry of the key IS the staleness signal.
   * Firestore: a field write on the agent doc.
   */
  heartbeat(project_id: ProjectId, agent_id: AgentId,
            status: AgentPresence['status'],
            current_task?: TaskId | null, branch?: string | null): Promise<void>;

  listPresence(project_id: ProjectId): Promise<AgentPresence[]>;

  // ---- read + notify ---------------------------------------------------
  /**
   * Cheap, high-frequency read of folded state.
   * Catalyst: signed Stratus GET of snapshot.json with cache-control + ETag.
   * Firestore: local cache view.
   * Return null when etag matches (HTTP 304 equivalent).
   */
  readSnapshot(project_id: ProjectId, etag?: string)
    : Promise<{ snapshot: Snapshot; etag: string } | null>;

  /**
   * Invoke onChange whenever project state advances past `from_seq`.
   * MUST fire once immediately with current state, then on every change.
   * Returns an unsubscribe function. MUST survive transient network loss.
   */
  subscribe(project_id: ProjectId, from_seq: Seq,
            onChange: (s: Snapshot) => void): () => void;
}
```

## Mandatory behaviours

Both implementations MUST satisfy all of these. `docs/how-to/acceptance-checklist.md` tests them.

1. **Idempotent append.** Same `idempotency_key` twice returns the same `seq` with
   `duplicate: true`, and the ledger grows by one, not two.
2. **Exactly-one claim.** N concurrent `claimTask` calls for one task produce exactly one
   `{ok:true}`. Verified by test, not by inspection.
3. **Append-only ledger.** No operation mutates or removes an existing event.
4. **Ascending seq.** `readEvents` returns strictly ascending `seq`. Gaps are legal;
   reordering is not.
5. **Read-your-own-writes tolerance.** A caller that appends and receives `seq = N` may then
   read a snapshot reporting `seq < N`. That is **stale, not lost**. The caller MUST NOT
   retry the append. Implementations MUST NOT paper over this.
6. **Scope locks are enforced server-side**, and reject with conflicts.
7. **Staleness is derived, not stored.** `AgentPresence.stale` is computed at read time from
   `last_heartbeat_at` against a configured timeout, default 90s.
8. **No emoji / 4-byte UTF-8 in durable text.** Catalyst Data Store silently stores these as
   `?`. Both implementations MUST strip or reject them on write so behaviour matches.
   Shared helper: `shared/sanitize.ts`.
9. **Cap every list.** `readEvents` at 300, presence at 100, locks at 200. Log what was
   dropped. Never truncate silently.
10. **`subscribe` fires immediately** with current state before any change arrives.

## Error mapping

Callers see these, never backend-specific errors.

| Condition | Throw / return |
|---|---|
| Claim lost | `{ ok:false, owner }` — not an error |
| Scope conflict | `{ ok:false, conflicts }` — not an error |
| Duplicate idempotency key | `{ duplicate:true }` — not an error |
| Agent token revoked | `StoreAuthError` — caller must stop, not retry |
| Backend rate limited | `StoreBusyError` — caller retries with jittered backoff |
| Backend unreachable | `StoreOfflineError` — caller queues to outbox, keeps working |
| Anything else | `StoreError` with the backend message attached |

## Implementations

| | Catalyst (C1 Snapshot) | Firebase (F Firestore) |
|---|---|---|
| `appendEvent` | Advanced I/O fn → Data Store INSERT | Firestore `add()` |
| idempotency | `request_dedupe` table, `is_unique` key column | doc id = idempotency key |
| `readEvents` | ZCQL `ORDER BY ROWID LIMIT o,300` | `orderBy('seq').limit(300)` |
| `seq` source | `ROWID` (auto-increment bigint) | monotonic counter doc or write time |
| `claimTask` | INSERT into `task_claims`, `task_id` is `is_unique` | `runTransaction` |
| `acquireScope` | INSERT + glob check in the function | `runTransaction` |
| `heartbeat` | Cache PUT, TTL 1h — **not** a Data Store UPDATE | field write on agent doc |
| `readSnapshot` | signed Stratus GET, `cache-control: max-age=5`, ETag | local cache read |
| `subscribe` | poll `readSnapshot` every 5s, adaptive backoff to 30s idle | `onSnapshot` |
| snapshot writer | Event fn on Data Store write, debounced 2s leading edge | n/a, no snapshot needed |
| `freshness` | `{ mode:'poll', stale_ms:5000 }` | `{ mode:'live', stale_ms:0 }` |

## Third implementation: memory

`shared/store/memory.ts` is required, not optional. In-process, no network, injectable clock.
It is what the test suite runs against and what `catalyst-builder dev` uses. Write it first —
it is how you find interface mistakes before either cloud build starts.
