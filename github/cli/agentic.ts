// The `.agentic/` tree: the interface between the CLI and the local agent.
//
// Implemented strictly to docs/reference/agentic-file-contract.md, which says
// the layout must be BYTE-IDENTICAL across builds (B2). That is checkable only
// if every build writes to the spec rather than to each other, so nothing here
// is informed by how another route did it.
//
// The agent speaks filesystem, never HTTP. It holds no token, so a prompt
// injection cannot exfiltrate a credential it never had; unsent work survives a
// crash because it is on disk; and every message it tried to send is auditable
// byte for byte.

import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

import type { Event, EventKind, Layer, ProjectId, Seq } from '../../shared/store/types.ts';
import { LAYER_OF, PROTOCOL_VERSION } from '../../shared/store/types.ts';
import { stripUnstorable } from '../../shared/sanitize.ts';

/**
 * A single `write()` with O_APPEND is atomic in practice below one page. POSIX
 * does not guarantee non-interleaving above that and network filesystems break
 * it outright, so anything larger goes to the spool directory instead.
 */
export const APPEND_LIMIT_BYTES = 4096;

export interface ProjectFile {
  project_id: ProjectId;
  name: string;
  repo_url: string;
  brief: string;
  protocol_version: string;
}

export interface StateFile {
  agent_id: string;
  last_seen_seq: Seq;
  last_written_seq: Seq;
}

export interface OutboxLine {
  v: string;
  kind: EventKind;
  ts: string;
  body: Record<string, unknown>;
}

export interface InboxLine {
  v: string;
  seq: Seq;
  layer: Layer;
  kind: EventKind;
  ts: string;
  body: Record<string, unknown>;
}

export interface RolePack {
  role_slug: string;
  title: string;
  responsibilities: string;
  may_edit: string[];
  may_not_edit: string[];
  branch_prefix: string;
  can_merge: boolean;
}

export class AgenticDir {
  readonly root: string;
  readonly dir: string;

  constructor(root: string) {
    this.root = root;
    this.dir = join(root, '.agentic');
  }

  p(...parts: string[]): string { return join(this.dir, ...parts); }

  // ---- creation -------------------------------------------------------

  /**
   * Write the full tree. `connect` calls this (B1).
   *
   * Every path in the contract's layout block is created, including the
   * directories that start empty -- an agent that finds `contracts/` missing
   * cannot tell "no contracts yet" from "the CLI is broken", and absence is the
   * ambiguity this project keeps finding.
   */
  async create(opts: {
    project: ProjectFile;
    role: RolePack;
    agent_id: string;
    protocol_excerpt: string;
  }): Promise<void> {
    await mkdir(this.p('tasks'), { recursive: true });
    await mkdir(this.p('contracts', 'schema'), { recursive: true });
    await mkdir(this.p('decisions'), { recursive: true });
    await mkdir(this.p('outbox.d'), { recursive: true });

    await writeFile(this.p('project.json'), `${JSON.stringify(opts.project, null, 2)}\n`, 'utf8');
    await writeFile(this.p('role.md'), rolePackMarkdown(opts.role), 'utf8');
    await writeFile(this.p('protocol.md'), opts.protocol_excerpt, 'utf8');
    await writeFile(this.p('tasks', 'current-task.md'), NO_TASK, 'utf8');

    // The four stream files exist from the start, empty. A cursor of 0 against a
    // missing file and a cursor of 0 against an empty file are the same state;
    // only one of them is representable without a special case.
    for (const f of ['inbox.jsonl', 'outbox.jsonl']) {
      if (!existsSync(this.p(f))) await writeFile(this.p(f), '', 'utf8');
    }
    for (const f of ['inbox.cursor', 'outbox.cursor']) {
      if (!existsSync(this.p(f))) await writeFile(this.p(f), '0', 'utf8');
    }

    await this.writeState({ agent_id: opts.agent_id, last_seen_seq: 0, last_written_seq: 0 });
    await writeFile(join(this.root, 'AGENTS.md'), agentsMarkdown(opts.role, opts.project), 'utf8');
    await ensureGitignored(this.root, '.agentic/');
  }

  // ---- state ----------------------------------------------------------

  async readState(): Promise<StateFile> {
    const raw = await readFile(this.p('state.json'), 'utf8');
    const s = JSON.parse(raw) as Partial<StateFile>;
    if (typeof s.agent_id !== 'string'
      || typeof s.last_seen_seq !== 'number'
      || typeof s.last_written_seq !== 'number') {
      // "Unverifiable is not true": a state file we cannot read must not default
      // to zeros. Zero last_seen_seq replays the entire ledger into the inbox.
      throw new Error('.agentic/state.json is malformed; refusing to guess the cursors');
    }
    return s as StateFile;
  }

  async writeState(s: StateFile): Promise<void> {
    await atomicWrite(this.p('state.json'), `${JSON.stringify(s, null, 2)}\n`);
  }

  // ---- cursors --------------------------------------------------------
  //
  // Separate files, never in-band. The CLI publishes from the stored offset to
  // EOF and writes the new offset AFTER the publish succeeds, so a crash
  // re-sends rather than drops. That is why appendEvent needs an idempotency
  // key -- the wire path is deliberately at-least-once.

  async readCursor(which: 'inbox' | 'outbox'): Promise<number> {
    const raw = (await readFile(this.p(`${which}.cursor`), 'utf8')).trim();
    if (!/^\d+$/.test(raw)) {
      throw new Error(`.agentic/${which}.cursor is not a byte offset: ${JSON.stringify(raw)}`);
    }
    return Number(raw);
  }

  async writeCursor(which: 'inbox' | 'outbox', offset: number): Promise<void> {
    await atomicWrite(this.p(`${which}.cursor`), String(offset));
  }

  // ---- outbox (agent writes, CLI drains) -------------------------------

  /**
   * Append one line as the AGENT would. Used by `report` and by tests.
   * Over the append limit it spools instead (B5).
   */
  async appendOutbox(line: OutboxLine): Promise<{ spooled: string | null }> {
    const text = `${JSON.stringify(line)}\n`;
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > APPEND_LIMIT_BYTES) {
      const id = randomUUID();
      const tmp = this.p('outbox.d', `.tmp-${id}`);
      const final = this.p('outbox.d', `${id}.json`);
      await writeFile(tmp, JSON.stringify(line), 'utf8');
      // rename() within one filesystem is atomic, so a reader never sees a
      // partial file.
      await rename(tmp, final);
      return { spooled: final };
    }
    await appendFile(this.p('outbox.jsonl'), text, 'utf8');
    return { spooled: null };
  }

  /**
   * Everything the CLI has not yet published: the tail of outbox.jsonl from the
   * cursor, plus every spooled file, ordered by mtime as the contract requires.
   */
  async pendingOutbox(): Promise<{
    lines: { line: OutboxLine; end_offset: number }[];
    spooled: { line: OutboxLine; path: string; mtime: number }[];
  }> {
    const cursor = await this.readCursor('outbox');
    const buf = await readFile(this.p('outbox.jsonl'));
    const tail = buf.subarray(Math.min(cursor, buf.length));

    const lines: { line: OutboxLine; end_offset: number }[] = [];
    let offset = Math.min(cursor, buf.length);
    for (const raw of tail.toString('utf8').split('\n')) {
      if (raw === '') continue;
      offset += Buffer.byteLength(raw, 'utf8') + 1;
      lines.push({ line: JSON.parse(raw) as OutboxLine, end_offset: offset });
    }

    const spooled: { line: OutboxLine; path: string; mtime: number }[] = [];
    for (const name of await readdir(this.p('outbox.d'))) {
      // A half-written spool file is named .tmp-*; it is not yet a message.
      if (name.startsWith('.tmp-') || !name.endsWith('.json')) continue;
      const path = this.p('outbox.d', name);
      const st = await stat(path);
      spooled.push({
        line: JSON.parse(await readFile(path, 'utf8')) as OutboxLine,
        path,
        mtime: st.mtimeMs,
      });
    }
    spooled.sort((a, b) => a.mtime - b.mtime);
    return { lines, spooled };
  }

  // ---- inbox (CLI writes, agent reads) ---------------------------------

  /**
   * Append one delivered event.
   *
   * Refuses the human layer outright rather than filtering silently. The
   * protocol calls that exclusion its most important rule, and a silent filter
   * and a broken writer produce the same observation -- which is exactly how
   * the A16 accident happened on another route.
   */
  async appendInbox(line: InboxLine): Promise<void> {
    if (line.layer === 'human' || LAYER_OF[line.kind] === 'human') {
      throw new Error(
        `refusing to write a human-layer event (${line.kind}) to inbox.jsonl: `
        + 'delivering it to an agent is a protocol violation',
      );
    }
    await appendFile(this.p('inbox.jsonl'), `${JSON.stringify(line)}\n`, 'utf8');
  }

  /** Materialise a blackboard blob so `body.local` points at a file that exists. */
  async materialise(relPath: string, contents: string): Promise<string> {
    const local = this.p('contracts', relPath.replace(/^contracts\//, ''));
    await mkdir(dirname(local), { recursive: true });
    await writeFile(local, contents, 'utf8');
    // Return the path as the agent will see it, relative to the repo root.
    return `.agentic/contracts/${relPath.replace(/^contracts\//, '')}`;
  }

  async writeDecision(relPath: string, contents: string): Promise<string> {
    const local = this.p('decisions', relPath.replace(/^decisions\//, ''));
    await mkdir(dirname(local), { recursive: true });
    await writeFile(local, contents, 'utf8');
    return `.agentic/decisions/${relPath.replace(/^decisions\//, '')}`;
  }

  async writeCurrentTask(md: string): Promise<void> {
    await writeFile(this.p('tasks', 'current-task.md'), md, 'utf8');
  }
}

// ---- helpers ---------------------------------------------------------------

/** Write via tmp+rename so a reader never observes a partial file. */
async function atomicWrite(path: string, contents: string): Promise<void> {
  const tmp = `${path}.tmp-${randomUUID()}`;
  await writeFile(tmp, contents, 'utf8');
  await rename(tmp, path);
}

async function ensureGitignored(root: string, entry: string): Promise<void> {
  const path = join(root, '.gitignore');
  let current = '';
  if (existsSync(path)) current = await readFile(path, 'utf8');
  if (current.split('\n').some((l) => l.trim() === entry.replace(/\/$/, '') || l.trim() === entry)) {
    return;
  }
  const sep = current === '' || current.endsWith('\n') ? '' : '\n';
  await appendFile(path, `${sep}${entry}\n`, 'utf8');
}

const NO_TASK = `# No task claimed

Run \`catalyst-builder claim <task_id>\` to take one, or wait for the CLI to
assign you the next open task in your role.
`;

function rolePackMarkdown(r: RolePack): string {
  return `# ${r.title}

${r.responsibilities}

## Your file scope

You may edit:      ${r.may_edit.join(', ')}
You may not edit:  ${r.may_not_edit.join(', ')}
Push to:           ${r.branch_prefix}<task-slug>

## Permissions

push branches: yes    open PRs: yes    merge: ${r.can_merge ? 'yes' : 'no'}
`;
}

function agentsMarkdown(r: RolePack, p: ProjectFile): string {
  return `# ${r.title}

${r.responsibilities}

## Your file scope
You may edit:      ${r.may_edit.join(', ')}
You may not edit:  ${r.may_not_edit.join(', ')}
Push to:           ${r.branch_prefix}<task-slug>

## How you communicate
Append one JSON line to .agentic/outbox.jsonl. Never call the network.
Read .agentic/inbox.jsonl from the offset in .agentic/inbox.cursor.
Contracts you need are already on disk in .agentic/contracts/.

Do not ask other agents questions. If you are blocked, append task_blocked
with a reason and stop. A human will unblock you.

## Publishing a contract
Write the file into contracts/ in the working tree, then append
contract_published naming that file. Do not commit it yourself.

## Permissions
push branches: yes    open PRs: yes    merge: ${r.can_merge ? 'yes' : 'no'}

<!-- project: ${p.name} (${p.project_id}) protocol ${p.protocol_version} -->
`;
}

/** The protocol subset an agent needs. Written to .agentic/protocol.md. */
export const PROTOCOL_EXCERPT = `# Protocol ${PROTOCOL_VERSION} -- what you need

You do not message other agents. You append facts to a ledger and read your inbox.

## What arrives in your inbox

Contract layer -- the payload that matters:
  schema_published, contract_published, contract_superseded, decision_recorded,
  scope_locked, scope_released, task_unblocked

Coordination layer:
  task_claimed, task_completed, task_blocked, branch_pushed, pr_opened,
  ci_passed, ci_failed, merged

You will NEVER receive human-layer events (agent_heartbeat, task_progress).
That exclusion is deliberate: it is what keeps you sharp over a long session
instead of drowning in other agents' status updates.

## What you send

Append to .agentic/outbox.jsonl, one JSON object per line:
  {"v":"${PROTOCOL_VERSION}","kind":"task_progress","ts":"<RFC3339>","body":{...}}

Payloads over 4 KiB go to .agentic/outbox.d/<uuid>.json instead. Write a
.tmp-<uuid> file first and rename it, so the CLI never reads a partial message.

## Contracts

A contract event's body carries a "local" path. The file is already on disk.
Open it. Do not make a network call.

## When you are blocked

Append task_blocked with a reason and stop. Do not work around a missing
contract and do not ask another agent. A human will unblock you.
`;

/** Strip emoji / 4-byte UTF-8 from durable text, identically in both builds. */
export function sanitizeForWire(text: string): string {
  return stripUnstorable(text).value;
}

/** Stable id for an outbox line, so a re-send after a crash dedupes (B6). */
export function outboxIdempotencyKey(project_id: ProjectId, line: OutboxLine): string {
  return createHash('sha256')
    .update(JSON.stringify([project_id, line.v, line.kind, line.ts, line.body]))
    .digest('hex')
    .slice(0, 32);
}

export function toInboxLine(e: Event, local?: string): InboxLine {
  const body = local === undefined ? e.body : { ...e.body, local };
  return { v: PROTOCOL_VERSION, seq: e.seq, layer: e.layer, kind: e.kind, ts: e.created_at, body };
}
