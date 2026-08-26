// Fold the ledger into a Snapshot.
//
// Pure: rows in, Snapshot out, no I/O and no clock of its own. That is what makes
// it testable without Stratus, and what lets the Event function stay a thin
// wrapper around it.
//
// TWO RULES THAT ARE NOT STYLE.
//
// 1. ORDERING IS BY `seq` AND ONLY BY `seq`. Order 0017 made `created_at`
//    metadata: nothing may sort, page or deduplicate on it. On this platform it
//    carries second resolution anyway, so a batch of events shares one timestamp
//    and a timestamp sort would silently reorder them. `seq` is the authority.
//
// 2. FOLDING IS DEFINED BY THE HIGHEST `seq` APPLIED, not by how many events were
//    read. `snapshot.seq` is what a caller compares its `last_written_seq`
//    against to decide "stale, not lost" (mandatory behaviour 5), so it has to
//    mean exactly "every event up to here is included".

import type {
  AgentPresence, ContractPointer, Event, ProjectId, ScopeLock, Seq, Snapshot, TaskView,
} from '../../shared/store/types.ts';
import { LIMITS, STALE_AFTER_MS } from '../../shared/store/types.ts';
import { readBool } from '../../shared/sanitize.ts';
import type { Logger } from '../../shared/log.ts';
import { nullLogger } from '../../shared/log.ts';

/** A row from `tasks`: the definition, never the folded state. */
export interface TaskDefRow {
  task_id: string; title: string; kind: string;
  description?: string | null;
  depends_on?: string | null; // JSON array
  file_scope?: string | null; // JSON array
}

/** A row from `agents`. `revoked` is deliberately unknown: booleans are strings. */
export interface AgentRow {
  agent_id: string; role_slug: string; member_label: string;
  harness: string; revoked: unknown;
}

export interface ClaimRow { task_id: string; agent_id: string; claimed_at: string }

export interface LockRow {
  agent_id: string; task_id: string; globs: string | string[]; acquired_at: string;
}

/** One presence entry from Cache. Absent means offline; that IS the signal. */
export interface PresenceEntry {
  agent_id: string;
  status: AgentPresence['status'];
  current_task: string | null;
  branch: string | null;
  /** Epoch ms of the heartbeat. */
  at_ms: number;
}

export interface FoldInput {
  project_id: ProjectId;
  /** Ascending by seq. Not required to be dense. */
  events: Event[];
  tasks: TaskDefRow[];
  agents: AgentRow[];
  claims: ClaimRow[];
  locks: LockRow[];
  presence: PresenceEntry[];
  /** Epoch ms, injected so staleness is testable. */
  now_ms: number;
  /** Display-only, and see the note in the docs: no table stores these yet. */
  project_name?: string;
  repo_url?: string;
  stale_after_ms?: number;
  log?: Logger;
}

function parseJsonArray(raw: string | null | undefined, log: Logger, field: string): string[] {
  if (raw === null || raw === undefined || raw === '') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    // Not silently emptied: a column that will not parse is a real problem and
    // an empty array would look like "no dependencies" or "no file scope".
    log.warn('fold.unparseable_json_column', 'column did not parse as JSON, treated as empty', {
      field, raw_length: raw.length,
    });
    return [];
  }
}

function initialsOf(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '??';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function foldSnapshot(input: FoldInput): Snapshot {
  const log = input.log ?? nullLogger;
  const staleAfter = input.stale_after_ms ?? STALE_AFTER_MS;

  // Sort by seq explicitly rather than trusting the caller. A read that came back
  // in ROWID order would otherwise apply events backwards.
  const events = [...input.events].sort((a, b) => a.seq - b.seq);

  const tasks = new Map<string, TaskView>();
  for (const def of input.tasks) {
    tasks.set(def.task_id, {
      task_id: def.task_id,
      title: def.title,
      kind: def.kind as TaskView['kind'],
      status: 'open',
      ...(def.description === null || def.description === undefined
        ? {} : { description: def.description }),
      claimed_by: null, branch: null, pr_url: null, pr_number: null, ci: null,
      depends_on: parseJsonArray(def.depends_on, log, `tasks.depends_on[${def.task_id}]`),
      blocked_by: null, blocked_reason: null, blocked_since: null,
      file_scope: parseJsonArray(def.file_scope, log, `tasks.file_scope[${def.task_id}]`),
      updated_at: '',
    });
  }

  const contracts = new Map<string, ContractPointer>();
  let folded_seq: Seq = 0;

  for (const e of events) {
    folded_seq = Math.max(folded_seq, e.seq);
    applyEvent(tasks, contracts, e, log);
  }

  // Claims and locks are LIVE store state, not folded history: a released claim
  // leaves no event that "un-claims", so the table is the truth.
  for (const claim of input.claims) {
    const task = tasks.get(claim.task_id);
    if (!task) continue;
    task.claimed_by = claim.agent_id;
    if (task.status === 'open') task.status = 'claimed';
  }

  const presenceByAgent = new Map(input.presence.map((p) => [p.agent_id, p]));
  const agents: AgentPresence[] = input.agents.map((a) => {
    const live = presenceByAgent.get(a.agent_id);
    const revoked = readBool(a.revoked); // "false" is truthy in JS
    return {
      agent_id: a.agent_id,
      role_slug: a.role_slug,
      member_label: a.member_label,
      initials: initialsOf(a.member_label),
      harness: a.harness as AgentPresence['harness'],
      status: revoked ? 'revoked' : live ? live.status : 'offline',
      current_task: live ? live.current_task : null,
      branch: live ? live.branch : null,
      last_heartbeat_at: live ? new Date(live.at_ms).toISOString() : null,
      // Derived at read time, never stored (mandatory behaviour 7).
      stale: live === undefined ? true : input.now_ms - live.at_ms > staleAfter,
    };
  });

  const locks: ScopeLock[] = input.locks.map((l) => ({
    agent_id: l.agent_id,
    task_id: l.task_id,
    globs: Array.isArray(l.globs) ? l.globs : parseJsonArray(l.globs, log, 'scope_locks.globs'),
    acquired_at: l.acquired_at,
  }));

  return {
    project_id: input.project_id,
    seq: folded_seq,
    generated_at: new Date(input.now_ms).toISOString(),
    project_name: input.project_name ?? input.project_id,
    repo_url: input.repo_url ?? '',
    tasks: [...tasks.values()],
    agents: capped(agents, LIMITS.presence, 'presence', log),
    locks: capped(locks, LIMITS.locks, 'locks', log),
    contracts: [...contracts.values()],
  };
}

function capped<T>(items: T[], cap: number, what: string, log: Logger): T[] {
  if (items.length <= cap) return items;
  log.warn('fold.capped', 'list exceeded its cap and was truncated', {
    what, cap, total: items.length, dropped: items.length - cap,
  });
  return items.slice(0, cap);
}

function applyEvent(
  tasks: Map<string, TaskView>, contracts: Map<string, ContractPointer>, e: Event, log: Logger,
): void {
  const body = e.body as Record<string, unknown>;
  const task_id = typeof body.task_id === 'string' ? body.task_id : undefined;
  const task = task_id === undefined ? undefined : tasks.get(task_id);
  const stamp = (patch: Partial<TaskView>): void => {
    if (!task) return;
    Object.assign(task, patch, { updated_at: e.created_at });
  };

  switch (e.kind) {
    case 'schema_published':
    case 'contract_published': {
      const name = String(body.name ?? '');
      if (name === '') break;
      const version = typeof body.version === 'number' ? body.version : 1;
      const prior = contracts.get(name);
      // Never regress to an older version. Events arrive in seq order, but a
      // republish of v1 after v2 would otherwise overwrite the newer pointer.
      if (prior && prior.version > version) break;
      contracts.set(name, {
        name, version,
        path: String(body.path ?? ''),
        commit_sha: String(body.commit_sha ?? ''),
        supersedes: typeof body.supersedes === 'number' ? body.supersedes : null,
        published_by: e.actor_id,
        published_at: e.created_at,
      });
      break;
    }
    case 'task_blocked':
      stamp({
        status: 'blocked',
        blocked_by: typeof body.blocked_by_task_id === 'string' ? body.blocked_by_task_id : null,
        blocked_reason: typeof body.reason === 'string' ? body.reason : null,
        blocked_since: e.created_at,
      });
      break;
    case 'task_unblocked':
      stamp({ status: 'open', blocked_by: null, blocked_reason: null, blocked_since: null });
      break;
    case 'task_completed':
      stamp({ status: 'needs_review' });
      break;
    case 'branch_pushed':
      stamp({
        status: task && (task.status === 'claimed' || task.status === 'open')
          ? 'in_progress' : task?.status ?? 'in_progress',
        branch: typeof body.branch === 'string' ? body.branch : task?.branch ?? null,
      });
      break;
    case 'pr_opened':
      stamp({
        status: 'pr_open',
        pr_url: typeof body.pr_url === 'string' ? body.pr_url : null,
        pr_number: typeof body.pr_number === 'number' ? body.pr_number : null,
        ci: 'pending',
      });
      break;
    case 'ci_passed': stamp({ ci: 'passed' }); break;
    case 'ci_failed': stamp({ ci: 'failed' }); break;
    case 'merged': stamp({ status: 'merged' }); break;

    // Live store state or no board effect. Claims and locks are read from their
    // tables; human-layer events never change the board.
    case 'task_claimed': case 'scope_locked': case 'scope_released':
    case 'contract_superseded': case 'decision_recorded':
    case 'agent_heartbeat': case 'task_progress':
      break;
    default:
      // Named, not swallowed: an unhandled kind means the protocol moved.
      log.warn('fold.unhandled_kind', 'event kind not folded into the snapshot', {
        kind: e.kind, seq: e.seq,
      });
  }
}
