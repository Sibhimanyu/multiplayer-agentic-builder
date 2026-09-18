// `flotilla chat` — the browser half of the conversation. Phase 2 of decision D.
//
// WHO THIS IS FOR. Phase 1 (`flotilla work`) hands the terminal to Claude Code, which serves
// developers and nobody else. A ui designer cannot use it, and the designer is a first-class role
// in this product with a real file scope (`client/**`). This is the same engine with a front door
// they will actually open.
//
// SAME ENGINE, DELIBERATELY. The agent is spawned on this machine, under this user's own
// subscription, with the same MCP server `work` wires up -- so it has `my_assignment`,
// `fleet_status`, `report` and `claim_task`. Flotilla still holds no model key. The browser is a
// transport, not a second implementation.
//
// One turn = one `claude -p --output-format json` run, pinned to a session id so the conversation
// continues. Verified: turn one with `--session-id <uuid>`, turn two with `--resume <uuid>`,
// which answers with the same id and remembers the first turn.

import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, randomBytes } from 'node:crypto';
import type { ApiClient } from './client.ts';
import type { Logger } from '../shared/log.ts';
import { chatPage } from './chatpage.ts';
import { TOOLS, currentTask } from './mcp.ts';

export interface ChatDeps {
  client: ApiClient;
  root: string;
  log: Logger;
  /** Absolute path to the MCP config `work` generates. The agent gets the same tools. */
  mcpConfig: string;
  /** `claude` or `codex`. */
  agent: string;
  allowedScope: () => Promise<string[]>;
}

/** What the sidebar shows. Structured, unlike the MCP tools, because a UI can lay it out. */
export interface ChatContext {
  project: string;
  role: string;
  scope: string[];
  task: { task_id: string; title: string; status: string; file_scope: string[] } | null;
  agents: { label: string; role: string; harness: string; stale: boolean; holds: string[]; you: boolean }[];
  contested: string[];
}

export async function readContext(deps: ChatDeps): Promise<ChatContext> {
  const me = await deps.client.whoami();
  const read = await deps.client.readSnapshot();
  const snap = read?.snapshot;
  const holds = new Map<string, string[]>();
  for (const l of snap?.locks ?? []) {
    holds.set(l.agent_id, [...(holds.get(l.agent_id) ?? []), ...l.globs]);
  }
  // The same resolver the MCP tool uses. Two answers to "what am I on" is a bug.
  const task = snap ? currentTask(snap, me.agent_id) : null;
  return {
    project: snap?.project_name ?? me.project_id,
    role: me.role_slug,
    scope: await deps.allowedScope(),
    task: task
      ? { task_id: task.task_id, title: task.title, status: task.status, file_scope: task.file_scope }
      : null,
    agents: (snap?.agents ?? []).map((a) => ({
      label: a.member_label,
      role: a.role_slug,
      harness: a.harness,
      stale: a.stale,
      holds: holds.get(a.agent_id) ?? [],
      you: a.agent_id === me.agent_id,
    })),
    // The globs SOMEONE ELSE holds. This is the one fact the designer most needs and the board
    // buries: it is why their agent must not touch a file.
    contested: (snap?.locks ?? []).filter((l) => l.agent_id !== me.agent_id).flatMap((l) => l.globs),
  };
}

/**
 * One turn. Spawns the user's own agent and waits for the whole reply.
 *
 * `--output-format json` rather than `stream-json`: a single result object is honest about when
 * the turn is finished, and a half-streamed reply that stops mid-sentence because the process
 * died is worse than a spinner. Streaming is a later change to this one function.
 */
export function runTurn(
  deps: ChatDeps,
  message: string,
  session: string,
  first: boolean,
): Promise<{ reply: string; error: boolean; cost?: number; denials: number }> {
  // FLOTILLA'S OWN TOOLS ARE PRE-ALLOWED, and they have to be. `claude -p` is non-interactive,
  // so it cannot prompt for approval and auto-denies instead: the first live turn came back
  // saying `my_assignment` "was blocked — it isn't in this session's allowlist", and the agent
  // read the files itself. A chat whose whole purpose is live fleet context, silently losing it
  // on every turn, is the feature not working while appearing to.
  //
  // Only these four. They read state, append one progress line, and claim a task -- all of which
  // the server already gates by role. Editing files is NOT allowed here: those are Claude Code's
  // own Edit and Write tools, and pre-approving them would let a browser tab rewrite the
  // repository with no human in the loop. That is a decision for the user, not a default.
  const allow = TOOLS.map((t) => `mcp__flotilla__${t.name}`).join(',');
  const args = deps.agent === 'claude'
    ? [
        '-p', message,
        '--output-format', 'json',
        first ? '--session-id' : '--resume', session,
        '--mcp-config', deps.mcpConfig,
        '--allowedTools', allow,
      ]
    : ['exec', message];

  return new Promise((resolve) => {
    const child = spawn(deps.agent, args, { cwd: deps.root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) =>
      resolve({ reply: `Could not start ${deps.agent}: ${e.message}`, error: true, denials: 0 }));
    child.on('close', () => {
      try {
        const j = JSON.parse(out) as {
          result?: string; is_error?: boolean; total_cost_usd?: number;
          permission_denials?: unknown[];
        };
        resolve({
          reply: j.result ?? '(the agent returned no text)',
          error: j.is_error === true,
          cost: j.total_cost_usd,
          denials: Array.isArray(j.permission_denials) ? j.permission_denials.length : 0,
        });
      } catch {
        // Never String() a transport failure and call it a reply. A non-JSON body means the
        // agent died or printed something we did not ask for, and the stderr is the evidence.
        resolve({
          reply: err.trim() || out.trim() || `${deps.agent} exited without a reply.`,
          error: true,
          denials: 0,
        });
      }
    });
  });
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
};

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let b = '';
    // Capped. An unbounded body on a loopback server is still a way to exhaust memory.
    req.on('data', (d) => { if (b.length < 64_000) b += d; });
    req.on('end', () => resolve(b));
  });

/**
 * Serve the chat on loopback and return its URL.
 *
 * THE NONCE IS NOT DECORATION. This endpoint spawns a coding agent with write access to the
 * repository. Any page in any browser tab can POST to 127.0.0.1, so without a secret in the URL a
 * visited website could drive the user's agent. The Host check closes DNS rebinding, where a
 * hostile name resolves to 127.0.0.1 and the browser sends its own Host header.
 */
export function serveChat(deps: ChatDeps, port = 0): Promise<{ url: string; close: () => void }> {
  const nonce = randomBytes(24).toString('base64url');
  const session = randomUUID();
  let turns = 0;

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const host = (req.headers.host ?? '').split(':')[0];
    if (host !== '127.0.0.1' && host !== 'localhost') {
      return json(res, 403, { error: 'loopback only' });
    }
    if (url.searchParams.get('n') !== nonce && req.headers['x-flotilla-nonce'] !== nonce) {
      return json(res, 403, { error: 'bad or missing nonce' });
    }

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(chatPage(nonce));
    }

    if (req.method === 'GET' && url.pathname === '/api/context') {
      try {
        return json(res, 200, await readContext(deps));
      } catch (e) {
        return json(res, 200, { error: (e as Error).message });
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/send') {
      const body = await readBody(req);
      let message = '';
      try { message = String((JSON.parse(body) as { message?: string }).message ?? '').trim(); }
      catch { return json(res, 400, { error: 'bad json' }); }
      if (!message) return json(res, 400, { error: 'empty message' });

      const first = turns === 0;
      turns += 1;
      const t = await runTurn(deps, message, session, first);
      deps.log.info('chat.turn', 'chat turn', { turns, error: t.error, denials: t.denials });
      return json(res, 200, t);
    }

    return json(res, 404, { error: 'not found' });
  });

  return new Promise((resolve) => {
    // 127.0.0.1, never 0.0.0.0: this must not be reachable from the network.
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const p = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        url: `http://127.0.0.1:${p}/?n=${nonce}`,
        close: () => server.close(),
      });
    });
  });
}
