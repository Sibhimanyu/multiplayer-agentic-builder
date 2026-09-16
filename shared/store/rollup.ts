// Per-project rollup: the few numbers the projects index needs, maintained as DELTAS.
//
// WHY THIS EXISTS, and why it is not computed in the index.
//
// The index answers one question: where does my attention need to go? To answer it for N projects
// it needs task counts, a blocked/failing signal, and a last-activity time for each. Computing
// those in the browser means reading every task of every project -- a cost that scales with
// projects x tasks, and one that grows silently as the product succeeds. Entry 56's lesson in a
// different costume: the per-item cost is the one that surprises people.
//
// So the numbers are maintained on the project document itself, by the same transaction that
// folds the board. The index then reads only the project docs it already reads, and its cost is
// unchanged.
//
// DELTAS, NOT RECOMPUTATION. The append transaction loads exactly one task -- the one the event
// touches -- so it cannot recount. It does not need to: it knows that task's status before and
// after, and a counter moves by the difference. That keeps the write O(1) with no extra reads,
// which is the only shape that stays honest when a project has a thousand tasks.
//
// The risk of a counter is drift: a missed decrement is permanent and invisible. Two things bound
// it. `rollupDelta` is pure and total, so it is directly testable against every transition. And
// `RECONCILABLE` records that a full recount is always available from the tasks collection --
// this is a cache of a derivable fact, never the source of truth.

import type { TaskStatus, TaskView } from './types.ts';

/**
 * What the index reads off `projects/{pid}`.
 *
 * `counts` is keyed by TaskStatus rather than by column so the index cannot invent a second
 * definition of "in progress". The column list lives in one place; this is the raw material.
 */
export interface ProjectRollup {
  counts: Partial<Record<TaskStatus, number>>;
  /** Tasks with a blocker. The one number that should pull the eye. */
  blocked: number;
  /** Tasks whose CI is failing. The other one. */
  ci_failed: number;
  /** ISO of the newest event. Answers "is this alive" better than a member avatar does. */
  last_activity: string;
  /** Ledger position the rollup reflects. A reconcile can tell how far behind it is. */
  last_seq: number;
}

/** A counter cache is only safe if a recount is always possible. It is: read `tasks/`. */
export const RECONCILABLE = true;

/** Numeric fields that move by increment. Kept as one list so a writer cannot miss one. */
export interface RollupDelta {
  counts: Partial<Record<TaskStatus, number>>;
  blocked: number;
  ci_failed: number;
}

const isBlocked = (t: TaskView | null): boolean => !!t && t.blocked_by !== null;
const isCiFailed = (t: TaskView | null): boolean => !!t && t.ci === 'failed';

/**
 * How the rollup moves when one task goes from `before` to `after`.
 *
 * `before` is null when the task is new; `after` is null when it is gone. Both null yields an
 * empty delta rather than a throw -- an event that touched nothing must not corrupt a counter,
 * and the caller has already logged it as ignored.
 *
 * Deliberately returns only the CHANGES. A key absent from `counts` means "do not touch", which
 * is not the same as zero: writing an explicit 0 would clobber a concurrent increment from
 * another transaction.
 */
export function rollupDelta(before: TaskView | null, after: TaskView | null): RollupDelta {
  const counts: Partial<Record<TaskStatus, number>> = {};

  const from = before?.status ?? null;
  const to = after?.status ?? null;
  if (from !== to) {
    if (from) counts[from] = (counts[from] ?? 0) - 1;
    if (to) counts[to] = (counts[to] ?? 0) + 1;
  }

  // Computed independently of status: a task can become blocked without changing column, and
  // deriving one from the other is how the two numbers drift apart.
  const blocked = Number(isBlocked(after)) - Number(isBlocked(before));
  const ci_failed = Number(isCiFailed(after)) - Number(isCiFailed(before));

  return { counts, blocked, ci_failed };
}

/** True when a delta would change nothing, so a writer can skip the field entirely. */
export function isEmptyDelta(d: RollupDelta): boolean {
  return d.blocked === 0 && d.ci_failed === 0 && Object.values(d.counts).every((v) => v === 0);
}

/**
 * Apply a delta to a rollup. Used by tests and by a reconcile; the live write path uses
 * Firestore's atomic increment instead, so two concurrent appends cannot lose a count.
 *
 * Clamps at zero. A negative count is always a bug, but rendering "-1 open" turns an invisible
 * accounting error into a visible one that a user cannot act on -- so it is clamped here and
 * catchable in tests rather than shown.
 */
export function applyDelta(r: ProjectRollup, d: RollupDelta): ProjectRollup {
  const counts = { ...r.counts };
  for (const [k, v] of Object.entries(d.counts)) {
    const next = (counts[k as TaskStatus] ?? 0) + (v ?? 0);
    counts[k as TaskStatus] = Math.max(0, next);
  }
  return {
    ...r,
    counts,
    blocked: Math.max(0, r.blocked + d.blocked),
    ci_failed: Math.max(0, r.ci_failed + d.ci_failed),
  };
}

export const emptyRollup = (): ProjectRollup => ({
  counts: {}, blocked: 0, ci_failed: 0, last_activity: '', last_seq: 0,
});

/** Recount from scratch. The escape hatch that makes the cache safe to hold. */
export function rollupFromTasks(tasks: TaskView[], last_activity: string, last_seq: number): ProjectRollup {
  const r = emptyRollup();
  for (const t of tasks) {
    r.counts[t.status] = (r.counts[t.status] ?? 0) + 1;
    if (isBlocked(t)) r.blocked += 1;
    if (isCiFailed(t)) r.ci_failed += 1;
  }
  return { ...r, last_activity, last_seq };
}
