// Seed the Inventory Tracker demo fixture.
//
// Needed for F1-F12 either way, and it is what makes checklist section E verifiable WITHOUT a
// deployed project: point the dashboard at the emulator, seed this, and the board has real
// folded state to render.
//
//   scripts/emulator.sh 'node scripts/seed-demo.ts'          # then open the client
//
// Everything here goes through the real adapter and the real ledger. Nothing writes a TaskView
// directly except the initial backlog, because a board state that was hand-written rather than
// folded from events would not prove the fold works — which is the thing worth screenshotting.

import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

import { createFirestoreStore } from './store.ts';
import { consoleLogger } from '../shared/log.ts';
import { systemClock } from '../shared/clock.ts';
import type { TaskView } from '../shared/store/types.ts';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
if (!EMULATOR) {
  console.error(
    'FIRESTORE_EMULATOR_HOST is not set.\n' +
      'Run: scripts/emulator.sh \'node scripts/seed-demo.ts\'\n\n' +
      'This refuses to run against a real project on purpose: it writes a fictional project ' +
      'and would be indistinguishable from real data on a live board.',
  );
  process.exit(1);
}

const PROJECT_ID = process.env.DEMO_PROJECT_ID ?? 'proj_inventory';
const REPO = process.env.DEMO_REPO ?? 'example/inventory-tracker';

const app = initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? 'demo-bakeoff' }, 'seed');
const db = getFirestore(app);
const store = createFirestoreStore({ db, log: consoleLogger, clock: systemClock, debounce_ms: 0 });

const task = (over: Partial<TaskView> & Pick<TaskView, 'task_id' | 'title' | 'kind'>): TaskView => ({
  status: 'open',
  claimed_by: null,
  branch: null,
  pr_url: null,
  pr_number: null,
  ci: null,
  depends_on: [],
  blocked_by: null,
  blocked_reason: null,
  file_scope: [],
  updated_at: systemClock.iso(),
  ...over,
});

/**
 * The backlog. Deliberately more than six tasks and spread across kinds, so the board exercises
 * every column and E5 (an empty column shows its dashed empty state) is actually reachable.
 */
const BACKLOG: TaskView[] = [
  task({
    task_id: 'task_schema',
    title: 'Define the items schema and publish items-api v1',
    kind: 'backend',
    description: 'Owns the contract. Publishes, then exits.',
    file_scope: ['contracts/**', 'schema/**'],
  }),
  task({
    task_id: 'task_items_crud',
    title: 'CRUD handlers for items: create, list, update, delete',
    kind: 'backend',
    description: 'Implements items-api. Owns functions/items.',
    file_scope: ['functions/**', 'schema/**'],
    depends_on: ['task_schema'],
  }),
  task({
    task_id: 'task_items_ui',
    title: 'Items list view with quantity editing',
    kind: 'frontend',
    // 47 characters, which is the length E6 asks about: a long title must truncate readably.
    description: 'Consumes items-api. Blocked until qty stops being a string.',
    file_scope: ['client/src/routes/items/**'],
    depends_on: ['task_schema'],
  }),
  task({
    task_id: 'task_items_detail',
    title: 'Item detail view with edit and delete',
    kind: 'frontend',
    file_scope: ['client/src/routes/items/detail/**'],
  }),
  task({
    task_id: 'task_qa_smoke',
    title: 'Smoke test create, list, update, delete',
    kind: 'qa',
    file_scope: ['test/e2e/**'],
    depends_on: ['task_items_crud'],
  }),
  task({
    task_id: 'task_api_docs',
    title: 'Write API reference for the items endpoints',
    kind: 'docs',
    file_scope: ['docs/api/**'],
  }),
];

const AGENTS = [
  { agent_id: 'agent_arch0001', role_slug: 'architect', member_label: 'sibhi', initials: 'AR', harness: 'claude-code' as const },
  { agent_id: 'agent_be000002', role_slug: 'backend-builder', member_label: 'sibhi', initials: 'BE', harness: 'claude-code' as const },
  { agent_id: 'agent_fe000003', role_slug: 'frontend-builder', member_label: 'priya', initials: 'FE', harness: 'codex' as const },
  { agent_id: 'agent_qa000004', role_slug: 'qa-verifier', member_label: 'ci', initials: 'QA', harness: 'manual' as const },
];

let step = 0;
const say = (msg: string) => console.log(`  ${String(++step).padStart(2, ' ')}. ${msg}`);

async function main(): Promise<void> {
  console.log(`\nSeeding ${PROJECT_ID} into the emulator at ${EMULATOR}\n`);

  await store.ensureProject(PROJECT_ID, { project_name: 'Inventory Tracker', repo_url: REPO });
  await store.seedTasks(PROJECT_ID, BACKLOG);
  say(`project + ${BACKLOG.length} tasks`);

  for (const a of AGENTS) await store.registerAgent(PROJECT_ID, a);
  say(`${AGENTS.length} agents registered`);

  // ---- F4: the architect publishes, then exits --------------------------------------
  await store.appendEvent(
    PROJECT_ID,
    {
      layer: 'contract',
      kind: 'contract_published',
      actor_type: 'agent',
      actor_id: 'agent_arch0001',
      body: {
        name: 'items-api',
        version: 1,
        path: 'contracts/items-api.v1.yaml',
        commit_sha: 'a3f9c1e0d4b28f6712c9ab3e5580f1d2c7e46a9b',
        supersedes: null,
      },
    },
    `seed:${PROJECT_ID}:contract:items-api:1`,
  );
  say('items-api v1 published (pointer, not content)');

  // ---- F5: backend and frontend claim concurrently ----------------------------------
  const [be, fe] = await Promise.all([
    store.claimTask(PROJECT_ID, 'task_items_crud', 'agent_be000002'),
    store.claimTask(PROJECT_ID, 'task_items_ui', 'agent_fe000003'),
  ]);
  if (!be.ok || !fe.ok) throw new Error('seed: a claim was lost, which should be impossible here');
  say('backend + frontend claimed concurrently, no double-claim');

  await store.acquireScope(PROJECT_ID, 'agent_be000002', 'task_items_crud', ['functions/**', 'schema/**']);
  await store.acquireScope(PROJECT_ID, 'agent_fe000003', 'task_items_ui', ['client/src/routes/items/**']);
  say('disjoint file scopes locked');

  // ---- F6: a breaking v2 -------------------------------------------------------------
  await store.appendEvent(
    PROJECT_ID,
    {
      layer: 'contract',
      kind: 'contract_published',
      actor_type: 'agent',
      actor_id: 'agent_be000002',
      body: {
        name: 'items-api',
        version: 2,
        path: 'contracts/items-api.v2.yaml',
        commit_sha: 'b7c2d40918ee5a6f3b1d8c027ea94f65d3801ab2',
        supersedes: 1,
      },
    },
    `seed:${PROJECT_ID}:contract:items-api:2`,
  );
  say('items-api v2 published (breaking: qty string -> integer)');

  // ---- F7: the consumer reports blocked ---------------------------------------------
  await store.appendEvent(
    PROJECT_ID,
    {
      layer: 'coordination',
      kind: 'task_blocked',
      actor_type: 'agent',
      actor_id: 'agent_fe000003',
      body: {
        task_id: 'task_items_ui',
        reason: 'needs items-api v2: qty changed from string to integer',
        blocked_by_task_id: 'task_items_crud',
      },
    },
    `seed:${PROJECT_ID}:blocked:task_items_ui`,
  );
  say('frontend reports blocked, with a reason and a blocker');

  // ---- F8/F9: branch, PR, red CI -----------------------------------------------------
  const github = { layer: 'coordination' as const, actor_type: 'github' as const, actor_id: 'github' };
  await store.appendEvent(
    PROJECT_ID,
    { ...github, kind: 'branch_pushed', body: { branch: 'agent/backend/task-items-crud', commit: 'c1d2e3f4', task_id: 'task_items_crud' } },
    `seed:${PROJECT_ID}:push:task_items_crud`,
  );
  await store.appendEvent(
    PROJECT_ID,
    { ...github, kind: 'pr_opened', body: { task_id: 'task_items_crud', pr_number: 42, pr_url: `https://github.com/${REPO}/pull/42`, branch: 'agent/backend/task-items-crud' } },
    `seed:${PROJECT_ID}:pr:42`,
  );
  await store.appendEvent(
    PROJECT_ID,
    { ...github, kind: 'ci_failed', body: { task_id: 'task_items_crud', pr_number: 42, check_name: 'GitHub Actions', details_url: `https://github.com/${REPO}/actions/runs/1` } },
    `seed:${PROJECT_ID}:ci:42:failed`,
  );
  say('branch pushed, PR #42 opened, CI red (E7: badge visible without opening the card)');

  // ---- a task in needs_review, so every column has an occupant except one ------------
  await store.claimTask(PROJECT_ID, 'task_api_docs', 'agent_qa000004');
  await store.appendEvent(
    PROJECT_ID,
    { layer: 'coordination', kind: 'task_completed', actor_type: 'agent', actor_id: 'agent_qa000004', body: { task_id: 'task_api_docs' } },
    `seed:${PROJECT_ID}:complete:task_api_docs`,
  );
  say('task_api_docs -> needs_review');

  // ---- presence, including one deliberately stale agent (E: the blocked/stale rail) ---
  await store.heartbeat(PROJECT_ID, 'agent_be000002', 'working', 'task_items_crud', 'agent/backend/task-items-crud');
  await store.heartbeat(PROJECT_ID, 'agent_fe000003', 'blocked', 'task_items_ui', 'agent/frontend/task-items-ui');
  await store.heartbeat(PROJECT_ID, 'agent_arch0001', 'idle', null, null);
  // No heartbeat for the QA agent at all: `stale` is derived, so it will read stale on its own
  // without anyone storing that fact. Gives the board a genuine stale row to render.
  say('presence written; the QA agent is left without a heartbeat so `stale` derives true');

  const snap = await store.readSnapshot(PROJECT_ID);
  console.log(`\nseq ${snap?.snapshot.seq}  tasks ${snap?.snapshot.tasks.length}  agents ${snap?.snapshot.agents.length}  contracts ${snap?.snapshot.contracts.length}  locks ${snap?.snapshot.locks.length}`);
  console.log('\nBoard state:');
  for (const t of snap?.snapshot.tasks ?? []) {
    console.log(`  ${t.status.padEnd(13)} ${t.task_id.padEnd(18)} ${t.ci ? `ci=${t.ci} ` : ''}${t.claimed_by ?? ''}`);
  }
  console.log(
    '\nNow run the dashboard against the same emulator:\n' +
      '  cd client && VITE_FIREBASE_PROJECT_ID=demo-bakeoff \\\n' +
      `    VITE_FIRESTORE_EMULATOR=${EMULATOR} npm run dev\n`,
  );
}

main()
  .then(async () => {
    await store.close();
    await deleteApp(app);
  })
  .catch(async (err) => {
    console.error('seed failed:', err);
    await store.close().catch(() => {});
    await deleteApp(app).catch(() => {});
    process.exit(1);
  });
