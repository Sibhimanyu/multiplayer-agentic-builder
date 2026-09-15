// `flotilla start` spawns the agent harness. Process management plus the file contract.
//
// NO SERVER IS NEEDED FOR THIS PART, and it is worth being precise about what "bounded by
// file_scope" does and does not mean here, because the difference is the whole lesson of order
// 0049:
//
//   THE PROMPT IS GUIDANCE. The role pack in .agentic/ and the scope passed below tell the agent
//   what it may touch. An agent that ignores them is not stopped by anything in this file.
//   THE GATE IS THE SERVER. acquireScope refuses globs outside the role's file_scope, in the
//   write function, where the user running this process cannot edit it.
//
// So this file makes the boundary VISIBLE to a cooperating agent and does not pretend to
// enforce it. Enforcement that lives next to the thing being constrained is not enforcement --
// that is exactly why the write path moved off the laptop.
//
// The agent still never holds a credential and never calls the network: it reads and writes
// .agentic/, and the bridge does everything else. Spawning it changes who starts the process,
// not what the process may do.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import { LAYOUT } from './agentic.ts';
import type { Logger } from '../shared/log.ts';

export interface HarnessOptions {
  root: string;
  /** e.g. 'claude'. Resolved on PATH by the OS. */
  command: string;
  args?: string[];
  /** The role's file_scope, shown to the agent. NOT an enforcement boundary — see the header. */
  file_scope: string[];
  role_slug: string;
  agent_id: string;
  log: Logger;
  /** Injectable so the spawn can be tested without launching a real agent. */
  spawnImpl?: typeof spawn;
}

export interface HarnessHandle {
  child: ChildProcess;
  /** Resolves with the exit code. */
  exited: Promise<number>;
  stop: () => void;
}

/**
 * Write the scope the agent is expected to respect, where it already looks.
 *
 * .agentic/role.md is part of the file contract the agent already reads, so the scope goes there
 * rather than into a new channel. One interface, not two.
 */
export async function writeScopeFile(opts: HarnessOptions): Promise<string> {
  const rel = path.join('.agentic', 'role.md');
  const body = `# ${opts.role_slug}

Agent: ${opts.agent_id}

## Your file scope

You may edit only these paths:

${opts.file_scope.map((g) => `- \`${g}\``).join('\n') || '- (nothing — this role holds no file scope)'}

A scope lock outside this list is REFUSED BY THE SERVER, not by this file. If you try, the claim
fails and you have wasted a round trip; there is no way to talk it into succeeding.

## How you act

Append one JSON line to \`${LAYOUT.outbox}\`. Never call the network and never run git — the
bridge does both. Read \`${LAYOUT.inbox}\` from the offset in \`${LAYOUT.inbox_cursor}\`.
Contracts you need are already on disk under \`.agentic/contracts/\`.

If you are blocked, append \`task_blocked\` with a reason and stop.
`;
  await fs.mkdir(path.join(opts.root, '.agentic'), { recursive: true });
  await fs.writeFile(path.join(opts.root, rel), body, 'utf8');
  return rel;
}

/**
 * Spawn the harness alongside the bridge.
 *
 * stdio is inherited so the user sees the agent exactly as if they had started it themselves --
 * this replaces "open a second terminal and run Claude", and hiding its output would make it
 * strictly worse than what it replaces.
 */
export async function startHarness(opts: HarnessOptions): Promise<HarnessHandle> {
  const scopeFile = await writeScopeFile(opts);
  const doSpawn = opts.spawnImpl ?? spawn;

  opts.log.info('cli.harness_starting', 'starting the agent harness', {
    command: opts.command, role: opts.role_slug, agent_id: opts.agent_id,
    file_scope: opts.file_scope, scope_file: scopeFile,
  });

  const child = doSpawn(opts.command, opts.args ?? [], {
    cwd: opts.root,
    stdio: 'inherit',
    env: {
      ...process.env,
      // Read by the agent's own tooling if it wants them; the role pack is the primary channel.
      FLOTILLA_ROLE: opts.role_slug,
      FLOTILLA_AGENT_ID: opts.agent_id,
      FLOTILLA_FILE_SCOPE: opts.file_scope.join(':'),
      // Deliberately absent: any credential. The agent holds none, before or after this change.
    },
  });

  const exited = new Promise<number>((resolve) => {
    child.on('exit', (code) => {
      opts.log.info('cli.harness_exited', 'the agent harness exited', { code });
      resolve(code ?? 0);
    });
    child.on('error', (err) => {
      // A missing binary is the common case and deserves a real message rather than a stack.
      opts.log.warn('cli.harness_failed', 'could not start the agent harness', {
        command: opts.command, error: String(err),
      });
      resolve(127);
    });
  });

  return {
    child,
    exited,
    stop: () => {
      // SIGTERM, not SIGKILL: the harness may be mid-write to the outbox, and a half-written
      // JSON line is a line the bridge will log as malformed forever.
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
    },
  };
}
