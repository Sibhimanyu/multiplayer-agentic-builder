// `flotilla handoff` -- give a ticket to whoever claims it next, WITH its context.
//
// THE GAP THIS CLOSES. `flotilla release` gives a ticket back and its lock; whoever claims it next
// starts cold. The work is on the first person's disk, uncommitted; what they finished, what they
// were about to try and the trap they already fell into are in their head. The case that makes
// this matter is ordinary: somebody's agent hits its usage limit mid-task, and a teammate with
// budget left could carry on -- if they could see where it got to.
//
// So a handoff is three things, in this order, and the order is the design:
//
//   1. PUSH a WIP checkpoint of the in-scope changes, exactly as `flotilla ship --wip` does. Same
//      function, not a copy: `shipScope` is the only code in this CLI that is allowed to decide
//      what leaves the machine, and a second implementation would eventually disagree with it
//      about a credential. If the push fails, NOTHING is handed off -- releasing a ticket whose
//      work never left the machine would strand that work behind a claim somebody else now holds.
//   2. RECORD the handoff and RELEASE the claim, atomically, on the server. Atomic because the
//      next claimant must never see the ticket free without the note on it.
//   3. RELEASE the file lock, through the same path `flotilla release` uses.
//
// The receiving half -- printing the note, continuing on the branch, dropping it in the inbox --
// is `deliverHandoff`, run by `flotilla claim`.

import { git, type GitResult } from './blackboard.ts';
import { LAYOUT, appendInbox } from './agentic.ts';
import { ShipError, branchFor, excluded, parseStatus, scopeForTask, shipScope, type ShipResult } from './ship.ts';
import { cleanBranch, cleanHandoffNote, latestHandoff } from '../shared/store/handoff.ts';
import { StoreOfflineError } from '../shared/store/errors.ts';
import type { Handoff, HandoffResult, ScopeLock, Snapshot, TaskView } from '../shared/store/types.ts';
import type { Logger } from '../shared/log.ts';

/** The four calls a handoff makes. `ApiClient` satisfies it; tests pass a fake. */
export interface HandoffClient {
  whoami(): Promise<{ agent_id: string; role_slug: string }>;
  readSnapshot(): Promise<{ snapshot: Snapshot; etag: string } | null>;
  handoffTask(task_id: string, h: { note: string; branch: string | null; head_sha: string | null }): Promise<HandoffResult>;
  releaseScope(): Promise<void>;
}

export interface HandoffRequest {
  root: string;
  task_id: string;
  /** Unvalidated on purpose: the refusal of an empty one is part of this function's contract. */
  note: unknown;
  client: HandoffClient;
  log: Logger;
  /** Injected for tests. Defaults to the real `shipScope` and `git`. */
  ship?: typeof shipScope;
  runner?: typeof git;
  remote?: string;
}

export type HandoffOutcome =
  | {
      ok: true;
      task_id: string;
      handoff: Handoff;
      /** The checkpoint push, or null when this caller held no scope (or is an owner, not the claimant). */
      pushed: ShipResult | null;
      /** Globs whose lock was released. Empty when none was held for this task. */
      released_lock: string[];
    }
  | {
      ok: false;
      reason: 'no_note' | 'no_task' | 'not_claimant' | 'ship_failed';
      message: string;
      owner?: string | null;
    };

/**
 * The branch a task's work lives on, for THIS claimant.
 *
 * A handed-off ticket continues on the branch it was handed off on, not a fresh one: the whole
 * point is that the next person builds on the last person's commits. A fresh `agent/<my role>/…`
 * would start from the default branch and the checkpoint would sit on a branch nobody ships.
 * `ship` and `start`'s ship-on-complete both go through here, so they cannot disagree about it.
 */
export function branchForTask(role_slug: string, task: Pick<TaskView, 'task_id' | 'handoffs'>): string {
  return cleanBranch(latestHandoff(task)?.branch) ?? branchFor(role_slug, task.task_id);
}

/** The globs locked for this task by this agent -- the rule `flotilla release` has always used. */
export function lockHeldFor(locks: ScopeLock[], agent_id: string, task_id: string): string[] {
  return scopeForTask(locks, agent_id, task_id);
}

/**
 * Release this agent's lock IF it is held for this task, and say which globs it covered.
 *
 * ONE implementation for `release` and `handoff`. releaseScope drops the agent's single lock, so
 * calling it unconditionally would free the files of a different task this agent is working on.
 */
export async function releaseLockFor(
  client: Pick<HandoffClient, 'releaseScope'>, locks: ScopeLock[], agent_id: string, task_id: string,
): Promise<string[]> {
  const held = lockHeldFor(locks, agent_id, task_id);
  if (held.length > 0) await client.releaseScope();
  return held;
}

/** The remote tip of a branch, or null when the branch does not exist there. */
export async function remoteHead(root: string, branch: string, run: typeof git = git, remote = 'origin'): Promise<string | null> {
  const r = await run(['ls-remote', remote, `refs/heads/${branch}`], root);
  if (r.code !== 0) return null;
  const sha = r.stdout.trim().split(/\s+/)[0] ?? '';
  return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

export async function performHandoff(req: HandoffRequest): Promise<HandoffOutcome> {
  const { root, task_id, client, log } = req;
  const ship = req.ship ?? shipScope;
  const run = req.runner ?? git;

  // FIRST, before any network: an empty note is a release, and `release` exists.
  const note = cleanHandoffNote(req.note);
  if (!note.ok) return { ok: false, reason: 'no_note', message: note.error };

  const me = await client.whoami();
  const read = await client.readSnapshot();
  // Offline is retryable, not a refusal: the outbox path must re-send this later, not drop it.
  if (!read) throw new StoreOfflineError('the board returned no snapshot');
  const task = read.snapshot.tasks.find((t) => t.task_id === task_id);
  if (!task) return { ok: false, reason: 'no_task', message: `no task ${task_id} on this board` };

  const mine = task.claimed_by === me.agent_id;
  let pushed: ShipResult | null = null;
  let branch: string | null;
  let head_sha: string | null = null;

  if (mine) {
    branch = branchForTask(me.role_slug, task);
    const scope = scopeForTask(read.snapshot.locks, me.agent_id, task_id);
    if (scope.length > 0) {
      try {
        pushed = await ship({
          root, branch, scope, agent_id: me.agent_id, role_slug: me.role_slug,
          task_id, task_title: task.title, ...(req.remote ? { remote: req.remote } : {}),
        }, log);
      } catch (err) {
        if (!(err instanceof ShipError)) throw err;
        log.warn('cli.handoff_push_failed', 'could not push a checkpoint; nothing was handed off', { task_id, error: err.message });
        return {
          ok: false, reason: 'ship_failed',
          message: `could not push a checkpoint, so nothing was handed off and you still hold ${task_id}: ${err.message}`,
        };
      }
    }
    // `commit_sha` is empty when nothing in scope changed; the branch may still hold earlier work.
    head_sha = pushed?.commit_sha || await remoteHead(root, branch, run, req.remote);
    // Never point the next claimant at a branch that does not exist: they would fetch nothing
    // and read that as the handoff being broken.
    if (!head_sha) branch = null;
  } else {
    // NOT THE CLAIMANT. There is nothing of ours to push, and whether this caller may hand the
    // ticket off at all -- an owner may -- is the SERVER's decision, not this file's. Pointing at
    // the branch the card already names is the most this machine can honestly say.
    branch = cleanBranch(task.branch);
  }

  let r = await client.handoffTask(task_id, { note: note.note, branch, head_sha });
  if (!r.ok && r.owner === null) {
    // A retry after a lost response lands here: the first request released the claim, so the
    // second finds nobody holding it. Read the card before calling that a refusal.
    const again = await client.readSnapshot();
    const last = latestHandoff(again?.snapshot.tasks.find((t) => t.task_id === task_id));
    if (last && last.from.agent_id === me.agent_id && last.note === note.note) r = { ok: true, seq: 0, handoff: last };
  }
  if (!r.ok) {
    return {
      ok: false, reason: 'not_claimant', owner: r.owner,
      message: r.owner
        ? `${task_id} is held by ${r.owner}; only its claimant or an owner may hand it off`
        : `nobody holds ${task_id}, so there is nothing to hand off`,
    };
  }

  // The lock, through the release path. Only our own: an owner handing off a teammate's ticket
  // cannot free the teammate's lock from here, and releaseScope would free the OWNER's instead.
  const released_lock = mine ? await releaseLockFor(client, read.snapshot.locks, me.agent_id, task_id) : [];
  log.info('cli.handed_off', 'task handed off', { task_id, branch, head_sha, released_lock });
  return { ok: true, task_id, handoff: r.handoff, pushed, released_lock };
}

// ---- the receiving half -----------------------------------------------------------------

/** What `claim` prints. Plain lines, because a person reads it before their agent does. */
export function renderHandoff(h: Handoff, earlier: number): string[] {
  return [
    `handed off by ${h.from.label} (${h.from.agent_id}) at ${h.at}${earlier > 0 ? ` — ${earlier} earlier handoff(s) in ${LAYOUT.current_task}` : ''}`,
    ...h.note.split('\n').map((l) => `  | ${l}`),
    h.branch
      ? `  continue on ${h.branch}${h.head_sha ? ` @ ${h.head_sha.slice(0, 12)}` : ''}`
      : '  nothing was pushed before the handoff; start from the default branch',
  ];
}

export type ContinueResult = { checked_out: true; branch: string } | { checked_out: false; reason: string };

/**
 * Put this checkout on the handed-off branch, if that is safe. Never loses a byte.
 *
 * CHECKS OUT ONLY A CLEAN TREE. `claim` runs before the agent starts, so this is the one moment a
 * checkout cannot pull files out from under an agent mid-edit -- but it can still clobber a
 * human's own uncommitted work, and nothing Flotilla does may do that. A dirty tree is told the
 * two commands instead. Flotilla's own files (.agentic/, the token, AGENTS.md) do not count as
 * dirt: they are rewritten on every claim and are never shipped.
 *
 * `-B` resets a local branch of the same name to the remote tip, so it also refuses when that
 * local branch holds commits the remote does not: those are somebody's, and a reset drops them.
 */
export async function continueOnBranch(
  root: string, h: Handoff, run: (args: string[], cwd: string) => Promise<GitResult> = git, remote = 'origin',
): Promise<ContinueResult> {
  const branch = cleanBranch(h.branch);
  if (!branch) return { checked_out: false, reason: 'nothing was pushed before the handoff; start from the default branch' };
  const tracking = `refs/remotes/${remote}/${branch}`;
  const manual = `git fetch ${remote} ${branch} && git checkout -B ${branch} ${remote}/${branch}`;

  const fetched = await run(['fetch', '-q', remote, `+refs/heads/${branch}:${tracking}`], root);
  if (fetched.code !== 0) return { checked_out: false, reason: `could not fetch ${branch}: ${fetched.stderr.trim().split('\n')[0]}` };

  const status = await run(['status', '--porcelain', '-z', '-uall'], root);
  const dirty = parseStatus(status.stdout).filter((p) => !excluded(p));
  if (status.code !== 0 || dirty.length > 0) {
    return { checked_out: false, reason: `your working tree has changes (${dirty.slice(0, 3).join(', ')}${dirty.length > 3 ? ', …' : ''}), so it was left alone. When ready: ${manual}` };
  }

  const local = await run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], root);
  if (local.code === 0) {
    const behind = await run(['merge-base', '--is-ancestor', `refs/heads/${branch}`, tracking], root);
    if (behind.code !== 0) {
      return { checked_out: false, reason: `a local ${branch} has commits the handed-off branch does not; merge them yourself` };
    }
  }

  const co = await run(['checkout', '-q', '-B', branch, tracking], root);
  if (co.code !== 0) return { checked_out: false, reason: `checkout failed: ${co.stderr.trim().split('\n')[0]}. Try: ${manual}` };
  return { checked_out: true, branch };
}

/**
 * The inbox line the new claimant's agent reads BEFORE it starts.
 *
 * An inbox-only kind, like `claim_denied`: it is a delivery to one agent, not a ledger fact (the
 * fact is `task_handed_off`, which every agent's feed carries). Only the latest note -- the full
 * history is in current-task.md -- so the line stays well under the 4 KiB atomic-append size.
 */
export function handoffInboxLine(task: Pick<TaskView, 'task_id' | 'handoffs'>, h: Handoff, continued: ContinueResult, now: string): Record<string, unknown> {
  return {
    v: '0.2', seq: 0, layer: 'coordination', kind: 'handoff_received', ts: now,
    body: {
      task_id: task.task_id,
      from: h.from,
      note: h.note,
      branch: h.branch,
      head_sha: h.head_sha,
      handed_off_at: h.at,
      checked_out: continued.checked_out,
      ...(continued.checked_out ? {} : { continue_hint: continued.reason }),
      earlier_handoffs: Math.max(0, (task.handoffs?.length ?? 1) - 1),
    },
  };
}

/**
 * Everything `claim` does with a handoff: print it, continue on its branch, tell the agent.
 * Returns the lines to print, so the caller owns stdout. No handoff, no lines, nothing touched.
 */
export async function deliverHandoff(
  root: string, task: Pick<TaskView, 'task_id' | 'handoffs'>, log: Logger,
  run?: (args: string[], cwd: string) => Promise<GitResult>,
): Promise<string[]> {
  const h = latestHandoff(task);
  if (!h) return [];
  const continued = await continueOnBranch(root, h, run);
  await appendInbox(root, handoffInboxLine(task, h, continued, new Date().toISOString()), log);
  return [
    ...renderHandoff(h, (task.handoffs?.length ?? 1) - 1),
    continued.checked_out ? `  checked out ${continued.branch}` : `  ${continued.reason}`,
    `  the note is in ${LAYOUT.inbox} and ${LAYOUT.current_task} for your agent`,
  ];
}
