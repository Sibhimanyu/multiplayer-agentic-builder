// Mirror of docs/reference/store-interface.md. Both builds implement CoordinationStore.
// Nothing in components/ may import a backend SDK. If it does, the seam has leaked.

export type ProjectId = string;
export type AgentId = string;
export type TaskId = string;
export type Seq = number;

export type Layer = 'contract' | 'coordination' | 'human';

export type TaskStatus =
  | 'open' | 'claimed' | 'in_progress' | 'blocked'
  | 'needs_review' | 'pr_open' | 'merged' | 'done' | 'cancelled';

/** Board column order. Mirrors the task state machine. done/cancelled are not columns. */
export const COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: 'open',         label: 'Open' },
  { status: 'claimed',      label: 'Claimed' },
  { status: 'in_progress',  label: 'In progress' },
  { status: 'needs_review', label: 'Needs review' },
  { status: 'pr_open',      label: 'PR open' },
  { status: 'merged',       label: 'Merged' },
];

export type TaskKind = 'frontend' | 'backend' | 'qa' | 'docs' | 'devops';
export type AgentStatus =
  | 'connected' | 'idle' | 'working' | 'blocked' | 'reviewing' | 'offline' | 'revoked';

export interface TaskView {
  task_id: TaskId; title: string; kind: TaskKind; status: TaskStatus;
  description?: string;
  claimed_by: AgentId | null;
  branch: string | null; pr_url: string | null; pr_number: number | null;
  ci: 'passed' | 'failed' | 'pending' | null;
  depends_on: TaskId[]; blocked_by: TaskId | null; blocked_reason: string | null;
  blocked_since?: string | null;
  file_scope: string[];
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

export interface ScopeLock { agent_id: AgentId; task_id: TaskId; globs: string[]; acquired_at: string; }

export interface ContractPointer {
  name: string; version: number; path: string; commit_sha: string;
  supersedes: number | null; published_by: AgentId; published_at: string;
  /** Optional inlined preview for the detail panel. Fetched from the CDN by sha, cached. */
  preview?: string;
}

export interface Snapshot {
  project_id: ProjectId; seq: Seq; generated_at: string;
  project_name: string; repo_url: string;
  tasks: TaskView[]; agents: AgentPresence[];
  locks: ScopeLock[]; contracts: ContractPointer[];
}

/**
 * The one honest place the two builds differ. Read it, never hardcode.
 * poll  -> render "updated {n}s ago"
 * live  -> render a steady live dot, no counter
 */
export interface Freshness { mode: 'poll' | 'live'; stale_ms: number; }

export interface CoordinationStore {
  readonly freshness: Freshness;
  /** Fires once immediately with current state, then on every change. */
  subscribe(project_id: ProjectId, from_seq: Seq, onChange: (s: Snapshot) => void): () => void;
}
