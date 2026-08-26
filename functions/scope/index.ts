// File-scope locks: server-enforced, not advisory.
//
// The protocol is explicit that a dashboard warning is not sufficient — a warning
// nobody reads is discovered at merge, and detecting a collision at claim time
// costs seconds where detecting it at merge costs a rebase.
//
// THE ATOMICITY GAP, STATED PLAINLY. Catalyst has no transactions, so the glob
// intersection check and the lock INSERT cannot be one atomic step. The unique
// constraint on `lock_key` prevents a duplicate lock for the same (project,
// agent, task), but it CANNOT prevent two different agents whose globs overlap
// from both passing the check in the same instant.
//
// That window is real and is not papered over. Three things narrow it:
//
//  1. The check reads immediately before the insert, so the window is one round
//     trip rather than a request lifetime.
//  2. After inserting, the lock set is re-read and re-checked. If a conflicting
//     lock landed during the window, THIS caller releases its own lock and
//     reports the conflict — losing on re-check rather than both agents
//     proceeding. Deterministic tie-break by lock_key, so the two racers cannot
//     both decide they lost, and cannot both decide they won.
//  3. Scope locks guard file edits, not money. The failure mode of the residual
//     window is two agents briefly holding overlapping globs, which the re-check
//     resolves within one round trip.
//
// Firestore does this in a single runTransaction. G9 entry.

import type { AgentId, ProjectId, ScopeLock, ScopeResult, TaskId } from '../../shared/store/types.ts';
import { LIMITS } from '../../shared/store/types.ts';
import { StoreError } from '../../shared/store/errors.ts';
import type { Logger } from '../../shared/log.ts';
import { findGlobConflicts } from '../../shared/globs.ts';
import { compositeKey } from '../../catalyst/schema/tables.ts';
import { DuplicateValueError } from '../../catalyst/lib/duplicate.ts';
import type { Principal } from '../_lib/auth.ts';
import { requireProject } from '../_lib/auth.ts';
import type { HttpResponse } from '../_lib/http.ts';
import { json, rejectServerOwnedFields, requireString } from '../_lib/http.ts';

export interface LockRecord {
  lock_key: string; agent_id: AgentId; task_id: TaskId;
  globs: string[]; acquired_at: string;
}

export interface ScopePort {
  /** Every live lock in the project. Capped; the cap is logged by the caller. */
  listLocks(project_id: ProjectId): Promise<LockRecord[]>;
  insertLock(row: {
    lock_key: string; project_id: ProjectId; agent_id: AgentId; task_id: TaskId;
    globs: string; acquired_at: string;
  }): Promise<void>;
  /** Delete by key. Used to release, and to undo a lock that lost the re-check. */
  deleteLock(lock_key: string): Promise<void>;
  deleteLocksForAgent(project_id: ProjectId, agent_id: AgentId): Promise<number>;
}

export function lockKeyFor(project_id: ProjectId, agent_id: AgentId, task_id: TaskId): string {
  return compositeKey(project_id, agent_id, task_id.toLowerCase());
}

function toScopeLock(l: LockRecord): ScopeLock {
  return { agent_id: l.agent_id, task_id: l.task_id, globs: [...l.globs], acquired_at: l.acquired_at };
}

/** Conflicts are locks held by a DIFFERENT agent whose globs intersect ours. */
function conflictsAgainst(locks: LockRecord[], agent_id: AgentId, globs: string[]): LockRecord[] {
  return locks.filter((l) => l.agent_id !== agent_id
    && findGlobConflicts(globs, l.globs).length > 0);
}

export async function handleAcquireScope(
  port: ScopePort, principal: Principal, body: unknown, now: () => string, log: Logger,
): Promise<HttpResponse> {
  rejectServerOwnedFields(body);
  const project_id = requireString(body, 'project_id');
  const task_id = requireString(body, 'task_id');
  requireProject(principal, project_id);

  const rawGlobs = (body as { globs?: unknown }).globs;
  if (!Array.isArray(rawGlobs) || rawGlobs.length === 0) {
    throw new StoreError('globs must be a non-empty array');
  }
  const globs = rawGlobs.map((g) => {
    if (typeof g !== 'string' || g.trim() === '') throw new StoreError('each glob must be a non-empty string');
    return g.trim();
  });

  const lock_key = lockKeyFor(project_id, principal.agent_id, task_id);

  // ---- pre-check
  const before = await port.listLocks(project_id);
  if (before.length > LIMITS.locks) {
    log.warn('scope.locks_capped', 'lock list exceeded its cap on read', {
      project_id, cap: LIMITS.locks, total: before.length, dropped: before.length - LIMITS.locks,
    });
  }
  const preConflicts = conflictsAgainst(before, principal.agent_id, globs);
  if (preConflicts.length > 0) {
    log.info('scope.conflict', 'scope rejected, globs intersect a live lock', {
      project_id, agent_id: principal.agent_id, task_id, globs,
      conflicts: preConflicts.map((c) => ({ agent_id: c.agent_id, task_id: c.task_id })),
    });
    return json(200, { ok: false, conflicts: preConflicts.map(toScopeLock) } satisfies ScopeResult);
  }

  // ---- insert
  try {
    await port.insertLock({
      lock_key, project_id, agent_id: principal.agent_id, task_id: task_id.toLowerCase(),
      globs: JSON.stringify(globs), acquired_at: now(),
    });
  } catch (err) {
    if (err instanceof DuplicateValueError && err.column === 'lock_key') {
      // This agent already holds a lock for this task. Idempotent, not an error.
      log.info('scope.already_held', 'agent already holds this lock', { project_id, lock_key });
      return json(200, { ok: true } satisfies ScopeResult);
    }
    throw err;
  }

  // ---- re-check: close the window the missing transaction leaves open
  const after = await port.listLocks(project_id);
  const raceConflicts = conflictsAgainst(after, principal.agent_id, globs);
  if (raceConflicts.length > 0) {
    // Deterministic tie-break: the LOWER lock_key wins. Both racers compute the
    // same comparison from the same data, so exactly one concludes it lost --
    // without it, both could yield and neither would hold the scope.
    const weLose = raceConflicts.some((c) => c.lock_key < lock_key);
    if (weLose) {
      await port.deleteLock(lock_key);
      log.warn('scope.lost_race', 'a conflicting lock landed during the insert window, released ours', {
        project_id, agent_id: principal.agent_id, task_id, lock_key,
        conflicts: raceConflicts.map((c) => c.lock_key),
      });
      return json(200, { ok: false, conflicts: raceConflicts.map(toScopeLock) } satisfies ScopeResult);
    }
    log.warn('scope.won_race', 'a conflicting lock landed during the insert window, we hold the lower key', {
      project_id, lock_key, conflicts: raceConflicts.map((c) => c.lock_key),
    });
  }

  return json(200, { ok: true } satisfies ScopeResult);
}

/** Release every lock this agent holds. Idempotent: releasing nothing is fine. */
export async function handleReleaseScope(
  port: ScopePort, principal: Principal, body: unknown, log: Logger,
): Promise<HttpResponse> {
  rejectServerOwnedFields(body);
  const project_id = requireString(body, 'project_id');
  requireProject(principal, project_id);

  const removed = await port.deleteLocksForAgent(project_id, principal.agent_id);
  log.info('scope.released', 'released scope locks', {
    project_id, agent_id: principal.agent_id, removed,
  });
  return json(200, { ok: true, released: removed });
}
