// catalyst-builder -- the local CLI bridge.
//
// Commands are deliberately thin. Everything interesting lives in agentic.ts
// (the file contract), blackboard.ts (the git half) and daemon.ts (the loop);
// this file is argument parsing and wiring, so that "what the CLI does" is
// readable in one screen.

import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

import type { AgentStatus, CoordinationStore, ProjectId, TaskId } from '../../shared/store/types.ts';
import { PROTOCOL_VERSION } from '../../shared/store/types.ts';
import { StoreAuthError } from '../../shared/store/errors.ts';
import { systemClock } from '../../shared/clock.ts';
import type { Clock } from '../../shared/clock.ts';

import { createGithubStore } from '../store/github.ts';
import { createGitRunner, createHttpTransport } from '../store/transport.ts';
import { AgenticDir, PROTOCOL_EXCERPT } from './agentic.ts';
import type { RolePack } from './agentic.ts';
import { createBlackboard } from './blackboard.ts';
import { createDaemon } from './daemon.ts';

export interface CliEnv {
  cwd: string;
  out: (s: string) => void;
  err: (s: string) => void;
  clock?: Clock;
}

/** `agent_<8 hex>`, per the type in store-interface.md. */
export function newAgentId(): string {
  return `agent_${randomBytes(4).toString('hex')}`;
}

export const ROLE_PACKS: Record<string, RolePack> = {
  architect: {
    role_slug: 'architect',
    title: 'Architect',
    responsibilities:
      'You own the data schema and the API contracts for this project. You publish\n'
      + 'them to the blackboard, then you exit. You do not implement.',
    may_edit: ['contracts/**', 'schema/**', 'decisions/**'],
    may_not_edit: ['client/**', 'functions/**', 'test/**'],
    branch_prefix: 'agent/architect/',
    can_merge: false,
  },
  backend: {
    role_slug: 'backend',
    title: 'Backend Builder',
    responsibilities:
      'You own the server functions, data access, API contracts and backend tests\n'
      + 'for the Inventory Tracker project.',
    may_edit: ['functions/**', 'schema/**'],
    may_not_edit: ['client/**', 'test/e2e/**'],
    branch_prefix: 'agent/backend/',
    can_merge: false,
  },
  frontend: {
    role_slug: 'frontend',
    title: 'Frontend Builder',
    responsibilities:
      'You own the client application and its tests. You consume API contracts;\n'
      + 'you do not define them.',
    may_edit: ['client/**'],
    may_not_edit: ['functions/**', 'schema/**'],
    branch_prefix: 'agent/frontend/',
    can_merge: false,
  },
};

/**
 * An invite encodes what `connect` needs and nothing an agent could misuse.
 * `<project_id>:<role_slug>:<repo>` -- no token: the CLI holds the credential,
 * the agent never does.
 */
export function parseInvite(invite: string): { project_id: ProjectId; role_slug: string; repo: string } {
  const parts = invite.split(':');
  if (parts.length !== 3 || parts.some((p) => p === '')) {
    throw new Error(`invite must be <project_id>:<role>:<owner/repo>, got ${JSON.stringify(invite)}`);
  }
  const [project_id, role_slug, repo] = parts as [string, string, string];
  if (!ROLE_PACKS[role_slug]) {
    throw new Error(`unknown role ${JSON.stringify(role_slug)}; known: ${Object.keys(ROLE_PACKS).join(', ')}`);
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`not an owner/repo: ${JSON.stringify(repo)}`);
  return { project_id, role_slug, repo };
}

function token(): string {
  return process.env.GITHUB_TOKEN
    ?? execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
}

export function makeStore(repo: string, cwd: string, clock: Clock) {
  return createGithubStore({
    repo,
    git: createGitRunner(cwd),
    http: createHttpTransport(),
    token: token(),
    clock,
  });
}

export async function run(argv: string[], env: CliEnv): Promise<number> {
  const clock = env.clock ?? systemClock;
  const [cmd, ...rest] = argv;
  const agentic = new AgenticDir(env.cwd);

  try {
    switch (cmd) {
      case 'connect': return await cmdConnect(rest, env, agentic, clock);
      case 'claim': return await cmdClaim(rest, env, agentic, clock);
      case 'report': return await cmdReport(rest, env, agentic, clock);
      case 'status': return await cmdStatus(env, agentic, clock);
      case 'start': return await cmdStart(env, agentic, clock);
      case undefined:
      case '--help':
      case 'help':
        env.out(USAGE);
        return cmd === undefined ? 1 : 0;
      default:
        env.err(`unknown command: ${cmd}\n${USAGE}`);
        return 1;
    }
  } catch (err) {
    if (err instanceof StoreAuthError) {
      // Stop, do not retry. The CLI exiting non-zero is what makes that visible
      // to whatever supervises it.
      env.err(`auth failed: ${err.message}. Your agent token is revoked or invalid.`);
      return 2;
    }
    env.err(`${(err as Error).message}`);
    return 1;
  }
}

const USAGE = `catalyst-builder <command>

  connect <project_id:role:owner/repo>   write AGENTS.md and the .agentic/ tree
  start                                  run the publish/deliver/heartbeat loop
  claim <task_id>                        claim a task atomically
  report "<summary>"                     queue a progress note for the ledger
  status                                 print connection and freshness
`;

async function cmdConnect(
  args: string[], env: CliEnv, agentic: AgenticDir, clock: Clock,
): Promise<number> {
  const invite = args[0];
  if (!invite) { env.err('connect needs an invite'); return 1; }
  const { project_id, role_slug, repo } = parseInvite(invite);
  const role = ROLE_PACKS[role_slug]!;
  const agent_id = newAgentId();

  await agentic.create({
    project: {
      project_id,
      name: project_id,
      repo_url: `https://github.com/${repo}`,
      brief: 'Inventory Tracker',
      protocol_version: PROTOCOL_VERSION,
    },
    role,
    agent_id,
    protocol_excerpt: PROTOCOL_EXCERPT,
  });

  const store = makeStore(repo, env.cwd, clock);
  await store.registerAgent(project_id, {
    agent_id, role_slug, member_label: role.title,
  });

  env.out(`connected as ${agent_id} (${role.title})`);
  env.out(`wrote AGENTS.md and .agentic/ for ${project_id}`);
  return 0;
}

async function cmdClaim(
  args: string[], env: CliEnv, agentic: AgenticDir, clock: Clock,
): Promise<number> {
  const task_id = args[0] as TaskId | undefined;
  if (!task_id) { env.err('claim needs a task_id'); return 1; }
  const { project_id, repo } = await context(agentic);
  const { agent_id } = await agentic.readState();
  const store = makeStore(repo, env.cwd, clock);

  const res = await store.claimTask(project_id, task_id, agent_id);
  if (res.ok) {
    await agentic.writeCurrentTask(`# ${task_id}\n\nClaimed by ${agent_id} at ${clock.iso()}.\n`);
    await agentic.appendOutbox({
      v: PROTOCOL_VERSION, kind: 'task_claimed', ts: clock.iso(),
      body: { task_id, agent_id, role_slug: 'backend' },
    });
    env.out(`claimed ${task_id}`);
    return 0;
  }

  // B3: a lost claim is a NORMAL outcome, not an error. Exit 0 and say who has
  // it, so a supervising harness does not treat losing a race as a crash.
  env.out(`${task_id} is owned by ${res.owner} (since ${res.claimed_at})`);
  return 0;
}

async function cmdReport(
  args: string[], env: CliEnv, agentic: AgenticDir, clock: Clock,
): Promise<number> {
  const summary = args.join(' ');
  if (!summary) { env.err('report needs a message'); return 1; }
  const { spooled } = await agentic.appendOutbox({
    v: PROTOCOL_VERSION, kind: 'task_progress', ts: clock.iso(),
    body: { summary },
  });
  env.out(spooled ? `queued (spooled to ${spooled})` : 'queued');
  return 0;
}

async function cmdStatus(env: CliEnv, agentic: AgenticDir, clock: Clock): Promise<number> {
  const { project_id, repo } = await context(agentic);
  const state = await agentic.readState();
  const store = makeStore(repo, env.cwd, clock);

  // B10: read the mode from store.freshness. Hardcoding "poll" here would make
  // the dashboard and the CLI disagree the moment an adapter changed, and the
  // whole point of the field is that callers never know which they got.
  const f = store.freshness;
  env.out(`project:   ${project_id}`);
  env.out(`agent:     ${state.agent_id}`);
  env.out(`repo:      ${repo}`);
  env.out(`freshness: ${f.mode} (worst-case staleness ${f.stale_ms} ms)`);
  env.out(`cursors:   seen=${state.last_seen_seq} written=${state.last_written_seq}`);
  return 0;
}

async function cmdStart(env: CliEnv, agentic: AgenticDir, clock: Clock): Promise<number> {
  const { project_id, repo } = await context(agentic);
  const { agent_id } = await agentic.readState();
  const store = makeStore(repo, env.cwd, clock);
  const blackboard = createBlackboard({ git: createGitRunner(env.cwd), repo, cwd: env.cwd });

  const daemon = createDaemon({
    store: store as unknown as CoordinationStore,
    agentic, project_id, agent_id, blackboard,
    fetchPinned: (sha, path) => blackboard.readPinned(sha, path, token(), async (url, init) => {
      const res = await fetch(url, { headers: init.headers });
      return { status: res.status, body: await res.text() };
    }),
    clock,
  });

  env.out(`started as ${agent_id}; freshness ${store.freshness.mode}`);
  const stop = daemon.start();
  await new Promise<void>((resolve) => {
    process.on('SIGINT', () => { stop(); resolve(); });
    process.on('SIGTERM', () => { stop(); resolve(); });
  });
  return 0;
}

async function context(agentic: AgenticDir): Promise<{ project_id: ProjectId; repo: string }> {
  const raw = await readFile(agentic.p('project.json'), 'utf8');
  const p = JSON.parse(raw) as { project_id?: string; repo_url?: string };
  if (typeof p.project_id !== 'string' || typeof p.repo_url !== 'string') {
    throw new Error('.agentic/project.json is malformed; run connect again');
  }
  const repo = p.repo_url.replace(/^https:\/\/github\.com\//, '');
  return { project_id: p.project_id, repo };
}

export type { AgentStatus };
