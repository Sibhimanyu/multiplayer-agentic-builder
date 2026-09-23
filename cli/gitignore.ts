// Keep Flotilla's local files out of git, without asking the human and without a commit.
//
// `ship` already refuses .flotilla-token, but ship is not the only way a commit happens. An agent
// told to "commit your work" runs `git add -A`, and a printed "add this to .gitignore" line was
// the only thing standing between that and a live credential on GitHub.
//
// .git/info/exclude, NOT .gitignore. Writing .gitignore made it a local change in every fresh
// checkout -- one only the owner's scope may commit -- so every other agent's `ship` warned about
// it forever and `sync` could never be clean. The exclude file is per-checkout, is never itself a
// change, and is exactly what these entries are: facts about this machine, not about the repo.
// A directory that is not a git repo (and so has no exclude file) falls back to .gitignore.

import fs from 'node:fs/promises';
import path from 'node:path';

import { git } from './blackboard.ts';

/** Never committed: `.agentic/` is per-machine state, the token a credential, AGENTS.md generated per checkout. */
export const IGNORED = ['.agentic/', '.flotilla-token', 'AGENTS.md'] as const;

const norm = (s: string) => s.trim().replace(/^\//, '').replace(/\/$/, '');

/** Where to write: the checkout's exclude file, or .gitignore outside a repo. */
async function target(root: string): Promise<string> {
  const r = await git(['rev-parse', '--git-path', 'info/exclude'], root).catch(() => null);
  if (!r || r.code !== 0 || !r.stdout.trim()) return path.join(root, '.gitignore');
  return path.resolve(root, r.stdout.trim());
}

/**
 * Add whichever of `entries` neither .gitignore nor the exclude file already lists. Idempotent;
 * returns what it added. A line counts as present with or without a leading or trailing `/`.
 */
export async function ensureIgnored(root: string, entries: readonly string[] = IGNORED): Promise<string[]> {
  const file = await target(root);
  const current = await fs.readFile(file, 'utf8').catch(() => '');
  const committed = await fs.readFile(path.join(root, '.gitignore'), 'utf8').catch(() => '');
  const have = new Set(`${current}\n${committed}`.split('\n').map(norm));
  const missing = entries.filter((e) => !have.has(norm(e)));
  if (missing.length === 0) return [];

  await fs.mkdir(path.dirname(file), { recursive: true });
  const sep = current === '' || current.endsWith('\n') ? '' : '\n';
  await fs.writeFile(file, `${current}${sep}# flotilla: local state and the agent token\n${missing.join('\n')}\n`, 'utf8');
  return missing;
}
