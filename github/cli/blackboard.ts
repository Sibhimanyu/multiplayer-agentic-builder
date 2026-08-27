// The git half of the system, per docs/reference/blackboard.md.
//
// Durable facts live in git; ephemeral coordination state lives in the store.
// Contracts and schemas are CODE -- versioned artifacts a human reviews in a PR
// -- so they go where diffs and review already work. Claims and presence are
// not, so they do not.
//
// THE ONE RULE: one file per fact, never a shared append-only markdown file.
// A single BLACKBOARD.md that every agent appends to conflicts on every merge
// from every branch, forever. One file per fact makes merges purely additive,
// so conflicts are structurally impossible.
//
// Route G note worth stating plainly: this file is IDENTICAL work for all three
// routes, because all three already use git for the blackboard. It is the one
// part of the system where route G's backend choice buys it nothing -- the
// other two get it for free too.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { GitRunner } from '../store/transport.ts';
import { StoreError } from '../../shared/store/errors.ts';
import type { Logger } from '../../shared/log.ts';
import { nullLogger } from '../../shared/log.ts';

export const BLACKBOARD_BRANCH = 'agentic/blackboard';

export interface ContractPointerBody {
  name: string;
  version: number;
  path: string;
  commit_sha: string;
  supersedes: number | null;
}

export interface PublishResult {
  path: string;
  commit_sha: string;
  /** Sha-pinned, therefore immutable, therefore cacheable forever. */
  raw_url: string;
}

export interface BlackboardOptions {
  git: GitRunner;
  /** "owner/repo" -- used to build the sha-pinned CDN URL. */
  repo: string;
  /** Working directory containing a clone whose origin is that repo. */
  cwd: string;
  log?: Logger;
  /** Push retries on rejection. One file per fact, so a rebase cannot conflict. */
  attempts?: number;
}

export function createBlackboard(opts: BlackboardOptions) {
  const log = opts.log ?? nullLogger;
  const attempts = opts.attempts ?? 3;

  async function git(args: string[], what: string): Promise<string> {
    const r = await opts.git.run(args);
    if (r.code !== 0) {
      throw new StoreError(`blackboard: ${what} failed`, { backend_message: r.stderr });
    }
    return r.stdout.trim();
  }

  /** Make sure the branch exists locally and tracks origin. */
  async function ensureBranch(): Promise<void> {
    const ls = await opts.git.run(['ls-remote', '--heads', 'origin', BLACKBOARD_BRANCH]);
    if (ls.code !== 0) {
      throw new StoreError('blackboard: could not reach origin', { backend_message: ls.stderr });
    }
    if (ls.stdout.trim() === '') {
      // First publish ever. An orphan branch, because the blackboard shares no
      // history with the app's code and a merge between them is meaningless.
      await git(['checkout', '--orphan', BLACKBOARD_BRANCH], 'create blackboard branch');
      await git(['rm', '-rf', '--cached', '.'], 'clear index').catch(() => '');
      return;
    }
    await opts.git.run(['fetch', '--quiet', 'origin', `${BLACKBOARD_BRANCH}:${BLACKBOARD_BRANCH}`]);
    await git(['checkout', BLACKBOARD_BRANCH], 'checkout blackboard branch');
  }

  /**
   * Publish one file as one fact.
   *
   * The agent names a file it has written into the working tree; the CLI does
   * the rest and rewrites the event body as a POINTER before publishing. The
   * agent never handles a commit sha -- that is checklist item C7.
   */
  async function publish(
    relPath: string, contents: string, message: string,
  ): Promise<PublishResult> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      await ensureBranch();

      const abs = join(opts.cwd, relPath);

      // Is this fact already published? A version is IMMUTABLE, so there are
      // exactly two cases and they need opposite answers.
      const existing = await opts.git.run(['show', `${BLACKBOARD_BRANCH}:${relPath}`]);
      if (existing.code === 0) {
        if (existing.stdout === contents) {
          // Identical bytes: an idempotent replay. The CLI's wire path is
          // deliberately at-least-once, so a re-send after a crash lands here
          // and MUST succeed with the original pointer rather than fail.
          const sha = await git(
            ['rev-list', '-1', BLACKBOARD_BRANCH, '--', relPath], 'find the publishing commit',
          );
          log.info('blackboard.alreadyPublished', 'identical fact already on the branch', {
            path: relPath, commit_sha: sha,
          });
          return { path: relPath, commit_sha: sha, raw_url: rawUrl(opts.repo, sha, relPath) };
        }
        // Different bytes at the same path. blackboard.md: "Versions are new
        // files, never edits. Editing items-api.v1.yaml in place destroys the
        // diff that tells a consumer what broke." Refuse loudly.
        throw new StoreError(
          `blackboard: ${relPath} already exists with different content. `
          + 'A version is immutable -- publish a new version rather than editing one.',
        );
      }

      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, contents, 'utf8');

      // ONE path. Never `git add -A` -- order 0004, and it is also what keeps a
      // publish from sweeping up an agent's unrelated working-tree mess.
      await git(['add', '--', relPath], `stage ${relPath}`);

      // "Nothing to commit" exits non-zero, and treating that as a failure is
      // what broke the second demo run after the first had already published
      // the same fact. Distinguish it from a real commit failure by asking
      // whether anything is actually staged.
      const staged = await opts.git.run(['diff', '--cached', '--quiet', '--', relPath]);
      if (staged.code === 0) {
        const sha = await git(
          ['rev-list', '-1', BLACKBOARD_BRANCH, '--', relPath], 'find the publishing commit',
        );
        return { path: relPath, commit_sha: sha, raw_url: rawUrl(opts.repo, sha, relPath) };
      }
      await git(['commit', '-m', message], 'commit');

      const push = await opts.git.push(['origin', `HEAD:${BLACKBOARD_BRANCH}`]);
      if (push.code === 0) {
        const sha = await git(['rev-parse', 'HEAD'], 'read commit sha');
        return {
          path: relPath,
          commit_sha: sha,
          raw_url: rawUrl(opts.repo, sha, relPath),
        };
      }

      // Someone published first. Because it is one file per fact, the rebase
      // cannot conflict -- that is the whole reason for the rule.
      log.info('blackboard.rejected', 'push rejected, rebasing and retrying', {
        path: relPath, attempt: attempt + 1,
      });
      const pull = await opts.git.run(['pull', '--rebase', '--quiet', 'origin', BLACKBOARD_BRANCH]);
      if (pull.code !== 0) {
        throw new StoreError('blackboard: rebase failed, so the one-file-per-fact rule was broken', {
          backend_message: pull.stderr,
        });
      }
    }
    throw new StoreError(`blackboard: could not publish ${relPath} in ${attempts} attempts`);
  }

  /**
   * Read a published blob back.
   *
   * Sha-pinned, so the answer is immutable and cacheable forever -- each agent
   * fetches each contract exactly once, ever. blackboard.md measures git at
   * ~1,350 ms against ~34 ms for a CDN read of the same bytes, which is why
   * consumers never use git for this.
   */
  async function readPinned(
    commit_sha: string, relPath: string, token: string,
    http: (url: string, init: { headers: Record<string, string> }) => Promise<{ status: number; body: string }>,
  ): Promise<string> {
    const url = `https://api.github.com/repos/${opts.repo}/contents/${relPath}?ref=${commit_sha}`;
    const res = await http(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        // Ask for the bytes, not the JSON envelope.
        Accept: 'application/vnd.github.raw',
      },
    });
    if (res.status < 200 || res.status >= 300) {
      throw new StoreError(`blackboard: could not read ${relPath}@${commit_sha}`, {
        cause_code: String(res.status),
      });
    }
    return res.body;
  }

  return { publish, readPinned, ensureBranch };
}

export function rawUrl(repo: string, sha: string, path: string): string {
  return `https://raw.githubusercontent.com/${repo}/${sha}/${path}`;
}

/** `contracts/<name>.v<n>.yaml` -- a version is a NEW FILE, never an edit. */
export function contractPath(name: string, version: number): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new RangeError(`contract name is not a safe path component: ${JSON.stringify(name)}`);
  }
  if (!Number.isInteger(version) || version < 1) {
    throw new RangeError(`contract version must be a positive integer, got ${version}`);
  }
  return `contracts/${name}.v${version}.yaml`;
}

export function schemaPath(table: string): string {
  if (!/^[a-z0-9][a-z0-9_]*$/.test(table)) {
    throw new RangeError(`schema table is not a safe path component: ${JSON.stringify(table)}`);
  }
  return `schema/${table}.sql`;
}

export function decisionPath(n: number, slug: string): string {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new RangeError(`decision slug is not a safe path component: ${JSON.stringify(slug)}`);
  }
  return `decisions/${String(n).padStart(4, '0')}-${slug}.md`;
}
