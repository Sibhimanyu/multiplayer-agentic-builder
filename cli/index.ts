#!/usr/bin/env node
// flotilla — the CLI half of the agentic file contract.
//
//   flotilla connect <invite>   write AGENTS.md + .agentic/, store the token
//   flotilla status             what the board thinks is happening
//   flotilla task <title>       create a task, so there is something to claim
//   flotilla claim <task_id>    atomic claim, then acquire the file scope
//   flotilla report "<msg>"     append one progress line to the outbox
//   flotilla start              the long-running loop: drain outbox, deliver inbox, heartbeat
//
// The agent runs none of these except by convention. It writes to outbox.jsonl and reads
// inbox.jsonl; `start` is what moves bytes between those files and the network.
//
// Exit codes are deliberate:
//   0  it worked, INCLUDING a lost claim (B3) and including being offline
//   1  a real failure: bad usage, revoked token, unpublishable state
//   2  not connected yet

import fs from 'node:fs/promises';
import nodeFs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

import {
  LAYOUT,
  appendInbox,
  readState,
  writeAgenticTree,
  writeState,
  type CliState,
  type ProjectFile,
  type RolePack,
} from './agentic.ts';
import { appendOutbox, drain, isConnected, readCursor, type OutboxRecord } from './outbox.ts';
import { ApiClient, connectWithInvite, type WhoAmI } from './client.ts';
import { materialise, publishToBlackboard } from './blackboard.ts';
import { serve } from './mcp.ts';
import { StoreAuthError, StoreOfflineError } from '../shared/store/errors.ts';
import { LAYER_OF, TASK_KINDS, type Event, type EventKind, type TaskKind } from '../shared/store/types.ts';
import { ROLE_SLUGS, roleFor } from '../shared/store/directory.ts';
import type { Logger } from '../shared/log.ts';

/**
 * Human-facing logger. Diagnostics go to stderr so stdout stays parseable — `flotilla status`
 * is read by people and by scripts, and interleaving log lines into it would break both.
 *
 * The machine-readable `code` is dropped from the rendered line on purpose: a person reading a
 * terminal wants the sentence, and the code is there for the structured sinks.
 */
const log: Logger = {
  debug: () => {},
  info: (_code, msg, fields) => console.error(`  ${msg}${fields ? ` ${fmt(fields)}` : ''}`),
  warn: (_code, msg, fields) => console.error(`! ${msg}${fields ? ` ${fmt(fields)}` : ''}`),
  error: (_code, msg, fields) => console.error(`! ${msg}${fields ? ` ${fmt(fields)}` : ''}`),
};
const fmt = (m: Record<string, unknown>): string =>
  Object.entries(m)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');

const out = (s: string) => process.stdout.write(`${s}\n`);

/** Token file. Outside .agentic/ so the agent's own tree never contains a credential. */
const TOKEN_FILE = '.flotilla-token';

interface Config {
  root: string;
  api_base: string;
  repo: string;
}

async function loadConfig(root: string): Promise<Config> {
  // NEVER FROM .agentic/ -- putting it there would let the agent see which platform it is on and
  // break the byte-identical tree (B2). That constraint is about the AGENT's tree, though, and it
  // was being honoured by reading an environment variable that nothing on earth sets: a user who
  // installed from the curl one-liner and ran `flotilla status` got "offline" and no reason.
  //
  // ~/.flotilla/config.json is the install's own config, written by `flotilla init` and by
  // `login`. It is not the agent's tree, so deriving the URL from it keeps B2 intact. The env
  // var still wins, for pointing a machine at an emulator or a second project.
  let api_base = process.env.BUILDER_API_URL ?? '';
  if (!api_base) {
    try {
      const { loadConfig: installConfig, apiUrl } = await import('./config.ts');
      api_base = apiUrl(await installConfig());
    } catch {
      // Not configured yet. The commands that need it report that themselves, with the fix.
    }
  }
  let repo = process.env.BUILDER_REPO ?? '';
  if (!repo) {
    const raw = await fs.readFile(path.join(root, LAYOUT.project), 'utf8').catch(() => '');
    if (raw) repo = (JSON.parse(raw) as ProjectFile).repo_url ?? '';
  }
  return { root, api_base, repo };
}

async function readToken(root: string): Promise<string> {
  const t = await fs.readFile(path.join(root, TOKEN_FILE), 'utf8').catch(() => '');
  return t.trim();
}

// ---- commands ---------------------------------------------------------------------------

async function cmdConnect(root: string, invite: string): Promise<number> {
  const cfg = await loadConfig(root);
  if (!cfg.api_base) {
    log.warn('cli.not_configured', 'this install is not pointed at a project yet: run `flotilla init --project <firebase-project-id>`');
    return 1;
  }

  const res = await connectWithInvite(cfg.api_base, invite, detectHarness());
  // 0600: the token is the agent's identity for the whole session.
  await fs.writeFile(path.join(root, TOKEN_FILE), `${res.token}\n`, { mode: 0o600 });

  const client = new ApiClient({ base_url: cfg.api_base, token: res.token, log });
  const me = await client.whoami();
  const snap = await client.readSnapshot();

  const role = rolePackFor(me);
  const project: ProjectFile = {
    project_id: res.project_id,
    name: snap?.snapshot.project_name ?? res.project_id,
    repo_url: snap?.snapshot.repo_url ?? cfg.repo,
    brief: '',
    protocol_version: '0.2',
  };
  const state: CliState = { agent_id: res.agent_id, last_seen_seq: 0, last_written_seq: 0 };

  const written = await writeAgenticTree(root, { role, project, task: null, state }, log);

  out(`connected as ${res.agent_id} (${res.role_slug}) to ${project.name}`);
  out(`wrote ${written.length} files: ${LAYOUT.agents_md} and ${LAYOUT.project.split('/')[0]}/`);
  out('');
  out('Add .agentic/ and .flotilla-token to .gitignore if they are not already there.');
  return 0;
}

async function cmdStatus(root: string): Promise<number> {
  if (!(await isConnected(root))) {
    log.warn('cli.not_connected_run_flotilla', 'not connected: run `flotilla connect <invite>` first');
    return 2;
  }
  const cfg = await loadConfig(root);
  const token = await readToken(root);
  const state = await readState(root, log);

  const client = new ApiClient({ base_url: cfg.api_base, token, log });

  let me: WhoAmI;
  try {
    me = await client.whoami();
  } catch (err) {
    if (err instanceof StoreOfflineError) {
      // Offline is a normal state, and `status` is exactly when a human wants to know it.
      out('offline — cannot reach the backend');
      out(`agent:      ${state.agent_id || '(unknown)'}`);
      out(await pendingLine(root));
      return 0;
    }
    throw err;
  }

  const snap = await client.readSnapshot();
  out(`project:    ${snap?.snapshot.project_name ?? me.project_id}`);
  out(`agent:      ${me.agent_id}  role ${me.role_slug}`);
  out(
    `permissions: push=${yn(me.permissions.push_branches)} pr=${yn(me.permissions.open_prs)} ` +
      `merge=${yn(me.permissions.merge)} contracts=${yn(me.permissions.publish_contracts)}`,
  );

  // B10: freshness is READ from the backend's own report, never a hardcoded string. The two
  // builds print different lines here and that is the honest result, not a bug.
  out(
    me.freshness.mode === 'live'
      ? 'freshness:  live (push; worst-case staleness 0ms)'
      : `freshness:  poll every ${me.freshness.stale_ms}ms (worst-case staleness ${me.freshness.stale_ms}ms)`,
  );

  out(await pendingLine(root));

  if (snap) {
    const mine = snap.snapshot.tasks.filter((t) => t.claimed_by === me.agent_id);
    out(`ledger seq: ${snap.snapshot.seq}  (you have seen ${state.last_seen_seq})`);
    out('');
    if (mine.length === 0) out('no task claimed');
    for (const t of mine) {
      out(`claimed:    ${t.task_id}  ${t.status}${t.ci ? `  ci ${t.ci}` : ''}`);
      if (t.blocked_reason) out(`  blocked:  ${t.blocked_reason}`);
    }
    const stale = snap.snapshot.agents.filter((a) => a.stale && a.status !== 'offline');
    for (const a of stale) out(`! stale:    ${a.agent_id} last seen ${a.last_heartbeat_at ?? 'never'}`);
  }
  return 0;
}

const yn = (b: boolean) => (b ? 'yes' : 'no');

async function pendingLine(root: string): Promise<string> {
  const pending = await countPending(root);
  return `outbox:     ${pending.lines} queued line(s), ${pending.spooled} spooled file(s), cursor ${pending.cursor}`;
}

async function countPending(root: string): Promise<{ lines: number; spooled: number; cursor: number }> {
  const cursor = await readCursor(root, LAYOUT.outbox_cursor, log);
  const buf = await fs.readFile(path.join(root, LAYOUT.outbox)).catch(() => Buffer.alloc(0));
  const tail = buf.subarray(Math.min(cursor, buf.byteLength)).toString('utf8');
  const lines = tail.split('\n').filter((l) => l.trim() !== '').length;
  const spooled = (await fs.readdir(path.join(root, LAYOUT.outbox_spool)).catch(() => []))
    .filter((n) => n.endsWith('.json') && !n.startsWith('.tmp-')).length;
  return { lines, spooled, cursor };
}

async function cmdClaim(root: string, task_id: string): Promise<number> {
  if (!(await isConnected(root))) {
    log.warn('cli.not_connected_run_flotilla', 'not connected: run `flotilla connect <invite>` first');
    return 2;
  }
  const cfg = await loadConfig(root);
  const client = new ApiClient({ base_url: cfg.api_base, token: await readToken(root), log });

  const claim = await client.claimTask(task_id);
  if (!claim.ok) {
    // B3: EXIT 0. Losing a claim is a normal outcome of a race, not an error, and exiting
    // non-zero here would make every agent harness treat a routine race as a failed command.
    out(`${task_id} is owned by ${claim.owner} (claimed ${claim.claimed_at})`);
    out('pick another task');
    return 0;
  }

  const snap = await client.readSnapshot();
  const task = snap?.snapshot.tasks.find((t) => t.task_id === task_id);

  // Scope is acquired AFTER the claim, and a conflict here means the claim must be given back.
  // Holding a task you cannot legally edit is worse than not holding it.
  if (task && task.file_scope.length > 0) {
    const scope = await client.acquireScope(task_id, task.file_scope);
    if (!scope.ok) {
      out(`cannot take ${task_id}: file scope conflicts`);
      for (const c of scope.conflicts) {
        out(`  ${c.agent_id} holds ${c.globs.join(', ')} for ${c.task_id}`);
      }
      await client.releaseTask(task_id);
      out('claim released; pick another task');
      return 0;
    }
  }

  const state = await readState(root, log);
  await writeAgenticTree(
    root,
    { role: rolePackFor(await client.whoami()), project: await projectFile(root), task: task ?? null, state },
    log,
  );
  out(`claimed ${task_id}`);
  if (task) out(`scope: ${task.file_scope.join(', ') || '(none declared)'}`);
  out(`see ${LAYOUT.current_task}`);
  return 0;
}

async function cmdReport(root: string, message: string): Promise<number> {
  if (!(await isConnected(root))) {
    log.warn('cli.not_connected_run_flotilla', 'not connected: run `flotilla connect <invite>` first');
    return 2;
  }
  const state = await readState(root, log);
  const snapPath = path.join(root, LAYOUT.current_task);
  const current = await fs.readFile(snapPath, 'utf8').catch(() => '');
  const task_id = /^task_id:\s*(\S+)/m.exec(current)?.[1] ?? null;

  // Appends to the outbox and nothing else (B4). No network call: `start` publishes.
  const r = await appendOutbox(root, { kind: 'task_progress', body: { task_id, summary: message } }, log);
  out(
    r.target === 'jsonl'
      ? `queued 1 line in ${LAYOUT.outbox} (${r.bytes} bytes)`
      : `queued ${LAYOUT.outbox_spool}/${r.file} (${r.bytes} bytes, over the 4 KiB append limit)`,
  );
  void state;
  return 0;
}

/**
 * The long-running loop.
 *
 * Three jobs, on different clocks:
 *   drain outbox        every 2s   — the agent's work must leave promptly
 *   deliver inbox       on change  — driven by the store's own notification
 *   heartbeat           every 30s  — see the cost note below
 *
 * Heartbeat interval, and why 30s: presence must be fresher than the 90s stale timeout, and
 * every heartbeat is one durable write. At 20s, three agents cost 12,960 writes/day against a
 * 20,000/day free tier — 65% of the budget on presence alone. At 30s it is 8,640/day for three
 * agents running continuously, or 2,880 for a realistic 8-hour session. 30s keeps a 3x margin
 * under the timeout while leaving the write budget for actual work.
 */
async function cmdStart(root: string): Promise<number> {
  if (!(await isConnected(root))) {
    log.warn('cli.not_connected_run_flotilla', 'not connected: run `flotilla connect <invite>` first');
    return 2;
  }
  const cfg = await loadConfig(root);
  const token = await readToken(root);
  const client = new ApiClient({ base_url: cfg.api_base, token, log });

  const me = await client.whoami();
  out(`flotilla start — ${me.agent_id} (${me.role_slug})`);
  out(`freshness: ${me.freshness.mode}${me.freshness.mode === 'poll' ? ` ${me.freshness.stale_ms}ms` : ''}`);

  let running = true;
  let offline = false;
  const stop = () => {
    running = false;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const publish = makePublisher(client, root, cfg, log);

  while (running) {
    // ---- drain the outbox ----
    try {
      const r = await drain(root, publish, log, {
        onOffline: (err) => {
          if (err instanceof StoreAuthError) throw err;
          offline = true;
        },
      });
      if (r.published > 0 || r.duplicates > 0) {
        out(`published ${r.published}, deduped ${r.duplicates}, ${r.remaining} remaining`);
        offline = false;
      }
    } catch (err) {
      if (err instanceof StoreAuthError) {
        // A14: STOP. Do not retry a revoked token.
        log.warn('cli.token_revoked_or_rejected', 'token revoked or rejected; stopping', { error: err.message });
        return 1;
      }
      throw err;
    }

    // ---- deliver the inbox ----
    try {
      const state = await readState(root, log);
      const { events } = await client.readEvents(state.last_seen_seq);
      let advanced = state.last_seen_seq;
      for (const e of events) {
        // Belt to the API's braces. The API already filters the human layer, but this file
        // writes the agent's context and a leak here is the one that actually hurts (B8).
        if (LAYER_OF[e.kind] === 'human') {
          log.warn('cli.human_layer_event_reached', 'human-layer event reached the CLI; not delivering', { kind: e.kind, seq: e.seq });
          advanced = Math.max(advanced, e.seq);
          continue;
        }
        await deliver(root, e, cfg, log);
        advanced = Math.max(advanced, e.seq);
      }
      if (advanced > state.last_seen_seq) {
        await writeState(root, { ...state, last_seen_seq: advanced });
        out(`delivered ${events.length} event(s) to ${LAYOUT.inbox}`);
      }
      offline = false;
    } catch (err) {
      if (err instanceof StoreAuthError) {
        log.warn('cli.token_revoked_or_rejected', 'token revoked or rejected; stopping', { error: err.message });
        return 1;
      }
      if (err instanceof StoreOfflineError) {
        if (!offline) log.info('cli.offline_the_agent_keeps', 'offline; the agent keeps working and the outbox keeps growing', {});
        offline = true;
      } else {
        throw err;
      }
    }

    // ---- heartbeat ----
    try {
      const state = await readState(root, log);
      const current = await fs.readFile(path.join(root, LAYOUT.current_task), 'utf8').catch(() => '');
      const task_id = /^task_id:\s*(\S+)/m.exec(current)?.[1] ?? null;
      // 'working' unconditionally: a heartbeat that reaches the backend proves we are not
      // offline, so there is no state where a different value would be sent.
      await client.heartbeat('working', task_id, null);
      void state;
    } catch (err) {
      if (err instanceof StoreAuthError) return 1;
      if (!(err instanceof StoreOfflineError)) throw err;
      offline = true;
    }

    await sleep(2_000);
  }

  out('stopped');
  return 0;
}

/**
 * Turn one outbox record into a published event.
 *
 * Contract, schema and decision events go through git first: the file the agent named is
 * committed, pushed, and the body is REWRITTEN as a pointer before the append. The agent never
 * handles a commit sha.
 */
function makePublisher(client: ApiClient, root: string, cfg: Config, logger: Logger) {
  return async (rec: OutboxRecord): Promise<{ seq: number; duplicate: boolean }> => {
    const kind = rec.kind;

    if (kind === 'contract_published' || kind === 'schema_published' || kind === 'decision_recorded') {
      const source = typeof rec.body.file === 'string' ? rec.body.file : null;
      if (!source) {
        // Not publishable, and never will be. Reported loudly; the caller's cursor still
        // advances so one malformed line does not wedge the queue forever.
        logger.warn('cli.contract_event_names_no', 'contract event names no file; cannot publish', { kind, key: rec.idempotency_key });
        return { seq: 0, duplicate: true };
      }
      if (!cfg.repo) {
        throw new StoreOfflineError('BUILDER_REPO is not set; cannot publish to the blackboard');
      }

      const published = await publishToBlackboard(
        { source_file: source, kind, body: rec.body },
        { root, repo: cfg.repo },
        logger,
      );

      // The pointer, not the content. This is the rewrite the blackboard doc describes.
      const pointerBody: Record<string, unknown> = {
        name: rec.body.name,
        path: published.path,
        commit_sha: published.commit_sha,
      };
      if (kind === 'contract_published') {
        pointerBody.version = rec.body.version ?? 1;
        pointerBody.supersedes = rec.body.supersedes ?? null;
      }
      return client.appendEvent(kind, pointerBody, rec.idempotency_key);
    }

    return client.appendEvent(kind as EventKind, rec.body, rec.idempotency_key);
  };
}

/**
 * Write one event into the agent's inbox.
 *
 * For a contract pointer the blob is fetched from the sha-pinned CDN and written to disk
 * FIRST, then `body.local` is set, then the line is appended (B9). The ordering is the
 * contract: an agent that reads a line naming a file it cannot open has to handle a network
 * failure it was promised it would never see.
 */
async function deliver(root: string, e: Event, cfg: Config, logger: Logger): Promise<void> {
  const body: Record<string, unknown> = { ...e.body };

  const pointerPath = typeof body.path === 'string' ? body.path : null;
  const sha = typeof body.commit_sha === 'string' ? body.commit_sha : null;
  if (pointerPath && sha && cfg.repo) {
    const local = await materialise(
      { path: pointerPath, commit_sha: sha },
      { root, repo: cfg.repo, token: process.env.BUILDER_GIT_TOKEN },
      logger,
    );
    body.local = local;
  }
  // C7: the sha never reaches the agent. It is CLI plumbing.
  delete body.commit_sha;

  await appendInbox(
    root,
    { v: '0.2', seq: e.seq, layer: e.layer, kind: e.kind, ts: e.created_at, body },
    logger,
  );
}

// ---- helpers ----------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function detectHarness(): string {
  if (process.env.CLAUDE_CODE_MESSAGING_TOKEN || process.env.CLAUDECODE) return 'claude-code';
  if (process.env.CODEX_SANDBOX || process.env.OPENAI_CODEX) return 'codex';
  return 'manual';
}

/**
 * Read .agentic/project.json, NORMALISED.
 *
 * `flotilla new` writes {project_id, project_name, repo_url} and `connect` writes
 * {project_id, name, repo_url, brief, protocol_version}. A cast pretended those were the same
 * object, so `claim` in a `new`-created project reached sanitizeText with brief=undefined and
 * died on "input is not iterable" -- AFTER the claim had already landed on the server, which is
 * the worst place to fail. Every field is defaulted here rather than asserted.
 */
async function projectFile(root: string): Promise<ProjectFile> {
  const raw = await fs.readFile(path.join(root, LAYOUT.project), 'utf8');
  const j = JSON.parse(raw) as Partial<ProjectFile> & { project_name?: string };
  return {
    project_id: j.project_id ?? '',
    name: j.name ?? j.project_name ?? j.project_id ?? '',
    repo_url: j.repo_url ?? '',
    brief: j.brief ?? '',
    protocol_version: j.protocol_version ?? '0.2',
  };
}


/**
 * `flotilla mcp` — the MCP server, on stdio.
 *
 * Not meant to be typed by a human: `flotilla work` wires it into the agent. It is a real
 * command rather than a hidden flag because `claude --mcp-config` has to name something it can
 * spawn, and a documented command is easier to debug than a private one.
 *
 * NOTHING MAY WRITE TO STDOUT HERE except the protocol. `out()` and the logger both go to stdout
 * elsewhere in this file; a single stray line corrupts the JSON-RPC stream and the server
 * disappears from Claude Code with no error anywhere.
 */
async function cmdMcp(root: string): Promise<number> {
  if (!(await isConnected(root))) {
    // stderr, deliberately. stdout belongs to the protocol.
    process.stderr.write('flotilla mcp: not connected; run `flotilla connect <invite>` first\n');
    return 2;
  }
  const cfg = await loadConfig(root);
  const token = await readToken(root);
  const client = new ApiClient({ base_url: cfg.api_base, token, log });

  await serve({
    client,
    root,
    log,
    // The API's own answer, not a table duplicated here -- the same rule rolePackFor follows.
    allowedScope: async () => rolePackFor(await client.whoami()).may_edit,
  });
  return 0;
}

/**
 * `flotilla work` — open the agent you already have, with live fleet context.
 *
 * This is the whole point of the design: Flotilla does not host the conversation, it FURNISHES
 * one. Claude Code keeps its own UX -- tool display, permission prompts, diff review -- and
 * gains four tools that answer what it could not know: your task, your scope, who holds what
 * right now, and how to report back.
 *
 * The agent runs on this machine under this user's own subscription. Flotilla never holds a
 * model key; it spawns a binary the user already installed.
 */
async function cmdWork(root: string, rest: string[]): Promise<number> {
  if (!(await isConnected(root))) {
    log.warn('cli.not_connected_run_flotilla', 'not connected: run `flotilla connect <invite>` first');
    return 2;
  }
  const i = rest.indexOf('--agent');
  const want = i > -1 ? rest[i + 1] : undefined;
  const agent = want ?? (whichAgent('claude') ? 'claude' : whichAgent('codex') ? 'codex' : undefined);
  if (!agent) {
    log.warn('cli.no_agent_found', 'no coding agent found on PATH. Install Claude Code or Codex, or pass --agent <name>.');
    return 1;
  }
  if (!whichAgent(agent)) {
    log.warn('cli.agent_not_on_path', `${agent} is not on your PATH.`);
    return 1;
  }

  // A per-invocation config file rather than `claude mcp add`: adding a global server would
  // outlive this repo and follow the user into unrelated projects. This one is scoped to the
  // run and thrown away with the temp directory.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flotilla-mcp-'));
  const configPath = path.join(dir, 'mcp.json');
  const self = process.argv[1] ?? 'flotilla';
  await fs.writeFile(
    configPath,
    `${JSON.stringify({
      mcpServers: {
        flotilla: { command: process.execPath, args: [self, 'mcp'], cwd: root },
      },
    }, null, 2)}\n`,
  );

  const opening = [
    'You are working inside a Flotilla project, where several coding agents share one repository.',
    '',
    'Before you edit anything, call `my_assignment` to learn your task and which file globs your',
    'role may write, and `fleet_status` to see which files other agents currently hold. Never edit',
    'a glob another agent holds. Use `report` for decisions and blockers a teammate would want.',
    '',
    'Start by telling me my assignment and what the rest of the fleet is doing.',
  ].join('\n');

  // THE PROMPT GOES FIRST. `--mcp-config` is variadic (`<configs...>`), so anything after it is
  // read as another config file: putting the prompt there made claude try to open the prompt
  // TEXT as a path and die with ENAMETOOLONG. Found by running it, not by reading the help.
  const args = agent === 'claude'
    ? [opening, '--mcp-config', configPath]
    : [opening, '--config', `mcp_servers.flotilla.command=${process.execPath}`];

  if (rest.includes('--print')) {
    out(`${agent} ${args.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`);
    out(`\nmcp config: ${configPath}`);
    return 0;
  }

  out(`flotilla work — launching ${agent} with live fleet context`);
  const child = spawn(agent, args, { stdio: 'inherit' });
  return await new Promise<number>((resolve) => {
    child.on('error', (err) => {
      log.warn('cli.agent_spawn_failed', `could not start ${agent}`, { error: err.message });
      resolve(1);
    });
    child.on('exit', (code) => resolve(code ?? 0));
  });
}

/** Is this agent binary on PATH? Synchronous and cheap; used before spawning. */
function whichAgent(bin: string): boolean {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return dirs.some((d) => {
    try {
      nodeFs.accessSync(path.join(d, bin), nodeFs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Build the role pack the generated files describe.
 *
 * File scope comes from the role slug, and permissions come from the API's own answer — not
 * from a table duplicated here. A local table would eventually disagree with the server, and
 * AGENTS.md would tell the agent it can do something the API refuses.
 */
function rolePackFor(me: WhoAmI): RolePack {
  const SCOPES: Record<string, { edit: string[]; not: string[]; prefix: string; title: string; what: string }> = {
    architect: {
      edit: ['contracts/**', 'schema/**', 'decisions/**'],
      not: ['client/**', 'functions/**', 'test/**'],
      prefix: 'agent/architect/',
      title: 'Architect',
      what: 'You own the API contracts, the data schema and the recorded decisions for this project.',
    },
    'backend-builder': {
      edit: ['functions/**', 'schema/**'],
      not: ['client/**', 'test/e2e/**'],
      prefix: 'agent/backend/',
      title: 'Backend Builder',
      what: 'You own backend functions, data access, API contracts and backend tests for this project.',
    },
    'frontend-builder': {
      edit: ['client/**'],
      not: ['functions/**', 'schema/**', 'test/e2e/**'],
      prefix: 'agent/frontend/',
      title: 'Frontend Builder',
      what: 'You own the client application, its routes and its component tests for this project.',
    },
    'qa-verifier': {
      edit: ['test/**'],
      not: ['client/**', 'functions/**', 'schema/**'],
      prefix: 'agent/qa/',
      title: 'QA Verifier',
      what: 'You own end-to-end tests and the smoke suite for this project.',
    },
    'docs-writer': {
      edit: ['docs/**'],
      not: ['client/**', 'functions/**', 'schema/**', 'test/**'],
      prefix: 'agent/docs/',
      title: 'Docs Writer',
      what: 'You own the written documentation for this project.',
    },
  };
  // THE SCOPE COMES FROM THE SHARED ROLE TABLE, NOT FROM SCOPES ABOVE.
  //
  // SCOPES was keyed on slugs that no longer exist -- 'backend-builder' where the real slug is
  // 'backend', and no 'owner' at all -- so every role except architect fell through to the
  // fail-closed default and was told, in AGENTS.md and in my_assignment, that it may write
  // NOTHING. An owner whose file_scope is ['**'] read "(nothing — read only)".
  //
  // The comment on this function already said scope must not come from a table duplicated here.
  // It was duplicated anyway, and it drifted. Prose still comes from SCOPES, because a title and
  // a sentence are not facts the server owns; the globs are, so they come from roleFor().
  const shared = roleFor(me.role_slug);
  const prose = SCOPES[me.role_slug] ?? {
    edit: [],
    not: ['**'],
    prefix: `agent/${me.role_slug || 'unknown'}/`,
    title: me.role_slug || 'Unknown role',
    what: `You are acting as ${me.role_slug || 'an unknown role'} on this project.`,
  };
  const s = {
    ...prose,
    edit: shared.file_scope,
    // Fail closed only when the SERVER says the role has no scope, not when this file has no
    // prose for it.
    not: shared.file_scope.length > 0 ? prose.not : ['**'],
  };
  return {
    role_slug: me.role_slug,
    title: s.title,
    responsibilities: s.what,
    may_edit: s.edit,
    may_not_edit: s.not,
    branch_prefix: s.prefix,
    push_branches: me.permissions.push_branches,
    open_prs: me.permissions.open_prs,
    merge: me.permissions.merge,
  };
}

// ---- entry ------------------------------------------------------------------------------

/**
 * The version this binary reports.
 *
 * INJECTED BY THE BUILD from packaging/package.json (scripts/build-cli.mjs), so a published
 * binary cannot disagree with the tarball it shipped in. Running from source has no define, and
 * says so rather than claiming a release number it is not.
 */
declare const __FLOTILLA_VERSION__: string | undefined;
const CLI_VERSION = typeof __FLOTILLA_VERSION__ === 'string' ? __FLOTILLA_VERSION__ : '0.1.0-dev';

const USAGE = `flotilla — agentic coordination CLI

  flotilla init --project <id>  point this install at a Firebase project
  flotilla login                sign in with Google (--anonymous for a disposable identity)
                                serves the sign-in page locally; --hosted uses the board
                                --no-browser prints the URL instead of opening one
  flotilla whoami               the identity this machine is signed in as

  flotilla new <name>           create a project here, connect this repo, write .agentic/
  flotilla ls                   projects you are a member of
  flotilla members <project_id> the roster
  flotilla invite <role>        mint a single-use invite code for a teammate
                                --label "Their Name"

  flotilla connect <invite>     write AGENTS.md + .agentic/, store the agent token
  flotilla status               what the board thinks is happening
  flotilla task <title> --kind <${TASK_KINDS.join('|')}> --scope "<globs>"
                                create a task on the board; --id overrides the derived id
  flotilla claim <task_id>      atomic claim, then acquire the declared file scope
  flotilla report "<message>"   queue one progress line in the outbox
  flotilla start                drain the outbox, deliver the inbox, heartbeat

  flotilla work                 open your agent with live fleet context
                                --agent <claude|codex>, --print to show the command only
  flotilla mcp                  speak MCP on stdio; work wires this up for you

Environment:
  FLOTILLA_UID         your member id; defaults to uid_$USER
  FB_PROJECT_ID       Firebase project for the coordination substrate
  BUILDER_API_URL     coordination API base url (connect/claim/report/start)
  BUILDER_REPO        owner/repo for the git blackboard
  BUILDER_GIT_TOKEN   token for reading contracts from a private repo
`;

/**
 * The project-tier commands, injected.
 *
 * `new`, `ls` and `members` need a ProjectDirectory, and constructing one means importing a
 * backend SDK — which this file must not do, for the same reason cli/bridge.ts must not. So the
 * packaged entry point (firebase/flotilla-main.ts) supplies them and this file routes to them.
 *
 * Absent means the binary was built without a backend, and the commands say so rather than
 * crashing on an undefined call.
 */
export interface ProjectCommands {
  new: (root: string, name: string, repo?: string) => Promise<number>;
  ls: () => Promise<number>;
  members: (project_id: string) => Promise<number>;
  /**
   * `flotilla task`. Injected like the rest, and for the same reason -- it writes through the
   * deployed function with the USER's token, not an agent token, because creating work is a
   * triage act and triage is a member capability. See docs/decisions/0005-work-appears-by-triage.md.
   */
  task: (root: string, title: string, kind: TaskKind, task_id?: string, file_scope?: string[]) => Promise<number>;
  /**
   * `flotilla invite`. The one command that turns a one-person project into a team, and the
   * reason membership was unreachable until now: the invite document `connect` consumes was
   * read by the API and written by nothing.
   */
  invite: (root: string, role_slug: string, label?: string) => Promise<number>;
}

let projectCommands: ProjectCommands | null = null;
export function registerProjectCommands(cmds: ProjectCommands): void {
  projectCommands = cmds;
}

/** `init` and `login`. Injected for the same reason: they touch the SDK, this file must not. */
export interface AuthCommands {
  init: (project_id: string, api_key?: string) => Promise<number>;
  /**
   * `hosted` opts out of the locally served page and back to the board's /login.
   * `no_browser` prints the URL without opening anything -- headless machines, and harnesses.
   */
  login: (anonymous: boolean, hosted?: boolean, no_browser?: boolean) => Promise<number>;
  whoami: () => Promise<number>;
}

let authCommands: AuthCommands | null = null;
export function registerAuthCommands(cmds: AuthCommands): void {
  authCommands = cmds;
}

export async function main(argv: string[]): Promise<number> {
  const root = process.env.BUILDER_ROOT ?? process.cwd();
  const [cmd, ...rest] = argv;

  const needsBackend = (): number => {
    log.warn('cli.no_backend', 'this build has no coordination backend wired in', {});
    out('This flotilla build cannot reach a backend. Reinstall the published package.');
    return 1;
  };

  switch (cmd) {
    case 'init': {
      const i = rest.indexOf('--project');
      const project = i > -1 ? rest[i + 1] : rest.find((a) => !a.startsWith('--'));
      if (!project) {
        log.warn('cli.usage_flotilla_init', 'usage: flotilla init --project <firebase-project-id>');
        return 1;
      }
      if (!authCommands) return needsBackend();
      const k = rest.indexOf('--api-key');
      return authCommands.init(project, k > -1 ? rest[k + 1] : undefined);
    }
    case 'login':
      if (!authCommands) return needsBackend();
      return authCommands.login(
        rest.includes('--anonymous'), rest.includes('--hosted'), rest.includes('--no-browser'),
      );
    case 'whoami':
      if (!authCommands) return needsBackend();
      return authCommands.whoami();
    case 'new': {
      const name = rest.filter((a) => !a.startsWith('--')).join(' ').trim();
      if (!name) {
        log.warn('cli.usage_flotilla_new_name', 'usage: flotilla new <name> [--repo owner/repo]');
        return 1;
      }
      if (!projectCommands) return needsBackend();
      const repoFlag = rest.indexOf('--repo');
      return projectCommands.new(root, name, repoFlag > -1 ? rest[repoFlag + 1] : undefined);
    }
    case 'ls':
      if (!projectCommands) return needsBackend();
      return projectCommands.ls();
    case 'members': {
      const pid = rest[0];
      if (!pid) {
        log.warn('cli.usage_flotilla_members', 'usage: flotilla members <project_id>');
        return 1;
      }
      if (!projectCommands) return needsBackend();
      return projectCommands.members(pid);
    }
    case 'connect': {
      const invite = rest[0];
      if (!invite) {
        log.warn('cli.usage_flotilla_connect_invite', 'usage: flotilla connect <invite>');
        return 1;
      }
      return cmdConnect(root, invite);
    }
    case 'task': {
      // Flags are stripped from the title, so `flotilla task Wire the webhook --kind backend`
      // works without quoting. The title is what is left over.
      const flag = (name: string): string | undefined => {
        const i = rest.indexOf(name);
        return i > -1 ? rest[i + 1] : undefined;
      };
      const flagged = new Set<number>();
      for (const name of ['--kind', '--id', '--scope']) {
        const i = rest.indexOf(name);
        if (i > -1) { flagged.add(i); flagged.add(i + 1); }
      }
      const title = rest.filter((a, i) => !flagged.has(i) && !a.startsWith('--')).join(' ').trim();
      const kind = flag('--kind');

      if (!title || !kind) {
        log.warn('cli.usage_flotilla_task', `usage: flotilla task "<title>" --kind <${TASK_KINDS.join('|')}> [--scope "glob glob"] [--id <task_id>]`);
        return 1;
      }
      if (!(TASK_KINDS as readonly string[]).includes(kind)) {
        // Refused, not defaulted. A task quietly filed under the wrong kind is a card in the
        // wrong swimlane that nobody can explain later.
        log.warn('cli.bad_task_kind', `--kind must be one of: ${TASK_KINDS.join(', ')} (got "${kind}")`);
        return 1;
      }
      if (!projectCommands) return needsBackend();
      // A TASK WITH NO SCOPE LOCKS NOTHING, which makes the collision prevention this product
      // exists for inert. The board's form has always had the field; the CLI did not, so every
      // task created from a terminal was unlockable. Comma or whitespace separated, because a
      // person typing two globs will use either.
      const scope = (flag('--scope') ?? '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
      if (scope.length === 0) {
        log.warn('cli.task_without_scope',
          'no --scope given: this task will lock no files, so two agents can edit the same code');
      }
      return projectCommands.task(root, title, kind as TaskKind, flag('--id'), scope);
    }
    case 'status':
      return cmdStatus(root);
    case 'claim': {
      const task = rest[0];
      if (!task) {
        log.warn('cli.usage_flotilla_claim_task', 'usage: flotilla claim <task_id>');
        return 1;
      }
      return cmdClaim(root, task);
    }
    case 'report': {
      const message = rest.join(' ').trim();
      if (!message) {
        log.warn('cli.usage_flotilla_report_message', 'usage: flotilla report "<message>"');
        return 1;
      }
      return cmdReport(root, message);
    }
    case 'start':
      return cmdStart(root);
    case 'invite': {
      const role = rest.find((a) => !a.startsWith('--'));
      if (!role) {
        log.warn('cli.usage_flotilla_invite', `usage: flotilla invite <${ROLE_SLUGS.join('|')}> [--label "Name"]`);
        return 1;
      }
      if (!projectCommands) return needsBackend();
      const li = rest.indexOf('--label');
      return projectCommands.invite(root, role, li > -1 ? rest[li + 1] : undefined);
    }
    case 'mcp':
      return cmdMcp(root);
    case 'work':
      return cmdWork(root, rest);
    // `--version` fell through to `default`, which printed 'unknown command: --version'
    // followed by the whole help text. The installer's own success line runs
    // `flotilla --version`, so the last thing a new install said was the help screen with the
    // word flotilla in front of it. Order 0074.
    case '-v':
    case '--version':
      out(CLI_VERSION);
      return 0;
    case undefined:
    case '-h':
    case '--help':
      out(USAGE);
      return 0;
    default:
      log.warn('cli.unknown_command', `unknown command: ${cmd}`);
      out(USAGE);
      return 1;
  }
}

// Only run when invoked directly, so the module can be imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      // Named at the top level: an unexpected throw prints its type, not a bare stack.
      if (err instanceof StoreAuthError) {
        log.warn('cli.authentication_failed_not_retrying', 'authentication failed; not retrying', { error: err.message });
        process.exit(1);
      }
      log.warn('cli.unhandled', `${(err as Error).name ?? 'Error'}: ${(err as Error).message}`);
      process.exit(1);
    });
}
