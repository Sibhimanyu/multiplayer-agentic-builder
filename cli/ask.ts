// `flotilla ask` — a ticket from a line of code.
//
// A ticket typed on the board says "fix the qty validation" and nothing else. The agent that
// claims it then spends its first minutes finding which file, which function, which line the
// person was looking at when they wrote it -- context the person HAD, at the moment they filed
// it, and threw away by typing a sentence instead of pointing.
//
// So you point:
//
//     flotilla ask server/items.ts:40-52 "reject negative qty here"
//
// and the ticket carries the file, the line range and the code itself, with a few lines either
// side. The scope is that one file and the kind is whichever role's fence covers it, so the ticket
// lands in the right swimlane and `flotilla claim` hands it to an agent that may actually edit it.
//
// `--scan` does the same for marker comments left in the code, one ticket per marker. The marker
// is the word FLOTILLA and a colon, after any comment opener, followed by the request.
//
// CREATION IS NOT REIMPLEMENTED HERE. Every ticket goes through the same write `flotilla task`
// uses (the injected ProjectCommands.createTask), which is the one way work appears -- decision
// 0005. This file only decides WHAT to file.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { git } from './blackboard.ts';
import { globContains } from '../shared/store/roles.ts';
import { ROLE_SLUGS, roleFor } from '../shared/store/directory.ts';
import { TASK_KINDS, isTaskKind } from '../shared/store/tasks.ts';
import type { NewTask } from '../shared/store/tasks.ts';
import type { TaskKind } from '../shared/store/types.ts';

// ---- the target ------------------------------------------------------------------------------

export interface AskTarget {
  file: string;
  start: number;
  end: number;
}

/**
 * `path/to/file.ts:12` or `path/to/file.ts:12-20`.
 *
 * Split on the LAST colon, so a path that itself contains one still parses. Refused, never
 * guessed: `file.ts` with no line would make a ticket that points nowhere, which is the ticket
 * this command exists to replace.
 */
export function parseTarget(arg: string): AskTarget | { error: string } {
  const i = arg.lastIndexOf(':');
  const usage = 'expected <file>:<line> or <file>:<line>-<endline>';
  if (i <= 0) return { error: `${usage}, got ${JSON.stringify(arg)}` };
  const file = arg.slice(0, i);
  const m = /^(\d+)(?:-(\d+))?$/.exec(arg.slice(i + 1));
  if (!m) return { error: `${usage}, got ${JSON.stringify(arg)}` };
  const start = Number(m[1]);
  const end = m[2] === undefined ? start : Number(m[2]);
  if (start < 1) return { error: `lines count from 1, got ${start}` };
  if (end < start) return { error: `the range ends before it starts: ${start}-${end}` };
  return { file, start, end };
}

/**
 * The target as a repo-relative POSIX path, or why not.
 *
 * Confined to the working tree: the path becomes a file scope, and `../elsewhere` would lock a
 * path in no repository at all.
 */
export async function resolveTarget(root: string, file: string): Promise<{ rel: string; text: string } | { error: string }> {
  const abs = path.resolve(root, file);
  const rootAbs = path.resolve(root);
  if (!abs.startsWith(rootAbs + path.sep)) return { error: `${file} is outside this repository` };
  const stat = await fs.stat(abs).catch(() => null);
  if (!stat) return { error: `${file} does not exist` };
  if (!stat.isFile()) return { error: `${file} is not a file` };
  const text = await fs.readFile(abs, 'utf8');
  return { rel: path.relative(rootAbs, abs).split(path.sep).join('/'), text };
}

// ---- the snippet -----------------------------------------------------------------------------

export interface SnippetOptions {
  /** Lines shown either side of the range. */
  context?: number;
  /** Hard cap on lines shown, context included. */
  max_lines?: number;
  /** Any one line longer than this is cut. Minified files are one line. */
  max_line_chars?: number;
}

/**
 * The requested lines, numbered, with context, CAPPED.
 *
 * Capped because it lands in a ticket description, which is stored text with a 10,000-character
 * column, and which an agent reads into its context. The point is "look here", not a copy of the
 * file: a 400-line range shows its first lines and says how many it left out, and the agent opens
 * the file for the rest. At the defaults the worst case is 40 x 160 characters, well inside the
 * column with the request and the fences around it.
 */
export function snippet(text: string, start: number, end: number, opts: SnippetOptions = {}): string | { error: string } {
  const context = opts.context ?? 3;
  const maxLines = opts.max_lines ?? 40;
  const maxChars = opts.max_line_chars ?? 160;
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  // Past the end is refused, not clamped: `:12-900` in a 50-line file is a typo, and a ticket
  // pointing at lines that never existed sends the agent looking for code that is not there.
  if (end > lines.length) return { error: `line ${end} is past the end: the file has ${lines.length} line(s)` };
  const last = end;

  const from = Math.max(1, start - context);
  const to = Math.min(lines.length, last + context);
  const width = String(to).length;
  const out: string[] = [];
  for (let n = from; n <= to; n++) {
    if (out.length === maxLines) {
      out.push(`${' '.repeat(width + 2)}... ${to - n + 1} more line(s) not shown`);
      break;
    }
    let line = lines[n - 1] ?? '';
    if (line.length > maxChars) line = `${line.slice(0, maxChars)} ...`;
    const mark = n >= start && n <= last ? '>' : ' ';
    out.push(`${mark} ${String(n).padStart(width)}  ${line}`);
  }
  return out.join('\n');
}

// ---- the kind --------------------------------------------------------------------------------

/**
 * Which ticket kind a file belongs to, from which role's FENCE covers it.
 *
 * A kind is a role slug (backend, frontend, qa); scripts/board.ts reads the same correspondence
 * to find the kinds no role owns. The fence is the project's policy when it has one, else the
 * template. Containment, the same test `flotilla claim` and the server apply: a ticket whose one
 * file no role may edit would sit on the board forever, refused to every agent that picked it.
 *
 * `**` is not a fence, it is the absence of one -- the owner's. Counting it would make every file
 * "covered", and every ticket would come back ambiguous.
 */
export function kindFor(
  file: string,
  scopes: Readonly<Record<string, readonly string[]>> = {},
): { kind: TaskKind } | { error: string; candidates: TaskKind[] } {
  const candidates = TASK_KINDS
    .filter((k) => (ROLE_SLUGS as readonly string[]).includes(k))
    .filter((r) => (scopes[r] ?? roleFor(r).file_scope).some((g) => g !== '**' && globContains(g, file)));
  if (candidates.length === 1) return { kind: candidates[0]! };
  if (candidates.length === 0) {
    return {
      error: `no role's fence covers ${file}, so no agent could take this ticket. ` +
        `Pass --kind <${TASK_KINDS.join('|')}>, or redraw a fence with \`flotilla role <role> --scope\``,
      candidates,
    };
  }
  return {
    error: `${file} is inside more than one role's fence (${candidates.join(', ')}); pass --kind to choose`,
    candidates,
  };
}

// ---- the ticket ------------------------------------------------------------------------------

/** Longest title we will build from a request. The column is 255; a card title is read at a glance. */
const TITLE_MAX = 120;

/**
 * `task_ask_<slug>_<hash>`, from the file and the request -- never the line.
 *
 * STABLE ON PURPOSE. Re-scanning must land on the same id so the store reports "already exists"
 * instead of a second card, which is the same trade deriveTaskId makes. The line is left out so
 * that inserting code above a marker does not file it again. The file is kept in, so the same
 * sentence left in two files is two tickets, which it is.
 */
export function askTaskId(file: string, request: string): string {
  const slug = request.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 24).replace(/_+$/g, '') || 'note';
  const hash = createHash('sha256').update(`${file}\n${request.trim()}`).digest('hex').slice(0, 8);
  return `task_ask_${slug}_${hash}`;
}

export function askTitle(request: string): string {
  const t = request.trim().replace(/\s+/g, ' ');
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 3)}...` : t;
}

export function askDescription(t: { file: string; start: number; end: number; code: string; request: string; via: 'ask' | 'marker' }): string {
  const where = t.start === t.end ? `${t.file}:${t.start}` : `${t.file}:${t.start}-${t.end}`;
  // Longer than any backtick run in the code, so a markdown file's own fences cannot close ours.
  const fence = '`'.repeat(Math.max(3, ...[...t.code.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return [
    t.request.trim(),
    '',
    `Where: ${where}${t.via === 'marker' ? ' (a FLOTILLA marker comment; remove it when this is done)' : ''}`,
    '',
    'The code, as it was when this was filed (lines marked > are the ones meant):',
    '',
    fence,
    t.code,
    fence,
  ].join('\n');
}

/** Everything needed to file one ticket through the task path. */
export function askTask(
  target: AskTarget & { code: string },
  request: string,
  kind: TaskKind,
  via: 'ask' | 'marker',
  task_id?: string,
): NewTask & { task_id: string } {
  return {
    task_id: task_id ?? askTaskId(target.file, request),
    title: askTitle(request),
    kind,
    file_scope: [target.file],
    description: askDescription({ ...target, request, via }),
  };
}

// ---- markers ---------------------------------------------------------------------------------

/**
 * The marker word, assembled rather than written out: a literal copy of it after a comment
 * opener anywhere in this repository would be found by `--scan` on this repository.
 */
const MARKER = ['FLOTILLA', ':'].join('');

/**
 * A marker after a comment opener: // # -- /* * <!-- ; %
 *
 * The opener must start the line or follow whitespace, so `foo(); // ...` counts and a marker
 * quoted inside backticks in prose does not. Uppercase only: "flotilla: ..." in a sentence is
 * somebody talking about the product, not asking it for something.
 */
const MARKER_RE = new RegExp(`(?:^|\\s)(?://+|#+|--|/\\*+|\\*|<!--|;+|%+)\\s*${MARKER}\\s*(.*?)\\s*(?:\\*+/|-->)?\\s*$`);

export interface Marker {
  file: string;
  line: number;
  request: string;
}

/** Markers in one file's text. A `<placeholder>` request is documentation, not a request. */
export function markersIn(file: string, text: string): Marker[] {
  const out: Marker[] = [];
  const lines = text.split(/\r\n?|\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = MARKER_RE.exec(lines[i]!);
    const request = m?.[1]?.trim() ?? '';
    if (!m || request === '' || /^<[^>]*>$/.test(request)) continue;
    out.push({ file, line: i + 1, request });
  }
  return out;
}

/** Big enough for any source file a person writes by hand; small enough to skip bundles. */
const SCAN_MAX_BYTES = 1_000_000;

/**
 * Every marker in the files git tracks.
 *
 * Tracked only: node_modules, build output and a teammate's scratch files are not requests to
 * this team, and `git ls-files` is the repository's own answer to "what is part of this".
 */
export async function scanMarkers(root: string, run: typeof git = git): Promise<{ files: number; markers: Marker[] }> {
  const ls = await run(['ls-files', '-z'], root, 30_000);
  if (ls.code !== 0) throw new Error(`git ls-files failed: ${ls.stderr.trim()}`);
  const files = ls.stdout.split('\0').filter(Boolean);
  const markers: Marker[] = [];
  for (const f of files) {
    const abs = path.join(root, f);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat?.isFile() || stat.size > SCAN_MAX_BYTES) continue;
    const buf = await fs.readFile(abs);
    // A NUL in the first 8 KB is how git itself decides a file is binary.
    if (buf.subarray(0, 8192).includes(0)) continue;
    markers.push(...markersIn(f, buf.toString('utf8')));
  }
  return { files: files.length, markers };
}

// ---- running it ------------------------------------------------------------------------------

/** One ticket through the task path. `created: false` means the id already existed. */
export type CreateTask = (t: NewTask & { task_id: string }) => Promise<{ created: boolean; task_id: string }>;

export interface AskDeps {
  root: string;
  /** The project's role fences, or {} for the template. */
  scopes: Readonly<Record<string, readonly string[]>>;
  create: CreateTask;
  out: (s: string) => void;
}

/** Parsed `flotilla ask` arguments. */
export interface AskArgs {
  scan: boolean;
  dry_run: boolean;
  kind?: string;
  id?: string;
  target?: string;
  request?: string;
}

/**
 * `ask <file>:<line> "<request>" [--kind k] [--id id]`, or `ask --scan [--dry-run] [--kind k]`.
 * The request is everything positional after the target, so it works unquoted.
 */
export function parseAskArgs(argv: string[]): AskArgs | { error: string } {
  const a: AskArgs = { scan: false, dry_run: false };
  const pos: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    if (v === '--scan') a.scan = true;
    else if (v === '--dry-run') a.dry_run = true;
    else if (v === '--kind' || v === '--id') {
      const val = argv[++i];
      if (val === undefined || val.startsWith('--')) return { error: `${v} needs a value` };
      if (v === '--kind') a.kind = val;
      else a.id = val;
    } else if (v.startsWith('--')) return { error: `unknown flag ${v}` };
    else pos.push(v);
  }
  if (a.kind !== undefined && !isTaskKind(a.kind)) {
    return { error: `--kind must be one of: ${TASK_KINDS.join(', ')} (got "${a.kind}")` };
  }
  if (a.scan) {
    if (pos.length > 0) return { error: '--scan takes no target; it reads every marker in the repository' };
    if (a.id) return { error: '--id names one ticket; --scan files many, each with its own stable id' };
    return a;
  }
  const [target, ...words] = pos;
  const request = words.join(' ').trim();
  if (!target || !request) return { error: 'usage: flotilla ask <file>:<line>[-<endline>] "<what you want>"' };
  return { ...a, target, request };
}

/** `flotilla ask <file>:<line>`. Returns the exit code. */
export async function runAsk(args: AskArgs, deps: AskDeps): Promise<number> {
  const t = parseTarget(args.target ?? '');
  if ('error' in t) { deps.out(`cannot ask: ${t.error}`); return 1; }
  const file = await resolveTarget(deps.root, t.file);
  if ('error' in file) { deps.out(`cannot ask: ${file.error}`); return 1; }
  const code = snippet(file.text, t.start, t.end);
  if (typeof code !== 'string') { deps.out(`cannot ask: ${code.error}`); return 1; }

  const kind = args.kind ? { kind: args.kind as TaskKind } : kindFor(file.rel, deps.scopes);
  if ('error' in kind) { deps.out(`cannot ask: ${kind.error}`); return 1; }

  const task = askTask({ ...t, file: file.rel, code }, args.request ?? '', kind.kind, 'ask', args.id);
  if (args.dry_run) {
    deps.out(`would file ${task.task_id}  (${task.kind}, locks ${file.rel})`);
    deps.out(`  title  ${task.title}`);
    deps.out('');
    deps.out(task.description ?? '');
    return 0;
  }
  const r = await deps.create(task);
  deps.out(r.created ? `created ${r.task_id}` : `${r.task_id} already exists — nothing filed`);
  deps.out(`  title  ${task.title}`);
  deps.out(`  kind   ${task.kind}`);
  deps.out(`  locks  ${file.rel}`);
  deps.out(`  where  ${file.rel}:${t.start === t.end ? t.start : `${t.start}-${t.end}`}`);
  if (r.created) deps.out(`\nAn agent can take it now:  flotilla claim ${r.task_id}`);
  return 0;
}

export interface ScanResult {
  created: string[];
  existing: string[];
  skipped: { where: string; reason: string }[];
  markers: number;
}

/** `flotilla ask --scan`. One ticket per marker, idempotently. */
export async function runScan(args: AskArgs, deps: AskDeps): Promise<ScanResult> {
  const found = await scanMarkers(deps.root);
  const res: ScanResult = { created: [], existing: [], skipped: [], markers: found.markers.length };

  for (const m of found.markers) {
    const where = `${m.file}:${m.line}`;
    const kind = args.kind ? { kind: args.kind as TaskKind } : kindFor(m.file, deps.scopes);
    if ('error' in kind) {
      res.skipped.push({ where, reason: kind.error });
      deps.out(`skipped   ${where}  ${kind.error}`);
      continue;
    }
    const text = await fs.readFile(path.join(deps.root, m.file), 'utf8');
    const code = snippet(text, m.line, m.line);
    const task = askTask({ file: m.file, start: m.line, end: m.line, code: typeof code === 'string' ? code : '' }, m.request, kind.kind, 'marker');
    if (args.dry_run) {
      deps.out(`would file ${task.task_id}  ${where}  (${task.kind})  ${task.title}`);
      continue;
    }
    const r = await deps.create(task);
    (r.created ? res.created : res.existing).push(r.task_id);
    deps.out(`${r.created ? 'created ' : 'exists  '}  ${r.task_id}  ${where}  (${task.kind})  ${task.title}`);
  }

  if (found.markers.length === 0) {
    deps.out(`no ${MARKER} markers in ${found.files} tracked file(s)`);
  } else if (args.dry_run) {
    deps.out(`\n${found.markers.length} marker(s); ${res.skipped.length} would be skipped. Nothing was filed (--dry-run).`);
  } else {
    deps.out(`\n${found.markers.length} marker(s): ${res.created.length} created, ${res.existing.length} already existed, ${res.skipped.length} skipped`);
  }
  return res;
}
