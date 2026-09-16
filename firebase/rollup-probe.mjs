// Does the rollup on the project document actually track the tasks collection?
//
// `shared/store/rollup.test.ts` proves the delta arithmetic, including that replaying every
// transition equals a recount. What it cannot prove is the WIRING: that commitRollup is reached
// on every append, that the dotted-key merge creates the nested shape, and that FieldValue
// increments land where the index reads them.
//
// That is the artifact rule. The pure function passing says nothing about whether the field
// exists in Firestore, and the index reads the field, not the function.
//
// Runs against REAL Firestore in a throwaway project namespace, then deletes what it wrote.
// Roughly 20 appends. Negligible cost.
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createFirestoreStore } from './store.ts';
import { rollupFromTasks } from '../shared/store/rollup.ts';
import { CapturingLogger } from '../shared/log.ts';
import { systemClock } from '../shared/clock.ts';

if (process.env.FIRESTORE_EMULATOR_HOST) {
  // The emulator does not enforce indexes and has its own transaction semantics. A rollup that
  // works there says nothing about production -- entry 65.
  console.error('FIRESTORE_EMULATOR_HOST set; refusing. Real Firestore only.');
  process.exit(1);
}

const PROJECT = process.env.FB_PROJECT_ID ?? 'multiplayer-agents-eec02';
const PID = `proj_rollupprobe_${Date.now().toString(36)}`;

const app = initializeApp({ projectId: PROJECT }, `rollup-probe-${Date.now()}`);
const db = getFirestore(app);
const log = new CapturingLogger();
const store = createFirestoreStore({ db, log, clock: systemClock, debounce_ms: 0 });

let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const append = (kind, body) =>
  store.appendEvent(PID, { kind, actor_id: 'agent_probe', actor_type: 'agent', body }, `${kind}:${JSON.stringify(body)}:${Math.random()}`);

const readRollup = async () => (await db.collection('projects').doc(PID).get()).get('rollup') ?? {};
const readTasks = async () =>
  (await db.collection('projects').doc(PID).collection('tasks').get()).docs.map((d) => d.data());

try {
  console.log(`\nrollup probe -- real Firestore, project namespace ${PID}\n`);

  // 1. A project with no events has no rollup. Absent means "not counted", and the index leans on
  //    that to avoid rendering a row of zeroes for a project it has not looked at.
  check(Object.keys(await readRollup()).length === 0,
    'a project with no events has no rollup at all (absent, not zeroed)');

  // 2. Create three tasks, move them, block one, fail CI on another.
  await append('task_created', { task_id: 't1', title: 'one', kind: 'backend' });
  await append('task_created', { task_id: 't2', title: 'two', kind: 'frontend' });
  await append('task_created', { task_id: 't3', title: 'three', kind: 'qa' });
  await append('task_claimed', { task_id: 't2', agent_id: 'agent_be01' });
  await append('task_progress', { task_id: 't2', summary: 'working' });
  await append('task_blocked', { task_id: 't3', reason: 'needs t2', blocked_by_task_id: 't2' });

  const r1 = await readRollup();
  check(typeof r1.last_activity === 'string' && r1.last_activity.length > 0,
    'last_activity is set', r1.last_activity);
  check(typeof r1.last_seq === 'number' && r1.last_seq > 0, 'last_seq tracks the ledger', String(r1.last_seq));

  // 3. THE CHECK THAT MATTERS: the cached counters equal a fresh recount of the tasks collection.
  const recount = (tasks) => rollupFromTasks(tasks, '', 0);
  const meaningful = (c) => Object.fromEntries(Object.entries(c ?? {}).filter(([, v]) => v !== 0));

  {
    const live = await readTasks();
    const expected = recount(live);
    const got = await readRollup();
    check(JSON.stringify(meaningful(got.counts)) === JSON.stringify(meaningful(expected.counts)),
      'counts match a recount of the tasks collection',
      `${JSON.stringify(meaningful(got.counts))} vs ${JSON.stringify(meaningful(expected.counts))}`);
    check((got.blocked ?? 0) === expected.blocked,
      'blocked matches the recount', `${got.blocked} vs ${expected.blocked}`);
  }

  // 4. The control. If the comparison above could not fail, it proves nothing -- so corrupt the
  //    stored counter and confirm the same comparison catches it.
  {
    await db.collection('projects').doc(PID).set({ 'rollup.counts.open': 99 }, { merge: true });
    const live = await readTasks();
    const expected = recount(live);
    const got = await readRollup();
    check(JSON.stringify(meaningful(got.counts)) !== JSON.stringify(meaningful(expected.counts)),
      '(control) a deliberately corrupted counter IS caught by that same comparison');
    // Put it back so the following assertions are not chasing our own damage.
    const repaired = recount(live);
    await db.collection('projects').doc(PID).set({ rollup: { ...got, counts: repaired.counts } }, { merge: true });
  }

  // 5. Unblocking must DECREMENT. A missed decrement is the failure mode a counter cache has, and
  //    it is invisible without this.
  {
    const before = (await readRollup()).blocked ?? 0;
    await append('task_unblocked', { task_id: 't3', was_blocked_by: 't2' });
    const after = (await readRollup()).blocked ?? 0;
    check(after === before - 1, 'unblocking decrements the blocked counter', `${before} -> ${after}`);
    const live = await readTasks();
    check(after === recount(live).blocked, 'and still matches a recount');
  }

  // 6. A duplicate append (same idempotency key) must not double-count.
  {
    const key = `dupe:${Date.now()}`;
    const ev = { kind: 'task_created', actor_id: 'agent_probe', actor_type: 'agent', body: { task_id: 't4', title: 'four', kind: 'docs' } };
    await store.appendEvent(PID, ev, key);
    const once = await readRollup();
    await store.appendEvent(PID, ev, key);
    const twice = await readRollup();
    check(JSON.stringify(meaningful(once.counts)) === JSON.stringify(meaningful(twice.counts)),
      'a replayed append does not double-count', JSON.stringify(meaningful(twice.counts)));
  }
} finally {
  // Leave nothing behind. A probe that litters a live project is the self-test that accumulated
  // four "self test" cards on the real board.
  const proj = db.collection('projects').doc(PID);
  for (const sub of ['tasks', 'events', 'agents', 'claims', 'locks', 'contracts', 'meta']) {
    const docs = await proj.collection(sub).get();
    await Promise.all(docs.docs.map((d) => d.ref.delete()));
  }
  await proj.delete();
  await deleteApp(app);
}

console.log(`\n${failed === 0 ? 'ROLLUP PROBE PASSED' : 'ROLLUP PROBE FAILED'}\n`);
process.exitCode = failed === 0 ? 0 : 1;
