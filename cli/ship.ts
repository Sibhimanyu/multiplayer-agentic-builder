// Put the agent's work on its own branch. Order 0085.
//
// THE PROMISE THIS KEEPS. Every AGENTS.md this CLI writes says, in the agent's own contract:
//
//     Never call the network, and never run git — the bridge does both for you.
//     A branch named above is pushed on your behalf.
//
// Nothing did it. `blackboard.ts` commits and pushes, but only contracts, and only to the
// blackboard branch. An agent that finished a task left its work as uncommitted edits in the
// human's checkout, and the human had to notice, stage it themselves and guess which files were
// the agent's. A contract an agent has to guess at is not a contract, and neither is one the
// runtime never honours.
//
// ---------------------------------------------------------------------------------------
// WHY THIS NEVER TOUCHES THE WORKING TREE
//
// The agent is editing this checkout RIGHT NOW. Every obvious way to make a commit on another
// branch is therefore unavailable:
//
//   `git checkout -b`      rewrites every file the agent has open, mid-edit.
//   `git stash`            same, plus the stash stack is shared with every other worktree.
//   `git add` + `commit`   leaves the human's own index full of the agent's files, so their
//                          next `git commit` silently picks up work that was never theirs.
//   a second worktree      cannot see the edits at all: they are in THIS tree, uncommitted.
//
// So this builds the commit with plumbing instead. A scratch index file, populated from a base
// commit and then from the scoped paths in the working tree, becomes a tree; `commit-tree` turns
// that tree into a commit with the branch tip as its parent; the commit is pushed straight to a
// ref. `.git/index` is never opened, HEAD never moves, and not one file in the tree changes.
// Run it while an agent is mid-edit and the agent cannot tell it happened.
//
// ---------------------------------------------------------------------------------------
// WHAT GETS COMMITTED IS THE SCOPE, AND ONLY THE SCOPE
//
// Never `git add -A`. That is not a style preference here: `git add -A` on a worktree whose
// index started at an older revision is how this repository once committed a revert of its
// entire design system as if it were new work. Staging is an explicit list of paths, each one
// matched against a glob the agent actually holds a lock on.
//
// Two things are refused even when the scope is `**`: `.flotilla-token`, which is a credential,
// and `.agentic/`, which is per-machine state the contract itself says is the agent's own. A
// role-specific AGENTS.md is excluded for the same reason -- one member's role file has no
// business on a branch another member will read.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git, type GitResult } from './blackboard.ts';
import { globsIntersect } from '../shared/globs.ts';
import type { Logger } from '../shared/log.ts';

export class ShipError extends Error {
  readonly detail: string;
  constructor(message: string, detail = '') {
    super(detail ? `${message}: ${detail}` : message);
    this.name = 'ShipError';
    this.detail = detail;
  }
}

export interface ShipRequest {
  /** Working tree root. */
  root: string;
  /** Target branch. Must be under the role's prefix; a bare branch name is refused. */
  branch: string;
  /** The globs this agent holds. A path outside every one of them is never staged. */
  scope: string[];
  /** Who and what, for the commit trailers. */
  agent_id: string;
  role_slug: string;
  task_id: string;
  task_title: string;
  remote?: string;
  max_attempts?: number;
  runner?: typeof git;
}

export interface ShipResult {
  branch: string;
  commit_sha: string;
  /** Repo-relative paths that went into the commit. */
  files: string[];
  /** Paths that changed but were NOT the agent's to commit. Reported, never staged. */
  skipped: string[];
  attempts: number;
  /** True when the scope held no changes: a no-op, not a failure. */
  unchanged: boolean;
}

/**
 * Paths no scope may ever include.
 *
 * `.flotilla-token` is the agent's credential. It lives outside `.agentic/` precisely so the
 * agent's own tree never contains one, and an owner whose scope is `**` would otherwise push it
 * to a shared branch on the first ship.
 */
const NEVER = ['.flotilla-token', '.agentic/', 'AGENTS.md'];

const excluded = (p: string): boolean =>
  NEVER.some((n) => (n.endsWith('/') ? p === n.slice(0, -1) || p.startsWith(n) : p === n));

/**
 * Does this file path fall inside one of the held globs?
 *
 * `globsIntersect` asks "could these two patterns match the same path", and a literal path is a
 * pattern that matches exactly itself -- so intersection with a literal IS matching. Reusing it
 * rather than writing a second matcher matters more than the small oddity of the call reading
 * backwards: a separate implementation would eventually disagree with the one the SERVER uses to
 * grant the lock, and an agent would be allowed to commit a file it was never allowed to hold.
 */
export const inScope = (file: string, scope: string[]): boolean =>
  scope.some((g) => globsIntersect(g, file));

/**
 * Split changed paths into what this agent may commit and what it may not.
 *
 * ONE implementation, used by `shipScope` and by `--dry-run`. The dry run first had its own copy
 * and immediately drifted: it reported `.flotilla-token` under "outside your scope", which is
 * not why it is excluded and would be an outright lie for an owner holding `**`. A preview that
 * disagrees with the thing it is previewing is worse than no preview.
 */
export function classifyChanges(
  changed: string[],
  scope: string[],
): { files: string[]; skipped: string[] } {
  const files: string[] = [];
  const skipped: string[] = [];
  for (const f of changed) {
    if (excluded(f)) continue;  // never anyone's work product; not a scope question at all
    (inScope(f, scope) ? files : skipped).push(f);
  }
  return { files, skipped };
}

/**
 * Changed paths in the working tree, tracked and untracked, as repo-relative strings.
 *
 * `-z` because a filename may contain a newline, and the human-readable format quotes and
 * escapes those in a way that round-trips wrongly. `-uall` because a brand new file the agent
 * created is the normal case, and the default collapses a new directory to its name.
 */
export function parseStatus(z: string): string[] {
  const out: string[] = [];
  const parts = z.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    const xy = entry.slice(0, 2);
    const p = entry.slice(3);
    if (!p) continue;
    out.push(p);
    // A rename or copy emits the ORIGINAL path as its own NUL-terminated field after the entry.
    // Both sides have to be staged or the commit records an add without the matching delete.
    if (xy[0] === 'R' || xy[0] === 'C') {
      const orig = parts[++i];
      if (orig) out.push(orig);
    }
  }
  return [...new Set(out)];
}

/**
 * The globs to commit under: THIS task's lock, not every lock this agent holds.
 *
 * An agent may hold two claims at once -- that is how the `currentTask` bug surfaced. Taking the
 * union would put task B's files on task A's branch, so a docs commit would carry frontend work
 * under a title that never mentions it and the reviewer would have no way to tell. One branch,
 * one task, one lock.
 */
export function scopeForTask(
  locks: { agent_id: string; task_id: string; globs: string[] }[],
  agent_id: string,
  task_id: string,
): string[] {
  return [...new Set(
    locks.filter((l) => l.agent_id === agent_id && l.task_id === task_id).flatMap((l) => l.globs),
  )];
}

/** `task_warehouse_filter_drops_rows` -> `warehouse-filter-drops-rows`. */
export function slugFor(task_id: string): string {
  const s = task_id.replace(/^task[_-]/, '').replace(/_/g, '-').toLowerCase()
    .replace(/[^a-z0-9-]/g, '-').replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
  // A branch has to be nameable even when the id is not. Empty would make `agent/frontend/`,
  // which git rejects with a message about a ref ending in a slash and no mention of the task.
  return s || 'task';
}

export function branchFor(role_slug: string, task_id: string): string {
  return `agent/${role_slug || 'unknown'}/${slugFor(task_id)}`;
}

/**
 * Whether a hand-run `flotilla ship` should also mark the task complete.
 *
 * YES BY DEFAULT. Shipping by hand left the ticket at in_progress: the board only moves on
 * task_completed, and a human who pushed their finished work had no reason to know that. Two
 * paths to "done" that end in different board states is the bug. `--wip` is the way to push a
 * checkpoint without saying you are finished. A task already past in_progress is left alone,
 * so shipping a follow-up fix does not re-announce it.
 */
export function shouldCompleteOnShip(status: string, args: readonly string[]): boolean {
  if (args.includes('--wip')) return false;
  return status === 'claimed' || status === 'in_progress';
}

/**
 * Commit the agent's in-scope changes onto its task branch and push.
 *
 * Returns `unchanged: true` when the scope held nothing, which is the common case on a loop and
 * is not an error: an agent may finish a task whose work was all reading.
 */
export async function shipScope(req: ShipRequest, log: Logger): Promise<ShipResult> {
  const run = req.runner ?? git;
  const remote = req.remote ?? 'origin';
  const maxAttempts = req.max_attempts ?? 3;
  const { root, branch } = req;

  // A BRANCH IS NOT A PLACE THIS MAY BE POINTED. The ref is built from a role slug and a task
  // id, both of which come off the network, so the shape is asserted rather than trusted: this
  // function force-free pushes to whatever ref it is handed, and `main` is one string away.
  if (!/^agent\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(branch)) {
    throw new ShipError('refusing to push to a branch outside agent/<role>/<task>', branch);
  }
  if (req.scope.length === 0) {
    throw new ShipError('this agent holds no scope', 'claim a task before shipping');
  }

  const status = await run(['status', '--porcelain', '-z', '-uall'], root);
  if (status.code !== 0) throw new ShipError('git status failed', status.stderr.trim());

  const { files, skipped } = classifyChanges(parseStatus(status.stdout), req.scope);

  if (skipped.length > 0) {
    // NAMED, NOT SWALLOWED. A file the agent changed and cannot ship is the single most
    // confusing outcome of this command -- the work exists, the branch does not have it, and
    // nothing said so. It is a lock problem, and the human is the one who can fix it.
    log.warn('cli.ship_out_of_scope', 'changed files are outside your scope and were NOT committed', {
      files: skipped, scope: req.scope,
    });
  }

  if (files.length === 0) {
    log.info('cli.ship_nothing_in_scope', 'nothing to ship: no changes inside the held scope', { scope: req.scope });
    return { branch, commit_sha: '', files: [], skipped, attempts: 0, unchanged: true };
  }

  // A SCRATCH INDEX, outside the repository. Inside .git/ a stray file survives a failed run and
  // gets picked up by tooling that globs that directory; in the temp dir it is unambiguously
  // ours and unambiguously disposable.
  const indexFile = path.join(
    await fs.mkdtemp(path.join(os.tmpdir(), 'flotilla-ship-')),
    'index',
  );
  const env = { GIT_INDEX_FILE: indexFile };
  const idx = (args: string[]): Promise<GitResult> => run(args, root, 60_000, env);

  try {
    let attempts = 0;
    let lastErr = '';

    while (attempts < maxAttempts) {
      attempts++;

      // THE BASE IS THE REMOTE BRANCH TIP WHEN THERE IS ONE, so a second ship of the same task
      // builds on the first instead of orphaning it. Fetch first, because another machine may
      // have moved it -- the whole premise is that several people run this at once.
      await run(['fetch', remote, branch], root);
      const remoteTip = await run(['rev-parse', '--verify', '--quiet', 'FETCH_HEAD'], root);
      const head = await run(['rev-parse', '--verify', 'HEAD'], root);
      if (head.code !== 0) throw new ShipError('this repository has no commits yet', head.stderr.trim());
      const base = remoteTip.code === 0 && remoteTip.stdout.trim()
        ? remoteTip.stdout.trim()
        : head.stdout.trim();

      // Populate the scratch index from the base commit, then overlay ONLY the scoped paths.
      // Everything the agent did not touch is therefore exactly what the base had -- the branch
      // is the base plus this agent's scope, and cannot silently carry a neighbour's edits.
      const readTree = await idx(['read-tree', base]);
      if (readTree.code !== 0) throw new ShipError('read-tree failed', readTree.stderr.trim());

      // `--all` so a deletion inside the scope is recorded as a deletion. `--` and an explicit
      // list, never a directory sweep: these paths were each matched against a held glob.
      const add = await idx(['add', '--all', '--', ...files]);
      if (add.code !== 0) throw new ShipError('git add failed', add.stderr.trim());

      const tree = await idx(['write-tree']);
      if (tree.code !== 0) throw new ShipError('write-tree failed', tree.stderr.trim());
      const treeSha = tree.stdout.trim();

      // An unchanged tree means the base already holds this exact work: a re-ship after a crash,
      // or a second `flotilla ship` with nothing new. Return the existing commit rather than
      // stacking an empty one on the branch.
      const baseTree = await run(['rev-parse', `${base}^{tree}`], root);
      if (baseTree.stdout.trim() === treeSha) {
        log.info('cli.ship_already_on_branch', 'already shipped: the branch holds this work', { branch, commit_sha: base });
        return { branch, commit_sha: base, files, skipped, attempts, unchanged: true };
      }

      const message = [
        `${req.task_title || req.task_id}`,
        '',
        `Shipped by flotilla from ${req.scope.join(', ')}.`,
        '',
        `Flotilla-Task: ${req.task_id}`,
        `Flotilla-Agent: ${req.agent_id} (${req.role_slug})`,
      ].join('\n');

      // commit-tree takes the message on stdin in normal use; `-m` avoids needing a stdin pipe
      // through the shared runner, and repeats cleanly for the body.
      const commit = await run(['commit-tree', treeSha, '-p', base, '-m', message], root, 60_000, env);
      if (commit.code !== 0) throw new ShipError('commit-tree failed', commit.stderr.trim());
      const sha = commit.stdout.trim();
      if (!/^[0-9a-f]{40}$/.test(sha)) throw new ShipError('commit-tree did not return a sha', sha);

      // NO --force. The base was just fetched, so the normal case is a fast-forward; a rejection
      // means someone else moved the branch between the fetch and the push, and the answer to
      // that is to rebuild on their commit, never to overwrite it.
      const push = await run(['push', remote, `${sha}:refs/heads/${branch}`], root);
      if (push.code === 0) {
        log.info('cli.ship_pushed', 'pushed the agent branch', {
          branch, commit_sha: sha, files: files.length, attempts,
        });
        return { branch, commit_sha: sha, files, skipped, attempts, unchanged: false };
      }

      lastErr = (push.stderr || push.stdout).trim();
      log.info('cli.ship_push_rejected_retrying', 'push rejected, rebuilding on the new tip', {
        branch, attempt: attempts, error: lastErr,
      });
    }

    throw new ShipError(`push refused after ${maxAttempts} attempts`, lastErr);
  } finally {
    // The scratch index and its directory, always, including on the throw paths above.
    await fs.rm(path.dirname(indexFile), { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * `gh pr create` arguments for a shipped task. Pure, so the exact command is testable.
 *
 * No --base: gh targets the repo's default branch, which is the only base an agent branch is
 * ever cut from. Passing one would be a second place to be wrong about it.
 */
export function prCreateArgs(repo: string, branch: string, title: string, task_id: string): string[] {
  return [
    'pr', 'create', '--repo', repo, '--head', branch, '--title', title,
    '--body', `Shipped by flotilla for \`${task_id}\`.\n\nMerging this marks the task merged and frees its file lock.`,
  ];
}

export type PrResult = { opened: true; url: string } | { opened: false; url?: string; reason: string };

/**
 * Open the task's PR with the GitHub CLI, if the human has it. Never throws.
 *
 * gh, not the REST API, because gh already holds the human's GitHub login and Flotilla holds no
 * GitHub credential of its own -- that is a property worth keeping. No gh, or gh not signed in,
 * falls back to the compare link, which is what `ship` printed before. An existing PR for the
 * branch is not an error: shipping a follow-up commit updates it, and gh names its URL.
 */
export async function openPr(
  root: string, repo: string, branch: string, title: string, task_id: string,
  run: (args: string[], cwd: string) => Promise<GitResult> = gh,
): Promise<PrResult> {
  let r: GitResult;
  try {
    r = await run(prCreateArgs(repo, branch, title, task_id), root);
  } catch {
    return { opened: false, reason: 'gh is not installed' };
  }
  const text = `${r.stdout}\n${r.stderr}`;
  const url = /https:\/\/github\.com\/\S+\/pull\/\d+/.exec(text)?.[0];
  if (r.code === 0 && url) return { opened: true, url };
  if (/already exists/i.test(text)) return { opened: false, url, reason: 'a PR for this branch is already open' };
  return { opened: false, reason: r.stderr.trim().split('\n')[0] || `gh exited ${r.code}` };
}

async function gh(args: string[], cwd: string): Promise<GitResult> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { cwd, env: { ...process.env, GH_PROMPT_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject); // ENOENT: gh is not installed
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

/**
 * Which globs `claim` should lock. The task's declared scope wins; `--scope` only fills a gap.
 *
 * A ticket raised from the board -- a user report, an accepted suggestion -- has no file scope,
 * because the person who raised it cannot know the repo layout. Claiming one took no lock, and
 * `ship` then refused it: a ticket anyone could pick up that nobody could finish. `--scope` is
 * how the claimer, who can see the code, says which files the fix touches. It does NOT override
 * a declared scope: that was decided by whoever wrote the ticket, and widening it quietly at
 * claim time would defeat the lock.
 */
export function scopeToAcquire(
  declared: readonly string[], args: readonly string[],
): { globs: string[]; from: 'task' | 'flag' | 'none'; ignored: string[] } {
  const flagged: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--scope' && args[i + 1]) flagged.push(...args[++i]!.split(',').map((g) => g.trim()).filter(Boolean));
  }
  if (declared.length > 0) return { globs: [...declared], from: 'task', ignored: flagged };
  if (flagged.length > 0) return { globs: flagged, from: 'flag', ignored: [] };
  return { globs: [], from: 'none', ignored: [] };
}
