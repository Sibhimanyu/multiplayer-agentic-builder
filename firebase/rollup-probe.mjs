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
// WHAT THIS PROBE GOT WRONG, recorded rather than quietly fixed (Order 0063).
//
// It was written against a `task_created` kind that DID NOT EXIST. It failed on its first append
// with `StoreError: unknown event kind: task_created` -- an invented kind, not a discovered bug,
// and chasing it is what found that nothing in the product could create a task at all. It was
// wrong a SECOND way that the first error hid: every append omitted `layer`, and planAppend
// rejects a layer that does not equal LAYER_OF[kind]. Fixing only the kind would have moved the
// failure one line down. The layer is now DERIVED from LAYER_OF rather than typed out, so the
// probe cannot disagree with the contract about it again.
//
// It was wrong a third way, found only by running it: it blocked a task straight out of `open`,
// which the fold refuses (`open -> blocked` is not a legal transition), so the "unblocking
// decrements" check was measuring a counter that had never been incremented. The probe now
// claims the task first, which is the path a real agent takes.
//
// Runs against REAL Firestore in a throwaway project namespace, then deletes what it wrote.
// Roughly 20 appends. Negligible cost.
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createFirestoreStore } from './store.ts';
import { rollupFromTasks } from '../shared/store/rollup.ts';
import { LAYER_OF } from '../shared/store/types.ts';
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

// The layer is a FACT ABOUT THE KIND, so it is read from LAYER_OF and never typed out here.
// A probe that hardcodes it is a second place that can disagree with the contract.
const append = (kind, body) =>
  store.appendEvent(
    PID,
    { layer: LAYER_OF[kind], kind, actor_id: 'agent_probe', actor_type: 'agent', body },
    `${kind}:${JSON.stringify(body)}:${Math.random()}`,
  );

const OWNER = { actor_type: 'member', actor_id: 'uid_probe' };

const readRollup = async () => (await db.collection('projects').doc(PID).get()).get('rollup') ?? {};
const readTasks = async () =>
  (await db.collection('projects').doc(PID).collection('tasks').get()).docs.map((d) => d.data());

try {
  console.log(`\nrollup probe -- real Firestore, project namespace ${PID}\n`);

  // 1. A project with no events has no rollup. Absent means "not counted", and the index leans on
  //    that to avoid rendering a row of zeroes for a project it has not looked at.
  check(Object.keys(await readRollup()).length === 0,
    'a project with no events has no rollup at all (absent, not zeroed)');

  // 2. Create three tasks THROUGH THE PORT. Not a hand-built event: createTask is the operation
  //    the CLI and the write function call, so this is the path a real first-run takes.
  const t1 = await store.createTask(PID, { task_id: 't1', title: 'one', kind: 'backend' }, OWNER);
  const t2 = await store.createTask(PID, { task_id: 't2', title: 'two', kind: 'frontend' }, OWNER);
  const t3 = await store.createTask(PID, { task_id: 't3', title: 'three', kind: 'qa' }, OWNER);
  check(t1.ok && t2.ok && t3.ok, 'createTask created three tasks against real Firestore');

  {
    // The whole reason Order 0063 exists: a created task must actually be on the board.
    const live = await readTasks();
    const created = live.find((t) => t.task_id === 't1');
    check(!!created && created.status === 'open' && created.title === 'one' && created.kind === 'backend',
      'a created task is a real open card in the tasks collection',
      created ? `${created.status}/${created.kind}` : '(absent)');
  }

  await append('task_claimed', { task_id: 't2', agent_id: 'agent_be01' });
  await append('task_progress', { task_id: 't2', summary: 'working' });
  // t3 is claimed before it is blocked: `open -> blocked` is not a legal transition, so blocking
  // a fresh task moves nothing and the decrement check below would have had nothing to decrement.
  await append('task_claimed', { task_id: 't3', agent_id: 'agent_qa01' });
  await append('task_blocked', { task_id: 't3', reason: 'needs t2', blocked_by_task_id: 't2' });

  const r1 = await readRollup();
  check(typeof r1.last_activity === 'string' && r1.last_activity.length > 0,
    'last_activity is set', r1.last_activity);
  check(typeof r1.last_seq === 'number' && r1.last_seq > 0, 'last_seq tracks the ledger', String(r1.last_seq));

  // 3. THE CHECK THAT MATTERS: the cached counters equal a fresh recount of the tasks collection.
  const recount = (tasks) => rollupFromTasks(tasks, '', 0);
  // SORTED, because these two objects are built in different orders and compared as strings.
  // Firestore hands back map keys in its own order and rollupFromTasks builds them in task order,
  // so an unsorted JSON.stringify reports {open,blocked,claimed} != {open,claimed,blocked} -- a
  // red check on two identical sets of numbers. Found by running it.
  const meaningful = (c) => Object.fromEntries(
    Object.entries(c ?? {}).filter(([, v]) => v !== 0).sort(([a], [b]) => a.localeCompare(b)),
  );

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
    // NESTED, not a dotted key. The corruption has to land where the rollup actually lives, or
    // the control "passes" by comparing two things that are both empty -- which is exactly what
    // it did on the run that found the dotted-key defect.
    await db.collection('projects').doc(PID).set({ rollup: { counts: { open: 99 } } }, { merge: true });
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
    const ev = {
      layer: LAYER_OF.task_created, kind: 'task_created', actor_id: 'agent_probe', actor_type: 'agent',
      body: { task_id: 't4', title: 'four', kind: 'docs' },
    };
    await store.appendEvent(PID, ev, key);
    const once = await readRollup();
    await store.appendEvent(PID, ev, key);
    const twice = await readRollup();
    check(JSON.stringify(meaningful(once.counts)) === JSON.stringify(meaningful(twice.counts)),
      'a replayed append does not double-count', JSON.stringify(meaningful(twice.counts)));
  }

  // 7. createTask's OWN idempotency, which is a different mechanism from the dedupe key above:
  //    the task id is the identity, so a retried create finds the card already there. This is the
  //    case a CLI hits after a timeout it cannot tell apart from a failure, and the failure mode
  //    it prevents is the one this board has actually suffered -- four identical "self test"
  //    cards that nobody could account for.
  {
    const before = await readRollup();
    const again = await store.createTask(PID, { task_id: 't1', title: 'one', kind: 'backend' }, OWNER);
    const after = await readRollup();
    check(again.ok === false, 'a repeated createTask reports the existing task rather than creating one',
      again.ok ? 'created a second time' : `status ${again.existing?.status}`);
    check(JSON.stringify(meaningful(before.counts)) === JSON.stringify(meaningful(after.counts)),
      'and it does not move a single counter',
      `${JSON.stringify(meaningful(before.counts))} vs ${JSON.stringify(meaningful(after.counts))}`);
  }

  // 8. The id the CLI actually uses. `flotilla task "<title>"` supplies no id, so the derivation
  //    is the default path and a probe that only ever passes explicit ids never exercises it.
  {
    const derived = await store.createTask(PID, { title: 'Wire the webhook', kind: 'devops' }, OWNER);
    check(derived.ok && derived.task_id === 'task_wire_the_webhook',
      'an id omitted by the caller is derived from the title',
      derived.ok ? derived.task_id : '(not created)');
    const live = await readTasks();
    const got = await readRollup();
    check((got.counts?.open ?? 0) === recount(live).counts.open,
      'and open STILL equals a recount after every create in this run',
      `${got.counts?.open} vs ${recount(live).counts.open}`);
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
