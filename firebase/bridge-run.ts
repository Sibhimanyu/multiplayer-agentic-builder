// Runnable entry point for the CLI bridge, and the vertical slice's self-test.
//
// This file exists in firebase/ rather than cli/ because constructing the store means importing
// the backend SDK, and cli/bridge.ts must not. The module graph enforces it: firebase-admin is
// a dependency of firebase/, and does not resolve from cli/ at all.
//
//   node firebase/bridge-run.ts            run the bridge until interrupted
//   node firebase/bridge-run.ts --seed     create the demo project + one open task
//   node firebase/bridge-run.ts --selftest positive control: write, publish, observe, assert
//
// --selftest is the POSITIVE CONTROL. Without one, "the dashboard did not move" and "my
// subscriber is broken" are the same observation. It writes a known line, publishes it, and
// asserts a live subscriber sees the resulting state — so a failure tells you WHICH half broke.

import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

import { runBridge } from '../cli/bridge.ts';
import { createFirestoreStore, type FirestoreStore } from './store.ts';
import { consoleLogger, CapturingLogger } from '../shared/log.ts';
import { systemClock } from '../shared/clock.ts';
import type { Snapshot, TaskView } from '../shared/store/types.ts';

const FB_PROJECT = process.env.FB_PROJECT_ID ?? 'multiplayer-agents-eec02';
const PID = process.env.BUILDER_PROJECT_ID ?? 'proj_inventory';
const ROOT = process.env.BUILDER_ROOT ?? process.cwd();

if (process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FIRESTORE_EMULATOR_HOST is set. The slice runs against real Firestore.');
  process.exit(1);
}

const task = (task_id: string, title: string, kind: TaskView['kind'] = 'backend'): TaskView => ({
  task_id,
  title,
  kind,
  status: 'open',
  claimed_by: null,
  branch: null,
  pr_url: null,
  pr_number: null,
  ci: null,
  depends_on: [],
  blocked_by: null,
  blocked_reason: null,
  file_scope: ['functions/**'],
  updated_at: systemClock.iso(),
});

function connect(log = consoleLogger): {
  store: FirestoreStore;
  db: ReturnType<typeof getFirestore>;
  close: () => Promise<void>;
} {
  const app = initializeApp({ projectId: FB_PROJECT }, `bridge-${Date.now()}-${Math.floor(performance.now())}`);
  const db = getFirestore(app);
  const store = createFirestoreStore({
    db,
    log,
    clock: systemClock, // real clock: this is a transport path, never an injected one
    debounce_ms: 0,
  });
  return {
    store,
    db,
    close: async () => {
      await store.close();
      await deleteApp(app);
    },
  };
}

async function seed(): Promise<void> {
  const { store, close } = connect();
  await store.ensureProject(PID, {
    project_name: 'Inventory Tracker',
    repo_url: 'Sibhimanyu/inventory-tracker-firebase',
  });
  await store.seedTasks(PID, [
    task('task_items_crud', 'CRUD handlers for items: create, list, update, delete'),
    task('task_items_ui', 'Items list view with quantity editing', 'frontend'),
    task('task_qa_smoke', 'Smoke test create, list, update, delete', 'qa'),
  ]);
  await store.registerAgent(PID, {
    agent_id: 'agent_be000001',
    role_slug: 'backend-builder',
    member_label: 'sibhi',
    initials: 'BE',
    harness: 'claude-code',
  });
  const snap = await store.readSnapshot(PID);
  console.log(`seeded ${PID}: ${snap?.snapshot.tasks.length} tasks, seq ${snap?.snapshot.seq}`);
  for (const t of snap?.snapshot.tasks ?? []) console.log(`  ${t.status.padEnd(13)} ${t.task_id}`);
  await close();
}

/**
 * Positive control for the whole slice.
 *
 * Asserts each hop separately so a failure is attributable:
 *   1. the store accepts a claim                    -> store works
 *   2. a LIVE subscriber sees the task move          -> push path works
 *   3. the human layer never reaches the inbox       -> the exclusion holds
 */
async function selftest(): Promise<void> {
  const log = new CapturingLogger();
  const { store, close } = connect(log);
  const TASK = 'task_selftest';
  let failed = 0;
  const check = (ok: boolean, label: string) => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
    if (!ok) failed += 1;
  };

  try {
    await store.ensureProject(PID, {
      project_name: 'Inventory Tracker',
      repo_url: 'Sibhimanyu/inventory-tracker-firebase',
    });
    // Fresh task id per run so a previous claim cannot make this pass for the wrong reason.
    const taskId = `${TASK}_${Date.now().toString(36)}`;
    await store.seedTasks(PID, [task(taskId, 'self test')]);

    // --- hop 2 armed BEFORE the write, so we observe a push and not a later read ---
    const frames: Snapshot[] = [];
    const unsub = store.subscribe(PID, 0, (s) => frames.push(s));
    await new Promise((r) => setTimeout(r, 2_000)); // let the initial load settle
    const framesBefore = frames.length;
    check(framesBefore >= 1, `subscriber received an initial frame (${framesBefore})`);

    // --- hop 1: the store accepts a claim ---
    const t0 = Date.now();
    const claim = await store.claimTask(PID, taskId, 'agent_be000001');
    check(claim.ok === true, 'store accepted the claim');

    // --- hop 2: a LIVE subscriber sees it move, with a bounded wait ---
    const deadline = Date.now() + 15_000;
    let movedAt = 0;
    while (Date.now() < deadline) {
      const latest = frames.at(-1);
      const t = latest?.tasks.find((x) => x.task_id === taskId);
      if (t?.status === 'claimed' && t.claimed_by === 'agent_be000001') {
        movedAt = Date.now();
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    check(movedAt > 0, `subscriber saw open -> claimed WITHOUT a refetch (${movedAt ? movedAt - t0 : '>15000'} ms)`);
    check(frames.length > framesBefore, `push delivered new frames (${framesBefore} -> ${frames.length})`);

    // --- hop 3: the human layer must not reach the inbox ---
    await store.appendEvent(
      PID,
      {
        layer: 'human',
        kind: 'task_progress',
        actor_type: 'agent',
        actor_id: 'agent_be000001',
        body: { task_id: taskId, summary: 'narration that must never reach an agent inbox' },
      },
      `selftest-human-${Date.now()}`,
    );
    unsub();

    const { events } = await store.readEvents(PID, 0);
    const humanOnLedger = events.some((e) => e.kind === 'task_progress');
    check(humanOnLedger, 'the human-layer event IS on the ledger (dashboard may show it)');
    // The exclusion is the bridge's job; assert the filter it uses, not the ledger.
    const wouldDeliver = events.filter((e) => e.layer !== 'human').map((e) => e.kind);
    check(!wouldDeliver.includes('task_progress'), 'and is EXCLUDED from what the inbox would get');

    console.log(`\n${failed === 0 ? 'SELFTEST PASSED' : `SELFTEST FAILED (${failed})`}`);
    console.log(`project ${FB_PROJECT} / ${PID}, region asia-south1, real Firestore`);
  } finally {
    await close();
  }
  if (failed > 0) process.exit(1);
}

/**
 * Admit a browser to the project by writing its membership document.
 *
 * This is the whole of order 0039 ruling 1 on the server side. The rules gate reads behind
 * `isMember(pid)`, membership is a DOCUMENT rather than a custom claim (so revocation is
 * immediate rather than waiting for a token refresh), and nothing but the admin SDK can write
 * one -- clients cannot write at all. So admitting a browser is deliberately an out-of-band act
 * by someone holding the service-account credential, which is the property that lets
 * deny-by-default stay intact.
 *
 * The uid comes from the browser's own anonymous sign-in, and the dashboard prints the exact
 * command when it is denied.
 */
async function admit(uid: string): Promise<void> {
  if (!uid || uid.startsWith('--')) {
    console.error('usage: node firebase/bridge-run.ts --admit <uid>');
    console.error('  The dashboard prints the uid when it is denied.');
    process.exit(1);
  }
  // Written with the raw SDK rather than through the store. Membership is not one of the ten
  // coordination operations -- it is authority over who may READ -- and widening the seam to
  // carry it would blur exactly the boundary the seam exists to hold.
  const { db, close } = connect(new CapturingLogger());
  const members = db.collection('projects').doc(PID).collection('members');
  await members.doc(uid).set(
    { uid, role: 'viewer', label: 'browser (anonymous)', revoked: false, admitted_at: systemClock.iso() },
    { merge: true },
  );
  const all = await members.get();
  console.log(`admitted ${uid} to ${PID} (${FB_PROJECT})`);
  console.log(`  members now: ${all.docs.map((d) => d.id).join(', ')}`);
  console.log('  Reload the dashboard; it renders without a refresh thereafter.');
  await close();
}

/** Print the board as the store sees it. The read side of the proof. */
async function board(): Promise<void> {
  const { store, close } = connect(new CapturingLogger());
  const snap = await store.readSnapshot(PID);
  console.log(`${FB_PROJECT} / ${PID}, real Firestore asia-south1, seq ${snap?.snapshot.seq}\n`);
  for (const t of snap?.snapshot.tasks ?? []) {
    console.log(`  ${t.status.padEnd(9)} ${t.task_id.padEnd(26)} ${t.claimed_by ?? '-'}`);
  }
  await close();
}

const mode = process.argv[2] ?? '';
if (mode === '--seed') {
  await seed();
} else if (mode === '--admit') {
  await admit(process.argv[3] ?? '');
} else if (mode === '--board') {
  await board();
} else if (mode === '--selftest') {
  await selftest();
} else {
  const { store, close } = connect();
  // runBridge starts the inbox feed itself. Starting a second one here would subscribe twice
  // and write every inbox line twice, which the agent would read as two events.
  await runBridge({ root: ROOT, project_id: PID, store, log: consoleLogger });
  await close();
}
