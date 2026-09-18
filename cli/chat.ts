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
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
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
  /**
   * The hosted board for this project, so the chat is not a dead end.
   *
   * Optional because a project without hosting has no board to link to, and a link that 404s is
   * worse than no link -- the page hides the button when this is absent rather than rendering a
   * broken one.
   */
  boardUrl?: string;
}

/**
 * Where the two Plex families live, checked in order.
 *
 * DESIGN.md: "any visual divergence between the two builds is a bug", and until order 0083 this
 * page fell back to `system-ui` -- the "I gave up on typography" signal DESIGN.md forbids by
 * name -- because the CLI had no font files to serve. They now ship in the npm tarball.
 *
 * INSTALLED FIRST, SOURCE SECOND. The bundle lands at `dist/flotilla.js` with the fonts beside it
 * at `dist/brand/fonts/`; running from source they are still in `client/public/`. Resolving from
 * `import.meta.url` rather than `process.cwd()` matters because `flotilla chat` runs in the
 * user's repository, not in its own install directory.
 */
const FONT_DIRS = [
  fileURLToPath(new URL('./brand/fonts/', import.meta.url)),
  fileURLToPath(new URL('../client/public/brand/fonts/', import.meta.url)),
];

/** Served same-origin and cached hard: the bytes are immutable and the page blocks paint on them. */
async function readFont(name: string): Promise<Buffer | null> {
  // Name comes off the URL, so it is validated against a fixed shape rather than trusted. A
  // loopback server is still a file server, and `..` in a path is how one becomes a file leak.
  if (!/^Plex(Sans|Mono)-[0-9]{3}\.woff2$/.test(name)) return null;
  for (const dir of FONT_DIRS) {
    try { return await readFile(path.join(dir, name)); } catch { /* try the next */ }
  }
  return null;
}

/** What the sidebar shows. Structured, unlike the MCP tools, because a UI can lay it out. */
export interface ChatContext {
  project: string;
  role: string;
  scope: string[];
  task: { task_id: string; title: string; status: string; file_scope: string[] } | null;
  agents: { label: string; role: string; harness: string; stale: boolean; holds: string[]; you: boolean }[];
  contested: string[];
  /** Absent when the project has no hosted board; the page hides the link rather than 404ing. */
  board_url?: string;
  /**
   * The globs this agent may EDIT this turn: the ones it currently holds a lock on.
   *
   * Not the role's file scope. The role says what you are allowed to acquire; the lock says what
   * you have actually taken, and it is the lock that stops two agents writing the same file.
   * Handing the role scope to the harness would let a frontend member edit every client file in
   * the repository while a teammate held half of them.
   *
   * Empty is the normal state before a claim, and it means no writing at all.
   */
  writable: string[];
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
    ...(deps.boardUrl ? { board_url: deps.boardUrl } : {}),
    writable: [...new Set(holds.get(me.agent_id) ?? [])],
  };
}

/**
 * The tools one turn may use, derived from the globs that turn holds.
 *
 * WHY THE AGENT CAN WRITE AT ALL NOW. Phase 2 shipped read-only: the four Flotilla tools and
 * nothing else, because pre-approving Claude Code's Edit and Write would have let a browser tab
 * rewrite the repository with no human in the loop. That is true of an UNSCOPED approval. It is
 * not true of this one, and a chat that cannot change a file is a demo of coordination rather
 * than the thing being coordinated.
 *
 * `Edit(<glob>)` was verified against the harness both ways before this was built: with
 * `--allowedTools 'Edit(web/**)'`, an edit to `web/index.html` ran with no denial and the file
 * changed; an edit to `server/index.js` came back denied with the file untouched.
 *
 * BASH IS DENIED, and that is the whole reason the scoping means anything. `Edit(web/**)` is a
 * wall; `echo >> server/index.js` is a door beside it. It is named in `deny` as well as left out
 * of `allow` because deny wins, and a future change to the allow list should not be able to open
 * it by accident. The cost is real: the agent cannot run your tests from this page. That is the
 * correct trade for a surface with no human confirming each action.
 *
 * Read, Glob and Grep are allowed everywhere. Reading the whole repository is how an agent finds
 * out what it must not break, and none of the three can change a byte.
 */
export function turnTools(writable: string[]): { allow: string[]; deny: string[] } {
  const flotilla = TOOLS.map((t) => `mcp__flotilla__${t.name}`);
  const write = writable.flatMap((g) => [`Edit(${g})`, `Write(${g})`, `MultiEdit(${g})`]);
  return {
    allow: [...flotilla, 'Read', 'Glob', 'Grep', ...write],
    deny: ['Bash', 'NotebookEdit', 'WebFetch', 'WebSearch'],
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
  /** The globs this turn may write. Re-read per turn, so releasing a lock removes the permission. */
  writable: string[] = [],
): Promise<{ reply: string; error: boolean; cost?: number; denials: number }> {
  // FLOTILLA'S OWN TOOLS ARE PRE-ALLOWED, and they have to be. `claude -p` is non-interactive,
  // so it cannot prompt for approval and auto-denies instead: the first live turn came back
  // saying `my_assignment` "was blocked — it isn't in this session's allowlist", and the agent
  // read the files itself. A chat whose whole purpose is live fleet context, silently losing it
  // on every turn, is the feature not working while appearing to.
  //
  // Editing is allowed ONLY inside the globs this agent currently holds. See `turnTools`.
  const { allow, deny } = turnTools(writable);
  const args = deps.agent === 'claude'
    ? [
        '-p', message,
        '--output-format', 'json',
        first ? '--session-id' : '--resume', session,
        '--mcp-config', deps.mcpConfig,
        '--allowedTools', allow.join(','),
        '--disallowedTools', deny.join(','),
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
    // THE FONTS ARE EXEMPT FROM THE NONCE, AND HAVE TO BE. A browser sends neither the query
    // string nor a custom header when it fetches a font referenced from CSS, so a nonce-gated
    // font route 403s every request and the page silently renders in the fallback stack -- the
    // exact failure this route exists to fix.
    //
    // Exempting them costs nothing: these are five OFL-licensed woff2 files with a fixed-shape
    // name check, no state, and no path to the agent. The Host check above still applies, so a
    // rebound name cannot reach even these.
    if (req.method === 'GET' && url.pathname.startsWith('/brand/fonts/')) {
      const bytes = await readFont(path.posix.basename(url.pathname));
      if (!bytes) return json(res, 404, { error: 'no such font' });
      res.writeHead(200, {
        'content-type': 'font/woff2',
        'content-length': bytes.length,
        // Immutable bytes, and the page blocks paint on them. The server dies with the command,
        // so a long max-age cannot outlive a font change by more than one `flotilla chat`.
        'cache-control': 'public, max-age=31536000, immutable',
      });
      return res.end(bytes);
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

      // THE SCOPE IS RE-READ PER TURN, not captured when the server started. A lock released in
      // another terminal, or a task merged from the board, must remove the write permission from
      // the very next message -- a chat that kept editing files it no longer held would be the
      // coordination failing silently, which is the one failure this product exists to prevent.
      //
      // A failed read means no writes, not the last known good scope. Offline is exactly when a
      // stale permission is most dangerous, because nothing can tell you the lock moved.
      let writable: string[] = [];
      try { writable = (await readContext(deps)).writable; }
      catch (e) { deps.log.warn('chat.scope_unreadable', 'could not read scope: this turn is read-only', { err: (e as Error).message }); }

      const first = turns === 0;
      turns += 1;
      const t = await runTurn(deps, message, session, first, writable);
      deps.log.info('chat.turn', 'chat turn', { turns, error: t.error, denials: t.denials, writable });
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
