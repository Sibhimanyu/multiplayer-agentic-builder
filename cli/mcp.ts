// The Flotilla MCP server: how a coding agent asks what the fleet is doing, live.
//
// WHY THIS EXISTS AND NOT A CHAT CLIENT. A task is an ASSIGNMENT; the work happens in a
// conversation. That conversation needs three things Flotilla knows and the agent does not: which
// task you are on, what your role may touch, and what every other agent is holding RIGHT NOW.
//
// The alternative was wrapping the agent -- Flotilla owning a prompt loop and re-injecting
// context every turn. That means reimplementing tool-use display, permission prompts and diff
// review, and chasing Claude Code's UX forever. Tools invert it: Claude Code stays Claude Code,
// and the agent PULLS live state at the moment it matters. `fleet_status` called mid-sentence is
// more live than anything a preamble could carry.
//
// Transport is stdio with newline-delimited JSON-RPC 2.0, which is what `claude --mcp-config`
// speaks. `handle()` is exported and pure-ish so the protocol can be tested without a pipe.

import path from 'node:path';
import fs from 'node:fs/promises';
import type { ApiClient } from './client.ts';
import { appendOutbox } from './outbox.ts';
import { LAYOUT } from './agentic.ts';
import type { Logger } from '../shared/log.ts';
import type { Snapshot, TaskView } from '../shared/store/types.ts';

/** Every version of the MCP handshake this server has been tested against. */
const KNOWN_PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

export const TOOLS: ToolDef[] = [
  {
    name: 'fleet_status',
    description:
      'Who else is working right now: each teammate, their agent, the file scope they currently '
      + 'hold, and the task they are on. Call this before editing shared files, when a build '
      + 'breaks unexpectedly, or whenever the user asks what the team is doing.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'my_assignment',
    description:
      'The task assigned to this machine, plus this member\'s role and the file globs that role '
      + 'is allowed to write. Call this at the start of a session, and whenever you are about to '
      + 'edit a file you have not touched yet.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'report',
    description:
      'Append one line of progress to the shared ledger so teammates see it on the board. Use it '
      + 'for things a human would want to know: a decision taken, a blocker hit, a file finished. '
      + 'Not for narration of every edit.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string', description: 'One sentence, plain language.' } },
      required: ['message'],
    },
  },
  {
    name: 'claim_task',
    description:
      'Claim an open task and acquire its file scope, so no other agent can edit those files. '
      + 'Fails if someone claimed it first, or if the scope is outside this role.',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string' } },
      required: ['task_id'],
    },
  },
];

const ago = (iso: string | null): string => {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
};

/**
 * The fleet, as prose rather than JSON.
 *
 * An agent reads this into its context, so it is written for reading. A JSON dump of the snapshot
 * would cost several hundred tokens to say what four lines say, and the agent would have to infer
 * which parts matter. Saying "holds server/** " directly is the whole point of the call.
 */
export function renderFleet(snap: Snapshot, me: string): string {
  if (snap.agents.length === 0) return 'No agents are connected to this project right now.';

  const holds = new Map<string, string[]>();
  for (const l of snap.locks) holds.set(l.agent_id, [...(holds.get(l.agent_id) ?? []), ...l.globs]);

  const lines = snap.agents.map((a) => {
    const scope = holds.get(a.agent_id) ?? [];
    const task = a.current_task ? snap.tasks.find((t) => t.task_id === a.current_task) : undefined;
    return [
      `- ${a.member_label}${a.agent_id === me ? ' (you)' : ''} · ${a.role_slug} · ${a.harness}`,
      `  ${a.stale ? `OFFLINE, last seen ${ago(a.last_heartbeat_at)}` : a.status}`,
      scope.length > 0 ? `  holds ${scope.join(', ')}` : '  holds no file scope',
      task ? `  on ${task.task_id}: ${task.title}` : '  no task claimed',
    ].join('\n');
  });

  const contested = snap.locks.filter((l) => l.agent_id !== me).flatMap((l) => l.globs);
  const warn = contested.length > 0
    ? `\n\nDo NOT edit these — another agent holds them: ${contested.join(', ')}`
    : '';
  return `${snap.agents.length} agent(s) on ${snap.project_name}:\n\n${lines.join('\n\n')}${warn}`;
}

export function renderAssignment(
  who: { agent_id: string; role_slug: string },
  allowed: string[],
  task: TaskView | null,
): string {
  const head = [
    `You are acting as: ${who.role_slug}`,
    `Your role may write: ${allowed.length > 0 ? allowed.join(', ') : '(nothing — read only)'}`,
    '',
  ];
  if (!task) {
    return [
      ...head,
      'No task is claimed on this machine.',
      'Ask the user which task to take, then call claim_task with its id.',
    ].join('\n');
  }
  return [
    ...head,
    `Current task ${task.task_id} (${task.status}): ${task.title}`,
    task.description ? `\n${task.description}` : '',
    '',
    task.file_scope.length > 0
      ? `This task locks: ${task.file_scope.join(', ')}`
      : 'This task declares no file scope. Ask before editing outside your role scope.',
    task.blocked_by ? `\nBLOCKED by ${task.blocked_by}: ${task.blocked_reason ?? ''}` : '',
  ].join('\n');
}

export interface McpDeps {
  client: ApiClient;
  /** The connected repo root. report() writes into its .agentic/ outbox. */
  root: string;
  log: Logger;
  /** Globs this member's role may write, from the API's own answer. */
  allowedScope: () => Promise<string[]>;
}

const text = (s: string) => ({ content: [{ type: 'text', text: s }] });

async function callTool(name: string, args: Record<string, unknown>, deps: McpDeps) {
  switch (name) {
    case 'fleet_status': {
      const read = await deps.client.readSnapshot();
      if (!read) return text('The board returned no snapshot. You may be offline.');
      const me = await deps.client.whoami();
      return text(renderFleet(read.snapshot, me.agent_id));
    }
    case 'my_assignment': {
      const me = await deps.client.whoami();
      const read = await deps.client.readSnapshot();
      const task = read?.snapshot.tasks.find((t) => t.claimed_by === me.agent_id) ?? null;
      return text(renderAssignment(me, await deps.allowedScope(), task));
    }
    case 'report': {
      const message = String(args.message ?? '').trim();
      if (!message) return text('report needs a message.');
      // THE SAME PATH `flotilla report` TAKES: append to the outbox, let `start` publish.
      // Calling the API directly here would be a second write path that works while online and
      // silently loses the line when it is not -- the outbox exists precisely to survive that.
      const current = await fs.readFile(path.join(deps.root, LAYOUT.current_task), 'utf8').catch(() => '');
      const task_id = /^task_id:\s*(\S+)/m.exec(current)?.[1] ?? null;
      await appendOutbox(deps.root, { kind: 'task_progress', body: { task_id, summary: message } }, deps.log);
      return text('Queued. It reaches the board on the next publish by `flotilla start`.');
    }
    case 'claim_task': {
      const task_id = String(args.task_id ?? '').trim();
      if (!task_id) return text('claim_task needs a task_id.');
      const r = await deps.client.claimTask(task_id);
      // A lost race is the normal outcome of two agents doing the right thing at once. It is
      // reported as fact, not as an error, so the agent reasons about it instead of retrying.
      if (!r.ok) return text(`Task ${task_id} is already claimed by ${r.owner}. Pick another.`);
      return text(`Claimed ${task_id}. Its file scope is now locked to you.`);
    }
    default:
      return text(`Unknown tool: ${name}`);
  }
}

/** One JSON-RPC request in, one response out. `null` means notification: send nothing. */
export async function handle(
  req: JsonRpcRequest,
  deps: McpDeps,
): Promise<Record<string, unknown> | null> {
  const reply = (result: unknown) => ({ jsonrpc: '2.0' as const, id: req.id ?? null, result });

  switch (req.method) {
    case 'initialize': {
      // Echo the client's version when we know it. Answering with our own favourite is how a
      // server ends up silently unusable by a client that speaks an older handshake.
      const asked = String(req.params?.protocolVersion ?? '');
      return reply({
        protocolVersion: KNOWN_PROTOCOLS.includes(asked) ? asked : KNOWN_PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: 'flotilla', version: '0.1.0' },
      });
    }
    // Notifications carry no id and MUST NOT be answered.
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call': {
      const name = String(req.params?.name ?? '');
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        return reply(await callTool(name, args, deps));
      } catch (err) {
        // An error INSIDE a tool is a result, not a protocol error: the agent should see what
        // went wrong and adapt, not have the connection torn down.
        return reply({ ...text(`${name} failed: ${(err as Error).message}`), isError: true });
      }
    }
    default:
      return { jsonrpc: '2.0', id: req.id ?? null, error: { code: -32601, message: `Method not found: ${req.method}` } };
  }
}

/** Read newline-delimited JSON-RPC from stdin, write responses to stdout. Never returns. */
export async function serve(deps: McpDeps): Promise<void> {
  let buf = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let res: Record<string, unknown> | null;
      try {
        res = await handle(JSON.parse(line) as JsonRpcRequest, deps);
      } catch (err) {
        res = { jsonrpc: '2.0', id: null, error: { code: -32700, message: String(err) } };
      }
      // stdout is the protocol channel. Nothing else may ever write to it -- a stray console.log
      // here corrupts the stream and the server vanishes from Claude Code with no error.
      if (res) process.stdout.write(`${JSON.stringify(res)}\n`);
    }
  }
}
