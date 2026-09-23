// `flotilla sync`: bring the working tree up to date after your shipped work has merged.
//
// `ship` commits onto the agent branch WITHOUT touching the working tree, on purpose -- the agent
// is editing it right now. The cost shows up after the merge: the shipped edits are still sitting
// there as local changes, and the next `git pull` refuses to overwrite them. Found when a merged
// duplicate-SKU fix blocked the owner's pull of the next PR.
//
// The rule is narrow so it can never lose work: a local change is discarded ONLY if its exact
// bytes already exist in the remote branch's history for that path. That version is in git, so
// dropping the local copy loses nothing. Anything else -- a deletion, a half-finished edit, a
// file the remote never had -- is left exactly as it is.

import fs from 'node:fs/promises';
import path from 'node:path';

import { git } from './blackboard.ts';
import { parseStatus } from './ship.ts';

/** Never touched by sync, landed or not: the credential and the agent's own tree. */
const NEVER = ['.flotilla-token', '.agentic/', 'AGENTS.md'];

export interface LandedResult {
  /** Local changes whose content is already in the remote history: safe to drop. */
  landed: string[];
  /** Everything else. Left alone. */
  kept: string[];
}

/** Blob ids a path has had on `ref`, newest first. Bounded: a sync is not a history audit. */
async function blobsOnRef(root: string, ref: string, file: string): Promise<Set<string>> {
  const r = await git(['log', '--raw', '--no-abbrev', '--format=', '-n', '200', ref, '--', file], root);
  const out = new Set<string>();
  for (const line of r.stdout.split('\n')) {
    // ":100644 100644 <old> <new> M\tpath"
    const m = /^:\d+ \d+ [0-9a-f]+ ([0-9a-f]+) /.exec(line);
    if (m && !/^0+$/.test(m[1]!)) out.add(m[1]!);
  }
  return out;
}

export async function landedChanges(root: string, ref: string): Promise<LandedResult> {
  const status = await git(['status', '--porcelain', '-z', '-uall'], root);
  const result: LandedResult = { landed: [], kept: [] };
  for (const file of parseStatus(status.stdout)) {
    if (NEVER.some((n) => (n.endsWith('/') ? file.startsWith(n) : file === n))) continue;
    const exists = await fs.stat(path.join(root, file)).then(() => true, () => false);
    if (!exists) { result.kept.push(file); continue; } // a deletion is a decision, not a leftover
    const blob = (await git(['hash-object', '--', file], root)).stdout.trim();
    ((await blobsOnRef(root, ref, file)).has(blob) ? result.landed : result.kept).push(file);
  }
  return result;
}

/** Drop the landed copies: restore tracked files to HEAD, remove untracked ones. */
export async function dropLanded(root: string, files: readonly string[]): Promise<void> {
  for (const file of files) {
    const tracked = (await git(['ls-files', '--error-unmatch', '--', file], root)).code === 0;
    if (tracked) await git(['checkout', 'HEAD', '--', file], root);
    else await fs.rm(path.join(root, file));
  }
}
