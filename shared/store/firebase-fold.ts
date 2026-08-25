// The ledger -> board projection. SHARED between the Catalyst and Firebase builds.
//
// Both adapters fold events into task/contract/lock state, and if they folded it separately
// the bake-off would compare two different state machines wearing the same interface. So the
// reducer lives here, is pure, and both call it. Catalyst runs it in an Event function on
// Data Store write; Firestore runs it inside the same transaction as the append.
//
// Pure and total: no clock, no I/O, no throw. An unknown or out-of-order event is recorded as
// ignored rather than dropped on the floor (non-negotiable H: no silent failure).

import type { ContractPointer, Event, ScopeLock, Snapshot, TaskStatus, TaskView } from './types.ts';
import { LAYER_OF } from './types.ts';

/** The mutable projection an adapter persists. Everything here is derivable from the ledger. */
export interface Projection {
  tasks: Map<string, TaskView>;
  contracts: ContractPointer[];
  /** Keyed by agent_id: releaseScope(agent_id) drops the whole set an agent holds. */
  locks: Map<string, ScopeLock>;
  seq: number;
}

export interface FoldOutcome {
  /** Task ids whose view changed. Lets an adapter write only the docs that moved. */
  touched_tasks: string[];
  /** Why an event changed nothing. Logged, never swallowed. */
  ignored: { seq: number; kind: string; reason: string }[];
}

export function emptyProjection(): Projection {
  return { tasks: new Map(), contracts: [], locks: new Map(), seq: 0 };
}

/**
 * Legal transitions, straight from the state machine in
 * docs/protocol/agent-coordination.md. A transition not listed here is refused and logged
 * rather than applied, so a replayed or out-of-order webhook cannot walk a merged task
 * backwards into pr_open.
 */
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  open: ['claimed', 'cancelled'],
  claimed: ['in_progress', 'blocked', 'open', 'needs_review', 'cancelled'],
  in_progress: ['needs_review', 'blocked', 'open', 'pr_open', 'cancelled'],
  blocked: ['in_progress', 'claimed', 'open', 'cancelled'],
  needs_review: ['pr_open', 'in_progress', 'blocked', 'cancelled'],
  pr_open: ['merged', 'in_progress', 'blocked', 'cancelled'],
  merged: ['done'],
  done: [],
  cancelled: [],
};

const canMove = (from: TaskStatus, to: TaskStatus): boolean =>
  from === to || (TRANSITIONS[from] ?? []).includes(to);

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Apply one event to the projection, in place. Returns what changed and what was refused.
 *
 * The caller is responsible for ordering by seq. Applying out of order is safe (the
 * transition guard refuses the illegal moves) but will log ignores.
 */
export function applyEvent(p: Projection, e: Event): FoldOutcome {
  const touched: string[] = [];
  const ignored: FoldOutcome['ignored'] = [];
  const ignore = (reason: string) => ignored.push({ seq: e.seq, kind: e.kind, reason });

  // The human layer is presence and narration. It never moves the board — that is the whole
  // reason it exists as a separate layer.
  if (LAYER_OF[e.kind] === 'human') {
    if (e.seq > p.seq) p.seq = e.seq;
    return { touched_tasks: [], ignored: [] };
  }

  const b = e.body;
  const taskId = str(b.task_id);
  const task = taskId ? p.tasks.get(taskId) : undefined;

  /** Move a task, guarded by the state machine, and stamp updated_at from the event clock. */
  const move = (t: TaskView, to: TaskStatus, patch: Partial<TaskView> = {}) => {
    if (!canMove(t.status, to)) {
      ignore(`illegal transition ${t.status} -> ${to} for ${t.task_id}`);
      return;
    }
    Object.assign(t, patch, { status: to, updated_at: e.created_at });
    touched.push(t.task_id);
  };

  switch (e.kind) {
    case 'task_claimed': {
      if (!task) { ignore(`unknown task_id ${taskId}`); break; }
      const agent = str(b.agent_id);
      if (!agent) { ignore('task_claimed without agent_id'); break; }
      move(task, 'claimed', { claimed_by: agent });
      break;
    }

    case 'task_blocked': {
      if (!task) { ignore(`unknown task_id ${taskId}`); break; }
      move(task, 'blocked', {
        blocked_reason: str(b.reason),
        blocked_by: str(b.blocked_by_task_id),
        blocked_since: e.created_at,
      });
      break;
    }

    case 'task_unblocked': {
      if (!task) { ignore(`unknown task_id ${taskId}`); break; }
      // A reaper-released claim returns the task to open; an unblocked consumer resumes work.
      const to: TaskStatus = task.claimed_by ? 'in_progress' : 'open';
      move(task, to, {
        blocked_reason: null,
        blocked_by: null,
        blocked_since: null,
        // Released by the reaper: the claim is gone with it.
        claimed_by: to === 'open' ? null : task.claimed_by,
      });
      break;
    }

    case 'task_completed': {
      if (!task) { ignore(`unknown task_id ${taskId}`); break; }
      // An agent asserting "done" means needs_review, not done. Only the webhook merges, and
      // only the owner closes out. Agents cannot merge (non-negotiable H).
      move(task, task.status === 'merged' ? 'done' : 'needs_review');
      break;
    }

    case 'branch_pushed': {
      if (!task) { ignore(`unknown task_id ${taskId}`); break; }
      // Record the branch unconditionally, then attempt the status move separately.
      //
      // These are two different facts and only one of them is guarded. A push against a task
      // still sitting in `open` means its task_claimed has not been folded yet — GitHub
      // delivery order is not guaranteed — and refusing the whole event would throw away the
      // branch name, which is the only link between the task and any later PR or CI event.
      // So: keep the branch, log the transition we declined, leave the status alone.
      task.branch = str(b.branch) ?? task.branch;
      task.updated_at = e.created_at;
      touched.push(task.task_id);
      if (task.status !== 'pr_open') move(task, 'in_progress');
      break;
    }

    case 'pr_opened': {
      if (!task) { ignore(`unknown task_id ${taskId}`); break; }
      move(task, 'pr_open', {
        pr_url: str(b.pr_url),
        pr_number: num(b.pr_number),
        branch: str(b.branch) ?? task.branch,
      });
      break;
    }

    case 'ci_passed':
    case 'ci_failed': {
      if (!task) { ignore(`unknown task_id ${taskId}`); break; }
      // CI is a badge, not a transition: a red check does not move the card out of pr_open.
      task.ci = e.kind === 'ci_passed' ? 'passed' : 'failed';
      task.updated_at = e.created_at;
      touched.push(task.task_id);
      break;
    }

    case 'merged': {
      if (!task) { ignore(`unknown task_id ${taskId}`); break; }
      move(task, 'merged', { pr_number: num(b.pr_number) ?? task.pr_number });
      break;
    }

    case 'scope_locked': {
      const agent = str(b.agent_id);
      const globs = Array.isArray(b.globs) ? b.globs.filter((g): g is string => typeof g === 'string') : [];
      if (!agent || !taskId || globs.length === 0) { ignore('scope_locked missing agent_id, task_id or globs'); break; }
      p.locks.set(agent, { agent_id: agent, task_id: taskId, globs, acquired_at: e.created_at });
      break;
    }

    case 'scope_released': {
      const agent = str(b.agent_id);
      if (!agent) { ignore('scope_released without agent_id'); break; }
      // Releasing a lock you do not hold is a no-op, matching releaseScope's contract.
      p.locks.delete(agent);
      break;
    }

    case 'contract_published':
    case 'schema_published': {
      const name = str(b.name);
      const path = str(b.path);
      const sha = str(b.commit_sha);
      if (!name || !path || !sha) { ignore(`${e.kind} is not a pointer: needs name, path, commit_sha`); break; }
      const version = num(b.version) ?? 1;
      // Same name+version republished (an at-least-once outbox drain) replaces rather than
      // duplicating. The pointer is immutable, so replacing is a no-op in practice.
      const at = p.contracts.findIndex((c) => c.name === name && c.version === version);
      const pointer: ContractPointer = {
        name, version, path, commit_sha: sha,
        supersedes: num(b.supersedes),
        published_by: e.actor_id,
        published_at: e.created_at,
      };
      if (at >= 0) p.contracts[at] = pointer;
      else p.contracts.push(pointer);
      break;
    }

    case 'contract_superseded':
    case 'decision_recorded':
      // Carried to agents via the inbox; no board state of its own.
      break;

    default:
      ignore(`no fold rule for kind ${e.kind}`);
  }

  if (e.seq > p.seq) p.seq = e.seq;
  return { touched_tasks: [...new Set(touched)], ignored };
}

/** Fold a whole ledger. Used by the memory adapter and by any snapshot rebuild. */
export function foldAll(events: Event[], into: Projection): FoldOutcome {
  const touched = new Set<string>();
  const ignored: FoldOutcome['ignored'] = [];
  for (const e of [...events].sort((a, b) => a.seq - b.seq)) {
    const r = applyEvent(into, e);
    r.touched_tasks.forEach((t) => touched.add(t));
    ignored.push(...r.ignored);
  }
  return { touched_tasks: [...touched], ignored };
}

/** Assemble the wire Snapshot from a projection plus presence. */
export function toSnapshot(
  p: Projection,
  meta: { project_id: string; project_name: string; repo_url: string; generated_at: string },
  agents: Snapshot['agents'],
): Snapshot {
  return {
    project_id: meta.project_id,
    seq: p.seq,
    generated_at: meta.generated_at,
    project_name: meta.project_name,
    repo_url: meta.repo_url,
    // Stable order: the board must not reshuffle cards between snapshots (E9, no layout shift).
    tasks: [...p.tasks.values()].sort((a, b) => a.task_id.localeCompare(b.task_id)),
    agents: [...agents].sort((a, b) => a.agent_id.localeCompare(b.agent_id)),
    locks: [...p.locks.values()].sort((a, b) => a.agent_id.localeCompare(b.agent_id)),
    contracts: [...p.contracts].sort((a, b) => a.name.localeCompare(b.name) || a.version - b.version),
  };
}
