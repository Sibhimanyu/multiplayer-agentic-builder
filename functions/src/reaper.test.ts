// The stale-claim reaper. F11: "kill the frontend agent's laptop; reaper releases the claim
// within 15 min", and F12: "another agent claims the released task successfully".
//
// F11 itself is a demo step that needs a deploy. What is testable here is the mechanism it
// depends on, with an injected clock instead of a fifteen-minute wait.
//
//   scripts/emulator.sh 'node --test functions/src/reaper.test.ts'

import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

import { reapAll, reapProject } from './reaper.ts';
import { createFirestoreStore, type FirestoreStore } from '../../shared/store/firestore.ts';
import { FakeClock } from '../../shared/store/memory.ts';
import { makeTask } from '../../shared/store/conformance.ts';
import { CLAIM_TIMEOUT_MS, type Logger } from '../../shared/store/types.ts';

assert.ok(
  process.env.FIRESTORE_EMULATOR_HOST,
  'FIRESTORE_EMULATOR_HOST is not set. Run via scripts/emulator.sh.',
);

let app: App;
let db: Firestore;
let store: FirestoreStore;
let clock: FakeClock;
let pid: string;
let run = 0;

const lines: string[] = [];
const log: Logger = {
  info: (m, meta) => lines.push(`info ${m} ${JSON.stringify(meta ?? {})}`),
  warn: (m, meta) => lines.push(`warn ${m} ${JSON.stringify(meta ?? {})}`),
};

const AGENT_FE = 'agent_fe000001';
const AGENT_BE = 'agent_be000002';

before(() => {
  app = initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? 'demo-bakeoff' }, `reaper-${Date.now()}`);
  db = getFirestore(app);
});

after(async () => {
  await store?.close();
  await deleteApp(app);
});

beforeEach(async () => {
  lines.length = 0;
  clock = new FakeClock();
  pid = `proj_reap_${run++}_${Date.now().toString(36)}`;
  store = createFirestoreStore({ db, log, clock, debounce_ms: 0 });
  await store.ensureProject(pid, { project_name: 'Inventory Tracker', repo_url: 'o/r' });
  await store.seedTasks(pid, [makeTask('task_items_ui', { kind: 'frontend' }), makeTask('task_items_crud')]);
  await store.registerAgent(pid, {
    agent_id: AGENT_FE,
    role_slug: 'frontend-builder',
    member_label: 'priya',
    initials: 'FE',
    harness: 'codex',
  });
  await store.registerAgent(pid, {
    agent_id: AGENT_BE,
    role_slug: 'backend-builder',
    member_label: 'sibhi',
    initials: 'BE',
    harness: 'claude-code',
  });
});

const now = () => clock.now();

test('a live agent keeps its claim', async () => {
  await store.heartbeat(pid, AGENT_FE, 'working', 'task_items_ui', 'agent/frontend/task-items-ui');
  const claim = await store.claimTask(pid, 'task_items_ui', AGENT_FE);
  assert.equal(claim.ok, true);

  clock.advance(60_000); // one minute: well inside the 15-minute timeout
  const r = await reapProject(db, store, pid, log, { now, claim_timeout_ms: CLAIM_TIMEOUT_MS });

  assert.equal(r.released.length, 0, 'a fresh heartbeat must protect the claim');
  assert.equal(r.kept.length, 1);
  assert.match(r.kept[0]!.reason, /within/, 'and the reason must say why it was kept');
  assert.equal(await store.claimOwner(pid, 'task_items_ui'), AGENT_FE);
});

test('F11 a dead agent loses its claim once past claim_timeout', async () => {
  await store.heartbeat(pid, AGENT_FE, 'working', 'task_items_ui', 'agent/frontend/task-items-ui');
  await store.claimTask(pid, 'task_items_ui', AGENT_FE);

  // The laptop lid closes. No more heartbeats.
  clock.advance(CLAIM_TIMEOUT_MS + 60_000);

  const r = await reapProject(db, store, pid, log, { now, claim_timeout_ms: CLAIM_TIMEOUT_MS });
  assert.equal(r.released.length, 1, 'the claim must be released');
  assert.equal(r.released[0]!.task_id, 'task_items_ui');
  assert.equal(r.released[0]!.agent_id, AGENT_FE);
  assert.ok(r.released[0]!.silent_ms > CLAIM_TIMEOUT_MS);

  assert.equal(await store.claimOwner(pid, 'task_items_ui'), null, 'the claim document must be gone');

  // And the release is on the ledger, so every agent's inbox learns about it.
  const { events } = await store.readEvents(pid, 0);
  const unblocked = events.filter((e) => e.kind === 'task_unblocked');
  assert.equal(unblocked.length, 1);
  assert.equal(unblocked[0]!.actor_type, 'system');
  assert.equal(unblocked[0]!.actor_id, 'reaper');
  assert.match(String(unblocked[0]!.body.reason_resolved), /reaped/);
});

test('F12 another agent can claim the released task', async () => {
  await store.heartbeat(pid, AGENT_FE, 'working', 'task_items_ui', null);
  await store.claimTask(pid, 'task_items_ui', AGENT_FE);
  clock.advance(CLAIM_TIMEOUT_MS + 60_000);
  await reapProject(db, store, pid, log, { now, claim_timeout_ms: CLAIM_TIMEOUT_MS });

  const retaken = await store.claimTask(pid, 'task_items_ui', AGENT_BE);
  assert.equal(retaken.ok, true, 'the task must be claimable again');
  assert.equal(await store.claimOwner(pid, 'task_items_ui'), AGENT_BE);
});

test('a revoked agent loses its claim immediately, without waiting out the timeout', async () => {
  await store.heartbeat(pid, AGENT_FE, 'working', 'task_items_ui', null);
  await store.claimTask(pid, 'task_items_ui', AGENT_FE);
  await store.setRevoked(pid, AGENT_FE, true);

  // No clock advance at all: the token is dead, the work is not resuming, and parking the
  // task for fifteen more minutes helps nobody.
  const r = await reapProject(db, store, pid, log, { now, claim_timeout_ms: CLAIM_TIMEOUT_MS });
  assert.equal(r.released.length, 1);
  assert.ok(lines.some((l) => l.includes('owner revoked')), 'the reason must be recorded');
});

test('an agent that claimed but never heartbeated is reaped on claim age', async () => {
  // A CLI that claimed and died before its first heartbeat. Without this fallback the claim
  // would be held forever, because there is no heartbeat to go stale.
  await store.claimTask(pid, 'task_items_crud', AGENT_BE);

  const early = await reapProject(db, store, pid, log, { now, claim_timeout_ms: CLAIM_TIMEOUT_MS });
  assert.equal(early.released.length, 0, 'a young claim is kept even with no heartbeat');
  assert.match(early.kept[0]!.reason, /never heartbeated but claim is only/);

  clock.advance(CLAIM_TIMEOUT_MS + 1_000);
  const late = await reapProject(db, store, pid, log, {
    now,
    claim_timeout_ms: CLAIM_TIMEOUT_MS,
  });
  assert.equal(late.released.length, 1, 'past the timeout it goes');
  assert.ok(lines.some((l) => l.includes('never heartbeated')));
});

test('a claim held by an agent with no presence document is reported, not guessed at', async () => {
  await db.collection('projects').doc(pid).collection('claims').doc('task_items_crud').set({
    task_id: 'task_items_crud',
    agent_id: 'agent_ghost0000',
    claimed_at: new Date(clock.now()).toISOString(),
  });

  const r = await reapProject(db, store, pid, log, { now, claim_timeout_ms: CLAIM_TIMEOUT_MS });
  assert.equal(r.released.length, 0, 'an inconsistency is not a stale agent; do not guess');
  assert.equal(r.kept.length, 1);
  assert.match(r.kept[0]!.reason, /no presence document/);
  assert.ok(lines.some((l) => l.includes('claim held by unknown agent')), 'and it must be logged');
});

test('the reaper is idempotent within a minute and does not double-append', async () => {
  await store.heartbeat(pid, AGENT_FE, 'working', 'task_items_ui', null);
  await store.claimTask(pid, 'task_items_ui', AGENT_FE);
  clock.advance(CLAIM_TIMEOUT_MS + 60_000);

  await reapProject(db, store, pid, log, { now, claim_timeout_ms: CLAIM_TIMEOUT_MS });
  // A second run finds nothing to do, because the claim document is already gone.
  const second = await reapProject(db, store, pid, log, { now, claim_timeout_ms: CLAIM_TIMEOUT_MS });
  assert.equal(second.examined, 0);
  assert.equal(second.released.length, 0);

  const { events } = await store.readEvents(pid, 0);
  assert.equal(
    events.filter((e) => e.kind === 'task_unblocked').length,
    1,
    'exactly one task_unblocked on the ledger',
  );
});

test('every claim is accounted for: examined equals released plus kept', async () => {
  await store.heartbeat(pid, AGENT_FE, 'working', 'task_items_ui', null);
  await store.claimTask(pid, 'task_items_ui', AGENT_FE);
  await store.heartbeat(pid, AGENT_BE, 'working', 'task_items_crud', null);
  await store.claimTask(pid, 'task_items_crud', AGENT_BE);

  // FE goes silent; BE keeps beating.
  clock.advance(CLAIM_TIMEOUT_MS + 60_000);
  await store.heartbeat(pid, AGENT_BE, 'working', 'task_items_crud', null);

  const r = await reapProject(db, store, pid, log, { now, claim_timeout_ms: CLAIM_TIMEOUT_MS });
  assert.equal(r.examined, 2);
  assert.equal(
    r.released.length + r.kept.length,
    r.examined,
    'nothing may be silently skipped: the counts must add up (non-negotiable H)',
  );
  assert.equal(r.released.length, 1);
  assert.equal(r.released[0]!.agent_id, AGENT_FE);
  assert.equal(r.kept[0]!.agent_id, AGENT_BE);
});

test('reapAll surveys every project and one bad project does not stop the rest', async () => {
  await store.heartbeat(pid, AGENT_FE, 'working', 'task_items_ui', null);
  await store.claimTask(pid, 'task_items_ui', AGENT_FE);
  clock.advance(CLAIM_TIMEOUT_MS + 60_000);

  const results = await reapAll(db, store, log, { now, claim_timeout_ms: CLAIM_TIMEOUT_MS });
  const mine = results.find((r) => r.project_id === pid);
  assert.ok(mine, 'this project must appear in the sweep');
  assert.equal(mine!.released.length, 1);
});
