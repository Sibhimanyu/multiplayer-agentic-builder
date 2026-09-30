// Stale flags on blackboard facts. Extends docs/reference/blackboard.md.
//
// A contract, schema or decision is written ABOUT some code. The code keeps moving; the fact does
// not, because a published fact is immutable (C6). Nothing connected the two, so a decision that
// said "qty is validated in server/items/validate.ts" stayed on the blackboard, looking exactly as
// authoritative, for weeks after that file was rewritten -- and an agent handed it had no way to
// know the ground had shifted under it.
//
// A fact may now PIN the paths it describes:
//
//     pins:
//       - server/items/**
//       - schema/items.sql
//
// and it is STALE when a commit touching any pinned path is newer than the fact's own last
// commit. That is the whole rule, and it is computed from git history every time it is asked --
// there is no stored "verified" flag to drift. A fact is NEVER edited by this file: stale is a
// flag for a human or an agent to review, not a correction.
//
// Clearing it is therefore just git: a new commit to the fact on agentic/blackboard makes the
// fact's last commit newer than the code again. For a contract that commit is the next version,
// because versions are new files; an older version is `superseded` and never flagged at all.
//
// CHEAP ON PURPOSE. It runs inside `flotilla status` and `flotilla claim`, so it touches only
// local refs: one ls-tree and one log over the blackboard branch, one `show` per fact, and one
// log per pinned fact over the code. No fetch, except where a human explicitly asks (`facts`).
// The blackboard doc's rule stands -- never poll git.

import { BLACKBOARD_BRANCH, git } from './blackboard.ts';
import { globsIntersect, normalizeGlob } from '../shared/globs.ts';
import { nullLogger } from '../shared/log.ts';
import { sanitizeText, VARCHAR_MAX } from '../shared/sanitize.ts';

/** The three directories a fact can live in. Anything else on the branch is not a fact. */
export const FACT_DIRS = ['contracts', 'schema', 'decisions'] as const;

export type FactStatus = 'fresh' | 'stale' | 'unpinned' | 'superseded';

export interface MovedCommit {
  sha: string;
  subject: string;
  /** Unix seconds, committer date. */
  committed_at: number;
}

export interface Fact {
  /** Path on the blackboard branch, e.g. contracts/items-api.v2.yaml. */
  path: string;
  /** The fact's own last commit on the blackboard branch. */
  commit_sha: string;
  committed_at: number;
  pins: string[];
  /** Why part of a pins declaration was ignored. Shown, never fatal: a typo must not hide a fact. */
  problems: string[];
  status: FactStatus;
  /** Newest first, capped. The commits that moved pinned code after the fact was written. */
  moved: MovedCommit[];
  /** True when more commits moved the code than `moved` shows. */
  more: boolean;
  /** Pins that match no tracked file. A pin that matches nothing can never go stale. */
  dangling: string[];
}

export interface ParsedPins {
  pins: string[];
  problems: string[];
}

// ---- parsing ------------------------------------------------------------------------------

/**
 * The pins a fact declares. ONE SYNTAX, three carriers:
 *
 *   contracts/*.yaml   a top-level `pins:` key
 *   decisions/*.md     a `pins:` key in YAML frontmatter (--- ... --- as the first lines)
 *   schema/*.sql       a `pins:` key in the leading `--` comment block
 *
 * The value is a YAML list of git-style globs, block (`- glob` per line) or flow (`[a, b]`).
 *
 * NOT A YAML PARSER, deliberately. The repo has no YAML dependency, a contract can be large, and
 * the only thing read is one key. So this reads exactly that key, forgivingly: a malformed item
 * is dropped and NAMED in `problems`, and the rest of the list still counts. The alternative --
 * refusing the whole declaration -- turns one typo into a fact that silently reads `unpinned`,
 * which is the failure this feature exists to remove.
 */
export function parsePins(filePath: string, content: string): ParsedPins {
  const text = content.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();

  if (ext === '.yaml' || ext === '.yml') return parsePinsBlock(text);

  if (ext === '.md') {
    // Frontmatter must be the very first line, as every static-site tool reads it. A `---`
    // further down is a markdown horizontal rule, not metadata.
    const lines = text.split('\n');
    if (lines[0]?.trim() !== '---') return { pins: [], problems: [] };
    const close = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    if (close === -1) {
      return { pins: [], problems: ['frontmatter opens with --- but never closes, so its pins were not read'] };
    }
    return parsePinsBlock(lines.slice(1, close).join('\n'));
  }

  if (ext === '.sql') {
    // The leading comment block only. `--` prefix plus one optional space is removed, so the
    // indentation of `--   - glob` survives and the same block parser reads it.
    const header: string[] = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '' && header.length === 0) continue;
      if (!line.startsWith('--')) break;
      header.push(line.slice(2).replace(/^ /, ''));
    }
    return parsePinsBlock(header.join('\n'));
  }

  return { pins: [], problems: [] };
}

/** Read the top-level `pins:` key out of a YAML-shaped block. */
export function parsePinsBlock(block: string): ParsedPins {
  const lines = block.split('\n');
  const problems: string[] = [];
  const raw: string[] = [];

  const starts = lines.flatMap((l, i) => (/^pins\s*:/.test(l) ? [i] : []));
  if (starts.length === 0) return { pins: [], problems: [] };
  if (starts.length > 1) problems.push('pins: is declared more than once; only the first is read');

  const at = starts[0]!;
  const rest = stripComment(lines[at]!.replace(/^pins\s*:/, '')).trim();

  if (rest.startsWith('[')) {
    if (!rest.endsWith(']')) {
      problems.push('pins: [ is never closed with ], so the list was not read');
    } else {
      const inner = rest.slice(1, -1).trim();
      if (inner !== '') raw.push(...inner.split(','));
    }
  } else if (rest !== '') {
    // `pins: server/**` is a YAML scalar, not a list. Read as the one-item list it obviously
    // means rather than refused on a technicality.
    raw.push(rest);
  } else {
    for (let i = at + 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() === '' || /^\s*#/.test(line)) continue;
      if (!/^\s/.test(line)) break; // the next top-level key: the list is over
      const item = /^\s+-\s*(.*)$/.exec(line);
      if (!item) {
        problems.push(`pins: expected "- <glob>", got ${JSON.stringify(line.trim())}`);
        continue;
      }
      raw.push(stripComment(item[1]!));
    }
    if (raw.length === 0 && problems.length === 0) {
      problems.push('pins: is present but lists nothing; write pins: [] to say "no pins" on purpose');
    }
  }

  const pins: string[] = [];
  for (const r of raw) {
    const checked = checkPin(r);
    if ('problem' in checked) problems.push(checked.problem);
    else if (!pins.includes(checked.pin)) pins.push(checked.pin);
  }
  return { pins, problems };
}

/** A trailing ` # comment`, which YAML allows after an unquoted value. */
function stripComment(s: string): string {
  const t = s.trim();
  if (t.startsWith('"') || t.startsWith("'")) return t;
  return t.replace(/\s+#.*$/, '');
}

/**
 * One glob, validated.
 *
 * Every pin reaches `git log -- :(glob)<pin>`, so it is agent-authored text headed for a git
 * pathspec. A leading `:` would smuggle in other pathspec magic and a leading `!` would negate it;
 * `..` and absolute paths point outside the repository. All refused, by name.
 */
function checkPin(raw: string): { pin: string } | { problem: string } {
  let p = raw.trim();
  if ((p.startsWith('"') && p.endsWith('"') && p.length >= 2) || (p.startsWith("'") && p.endsWith("'") && p.length >= 2)) {
    p = p.slice(1, -1).trim();
  }
  if (p === '') return { problem: 'pins: an empty item was ignored' };
  if (p.startsWith('/') || /^[a-z]:[\\/]/i.test(p)) return { problem: `pins: ${p} is absolute; pins are repo-relative` };
  if (p.startsWith(':') || p.startsWith('!')) return { problem: `pins: ${p} starts with ${p[0]}, which git would read as pathspec magic` };
  if (p.split(/[\\/]/).includes('..')) return { problem: `pins: ${p} climbs out of the repository with ..` };
  return { pin: normalizeGlob(p) };
}

// ---- git -----------------------------------------------------------------------------------

export interface ReadFactsOptions {
  /** The blackboard ref. Resolved from the local refs when absent. */
  ref?: string;
  /** Where the CODE lives. HEAD: the code this checkout is looking at. */
  code_ref?: string;
  /** Commits to list per stale fact. */
  limit?: number;
  runner?: typeof git;
}

/**
 * The local ref holding the blackboard, or null. Remote-tracking first: it is what the last
 * publish or fetch saw, and a local branch of the same name is usually an old checkout of it.
 */
export async function blackboardRef(root: string, run: typeof git = git): Promise<string | null> {
  for (const ref of [`refs/remotes/origin/${BLACKBOARD_BRANCH}`, `refs/heads/${BLACKBOARD_BRANCH}`]) {
    const r = await run(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], root, 15_000);
    if (r.code === 0) return ref;
  }
  return null;
}

/** `contracts/items-api.v2.yaml` -> { name: 'items-api', version: 2 }. */
function contractVersion(p: string): { name: string; version: number } | null {
  const m = /^contracts\/(.+)\.v(\d+)\.ya?ml$/.exec(p);
  return m ? { name: m[1]!, version: Number(m[2]) } : null;
}

/**
 * Every fact on the blackboard, with its freshness.
 *
 * TIME IS COMMITTER TIME, compared across two histories. The blackboard is an orphan branch, so a
 * fact and the code it describes share no ancestry and "newer" cannot be a graph question; it is
 * a clock question. Committer date rather than author date because a rebase or cherry-pick that
 * lands old work today IS the code moving today. The cost is clock skew between machines, which
 * at worst shifts a flag by the skew -- acceptable for a flag whose whole job is "go and look".
 */
export async function readFacts(root: string, opts: ReadFactsOptions = {}): Promise<{ ref: string | null; facts: Fact[] }> {
  const run = opts.runner ?? git;
  const codeRef = opts.code_ref ?? 'HEAD';
  const limit = opts.limit ?? 5;
  const ref = opts.ref ?? (await blackboardRef(root, run));
  if (!ref) return { ref: null, facts: [] };

  const tree = await run(['ls-tree', '-r', '-z', '--name-only', ref, '--', ...FACT_DIRS], root, 15_000);
  if (tree.code !== 0) return { ref, facts: [] };
  const paths = tree.stdout.split('\0').filter(Boolean);
  if (paths.length === 0) return { ref, facts: [] };

  // One walk of the blackboard's history gives every fact its last commit: newest first, so the
  // first time a path appears is the commit that last touched it.
  const log = await run(['log', '--format=%x1e%H%x09%ct', '--name-only', ref, '--', ...FACT_DIRS], root, 15_000);
  const last = new Map<string, { sha: string; ct: number }>();
  for (const rec of log.stdout.split('\x1e')) {
    const [head, ...names] = rec.split('\n');
    const [sha, ct] = (head ?? '').split('\t');
    if (!sha || !ct) continue;
    for (const n of names) if (n && !last.has(n)) last.set(n, { sha, ct: Number(ct) });
  }

  const newest = new Map<string, number>();
  for (const p of paths) {
    const v = contractVersion(p);
    if (v) newest.set(v.name, Math.max(newest.get(v.name) ?? 0, v.version));
  }

  const facts: Fact[] = [];
  for (const p of paths.sort()) {
    const own = last.get(p) ?? { sha: '', ct: 0 };
    const fact: Fact = {
      path: p, commit_sha: own.sha, committed_at: own.ct,
      pins: [], problems: [], status: 'unpinned', moved: [], more: false, dangling: [],
    };
    facts.push(fact);

    // A superseded version is history, not a claim about the present. Flagging v1 stale forever
    // after v2 exists would make every contract ever revised look like an open problem.
    const v = contractVersion(p);
    if (v && v.version < (newest.get(v.name) ?? 0)) {
      fact.status = 'superseded';
      continue;
    }

    const body = await run(['show', `${ref}:${p}`], root, 15_000);
    if (body.code !== 0) continue;
    const parsed = parsePins(p, body.stdout);
    fact.pins = parsed.pins;
    fact.problems = parsed.problems;
    if (fact.pins.length === 0) continue;

    const spec = fact.pins.map((g) => `:(glob)${g}`);
    const moved = await run(
      ['log', '-n', String(limit + 1), '--format=%H%x09%ct%x09%s', codeRef, '--', ...spec],
      root, 15_000,
    );
    const newer = moved.stdout
      .split('\n')
      .map((l) => l.split('\t'))
      .filter((f) => f.length >= 3 && Number(f[1]) > own.ct)
      .map((f) => ({ sha: f[0]!, committed_at: Number(f[1]), subject: f.slice(2).join('\t') }));
    fact.status = newer.length > 0 ? 'stale' : 'fresh';
    fact.moved = newer.slice(0, limit);
    fact.more = newer.length > limit;

    for (const g of fact.pins) {
      const files = await run(['ls-files', '--', `:(glob)${g}`], root, 15_000);
      if (files.code === 0 && files.stdout.trim() === '') fact.dangling.push(g);
    }
  }
  return { ref, facts };
}

/**
 * readFacts, never throwing. For the paths that surface staleness in passing -- status, claim,
 * the MCP tool -- where a missing git or an odd repo must cost the flag, not the command.
 */
export async function readFactsQuietly(root: string, opts: ReadFactsOptions = {}): Promise<Fact[]> {
  try {
    return (await readFacts(root, opts)).facts;
  } catch {
    return [];
  }
}

/**
 * Stale facts whose pins overlap a scope. Intersection, not containment: a fact pinned to
 * `server/**` is about the file an agent holding `server/items.ts` is about to edit.
 */
export function staleTouching(facts: readonly Fact[], scope: readonly string[]): Fact[] {
  return facts.filter((f) => f.status === 'stale' && f.pins.some((p) => scope.some((s) => globsIntersect(p, s))));
}

// ---- rendering -----------------------------------------------------------------------------

const day = (unix: number): string => (unix > 0 ? new Date(unix * 1000).toISOString().slice(0, 10) : '?');

/** `flotilla facts`. For a human at a terminal. */
export function renderFactsReport(ref: string | null, facts: readonly Fact[]): string {
  if (!ref) {
    return [
      `no blackboard here: ${BLACKBOARD_BRANCH} is not in this checkout`,
      'nothing has been published yet, or it has not been fetched',
    ].join('\n');
  }
  if (facts.length === 0) return `${shortRef(ref)} holds no facts yet`;

  const count = (s: FactStatus) => facts.filter((f) => f.status === s).length;
  const lines = [
    `${shortRef(ref)}  ${facts.length} fact(s): ${count('stale')} stale, ${count('fresh')} fresh, ` +
      `${count('unpinned')} unpinned${count('superseded') ? `, ${count('superseded')} superseded` : ''}`,
    '',
  ];
  const width = Math.max(...facts.map((f) => f.path.length));
  for (const f of facts) {
    const label = f.status === 'stale' ? 'STALE' : f.status;
    const pins = f.pins.length ? `  pins ${f.pins.join(', ')}` : '';
    lines.push(`${label.padEnd(10)} ${f.path.padEnd(width)}${pins}`);
    if (f.status === 'stale') {
      lines.push(`           last committed ${f.commit_sha.slice(0, 8)} ${day(f.committed_at)}; the code it pins moved since:`);
      for (const m of f.moved) lines.push(`             ${m.sha.slice(0, 8)}  ${day(m.committed_at)}  ${m.subject}`);
      if (f.more) lines.push('             ... and more');
    }
    for (const g of f.dangling) lines.push(`           ! pin ${g} matches no tracked file, so it can never go stale`);
    for (const p of f.problems) lines.push(`           ! ${p}`);
  }
  if (count('stale') > 0) {
    lines.push(
      '',
      'Stale is a flag, not an edit: nothing on the blackboard was changed.',
      'Re-verify each one against the code. If it still holds, re-commit it on',
      `${BLACKBOARD_BRANCH} (for a contract: publish the next version) and it reads fresh.`,
    );
  }
  return lines.join('\n');
}

const shortRef = (ref: string): string => ref.replace(/^refs\/(remotes|heads)\//, '');

/**
 * The same flags, for an agent. Goes into current-task.md and the MCP tools.
 *
 * NO DATES, deliberately: this lands in the agent's tree, which must be byte-identical between
 * the two builds (B2). A sha and a subject are git facts, the same for both; a rendered date is
 * a function of the machine's timezone.
 */
export function renderStaleForAgent(stale: readonly Fact[]): string[] {
  if (stale.length === 0) return [];
  return [
    'These blackboard facts describe files in your scope, and that code has changed since',
    'the fact was last committed. Re-verify each against the code before you rely on it. If',
    'one no longer holds, say so with task_progress or task_blocked; do not edit the fact.',
    '',
    ...stale.map((f) => {
      const by = f.moved[0];
      const tail = by ? ` — moved by ${by.sha.slice(0, 8)} "${by.subject}"${f.moved.length > 1 || f.more ? ' and later commits' : ''}` : '';
      // A commit subject is free text from whoever committed; it gets the same scrub as every
      // other string headed for the agent's tree.
      return sanitizeText(`- ${f.path} (pins ${f.pins.join(', ')})${tail}`, { field: 'fact.stale', max: VARCHAR_MAX, log: nullLogger });
    }),
  ];
}
