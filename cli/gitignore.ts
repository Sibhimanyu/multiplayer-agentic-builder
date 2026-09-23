// Keep Flotilla's local files out of git, by writing .gitignore rather than asking the human to.
//
// `ship` already refuses .flotilla-token, but ship is not the only way a commit happens. An agent
// told to "commit your work" runs `git add -A`, and a printed "add this to .gitignore" line was
// the only thing standing between that and a live credential on GitHub.

import fs from 'node:fs/promises';
import path from 'node:path';

/** What must never be committed. `.agentic/` is per-machine state; the token is a credential. */
export const IGNORED = ['.agentic/', '.flotilla-token'] as const;

/**
 * Append whichever of `entries` .gitignore does not already list. Idempotent; returns what it added.
 *
 * A line counts as present if it matches with or without a leading `/` or trailing `/`, so a
 * hand-written `/.agentic` is respected rather than duplicated.
 */
export async function ensureIgnored(root: string, entries: readonly string[] = IGNORED): Promise<string[]> {
  const file = path.join(root, '.gitignore');
  const current = await fs.readFile(file, 'utf8').catch(() => '');
  const norm = (s: string) => s.trim().replace(/^\//, '').replace(/\/$/, '');
  const have = new Set(current.split('\n').map(norm));
  const missing = entries.filter((e) => !have.has(norm(e)));
  if (missing.length === 0) return [];

  const sep = current === '' || current.endsWith('\n') ? '' : '\n';
  await fs.writeFile(file, `${current}${sep}# flotilla: local state and the agent token\n${missing.join('\n')}\n`, 'utf8');
  return missing;
}
