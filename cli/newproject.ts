// `drydock new <name>` — create a project, connect the repo, write .agentic/, generate role packs.
//
// Takes a ProjectDirectory, not an adapter: this file must not import a backend SDK, for the same
// reason cli/bridge.ts must not. The runnable entry point that constructs the directory lives in
// firebase/drydock.ts.
//
// WHY THE CLI DOES THIS AND NOT THE BROWSER. Creating a project connects a repo, writes .agentic/
// into a working tree, and generates role packs on disk. A browser cannot do any of that without
// uploading the developer's working tree somewhere. The security rules deny every client write and
// Spark has no Cloud Functions to defer to, so the one process already trusted with a
// service-account key — the local CLI — is also the only one that can see the repo. The
// constraint and the right design point the same way.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { ProjectDirectory, RoleSlug } from '../shared/store/directory.ts';
import { ROLE_SLUGS } from '../shared/store/directory.ts';
import type { Logger } from '../shared/log.ts';

/** Every git child gets a DEADLINE. A wedged git child with no timeout hangs the CLI forever. */
function git(args: string[], cwd: string, timeout_ms = 15_000): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: 124, stdout });
    }, timeout_ms);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', () => {});
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout });
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: 1, stdout });
    });
  });
}

/**
 * `Inventory Tracker` -> `proj_inventory_tracker`.
 *
 * Deterministic, not random: running `drydock new` twice with the same name in the same repo must
 * COLLIDE rather than quietly create a second project. createProject throws ProjectExistsError,
 * which is the intended outcome — two clones of one repo are one project.
 */
export function projectIdFor(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  if (!slug) throw new Error(`project name "${name}" has no usable characters`);
  return `proj_${slug}`;
}

/** `git@github.com:owner/repo.git` or an https remote -> `owner/repo`. */
export function repoSlugFrom(remoteUrl: string): string | null {
  const m = /(?:github\.com[:/])([^/]+\/[^/.]+)(?:\.git)?\/?$/.exec(remoteUrl.trim());
  return m ? m[1] : null;
}

/** The role pack. Prose at this tier — capabilities are the next order's work. */
function rolePack(role: RoleSlug, project_name: string): string {
  const scope: Record<RoleSlug, string> = {
    owner: 'the whole repository. You triage suggestions and decide what gets built.',
    architect: '`contracts/**` and `schema/**`. You publish contracts; you do not implement them.',
    backend: '`functions/**` and `schema/**`.',
    frontend: '`client/**`.',
    qa: '`test/**` and `e2e/**`.',
    client: 'nothing. You have no working tree and no agent.',
  };
  const body =
    role === 'client'
      ? `You administer the delivered app. You ask questions and suggest changes.

You do not write code, claim tasks, or hold a file scope, and you have no agent. Your questions and
suggestions are HUMAN-LAYER events: they are recorded on the board and never written into any
agent's inbox.jsonl. That is not a policy — it is how the file contract is built. An owner or
architect turns a suggestion into a task, or declines it with a recorded reason.`
      : `Your file scope is ${scope[role]}

Claim a task before you touch anything. Append one JSON line to .agentic/outbox.jsonl; never call
the network and never run git yourself — the bridge does both. Read .agentic/inbox.jsonl from the
offset in .agentic/inbox.cursor. Contracts you need are already on disk under .agentic/contracts/.

If you are blocked, append task_blocked with a reason and stop. A human will unblock you.`;

  return `# ${role} — ${project_name}

${body}
`;
}

export interface NewProjectResult {
  project_id: string;
  project_name: string;
  repo_url: string;
  role_packs: string[];
  agentic_dir: string;
}

export interface NewProjectOptions {
  root: string;
  name: string;
  /**
   * Only createProject is needed, so only createProject is required.
   *
   * That lets the CLI pass a RemoteDirectory -- which writes through the deployed function with
   * the user's token -- where it used to require the full Admin-SDK-backed directory. A stranger
   * has a user token and no service-account key, so demanding the whole interface demanded
   * credentials they cannot have.
   */
  directory: Pick<ProjectDirectory, 'createProject'>;
  owner_uid: string;
  owner_label: string;
  /** Overrides the repo detected from `git remote get-url origin`. */
  repo_url?: string;
  log: Logger;
}

/**
 * Create the project, then scaffold. In that order, deliberately.
 *
 * If createProject fails — the id is taken, the backend is down — nothing has been written to the
 * developer's working tree. The reverse order would leave .agentic/ and role packs on disk for a
 * project that does not exist, which looks like a half-working install and is worse than a clean
 * failure.
 */
export async function newProject(opts: NewProjectOptions): Promise<NewProjectResult> {
  const project_id = projectIdFor(opts.name);

  let repo_url = opts.repo_url ?? '';
  if (!repo_url) {
    const remote = await git(['remote', 'get-url', 'origin'], opts.root);
    // Not "it did not throw": an exit code of 0 with empty output is not a remote.
    const slug = remote.code === 0 ? repoSlugFrom(remote.stdout) : null;
    if (!slug) {
      throw new Error(
        `no GitHub remote found in ${opts.root}. Run this inside a repo with an origin remote, ` +
          'or pass --repo <owner/repo>. A project without a repo has no blackboard, and the ' +
          'durable half of the architecture would silently not exist.',
      );
    }
    repo_url = slug;
  }

  const record = await opts.directory.createProject({
    project_id,
    project_name: opts.name,
    repo_url,
    owner_uid: opts.owner_uid,
    owner_label: opts.owner_label,
  });

  // ---- scaffold, only now that the project exists ----
  const agentic = path.join(opts.root, '.agentic');
  await fs.mkdir(path.join(agentic, 'roles'), { recursive: true });
  await fs.mkdir(path.join(agentic, 'contracts'), { recursive: true });

  await fs.writeFile(
    path.join(agentic, 'project.json'),
    `${JSON.stringify({ project_id, project_name: record.project_name, repo_url }, null, 2)}\n`,
    'utf8',
  );

  const role_packs: string[] = [];
  for (const role of ROLE_SLUGS) {
    const rel = path.join('.agentic', 'roles', `${role}.md`);
    await fs.writeFile(path.join(opts.root, rel), rolePack(role, record.project_name), 'utf8');
    role_packs.push(rel);
  }

  opts.log.info('cli.project_created', 'project created and scaffolded', {
    project_id, repo_url, role_packs: role_packs.length,
  });

  return {
    project_id,
    project_name: record.project_name,
    repo_url,
    role_packs,
    agentic_dir: path.relative(opts.root, agentic) || '.agentic',
  };
}
