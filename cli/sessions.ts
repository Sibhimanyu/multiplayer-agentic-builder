// Shared sessions on the agent's machine. docs/designs/shared-sessions.md, pieces 2 and 3.
//
// What lives here:
//   - the fence file the edit guard reads (.agentic/fence.json)
//   - `flotilla guard`, the Claude Code PreToolUse hook that refuses an edit outside the seat
//   - installing that hook into the checkout's .claude/settings.local.json
//   - syncSessions(), one pass of `flotilla start`'s loop: deliver messages and the host's answers,
//     and when a request is granted, widen this agent's lock so the grant is usable at once
//
// None of it is an enforcement point. The server's lock gate and `ship` refuse regardless; the
// guard refuses EARLIER, so an agent learns it must ask before doing the work, not after.

import fs from 'node:fs/promises';
import path from 'node:path';

import { AGENTIC_DIR, LAYOUT } from './agentic.ts';
import type { ApiClient } from './client.ts';
import { scopeForTask } from './ship.ts';
import { guardDecision, type Message, type ScopeRequest } from '../shared/store/sessions.ts';
import type { Logger } from '../shared/log.ts';

export const FENCE_FILE = `${AGENTIC_DIR}/fence.json`;
export const MESSAGES_FILE = `${AGENTIC_DIR}/messages.jsonl`;
export const SESSION_FILE = `${AGENTIC_DIR}/session.json`;
export const CLAUDE_SETTINGS = '.claude/settings.local.json';

/** What the guard needs, written by the bridge. Never by the agent: it is outside nothing it may edit. */
export interface Fence {
  role_slug: string;
  file_scope: string[];
  /** The ticket the extra globs are granted for, and the globs. Empty when nothing is granted. */
  task_id: string | null;
  granted: string[];
}

/** What syncSessions remembers between passes. CLI-owned, like state.json. */
export interface SessionState {
  messages_since_ms: number;
  /** request_id -> the status last delivered, so an answer is delivered exactly once. */
  seen: Record<string, ScopeRequest['status']>;
}

async function readJson<T>(file: string, fallback: T): Promise<T> {
  const raw = await fs.readFile(file, 'utf8').catch(() => '');
  if (!raw.trim()) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, v: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(v, null, 2)}\n`, 'utf8');
}

export const readFence = (root: string): Promise<Fence | null> => readJson<Fence | null>(path.join(root, FENCE_FILE), null);
export const writeFence = (root: string, f: Fence): Promise<void> => writeJson(path.join(root, FENCE_FILE), f);
export const readSessionState = (root: string): Promise<SessionState> =>
  readJson<SessionState>(path.join(root, SESSION_FILE), { messages_since_ms: 0, seen: {} });

/** The ticket on this machine, from the file the bridge writes at claim. Null when none. */
export async function currentTaskId(root: string): Promise<string | null> {
  const current = await fs.readFile(path.join(root, LAYOUT.current_task), 'utf8').catch(() => '');
  return /^task_id:\s*(\S+)/m.exec(current)?.[1] ?? null;
}

// ---- the edit guard ---------------------------------------------------------------------------

/** Walk up from `start` to the checkout that has a fence. Null outside any Flotilla checkout. */
export async function findFenceRoot(start: string): Promise<string | null> {
  let dir = path.resolve(start);
  for (;;) {
    const hit = await fs.stat(path.join(dir, FENCE_FILE)).then(() => true, () => false);
    if (hit) return dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/**
 * `flotilla guard`: decide one PreToolUse call. Returns the exit code and the message.
 *
 * Exit 2 with a reason on stderr is how a Claude Code hook refuses a tool call; the reason is
 * shown to the agent, so it says what to do next rather than only what went wrong. Anything this
 * cannot parse is ALLOWED: the guard is an early warning, and an early warning that blocks every
 * edit because a field moved is worse than none. The server still refuses.
 */
export async function runGuard(stdin: string, cwd: string): Promise<{ code: number; message: string }> {
  let input: { tool_input?: Record<string, unknown>; cwd?: string };
  try {
    input = JSON.parse(stdin) as typeof input;
  } catch {
    return { code: 0, message: '' };
  }
  const ti = input.tool_input ?? {};
  const target = [ti.file_path, ti.notebook_path, ti.path].find((v): v is string => typeof v === 'string' && v.length > 0);
  if (!target) return { code: 0, message: '' };

  const base = typeof input.cwd === 'string' && input.cwd ? input.cwd : cwd;
  const root = await findFenceRoot(base);
  if (!root) return { code: 0, message: '' };
  const fence = await readFence(root);
  if (!fence) return { code: 0, message: '' };

  const abs = path.isAbsolute(target) ? target : path.resolve(base, target);
  const rel = path.relative(root, abs);
  const task = await currentTaskId(root);
  // A grant counts only for the ticket it was given for.
  const granted = fence.task_id && fence.task_id === task ? fence.granted : [];
  const d = guardDecision(rel, fence.file_scope, granted);
  return d.allow ? { code: 0, message: '' } : { code: 2, message: d.reason };
}

const GUARD_MATCHER = 'Edit|Write|MultiEdit|NotebookEdit';
const GUARD_COMMAND = 'flotilla guard';

/**
 * Install the guard into this checkout's Claude Code settings. Idempotent; merges, never replaces.
 *
 * settings.local.json is the per-checkout, uncommitted settings file, so a guest's fence does not
 * land in the repo for everyone else. Returns whether anything changed.
 */
export async function installGuardHook(root: string): Promise<boolean> {
  const file = path.join(root, CLAUDE_SETTINGS);
  const cfg = await readJson<Record<string, unknown>>(file, {});
  const hooks = (cfg.hooks && typeof cfg.hooks === 'object' ? cfg.hooks : {}) as Record<string, unknown>;
  const pre = Array.isArray(hooks.PreToolUse) ? (hooks.PreToolUse as Record<string, unknown>[]) : [];
  const present = pre.some((h) =>
    Array.isArray(h.hooks) && (h.hooks as Record<string, unknown>[]).some((x) => x.command === GUARD_COMMAND));
  if (present) return false;
  pre.push({ matcher: GUARD_MATCHER, hooks: [{ type: 'command', command: GUARD_COMMAND }] });
  await writeJson(file, { ...cfg, hooks: { ...hooks, PreToolUse: pre } });
  return true;
}

// ---- rendering --------------------------------------------------------------------------------

export function formatMessage(m: Message): string {
  const to = m.to === '*' ? 'everyone' : m.to_label;
  return `${m.from_label} → ${to}: ${m.body}`;
}

export function formatRequest(r: ScopeRequest): string {
  const head = `${r.request_id}  ${r.label} (${r.role_slug}) wants ${r.globs.join(', ')}`;
  const tail = r.task_id ? ` for ${r.task_id}` : '';
  switch (r.status) {
    case 'open': return `${head}${tail}\n    why: ${r.reason}`;
    case 'granted': return `${head}${tail} — granted ${r.grant === 'seat' ? 'for good' : 'for this ticket'} by ${r.decided_by}`;
    case 'denied': return `${head}${tail} — denied by ${r.decided_by}: ${r.denied_reason}`;
  }
}

// ---- one pass of the loop ---------------------------------------------------------------------

/**
 * Deliver what the session has to say to this agent, once each, and act on grants.
 *
 *   messages        -> .agentic/messages.jsonl, and a line on the terminal
 *   answered asks   -> the same file, as a scope_granted / scope_denied line
 *   a live grant    -> the lock is widened to include it, and the fence file records it
 *
 * WIDENING IS THE POINT. A lock is one document per agent; a grant the agent then has to act on by
 * hand is a grant it will not know how to use. Re-acquiring with the union keeps every file it
 * already held and adds the granted ones -- through the same server gate, which now admits them.
 */
export async function syncSessions(
  root: string,
  client: ApiClient,
  me: { agent_id: string; role_slug: string; file_scope: string[] },
  out: (line: string) => void,
  log: Logger,
): Promise<{ messages: number; decisions: number; widened: string[] }> {
  const state = await readSessionState(root);
  const lines: string[] = [];

  const messages = await client.readMessages(state.messages_since_ms);
  for (const m of messages) {
    if (m.from_id !== me.agent_id) {
      lines.push(JSON.stringify({ kind: 'message', ...m }));
      out(`message  ${formatMessage(m)}`);
    }
    state.messages_since_ms = Math.max(state.messages_since_ms, m.sent_at_ms);
  }

  const task = await currentTaskId(root);
  const requests = await client.myScopeRequests();
  let decisions = 0;
  let widened: string[] = [];
  const granted: string[] = [];
  for (const r of requests) {
    // Live grants for the current ticket, every pass, so the fence is right after a restart too.
    if (r.status === 'granted' && task && (r.grant === 'seat' || r.task_id === task)) {
      for (const g of r.globs) if (!granted.includes(g)) granted.push(g);
    }
    if (state.seen[r.request_id] === r.status) continue;
    state.seen[r.request_id] = r.status;
    if (r.status === 'open') continue;
    decisions += 1;
    lines.push(JSON.stringify({ kind: r.status === 'granted' ? 'scope_granted' : 'scope_denied', ...r }));
    out(`${r.status === 'granted' ? 'granted ' : 'denied  '} ${formatRequest(r)}`);
  }

  if (task && granted.length > 0) {
    const read = await client.readSnapshot();
    const held = read ? scopeForTask(read.snapshot.locks, me.agent_id, task) : [];
    const want = [...held, ...granted.filter((g) => !held.includes(g))];
    if (want.length > held.length) {
      const r = await client.acquireScope(task, want);
      if (r.ok) {
        widened = want.filter((g) => !held.includes(g));
        out(`lock     widened to include ${widened.join(', ')} for ${task}`);
      } else {
        // Somebody else holds one of the granted files. The grant stands; the lock will be
        // retried next pass, and the agent is told who is in the way.
        log.warn('cli.grant_lock_conflict', 'granted files are locked by another agent; retrying next pass', {
          task_id: task, conflicts: r.conflicts.map((c) => c.agent_id),
        });
      }
    }
  }

  await writeFence(root, { role_slug: me.role_slug, file_scope: me.file_scope, task_id: task, granted });
  if (lines.length > 0) await fs.appendFile(path.join(root, MESSAGES_FILE), `${lines.join('\n')}\n`, 'utf8');
  await writeJson(path.join(root, SESSION_FILE), state);
  return { messages: messages.filter((m) => m.from_id !== me.agent_id).length, decisions, widened };
}
