// The git blackboard write path. Implements docs/reference/blackboard.md.
//
// The agent writes a file into the working tree and appends contract_published naming it. The
// CLI does everything else: commit, push, rewrite the event body as a pointer, append. The
// agent never handles a commit sha (C7).
//
// One rule from that document decides whether any of this works:
//
//   ONE FILE PER FACT. NEVER A SHARED APPEND-ONLY FILE.
//
// It is why `git add <one path>` below is never `git add -A`, and why the rebase-and-retry on
// push rejection is safe: two agents publishing two different contracts touch two different
// paths, so the rebase is purely additive and cannot conflict (C3).

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { Logger } from '../shared/log.ts';

export const BLACKBOARD_BRANCH = 'agentic/blackboard';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Run git. Never through a shell.
 *
 * spawn with an argument array, not exec with a string: a contract named
 * `items-api.v2.yaml; rm -rf ~` is a filename the agent controls, and a shell would run it.
 */
export function git(args: string[], cwd: string, timeout_ms = 60_000): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: {
        ...process.env,
        // Never block on a credential or editor prompt: a CLI run from an agent harness has
        // no terminal to answer it, and the process would hang until killed.
        GIT_TERMINAL_PROMPT: '0',
        GIT_EDITOR: 'true',
        // Suppress the hint blocks: they land on stderr and make error detection noisier.
        GIT_ADVICE: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`git ${args[0]} timed out after ${timeout_ms}ms`));
    }, timeout_ms);
    child.stdout.on('data', (d) => (stdout += String(d)));
    child.stderr.on('data', (d) => (stderr += String(d)));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export class BlackboardError extends Error {
  readonly detail: string;
  constructor(message: string, detail: string) {
    super(`${message}: ${detail}`);
    this.name = 'BlackboardError';
    this.detail = detail;
  }
}

/** Where a published fact belongs, derived from its kind and name. */
export function pathFor(
  kind: 'contract_published' | 'schema_published' | 'decision_recorded',
  body: { name?: string; version?: number; table?: string; slug?: string; number?: number },
): string {
  switch (kind) {
    case 'contract_published': {
      const name = requireSlug(body.name, 'contract name');
      const version = body.version ?? 1;
      if (!Number.isInteger(version) || version < 1) {
        throw new BlackboardError('invalid contract version', String(body.version));
      }
      // A new version is a NEW FILE, never an edit. Editing v1 in place destroys the diff that
      // tells a blocked consumer what broke, which is the information they need most.
      return `contracts/${name}.v${version}.yaml`;
    }
    case 'schema_published':
      return `schema/${requireSlug(body.table ?? body.name, 'schema table')}.sql`;
    case 'decision_recorded': {
      const n = body.number ?? 1;
      const slug = requireSlug(body.slug ?? body.name, 'decision slug');
      return `decisions/${String(n).padStart(4, '0')}-${slug}.md`;
    }
  }
}

/**
 * Validate a path component from agent-supplied data.
 *
 * The agent names the file. Without this, `name: "../../.github/workflows/deploy"` would let a
 * contract publish overwrite CI config on a branch everyone pushes to.
 */
function requireSlug(value: string | undefined, what: string): string {
  if (!value) throw new BlackboardError(`missing ${what}`, '(empty)');
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(value) || value.includes('..')) {
    throw new BlackboardError(
      `unsafe ${what}`,
      `${value} — must match [a-z0-9][a-z0-9._-]* and contain no ".."`,
    );
  }
  return value;
}

export interface PublishRequest {
  /** Path the agent wrote, relative to the working tree. */
  source_file: string;
  kind: 'contract_published' | 'schema_published' | 'decision_recorded';
  body: Record<string, unknown>;
}

export interface PublishResult {
  /** Path on the blackboard branch. Goes into the event body. */
  path: string;
  /** 40 hex. Pins an immutable blob, so the CDN read is cacheable forever. */
  commit_sha: string;
  /** sha-pinned raw URL a consumer fetches. Never `git fetch` on the hot path. */
  cdn_url: string;
  attempts: number;
  /** True when the file was already identical on the branch: nothing to commit. */
  unchanged: boolean;
}

export interface BlackboardOptions {
  /** Working tree root. */
  root: string;
  /** owner/repo, used to build the CDN url. */
  repo: string;
  remote?: string;
  /** Max push attempts on rejection. blackboard.md says 3. */
  max_attempts?: number;
  /** Injectable for tests. */
  runner?: typeof git;
}

/**
 * Publish one fact to the blackboard branch and return a pointer.
 *
 * Uses a dedicated worktree rather than switching branches in place. Switching branches under
 * a running agent would change every file it has open, mid-edit — the agent is working in this
 * tree right now. A worktree is a separate directory on the same object store, so the agent's
 * checkout is never touched.
 */
export async function publishToBlackboard(
  req: PublishRequest,
  opts: BlackboardOptions,
  log: Logger,
): Promise<PublishResult> {
  const run = opts.runner ?? git;
  const remote = opts.remote ?? 'origin';
  const maxAttempts = opts.max_attempts ?? 3;
  const target = pathFor(req.kind, req.body as Parameters<typeof pathFor>[1]);

  const sourceAbs = path.resolve(opts.root, req.source_file);
  // Confine the source to the working tree: the agent names this path too.
  if (!sourceAbs.startsWith(path.resolve(opts.root) + path.sep)) {
    throw new BlackboardError('source file escapes the working tree', req.source_file);
  }
  const contents = await fs.readFile(sourceAbs, 'utf8').catch(() => {
    throw new BlackboardError('named file does not exist in the working tree', req.source_file);
  });

  const wt = path.join(opts.root, '.agentic', '.blackboard-worktree');
  await prepareWorktree(run, opts.root, wt, remote, log);

  let attempts = 0;
  let lastErr = '';

  while (attempts < maxAttempts) {
    attempts++;

    // Refresh to the remote tip before writing, so the common case needs no rebase at all.
    await run(['fetch', remote, BLACKBOARD_BRANCH], opts.root);
    const reset = await run(['reset', '--hard', `${remote}/${BLACKBOARD_BRANCH}`], wt);
    if (reset.code !== 0 && !/unknown revision|ambiguous argument/i.test(reset.stderr)) {
      throw new BlackboardError('could not reset the blackboard worktree', reset.stderr.trim());
    }

    const destAbs = path.join(wt, target);

    // C6: a published version is immutable. If the path exists with different content, this is
    // an attempt to rewrite history, not a publish. Refuse rather than clobber.
    const existing = await fs.readFile(destAbs, 'utf8').catch(() => null);
    if (existing !== null && existing !== contents) {
      throw new BlackboardError(
        'refusing to overwrite a published fact',
        `${target} already exists with different content. Versions are new files, never edits.`,
      );
    }
    if (existing === contents) {
      // Idempotent republish, e.g. an outbox re-drain after a crash. Return the commit that
      // already holds it rather than making an empty one.
      const sha = (await run(['rev-parse', 'HEAD'], wt)).stdout.trim();
      log.info('cli.blackboard_fact_already_published', 'blackboard fact already published, reusing pointer', { path: target, commit_sha: sha });
      return {
        path: target,
        commit_sha: sha,
        cdn_url: cdnUrl(opts.repo, sha, target),
        attempts,
        unchanged: true,
      };
    }

    await fs.mkdir(path.dirname(destAbs), { recursive: true });
    await fs.writeFile(destAbs, contents, 'utf8');

    // ONE path. Never `git add -A`: the worktree could hold anything, and staging it all is how
    // an unrelated file ends up on a branch everyone pushes to.
    const add = await run(['add', '--', target], wt);
    if (add.code !== 0) throw new BlackboardError('git add failed', add.stderr.trim());

    const message = commitMessage(req.kind, req.body);
    const commit = await run(['commit', '-m', message], wt);
    if (commit.code !== 0) {
      if (/nothing to commit/i.test(commit.stdout + commit.stderr)) {
        const sha = (await run(['rev-parse', 'HEAD'], wt)).stdout.trim();
        return { path: target, commit_sha: sha, cdn_url: cdnUrl(opts.repo, sha, target), attempts, unchanged: true };
      }
      throw new BlackboardError('git commit failed', (commit.stderr || commit.stdout).trim());
    }

    const push = await run(['push', remote, `HEAD:${BLACKBOARD_BRANCH}`], wt);
    if (push.code === 0) {
      const sha = (await run(['rev-parse', 'HEAD'], wt)).stdout.trim();
      if (!/^[0-9a-f]{40}$/.test(sha)) {
        throw new BlackboardError('rev-parse did not return a 40-hex sha', sha);
      }
      log.info('cli.blackboard_fact_published', 'blackboard fact published', { path: target, commit_sha: sha, attempts });
      return { path: target, commit_sha: sha, cdn_url: cdnUrl(opts.repo, sha, target), attempts, unchanged: false };
    }

    lastErr = (push.stderr || push.stdout).trim();

    // Two distinct failures hide behind "push was refused", and they need opposite recoveries.
    //
    // `reference already exists` means the branch did not exist when we started and another
    // agent created it while we were working. Our HEAD is an ORPHAN commit with no ancestor in
    // common with theirs, so rebasing is not just wrong, it is impossible — there is nothing to
    // rebase onto. The fix is to restart the attempt: the top of this loop re-fetches, resets
    // the worktree onto the now-existing remote branch, and re-applies the file. Found by C3,
    // which races two first-publishes; a sequential test would never have hit it.
    const refExists = /reference already exists|cannot lock ref|stale info/i.test(lastErr);
    if (refExists) {
      log.info('cli.blackboard_branch_was_created', 'blackboard branch was created concurrently, restarting against it', {
        attempt: attempts,
        path: target,
      });
      continue;
    }

    const rejected = /\[rejected\]|non-fast-forward|fetch first|Updates were rejected/i.test(lastErr);
    if (!rejected) throw new BlackboardError('git push failed', lastErr);

    // C4: somebody else pushed first, on a branch we share history with. Rebase and retry.
    // Because it is one file per fact, this cannot conflict — the entire reason for the rule.
    log.info('cli.blackboard_push_rejected_rebasing', 'blackboard push rejected, rebasing', { attempt: attempts, path: target });
    const rebase = await run(['pull', '--rebase', remote, BLACKBOARD_BRANCH], wt);
    if (rebase.code !== 0) {
      await run(['rebase', '--abort'], wt);
      throw new BlackboardError(
        'rebase after push rejection failed',
        `${rebase.stderr.trim()} — this should be impossible under one-file-per-fact; ` +
          'check whether something is appending to a shared file.',
      );
    }
    const retry = await run(['push', remote, `HEAD:${BLACKBOARD_BRANCH}`], wt);
    if (retry.code === 0) {
      const sha = (await run(['rev-parse', 'HEAD'], wt)).stdout.trim();
      log.info('cli.blackboard_fact_published_after', 'blackboard fact published after rebase', { path: target, commit_sha: sha, attempts });
      return { path: target, commit_sha: sha, cdn_url: cdnUrl(opts.repo, sha, target), attempts, unchanged: false };
    }
    lastErr = (retry.stderr || retry.stdout).trim();
  }

  throw new BlackboardError(`push rejected after ${maxAttempts} attempts`, lastErr);
}

/**
 * Sha-pinned raw URL.
 *
 * Pinned to a commit, therefore immutable, therefore cacheable forever — each agent fetches
 * each contract exactly once, ever. Measured in blackboard.md: 34 ms here against 1,347 ms for
 * `git ls-remote`, a 40x difference for answering the same question.
 */
export const cdnUrl = (repo: string, commit_sha: string, filePath: string): string =>
  `https://raw.githubusercontent.com/${repo}/${commit_sha}/${filePath}`;

function commitMessage(kind: PublishRequest['kind'], body: Record<string, unknown>): string {
  const name = String(body.name ?? body.table ?? body.slug ?? 'fact');
  switch (kind) {
    case 'contract_published':
      return `publish ${name} v${body.version ?? 1}`;
    case 'schema_published':
      return `publish schema ${name}`;
    case 'decision_recorded':
      return `record decision ${name}`;
  }
}

/** Create the worktree if absent, and make sure the branch exists on the remote. */
async function prepareWorktree(
  run: typeof git,
  root: string,
  wt: string,
  remote: string,
  log: Logger,
): Promise<void> {
  const exists = await fs
    .access(path.join(wt, '.git'))
    .then(() => true)
    .catch(() => false);
  if (exists) return;

  await run(['fetch', remote, BLACKBOARD_BRANCH], root);
  const remoteHas = await run(['rev-parse', '--verify', `${remote}/${BLACKBOARD_BRANCH}`], root);

  await fs.mkdir(path.dirname(wt), { recursive: true });
  if (remoteHas.code === 0) {
    const add = await run(['worktree', 'add', '--force', wt, `${remote}/${BLACKBOARD_BRANCH}`], root);
    if (add.code !== 0) throw new BlackboardError('could not create the blackboard worktree', add.stderr.trim());
    // Detached at the remote tip; the push uses HEAD:branch so no local branch is needed.
    return;
  }

  // First publish in the repo: the branch does not exist yet. Create it as an orphan so the
  // blackboard carries only facts and none of the application history.
  //
  // This is racy by nature — another agent may be doing the same thing right now — and that is
  // handled at the push, not here. Trying to win the race with a lock would mean inventing a
  // distributed lock to create a git branch, when git already arbitrates it for us.
  log.info('cli.blackboard_branch_does_not', 'blackboard branch does not exist on the remote, creating it', { branch: BLACKBOARD_BRANCH });
  const add = await run(['worktree', 'add', '--detach', wt, 'HEAD'], root);
  if (add.code !== 0) throw new BlackboardError('could not create the blackboard worktree', add.stderr.trim());
  const orphan = await run(['checkout', '--orphan', BLACKBOARD_BRANCH], wt);
  if (orphan.code !== 0) throw new BlackboardError('could not create the orphan branch', orphan.stderr.trim());
  await run(['rm', '-rf', '--quiet', '.'], wt);
}

/**
 * Materialise a published fact onto the agent's disk from a pointer.
 *
 * Fetches by sha from the CDN, not with git. Writes to .agentic/contracts/ (or decisions/) and
 * returns the local path, which the caller puts in `body.local` BEFORE appending the inbox line
 * (B9). The agent then opens a file and makes no network call at all.
 */
export async function materialise(
  pointer: { path: string; commit_sha: string },
  opts: { root: string; repo: string; token?: string; fetchImpl?: typeof fetch },
  log: Logger,
): Promise<string> {
  const doFetch = opts.fetchImpl ?? fetch;
  const url = cdnUrl(opts.repo, pointer.commit_sha, pointer.path);

  // Local path mirrors the blackboard layout under .agentic/, so contracts/items-api.v2.yaml
  // lands at .agentic/contracts/items-api.v2.yaml — exactly what the file contract shows.
  const rel = path.join('.agentic', pointer.path);
  const abs = path.resolve(opts.root, rel);
  if (!abs.startsWith(path.resolve(opts.root, '.agentic') + path.sep)) {
    throw new BlackboardError('pointer path escapes .agentic', pointer.path);
  }

  // Sha-pinned content is immutable, so a local hit is always correct. No revalidation, ever.
  const cached = await fs.readFile(abs, 'utf8').catch(() => null);
  if (cached !== null) return rel;

  const res = await doFetch(url, {
    headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
  });
  if (!res.ok) {
    throw new BlackboardError(
      'could not fetch a published fact from the CDN',
      `${res.status} ${url}`,
    );
  }
  const text = await res.text();
  await fs.mkdir(path.dirname(abs), { recursive: true });
  // Write then rename, so an agent reading concurrently never sees a partial contract.
  const tmp = `${abs}.tmp`;
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, abs);
  log.info('cli.materialised_published_fact', 'materialised published fact', { path: pointer.path, local: rel, bytes: text.length });
  return rel;
}
