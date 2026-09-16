// How a task comes into existence, in one place.
//
// This file exists because THREE things have to agree on what a brand-new task looks like: the
// Firestore fold (firebase/fold.ts), the in-memory fold (shared/store/memory.ts), and any future
// adapter. When Order 0063 found that `addTask` lived only in the memory store, a seeder and a
// test, the fix was not "add a second creation path" -- a second definition of how work appears
// is the shape of defect this project has paid for repeatedly. So there is one reducer for
// `task_created`, and both folds call it.
//
// Pure: no clock, no I/O, no throw except on an id that cannot be derived. `created_at` is passed
// in by the caller because it must be the EVENT's clock, not the machine's.

import { StoreError } from './errors.ts';
import type { TaskId, TaskKind, TaskView } from './types.ts';

/** Every legal `kind`, as a value. The CLI needs to print them; validation needs to check them. */
export const TASK_KINDS: readonly TaskKind[] = ['frontend', 'backend', 'qa', 'docs', 'devops'];

export const isTaskKind = (v: unknown): v is TaskKind =>
  typeof v === 'string' && (TASK_KINDS as readonly string[]).includes(v);

/** Longest slug we will build from a title. Firestore doc ids cap at 1,500 bytes; this is taste. */
const SLUG_MAX = 48;

/**
 * `task_<slug-of-title>`, deterministically.
 *
 * DETERMINISTIC ON PURPOSE, and this is the one real trade in `createTask`.
 *
 * The id is the task's identity, so deriving it from the title makes creation idempotent for
 * free: a CLI that retries after a timeout, or an at-least-once outbox drain, lands on the same
 * document and the store reports "already exists" instead of putting a second identical card on
 * the board. That is the failure mode a board actually suffers from -- the demo project grew four
 * "self test" cards exactly this way.
 *
 * The cost is that two genuinely different tasks cannot share a title. That is a real limit and
 * it is not hidden: `createTask` returns the existing task rather than throwing, the CLI prints
 * it, and an explicit `task_id` escapes the rule entirely.
 *
 * Throws rather than inventing an id when the title has nothing slug-able in it (all emoji, all
 * punctuation). A generated `task_a7f3` would be an id no human could ever guess back.
 */
export function deriveTaskId(title: string): TaskId {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/_+$/g, '');
  if (slug === '') {
    throw new StoreError(
      `cannot derive a task id from ${JSON.stringify(title)}: it contains no letters or digits. ` +
        'Supply an explicit task_id.',
    );
  }
  return `task_${slug}`;
}

/** What a caller supplies to `createTask`. Everything the board needs, nothing it derives. */
export interface NewTask {
  /** Optional. Derived from the title when absent -- see deriveTaskId. */
  task_id?: TaskId;
  title: string;
  kind: TaskKind;
  description?: string;
  depends_on?: TaskId[];
  /** Globs the claimant will lock. Empty means the task declares no scope. */
  file_scope?: string[];
}

/**
 * The event body a `task_created` carries. Named so the fold and the writer cannot drift on
 * field names -- `file_scope` vs `scope` is exactly the kind of silent mismatch that leaves a
 * task on the board with no scope and no error anywhere.
 */
export function taskCreatedBody(task_id: TaskId, t: NewTask): Record<string, unknown> {
  return {
    task_id,
    title: t.title,
    kind: t.kind,
    ...(t.description === undefined ? {} : { description: t.description }),
    depends_on: t.depends_on ?? [],
    file_scope: t.file_scope ?? [],
  };
}

/**
 * Build the initial TaskView for a `task_created` event body, or explain why the event is unusable.
 *
 * Returns a reason instead of throwing so a fold stays total: an unusable event is recorded as
 * ignored (non-negotiable H, no silent failure), it does not take a transaction down.
 *
 * A new task is ALWAYS `open`. There is no "create it already claimed" shortcut, because a claim
 * is atomic and a status field is not -- inventing a claimed task here would produce a card with
 * an owner and no claim document.
 */
export function newTaskView(
  body: Record<string, unknown>,
  created_at: string,
): { ok: true; task: TaskView } | { ok: false; reason: string } {
  const task_id = typeof body.task_id === 'string' && body.task_id !== '' ? body.task_id : null;
  if (!task_id) return { ok: false, reason: 'task_created without task_id' };

  const title = typeof body.title === 'string' && body.title.trim() !== '' ? body.title : null;
  if (!title) return { ok: false, reason: `task_created for ${task_id} without a title` };

  if (!isTaskKind(body.kind)) {
    // Refused rather than defaulted. A task silently filed as 'backend' because the kind was
    // misspelled is a card in the wrong swimlane that nobody can explain later.
    return {
      ok: false,
      reason: `task_created for ${task_id} has kind ${JSON.stringify(body.kind)}, not one of ${TASK_KINDS.join(', ')}`,
    };
  }

  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

  return {
    ok: true,
    task: {
      task_id,
      title,
      kind: body.kind,
      status: 'open',
      ...(typeof body.description === 'string' ? { description: body.description } : {}),
      claimed_by: null,
      branch: null,
      pr_url: null,
      pr_number: null,
      ci: null,
      depends_on: strings(body.depends_on),
      blocked_by: null,
      blocked_reason: null,
      blocked_since: null,
      file_scope: strings(body.file_scope),
      updated_at: created_at,
    },
  };
}
