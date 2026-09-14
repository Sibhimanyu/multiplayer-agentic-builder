// F5, F11 and F12 against real Firestore. Evidence type: LEDGER, as the checklist specifies.
//
// These three need nothing from the user -- no board, so no Auth, and no RTDB instance. F8-F10
// need the dashboard and wait.
//
// F11 and F12 are ONE test in two halves, per order 0043: a release nobody can then claim is not
// a release. They are asserted together and share a namespace for that reason.
//
// The reaper here runs the way it runs in production on this route: inside a bridge process,
// behind the lease. Spark has no Cloud Functions, so there is no scheduled sweep to lean on --
// see the header of firebase/reaper.ts.
//
//   node firebase/f-cases.mjs
//
// Costs a few hundred operations.
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createFirestoreStore } from './store.ts';
import { makeReaperPort } from './reaper.ts';
import { startReaper, REAPER_LEASE_ID } from '../cli/bridge.ts';
import { CLAIM_TIMEOUT_MS } from '../shared/store/types.ts';
import { CapturingLogger } from '../shared/log.ts';
import { systemClock } from '../shared/clock.ts';

if (process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FIRESTORE_EMULATOR_HOST set; refusing. These are product-level cases on real Firestore.');
  process.exit(1);
}

const PROJECT = process.env.FB_PROJECT_ID ?? 'multiplayer-agents-eec02';
const PID = `proj_f_${Date.now().toString(36)}`;

let failed = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const task = (task_id, title, kind = 'backend') => ({
  task_id, title, kind, status: 'open', claimed_by: null,
  branch: null, pr_url: null, pr_number: null, ci: null, depends_on: [],
  blocked_by: null, blocked_reason: null, file_scope: [], updated_at: systemClock.iso(),
});

const log = new CapturingLogger();
const app = initializeApp({ projectId: PROJECT }, `fcases-${Date.now()}`);
const db = getFirestore(app);
const store = createFirestoreStore({ db, log, clock: systemClock, debounce_ms: 0 });

/** Every event of a kind, from the ledger. The ledger IS the evidence for these cases. */
const eventsOf = async (kind, task_id) => {
  const { events } = await store.readEvents(PID, 0);
  return events.filter((e) => e.kind === kind && (!task_id || e.body.task_id === task_id));
};

console.log(`F-cases against real Firestore -- ${PROJECT}, asia-south1`);
console.log(`namespace ${PID}\nevidence: ledger\n`);

try {
  await store.ensureProject(PID, { project_name: 'Inventory Tracker', repo_url: 'Sibhimanyu/inventory-tracker' });
  for (const [id, role, initials] of [
    ['agent_backend', 'backend-builder', 'BE'],
    ['agent_frontend', 'frontend-builder', 'FE'],
    ['agent_reaper', 'backend-builder', 'RP'],
  ]) {
    await store.registerAgent(PID, { agent_id: id, role_slug: role, member_label: 'sibhi', initials, harness: 'claude-code' });
  }

  // ---------------------------------------------------------------- F5
  // "Backend and frontend claim concurrently; no double-claim." The product-level version of
  // A2: two REAL agents, one task, simultaneously, through the same adapter path the bridge uses.
  console.log('F5  backend and frontend claim concurrently, no double-claim');
  await store.seedTasks(PID, [task('task_items_crud', 'CRUD handlers for items')]);

  const [be, fe] = await Promise.all([
    store.claimTask(PID, 'task_items_crud', 'agent_backend'),
    store.claimTask(PID, 'task_items_crud', 'agent_frontend'),
  ]);
  const winners = [be, fe].filter((r) => r.ok);
  const losers = [be, fe].filter((r) => !r.ok);
  check(winners.length === 1, `exactly one winner (${winners.length})`);
  check(losers.length === 1 && typeof losers[0].owner === 'string', 'the loser is told who owns it, and does not throw');

  // The LEDGER is the evidence, not the return values: exactly one task_claimed must exist.
  const claimed = await eventsOf('task_claimed', 'task_items_crud');
  check(claimed.length === 1, `ledger carries exactly ONE task_claimed for the task (${claimed.length})`);
  const owner = claimed[0]?.body.agent_id;
  check(losers[0].owner === owner, `the loser names the same owner the ledger records (${owner})`);

  // ---------------------------------------------------------------- F11 + F12
  // "Kill the agent's laptop; reaper releases the claim within 15 min", then "another agent
  // claims the released task successfully". Asserted together: a release nobody can claim is
  // not a release.
  console.log('\nF11 reaper releases a dead agent\'s claim  /  F12 another agent then claims it');
  await store.seedTasks(PID, [task('task_items_ui', 'Items list view', 'frontend')]);
  const claim = await store.claimTask(PID, 'task_items_ui', 'agent_frontend');
  check(claim.ok === true, 'frontend claims the task');

  // "Kill the laptop" = the agent stops heartbeating. Simulated by backdating its last heartbeat
  // past CLAIM_TIMEOUT_MS rather than by waiting 15 real minutes. The reaper's own clock is real;
  // only the agent's last-seen time is moved, which is the thing a dead laptop actually changes.
  await db.collection('projects').doc(PID).collection('agents').doc('agent_frontend')
    .set({ last_heartbeat_ms: Date.now() - (CLAIM_TIMEOUT_MS + 60_000) }, { merge: true });
  const presence = (await store.listPresence(PID)).find((p) => p.agent_id === 'agent_frontend');
  check(presence?.stale === true, 'the killed agent reads as stale (the reaper\'s precondition)');

  // Run the reaper the way this route runs it: inside a bridge, behind the lease.
  const reaper = makeReaperPort(db, store, PID, log, REAPER_LEASE_ID);
  const stopReaper = startReaper({
    root: process.cwd(), project_id: PID, store, log,
    agent_id: 'agent_reaper', reaper, interval_ms: 5_000,
  });

  // Wait for the sweep, bounded. Asserting the RELEASE, not the absence of the agent.
  let released = [];
  for (let i = 0; i < 40 && released.length === 0; i++) {
    await sleep(500);
    released = await eventsOf('task_unblocked', 'task_items_ui');
  }
  stopReaper();

  check(released.length >= 1, `F11: ledger carries task_unblocked for the claim (${released.length})`);
  check(
    released[0]?.actor_type === 'system',
    `F11: the release is SYSTEM-attributed, not attributed to the dead agent (${released[0]?.actor_type})`,
  );

  // F12: the release must be real, which means claimable.
  const reclaim = await store.claimTask(PID, 'task_items_ui', 'agent_backend');
  check(reclaim.ok === true, 'F12: another agent claims the released task successfully');
  const uiClaims = await eventsOf('task_claimed', 'task_items_ui');
  check(uiClaims.length === 2, `F12: ledger shows both claims in order (${uiClaims.length})`);
  check(
    uiClaims.at(-1)?.body.agent_id === 'agent_backend' && uiClaims.at(-1).seq > released[0].seq,
    'F12: the second claim is recorded AFTER the release, not before it',
  );

  // ---------------------------------------------------------------- the stampede guard
  console.log('\nstampede guard: concurrent bridges must not all sweep');
  const BRIDGES = 5;
  // Registered and heartbeating BEFORE any reaper starts: a bridge whose presence row is missing
  // reads as dead, and the dead-holder path would then break the lease and defeat the test.
  for (let i = 0; i < BRIDGES; i++) {
    await store.registerAgent(PID, {
      agent_id: `agent_r${i}`, role_slug: 'backend-builder', member_label: 'sibhi', initials: `R${i}`, harness: 'manual',
    });
    await store.heartbeat(PID, `agent_r${i}`, 'connected');
  }

  let sweeps = 0;
  const stops = Array.from({ length: BRIDGES }, (_u, i) => {
    const port = makeReaperPort(db, store, PID, log, REAPER_LEASE_ID);
    return startReaper({
      root: process.cwd(), project_id: PID, store, log,
      agent_id: `agent_r${i}`,
      reaper: {
        sweep: async () => { sweeps += 1; return port.sweep(); },
        breakLease: port.breakLease,
      },
      // Long interval so this measures the IMMEDIATE start-up sweep racing, which is the
      // stampede that actually happens: five laptops opening at once.
      interval_ms: 60_000,
    });
  });
  await sleep(8_000);
  for (const s of stops) s();
  check(sweeps === 1, `exactly one of ${BRIDGES} concurrent bridges swept (${sweeps})`);

  // NEGATIVE CONTROL (entry 60): "1 of 5" is also what four silently-broken bridges produce.
  // Give each bridge its OWN lease id so nothing contends, and the same five must all sweep. If
  // this does not reach 5, the number above was measuring breakage, not the guard.
  let unguarded = 0;
  const stops2 = Array.from({ length: BRIDGES }, (_u, i) => {
    const lease = `${REAPER_LEASE_ID}_ctl_${i}`;
    const port = makeReaperPort(db, store, PID, log, lease);
    return startReaper({
      root: process.cwd(), project_id: PID, store, log,
      agent_id: `agent_r${i}`,
      lease_id: lease, // each bridge its own lease: nothing contends, so all five must sweep
      reaper: {
        sweep: async () => { unguarded += 1; return port.sweep(); },
        breakLease: port.breakLease,
      },
      interval_ms: 60_000,
    });
  });
  await sleep(8_000);
  for (const s of stops2) s();
  check(
    unguarded === BRIDGES,
    `control: with no shared lease all ${BRIDGES} sweep (${unguarded}) -- so the 1 above is the guard, not breakage`,
  );
} finally {
  await store.close();
  await deleteApp(app);
}

console.log(`\n${failed === 0 ? 'F-CASES PASSED' : `F-CASES FAILED (${failed})`}`);
console.log(`F5, F11, F12 -- evidence: ledger, real Firestore ${PROJECT} asia-south1`);
process.exit(failed === 0 ? 0 : 1);
