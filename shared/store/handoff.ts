// Handing a ticket to a teammate WITH its context, in one place.
//
// `flotilla release` gives a ticket back and whoever claims it next starts cold: the branch the
// last person pushed, what they finished, what they were about to try and the trap they already
// fell into all stay on the first person's machine. A handoff is a release that carries those
// things with it, so the next claimant reads a note instead of reverse-engineering a diff.
//
// This file is the shared half, for the same reason tasks.ts exists: the Firestore fold, the
// memory fold, the API and the CLI all have to agree on what a handoff IS, and four definitions
// of one record is the shape of defect this project keeps paying for. Pure: no clock, no I/O.
// `at` is always the EVENT's clock, passed in by the fold.

import type { AgentId, Handoff, TaskStatus, TaskView } from './types.ts';

/**
 * Longest note kept. A note is a paragraph for a person, not a transcript.
 *
 * TRUNCATED WITH A WARNING, NOT REFUSED. The caller most likely to write a long note is an agent
 * that has noticed it is out of budget, and refusing its handoff because the note ran long would
 * strand the ticket under an agent that is about to stop -- the exact outcome this exists to
 * prevent. The sanitiser logs the truncation, so it is never silent.
 */
export const HANDOFF_NOTE_MAX = 2_000;

/**
 * How many handoffs a task remembers, newest last.
 *
 * Ten, because a ticket that has changed hands ten times has a problem no eleventh note will
 * fix, and the list rides every snapshot read: an unbounded one would grow a card's document
 * towards Firestore's 1 MiB limit one tired teammate at a time. The oldest is dropped, and the
 * fold says so.
 */
export const HANDOFF_HISTORY_MAX = 10;

/**
 * Validate a note. Required, and that is the definition of the feature rather than a nicety:
 * a handoff with no note is a release with extra steps, and `flotilla release` already exists.
 */
export function cleanHandoffNote(raw: unknown): { ok: true; note: string } | { ok: false; error: string } {
  const note = typeof raw === 'string' ? raw.trim() : '';
  if (!note) {
    return {
      ok: false,
      error: 'a handoff needs a note (what is done, what is next, what bit you). '
        + 'With nothing to say, use `flotilla release <task_id>` instead',
    };
  }
  return { ok: true, note };
}

/** Git's shape for the two optional pointers. Anything else is dropped rather than stored. */
const BRANCH = /^agent\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const SHA = /^[0-9a-f]{40}$/;
export const cleanBranch = (v: unknown): string | null => (typeof v === 'string' && BRANCH.test(v) ? v : null);
export const cleanSha = (v: unknown): string | null => (typeof v === 'string' && SHA.test(v) ? v : null);

/**
 * Who may hand a ticket off. Pure, so both branches are testable without a backend.
 *
 * THE CLAIMANT, OR AN OWNER. The claimant because it is their work; an owner because the case
 * that most needs a handoff is the teammate who has gone home with the ticket still claimed, and
 * the reaper takes fifteen minutes and carries no note. Nobody else: a handoff releases a claim,
 * and releasing somebody else's claim is the one thing `release` has always refused.
 */
export function mayHandOff(
  holder: AgentId | null, caller: string, caller_is_owner: boolean,
): { ok: true } | { ok: false; owner: AgentId | null; reason: string } {
  if (holder === null) return { ok: false, owner: null, reason: 'nobody holds this task, so there is nothing to hand off' };
  if (holder === caller || caller_is_owner) return { ok: true };
  return { ok: false, owner: holder, reason: `the task is held by ${holder}; only its claimant or an owner may hand it off` };
}

/**
 * The `task_handed_off` event body. Named so the writer and both folds cannot drift on a field
 * name -- `head_sha` vs `sha` is exactly the mismatch that leaves a card with a handoff and no
 * way to find the commit it describes.
 */
export function handoffEventBody(
  task_id: string,
  h: Omit<Handoff, 'at'>,
): Record<string, unknown> {
  return {
    task_id,
    from_agent_id: h.from.agent_id,
    from_label: h.from.label,
    handed_off_by: h.handed_off_by,
    note: h.note,
    branch: h.branch,
    head_sha: h.head_sha,
  };
}

/** Parse a `task_handed_off` body back into a record, or say why it is unusable. */
export function handoffFromEvent(
  body: Record<string, unknown>, at: string,
): { ok: true; handoff: Handoff } | { ok: false; reason: string } {
  const from = typeof body.from_agent_id === 'string' && body.from_agent_id ? body.from_agent_id : null;
  if (!from) return { ok: false, reason: 'task_handed_off without from_agent_id' };
  const note = cleanHandoffNote(body.note);
  if (!note.ok) return { ok: false, reason: 'task_handed_off without a note' };
  return {
    ok: true,
    handoff: {
      from: { agent_id: from, label: typeof body.from_label === 'string' && body.from_label ? body.from_label : from },
      handed_off_by: typeof body.handed_off_by === 'string' && body.handed_off_by ? body.handed_off_by : from,
      note: note.note,
      branch: cleanBranch(body.branch),
      head_sha: cleanSha(body.head_sha),
      at,
    },
  };
}

/** Append one, newest last, keeping at most HANDOFF_HISTORY_MAX. Reports how many fell off. */
export function withHandoff(list: readonly Handoff[] | undefined, h: Handoff): { handoffs: Handoff[]; dropped: number } {
  const all = [...(list ?? []), h];
  const dropped = Math.max(0, all.length - HANDOFF_HISTORY_MAX);
  return { handoffs: all.slice(dropped), dropped };
}

/**
 * Where a handed-off card goes. Back to `open` when its work is still in flight, so the next
 * claimant can take it; left alone once it is shipped (needs_review, pr_open), because moving a
 * card with an open PR back to `open` would claim the PR never happened. The same rule
 * `task_unblocked` follows in firebase/fold.ts, stated once here for both folds.
 */
export function statusAfterHandoff(status: TaskStatus): TaskStatus {
  return status === 'claimed' || status === 'in_progress' || status === 'blocked' ? 'open' : status;
}

/** The handoff the next claimant must read, if there is one. */
export const latestHandoff = (task: Pick<TaskView, 'handoffs'> | null | undefined): Handoff | null =>
  task?.handoffs?.at(-1) ?? null;
