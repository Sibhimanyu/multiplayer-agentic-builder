// The CoordinationStore contract. Mirrors docs/reference/store-interface.md.
//
// This file is the seam. Nothing above it may import a backend SDK, and nothing
// below it may leak a backend error type. Three adapters implement it:
// shared/store/memory.ts, shared/store/catalyst.ts, shared/store/firebase.ts.
//
// The view types here are a superset of client/src/store/types.ts: they carry the
// display-only fields the dashboard needs (initials, project_name, repo_url) so a
// Snapshot from this file is assignable to the client's Snapshot without a mapper.

export type ProjectId = string; // proj_<slug>
export type AgentId = string; // agent_<8 hex>
export type TaskId = string; // task_<slug>
export type Seq = number; // monotonic, ascending, gaps permitted

export const PROTOCOL_VERSION = '0.2';

export type Layer = 'contract' | 'coordination' | 'human';

export type ContractEventKind =
  | 'schema_published' | 'contract_published' | 'contract_superseded'
  | 'decision_recorded' | 'scope_locked' | 'scope_released' | 'task_unblocked';

export type CoordinationEventKind =
  | 'task_claimed' | 'task_completed' | 'task_blocked'
  | 'branch_pushed' | 'pr_opened' | 'ci_passed' | 'ci_failed' | 'merged';

/** Dashboard only. Delivering these to an agent is a protocol violation. */
export type HumanEventKind = 'agent_heartbeat' | 'task_progress';

export type EventKind = ContractEventKind | CoordinationEventKind | HumanEventKind;

/** The layer of a kind is a fact about the kind, not a caller-supplied field. */
export const LAYER_OF: Record<EventKind, Layer> = {
  schema_published: 'contract', contract_published: 'contract',
  contract_superseded: 'contract', decision_recorded: 'contract',
  scope_locked: 'contract', scope_released: 'contract', task_unblocked: 'contract',
  task_claimed: 'coordination', task_completed: 'coordination', task_blocked: 'coordination',
  branch_pushed: 'coordination', pr_opened: 'coordination',
  ci_passed: 'coordination', ci_failed: 'coordination', merged: 'coordination',
  agent_heartbeat: 'human', task_progress: 'human',
};

export type ActorType = 'owner' | 'member' | 'agent' | 'github' | 'system';

export interface Event {
  event_id: string;
  project_id: ProjectId;
  seq: Seq;
  layer: Layer;
  kind: EventKind;
  actor_type: ActorType;
  actor_id: string;
  created_at: string; // RFC3339, server clock
  /** For contract-layer events this is a POINTER, never the content. */
  body: Record<string, unknown>;
}

/** What a caller supplies. seq, event_id, created_at and project_id are server-assigned. */
export type EventInput = Omit<Event, 'event_id' | 'seq' | 'created_at' | 'project_id'>;

export type TaskKind = 'frontend' | 'backend' | 'qa' | 'docs' | 'devops';

export type TaskStatus =
  | 'open' | 'claimed' | 'in_progress' | 'blocked'
  | 'needs_review' | 'pr_open' | 'merged' | 'done' | 'cancelled';

export type AgentStatus =
  | 'connected' | 'idle' | 'working' | 'blocked' | 'reviewing' | 'offline' | 'revoked';

export type CiStatus = 'passed' | 'failed' | 'pending' | null;

export interface TaskView {
  task_id: TaskId; title: string; kind: TaskKind; status: TaskStatus;
  description?: string;
  claimed_by: AgentId | null;
  branch: string | null; pr_url: string | null; pr_number: number | null;
  ci: CiStatus;
  depends_on: TaskId[]; blocked_by: TaskId | null; blocked_reason: string | null;
  blocked_since?: string | null;
  file_scope: string[]; // globs
  updated_at: string;
}

export interface AgentPresence {
  agent_id: AgentId; role_slug: string; member_label: string; initials: string;
  harness: 'claude-code' | 'codex' | 'manual';
  status: AgentStatus;
  current_task: TaskId | null; branch: string | null;
  last_heartbeat_at: string | null;
  /** Derived at read time from last_heartbeat_at. Never stored. */
  stale: boolean;
}

export interface ScopeLock {
  agent_id: AgentId; task_id: TaskId; globs: string[]; acquired_at: string;
}

export interface ContractPointer {
  name: string; // "items-api"
  version: number; // 2
  path: string; // "contracts/items-api.v2.yaml"
  commit_sha: string; // 40 hex, pins an immutable blob
  supersedes: number | null;
  published_by: AgentId; published_at: string;
  /** Optional inlined preview for the detail panel. Fetched from the CDN by sha. */
  preview?: string;
}

export interface Snapshot {
  project_id: ProjectId;
  seq: Seq; // highest event seq folded into this snapshot
  generated_at: string;
  project_name: string; repo_url: string;
  tasks: TaskView[]; agents: AgentPresence[];
  locks: ScopeLock[]; contracts: ContractPointer[];
}

/**
 * The one honest place the two builds differ. Read it, never hardcode.
 * poll -> render "updated {n}s ago";  live -> steady dot, no counter.
 */
export interface Freshness { mode: 'poll' | 'live'; stale_ms: number; }

export interface AppendResult { event_id: string; seq: Seq; duplicate: boolean }
export type ClaimResult =
  | { ok: true }
  | { ok: false; owner: AgentId; claimed_at: string };
export type ScopeResult = { ok: true } | { ok: false; conflicts: ScopeLock[] };
export interface SnapshotRead { snapshot: Snapshot; etag: string }

/** Hard caps. Exceeding one is logged, never silently truncated. */
export const LIMITS = { events: 300, presence: 100, locks: 200 } as const;

/** Default staleness timeout for AgentPresence.stale, in ms. */
export const STALE_AFTER_MS = 90_000;

/** A stale claim past this is released by the reaper. */
export const CLAIM_TIMEOUT_MS = 15 * 60_000;

export interface CoordinationStore {
  readonly freshness: Freshness;

  // ---- ledger ----------------------------------------------------------
  /**
   * Append one event. Idempotent on idempotency_key: a repeat returns the
   * ORIGINAL {event_id, seq} and appends nothing. Never mutates or deletes.
   */
  appendEvent(
    project_id: ProjectId,
    event: EventInput,
    idempotency_key: string,
  ): Promise<AppendResult>;

  /** Ascending by seq. `limit` defaults to 300 and is capped at 300. */
  readEvents(
    project_id: ProjectId,
    since_seq: Seq,
    limit?: number,
  ): Promise<{ events: Event[]; next_cursor: Seq; has_more: boolean }>;

  // ---- claims (atomic) -------------------------------------------------
  /** Atomic. Exactly one concurrent caller wins. A loss is not an error. */
  claimTask(project_id: ProjectId, task_id: TaskId, agent_id: AgentId): Promise<ClaimResult>;

  /** Idempotent. Releasing a task you do not own is a no-op, not an error. */
  releaseTask(project_id: ProjectId, task_id: TaskId, agent_id: AgentId): Promise<void>;

  // ---- file scope locks ------------------------------------------------
  /** Server-enforced, not advisory. Rejects on glob intersection, names conflicts. */
  acquireScope(
    project_id: ProjectId, agent_id: AgentId, task_id: TaskId, globs: string[],
  ): Promise<ScopeResult>;

  releaseScope(project_id: ProjectId, agent_id: AgentId): Promise<void>;

  // ---- presence --------------------------------------------------------
  /** MUST NOT cost a durable row UPDATE per call. See store-interface.md. */
  heartbeat(
    project_id: ProjectId, agent_id: AgentId, status: AgentStatus,
    current_task?: TaskId | null, branch?: string | null,
  ): Promise<void>;

  listPresence(project_id: ProjectId): Promise<AgentPresence[]>;

  // ---- read + notify ---------------------------------------------------
  /** Cheap folded read. Returns null when etag matches (a 304 equivalent). */
  readSnapshot(project_id: ProjectId, etag?: string): Promise<SnapshotRead | null>;

  /**
   * Fires once immediately with current state, then on every change past
   * from_seq. Returns an unsubscribe function. Survives transient network loss.
   */
  subscribe(project_id: ProjectId, from_seq: Seq, onChange: (s: Snapshot) => void): () => void;
}
