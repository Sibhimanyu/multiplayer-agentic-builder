// The .agentic/ tree writer. Implements docs/reference/agentic-file-contract.md.
//
// B2 requires this tree to be BYTE-IDENTICAL between the Catalyst and Firebase builds. That is
// a hard constraint on this file, and it has one consequence worth stating loudly:
//
//   NOTHING HERE MAY MENTION THE BACKEND.
//
// No "Firestore", no "Catalyst", no function URLs, no project ids that differ by platform, no
// timestamps, no version strings, no `Date.now()`. If a byte of output depends on which build
// produced it, the comparison is invalid. Everything platform-specific lives in state.json,
// which is CLI-owned and excluded from the diff.
//
// The agent speaks filesystem, not HTTP. It holds no token, so a prompt injection cannot
// exfiltrate a credential it never had.

import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { sanitizeText, VARCHAR_MAX } from '../shared/sanitize.ts';
import { nullLogger } from '../shared/log.ts';
import { PROTOCOL_VERSION, type TaskView } from '../shared/store/types.ts';
import type { Logger } from '../shared/log.ts';

export interface RolePack {
  role_slug: string;
  title: string;
  responsibilities: string;
  may_edit: string[];
  may_not_edit: string[];
  branch_prefix: string;
  push_branches: boolean;
  open_prs: boolean;
  merge: boolean;
}

export interface ProjectFile {
  project_id: string;
  name: string;
  repo_url: string;
  brief: string;
  protocol_version: string;
}

export const AGENTIC_DIR = '.agentic';

/** Every path the contract defines, relative to the working tree root. */
export const LAYOUT = {
  agents_md: 'AGENTS.md',
  project: `${AGENTIC_DIR}/project.json`,
  role: `${AGENTIC_DIR}/role.md`,
  protocol: `${AGENTIC_DIR}/protocol.md`,
  current_task: `${AGENTIC_DIR}/tasks/current-task.md`,
  contracts_dir: `${AGENTIC_DIR}/contracts`,
  decisions_dir: `${AGENTIC_DIR}/decisions`,
  inbox: `${AGENTIC_DIR}/inbox.jsonl`,
  inbox_cursor: `${AGENTIC_DIR}/inbox.cursor`,
  outbox: `${AGENTIC_DIR}/outbox.jsonl`,
  outbox_cursor: `${AGENTIC_DIR}/outbox.cursor`,
  outbox_spool: `${AGENTIC_DIR}/outbox.d`,
  state: `${AGENTIC_DIR}/state.json`,
} as const;

/** CLI-owned. Deliberately NOT part of the byte-identical comparison. */
export interface CliState {
  agent_id: string;
  last_seen_seq: number;
  last_written_seq: number;
}

const enc = new TextEncoder();

/** Write a file, creating parents. Trailing newline always, so diffs stay clean. */
async function writeFile(root: string, rel: string, contents: string): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  const body = contents.endsWith('\n') ? contents : `${contents}\n`;
  await fs.writeFile(abs, body, 'utf8');
}

async function ensureDir(root: string, rel: string): Promise<void> {
  await fs.mkdir(path.join(root, rel), { recursive: true });
}

async function ensureFile(root: string, rel: string, initial = ''): Promise<void> {
  const abs = path.join(root, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  try {
    await fs.access(abs, constants.F_OK);
  } catch {
    // Only create when absent. Truncating inbox.jsonl on reconnect would erase unread
    // messages, and truncating outbox.jsonl would erase unsent work — the exact thing the
    // file contract exists to protect.
    await fs.writeFile(abs, initial, 'utf8');
  }
}

/**
 * Generate AGENTS.md.
 *
 * Mirrors the template in the file contract exactly. The permissions line reads from the role
 * pack rather than being hardcoded, because "merge: no" has to be true for the reason that it
 * is enforced server-side, not because it is typed here.
 */
export function renderAgentsMd(role: RolePack, project: ProjectFile): string {
  const lines: string[] = [
    `# ${role.title}`,
    '',
    role.responsibilities.trim(),
    '',
    '## Your file scope',
    `You may edit:      ${role.may_edit.join(', ')}`,
    `You may not edit:  ${role.may_not_edit.join(', ')}`,
    `Push to:           ${role.branch_prefix}<task-slug>`,
    '',
    '## How you communicate',
    `Append one JSON line to ${LAYOUT.outbox}. Never call the network.`,
    `Read ${LAYOUT.inbox} from the offset in ${LAYOUT.inbox_cursor}.`,
    `Contracts you need are already on disk in ${LAYOUT.contracts_dir}/.`,
    '',
    'Do not ask other agents questions. If you are blocked, append task_blocked',
    'with a reason and stop. A human will unblock you.',
    '',
    '## Publishing a contract',
    'Write the file into contracts/ in the working tree, then append',
    'contract_published naming that file. Do not commit it yourself.',
    '',
    '## Permissions',
    `push branches: ${yn(role.push_branches)}    open PRs: ${yn(role.open_prs)}    merge: ${yn(role.merge)}`,
  ];
  // Project name appears nowhere above on purpose: it is in project.json. Interpolating it
  // here would be fine for identity, but every extra field is another chance for the two
  // builds to drift, and the agent already reads project.json.
  void project;
  return lines.join('\n');
}

const yn = (b: boolean): string => (b ? 'yes' : 'no');

/**
 * The subset of the protocol an agent needs.
 *
 * A subset, not the whole document: the protocol file is written for humans building the
 * system, and handing an agent the rationale for 0.1-vs-0.2 costs context it should spend on
 * its task. Notably absent is the human layer — an agent never receives it, so describing it
 * would only invite the agent to ask why it sees none.
 */
export function renderProtocolMd(): string {
  return [
    `# Coordination protocol ${PROTOCOL_VERSION} — the part you need`,
    '',
    'You do not message other agents. You append facts to a ledger and read your inbox.',
    '',
    '## Reading',
    '',
    `${LAYOUT.inbox} is append-only, one JSON object per line. Track your own read`,
    `position in ${LAYOUT.inbox_cursor} as a byte offset. Nothing rewrites the inbox, so`,
    'reading while it grows is safe.',
    '',
    'A contract or decision that arrives in your inbox is ALREADY ON DISK. The line carries',
    '`body.local` — a path you can open. Do not fetch anything over the network.',
    '',
    '## Writing',
    '',
    `Append one JSON object per line to ${LAYOUT.outbox}, LF-terminated, no raw newlines`,
    'inside the object (escape them as \\n).',
    '',
    `If your payload exceeds 4096 bytes — a contract fragment will — do not append it.`,
    `Write it to ${LAYOUT.outbox_spool}/<uuid>.json instead, via a temp file and a rename.`,
    'A single append under one page is atomic in practice; above that it is not.',
    '',
    '## The events you may append',
    '',
    '  task_progress        { task_id, summary, files_changed[] }',
    '  task_blocked         { task_id, reason, blocked_by_task_id }',
    '  task_completed       { task_id }',
    '  contract_published   { name, version, file }',
    '  schema_published     { name, file }',
    '  decision_recorded    { title, file }',
    '',
    'For contract_published and schema_published you name a file you have written into the',
    'working tree. The CLI commits it, pushes it, and rewrites the event as a pointer. You',
    'never handle a commit sha.',
    '',
    '## When you are blocked',
    '',
    'Append task_blocked with a reason and stop. Do not poll. Do not ask another agent.',
    'A human, or the contract you are waiting for, will unblock you.',
    '',
    '## Offline is normal',
    '',
    'If the CLI cannot reach the backend your lines stay in the outbox and are sent later.',
    'That is not an error and there is nothing for you to do about it. Keep working.',
  ].join('\n');
}

/** The claimed task, as the agent sees it. */
export function renderCurrentTask(task: TaskView | null): string {
  if (!task) {
    return [
      '# No task claimed',
      '',
      'You have not claimed a task yet. Run `builder claim <task_id>`, or wait for the',
      'owner to assign one.',
    ].join('\n');
  }
  const lines = [
    `# ${sanitizeText(task.title, { field: 'task.title', max: VARCHAR_MAX, log: nullLogger })}`,
    '',
    `task_id: ${task.task_id}`,
    `kind:    ${task.kind}`,
    `status:  ${task.status}`,
    '',
    '## Description',
    '',
    sanitizeText(task.description ?? '(none supplied)', { field: 'task.description', log: nullLogger }),
    '',
    '## File scope',
    '',
    task.file_scope.length > 0
      ? task.file_scope.map((g) => `- ${g}`).join('\n')
      : '- (none declared; ask the owner before editing outside your role scope)',
  ];
  if (task.depends_on.length > 0) {
    lines.push('', '## Depends on', '', ...task.depends_on.map((d) => `- ${d}`));
  }
  if (task.blocked_by) {
    lines.push(
      '',
      '## Blocked',
      '',
      `Blocked by ${task.blocked_by}: ${sanitizeText(task.blocked_reason ?? '', { field: 'task.blocked_reason', log: nullLogger })}`,
    );
  }
  return lines.join('\n');
}

/**
 * Create or refresh the whole tree. Idempotent: safe to run on every `connect`.
 *
 * Generated files are rewritten; the four append-only files and the spool are created only if
 * absent. That asymmetry is the whole point — a reconnect must not lose queued work.
 */
export async function writeAgenticTree(
  root: string,
  opts: { role: RolePack; project: ProjectFile; task: TaskView | null; state: CliState },
  log: Logger,
): Promise<string[]> {
  const written: string[] = [];
  const put = async (rel: string, body: string) => {
    await writeFile(root, rel, body);
    written.push(rel);
  };

  await put(LAYOUT.agents_md, renderAgentsMd(opts.role, opts.project));
  // Two-space indent and a trailing newline, fixed key order: JSON.stringify of an object
  // literal preserves insertion order, so this is byte-stable across both builds.
  await put(
    LAYOUT.project,
    JSON.stringify(
      {
        project_id: opts.project.project_id,
        name: sanitizeText(opts.project.name, { field: 'project.name', max: VARCHAR_MAX, log }),
        repo_url: opts.project.repo_url,
        brief: sanitizeText(opts.project.brief, { field: 'project.brief', log }),
        protocol_version: opts.project.protocol_version,
      },
      null,
      2,
    ),
  );
  await put(LAYOUT.role, renderRoleMd(opts.role));
  await put(LAYOUT.protocol, renderProtocolMd());
  await put(LAYOUT.current_task, renderCurrentTask(opts.task));

  await ensureDir(root, LAYOUT.contracts_dir);
  await ensureDir(root, LAYOUT.decisions_dir);
  await ensureDir(root, LAYOUT.outbox_spool);

  await ensureFile(root, LAYOUT.inbox, '');
  await ensureFile(root, LAYOUT.inbox_cursor, '0\n');
  await ensureFile(root, LAYOUT.outbox, '');
  await ensureFile(root, LAYOUT.outbox_cursor, '0\n');

  // state.json is CLI-owned and NOT part of the byte-identical comparison: it holds the
  // agent_id and cursors, which legitimately differ between two runs of anything.
  await writeFile(root, LAYOUT.state, JSON.stringify(opts.state, null, 2));

  log.info('cli.agentic_tree_written', 'agentic tree written', { root, files: written.length });
  return written;
}

export function renderRoleMd(role: RolePack): string {
  return [
    `# ${role.title}`,
    '',
    `Role: ${role.role_slug}`,
    '',
    '## Responsibilities',
    '',
    role.responsibilities.trim(),
    '',
    '## File scope',
    '',
    'You may edit:',
    ...role.may_edit.map((g) => `- ${g}`),
    '',
    'You may not edit:',
    ...role.may_not_edit.map((g) => `- ${g}`),
    '',
    '## Branch',
    '',
    `${role.branch_prefix}<task-slug>`,
    '',
    'Never push to the default branch. Never merge.',
  ].join('\n');
}

/** Read CLI state, or a zeroed default. Never throws on a corrupt file. */
export async function readState(root: string, log: Logger): Promise<CliState> {
  const abs = path.join(root, LAYOUT.state);
  try {
    const raw = await fs.readFile(abs, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CliState>;
    return {
      agent_id: typeof parsed.agent_id === 'string' ? parsed.agent_id : '',
      last_seen_seq: Number(parsed.last_seen_seq ?? 0) || 0,
      last_written_seq: Number(parsed.last_written_seq ?? 0) || 0,
    };
  } catch (err) {
    const e = err as { code?: string };
    if (e.code !== 'ENOENT') {
      // A corrupt state file loses cursor position, which means re-delivery, not loss —
      // appendEvent is idempotent. Worth a loud warning, not a crash.
      log.warn('cli.state_json_unreadable_starting', 'state.json unreadable, starting from zero', { path: abs, error: String(err) });
    }
    return { agent_id: '', last_seen_seq: 0, last_written_seq: 0 };
  }
}

export async function writeState(root: string, state: CliState): Promise<void> {
  await writeFile(root, LAYOUT.state, JSON.stringify(state, null, 2));
}

/**
 * Append one line to inbox.jsonl.
 *
 * B9: `body.local` must be populated and the file must EXIST before the line is appended.
 * That ordering is the contract — an agent that reads a line naming a file it cannot open has
 * to handle a network failure it was promised it would never see. So this function verifies
 * existence and refuses rather than appending a line that lies.
 */
export async function appendInbox(
  root: string,
  line: Record<string, unknown>,
  log: Logger,
): Promise<void> {
  const body = line.body as { local?: unknown } | undefined;
  const local = body && typeof body.local === 'string' ? body.local : null;
  if (local) {
    const abs = path.isAbsolute(local) ? local : path.join(root, local);
    try {
      await fs.access(abs, constants.R_OK);
    } catch {
      throw new Error(
        `refusing to append an inbox line whose body.local does not exist yet: ${local}. ` +
          'The CLI must materialise the blob before announcing it (B9).',
      );
    }
  }

  // One object per line, LF-terminated, no raw newlines. JSON.stringify already escapes them.
  const serialised = JSON.stringify(line);
  if (serialised.includes('\n')) throw new Error('inbox line contains a raw newline');
  const bytes = enc.encode(`${serialised}\n`).byteLength;

  const abs = path.join(root, LAYOUT.inbox);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  // O_APPEND, one write. Atomic in practice under 4 KiB on a local filesystem.
  await fs.appendFile(abs, `${serialised}\n`, 'utf8');
  if (bytes > 4096) {
    // An inbox line over one page is not guaranteed atomic. Contract CONTENT never goes here
    // (only a pointer plus a local path), so this should be unreachable — say so if it is not.
    log.warn('cli.inbox_line_exceeds_4', 'inbox line exceeds 4 KiB; atomicity is not guaranteed', {
      bytes,
      kind: String(line.kind),
    });
  }
}
