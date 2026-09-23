// Set up ONE real project, ONE task, ONE agent workspace — for a real agent to drive.
//
// Everything here is the real path: a real project in production Firestore, the real scaffolding
// newProject writes, the real role pack harness.ts writes, and the real inbox the bridge feeds.
// Nothing about the workspace is special-cased for the test, because the whole question is
// whether a real agent can work the contract as it actually ships.
//
//   node firebase/agentrun-setup.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

import { createFirestoreStore } from './store.ts';
import { createFirestoreDirectory } from './directory.ts';
import { newProject } from '../cli/newproject.ts';
import { writeScopeFile } from '../cli/harness.ts';
import { LAYOUT, writeAgenticTree } from '../cli/agentic.ts';
import { consoleLogger, CapturingLogger } from '../shared/log.ts';
import { systemClock } from '../shared/clock.ts';

const PROJECT = process.env.FB_PROJECT_ID ?? 'multiplayer-agents-eec02';
const STAMP = Date.now().toString(36);
const ROOT = path.resolve('.agentic', `agentrun-${STAMP}`);
const AGENT = `agent_be_${STAMP}`;

const git = (args, cwd) => new Promise((r) => {
  const c = spawn('git', args, { cwd, stdio: 'ignore' });
  const t = setTimeout(() => { c.kill('SIGKILL'); r(1); }, 15_000);
  c.on('close', (code) => { clearTimeout(t); r(code ?? 1); });
  c.on('error', () => { clearTimeout(t); r(1); });
});

const log = new CapturingLogger();
const app = initializeApp({ projectId: PROJECT }, `setup-${Date.now()}`);
const db = getFirestore(app);
const store = createFirestoreStore({ db, log, clock: systemClock, debounce_ms: 0 });
const directory = createFirestoreDirectory({ db, log });

await fs.mkdir(ROOT, { recursive: true });
await git(['init', '-q'], ROOT);
await git(['remote', 'add', 'origin', 'https://github.com/flotilla-test/scratch.git'], ROOT);

const created = await newProject({
  root: ROOT, name: `Agent Run ${STAMP}`, directory,
  owner_uid: `uid_owner_${STAMP}`, owner_label: 'sibhi', log: consoleLogger,
});
const PID = created.project_id;

await store.registerAgent(PID, {
  agent_id: AGENT, role_slug: 'backend', member_label: 'sibhi',
  initials: 'BE', harness: 'claude-code',
});
await store.seedTasks(PID, [{
  task_id: 'task_items_qty', title: 'Add a quantity field to the items handler',
  kind: 'backend', status: 'open', claimed_by: null, branch: null, pr_url: null, pr_number: null,
  ci: null, depends_on: [], blocked_by: null, blocked_reason: null,
  file_scope: ['functions/**'], updated_at: systemClock.iso(),
}]);

// The real role pack, from the real writer.
await writeScopeFile({
  root: ROOT, command: 'claude', file_scope: ['functions/**', 'schema/**'],
  role_slug: 'backend', agent_id: AGENT, log: consoleLogger,
});

// The REAL .agentic/ tree, written by the real writer — AGENTS.md included. Hand-rolling these
// files would have tested a fixture rather than the contract that ships.
await writeAgenticTree(
  ROOT,
  {
    role: {
      role_slug: 'backend', title: 'Backend builder',
      responsibilities: 'Implement API handlers and the data schema. Do not implement the UI.',
      may_edit: ['functions/**', 'schema/**'],
      may_not_edit: ['client/**', 'contracts/**'],
      branch_prefix: 'feat/be-', push_branches: true, open_prs: true, merge: false,
    },
    project: {
      project_id: PID, name: created.project_name, repo_url: created.repo_url,
      brief: 'Inventory tracker. Items have a name, a sku and a quantity.',
      protocol_version: '0.2',
    },
    task: null,
    state: { agent_id: AGENT, last_seen_seq: 0, last_written_seq: 0 },
  },
  consoleLogger,
);

// A task announcement in the inbox, exactly as the bridge would deliver it.
await fs.writeFile(
  path.join(ROOT, LAYOUT.inbox),
  `${JSON.stringify({
    v: '0.2', seq: 1, layer: 'coordination', kind: 'task_unblocked',
    ts: systemClock.iso(),
    body: { task_id: 'task_items_qty', title: 'Add a quantity field to the items handler', kind: 'backend' },
  })}\n`,
  'utf8',
);
await fs.writeFile(path.join(ROOT, LAYOUT.inbox_cursor), '0\n', 'utf8');

console.log(JSON.stringify({ root: ROOT, project_id: PID, agent_id: AGENT }, null, 2));

await store.close();
await deleteApp(app);
