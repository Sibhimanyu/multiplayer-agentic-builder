// A2's EXACT sequence against production Firestore. The discriminating experiment, order 0042.
//
// A2 fails on the emulator with `10 ABORTED: Transaction lock timeout` escaping
// withContentionRetry. The emulator implements transactions with PESSIMISTIC locking and a lock
// timeout; production Firestore uses OPTIMISTIC concurrency and retries on a version conflict.
// So that error string may describe an emulator mechanism that does not exist in production --
// a hypothesis, and the kind this project has been wrong about before, so it gets measured.
//
// Same racer count, same rounds, same assertions, same adapter path (store.claimTask) as
// shared/store/conformance.ts:125. The only difference is which Firestore is on the other end.
//
// It also instruments what the suite cannot see:
//   - how many retry attempts the WORST transaction actually consumed, against the budget
//   - every distinct backend error observed, by structured code, not by message text
//   - per-round wall clock, so "it passed" comes with the load it passed under
//
// Cost: roughly 1,000 reads and a few hundred writes per run. Losers read the claim document and
// return without writing, so this is far cheaper than its round count suggests.
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createFirestoreStore } from './store.ts';
import { CapturingLogger } from '../shared/log.ts';
import { systemClock } from '../shared/clock.ts';

// `--emulator` runs the SAME harness against the emulator. That is not a convenience: a run
// reporting "0 contention backoffs" is indistinguishable from a broken counter, so the emulator
// side is the POSITIVE CONTROL for the instrument. If the counter registers there and reads zero
// on production, the zero means something.
const EMULATOR = process.argv.includes('--emulator');
if (EMULATOR) {
  process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
} else if (process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FIRESTORE_EMULATOR_HOST is set but --emulator was not passed.');
  console.error('  Refusing to guess which backend this run is measuring.');
  process.exit(1);
}

const PROJECT = process.env.FB_PROJECT_ID ?? 'multiplayer-agents-eec02';
const CLAIMANTS = Number(process.env.A2_CLAIMANTS ?? 20);
const ROUNDS = Number(process.env.A2_ROUNDS ?? 50);
const PID = `proj_a2_${Date.now().toString(36)}`;

const log = new CapturingLogger();
const app = initializeApp({ projectId: PROJECT }, `a2-${Date.now()}`);
const store = createFirestoreStore({ db: getFirestore(app), log, clock: systemClock, debounce_ms: 0 });

const task = (task_id, title) => ({
  task_id, title, kind: 'backend', status: 'open', claimed_by: null,
  branch: null, pr_url: null, pr_number: null, ci: null, depends_on: [],
  blocked_by: null, blocked_reason: null, file_scope: [], updated_at: systemClock.iso(),
});

const pct = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
};

console.log(
  EMULATOR
    ? `A2 against the EMULATOR -- ${process.env.FIRESTORE_EMULATOR_HOST} (no latency here is a result)`
    : `A2 against PRODUCTION Firestore -- ${PROJECT}, asia-south1, client Asia/Kolkata`,
);
console.log(`${CLAIMANTS} concurrent claimants x ${ROUNDS} consecutive rounds, namespace ${PID}`);
console.log(
  `mechanism: ${EMULATOR ? 'pessimistic locking with a lock timeout' : 'optimistic concurrency (server-side version check, SDK retry)'}\n`,
);

const claimants = Array.from({ length: CLAIMANTS }, (_u, i) => `agent_r${i}`);
let failures = 0;
const roundMs = [];
const errors = new Map();

try {
  await store.ensureProject(PID, { project_name: 'A2 production', repo_url: 'x/y' });
  for (const agent_id of claimants) {
    await store.registerAgent(PID, {
      agent_id, role_slug: 'backend', member_label: `Racer ${agent_id}`, initials: 'R', harness: 'manual',
    });
  }

  for (let round = 0; round < ROUNDS; round += 1) {
    const task_id = `task_race_${round}`;
    await store.seedTasks(PID, [task(task_id, `Race ${round}`)]);

    const t0 = Date.now();
    // Promise.all, exactly as A2 does: a rejection anywhere fails the round, which is the point
    // -- A2 asserts the adapter ABSORBS contention rather than surfacing it.
    let results;
    try {
      results = await Promise.all(
        claimants.map((agent_id) => store.claimTask(PID, task_id, agent_id)),
      );
    } catch (err) {
      failures += 1;
      const code = err?.grpc_code ?? err?.name ?? 'unknown';
      errors.set(code, (errors.get(code) ?? 0) + 1);
      console.log(`  round ${round}: THREW ${err?.name}: ${err?.backend_message ?? err?.message}`);
      continue;
    }
    roundMs.push(Date.now() - t0);

    const winners = results.filter((r) => r.ok);
    const losers = results.filter((r) => !r.ok);
    const owners = new Set(losers.map((l) => l.owner));

    if (winners.length !== 1) {
      failures += 1;
      console.log(`  round ${round}: expected 1 winner, got ${winners.length}`);
    } else if (losers.length !== CLAIMANTS - 1) {
      failures += 1;
      console.log(`  round ${round}: expected ${CLAIMANTS - 1} losers, got ${losers.length}`);
    } else if (owners.size !== 1) {
      failures += 1;
      console.log(`  round ${round}: losers disagree on the owner (${owners.size} distinct)`);
    } else if (!claimants.includes([...owners][0])) {
      failures += 1;
      console.log(`  round ${round}: owner is not a claimant`);
    }

    if ((round + 1) % 10 === 0) {
      console.log(`  ${round + 1}/${ROUNDS} rounds, ${failures} failure(s) so far`);
    }
  }
} finally {
  await store.close();
  await deleteApp(app);
}

// ---- what the suite cannot see: how close the retry budget came to exhausting ----
const contended = log.withCode('store.tx.contended');
const attemptsUsed = contended.map((l) => Number(l.fields?.attempt ?? 0));
const worst = attemptsUsed.length ? Math.max(...attemptsUsed) : 0;
const BUDGET = 6;

const WHERE = EMULATOR ? 'the emulator' : 'production';
console.log(`\n--- result: ${failures === 0 ? `A2 PASSES on ${WHERE}` : `A2 FAILS on ${WHERE} (${failures} round(s))`} ---\n`);
if (roundMs.length) {
  console.log(`round latency  n=${roundMs.length}  p50=${pct(roundMs, 0.5)} ms  p95=${pct(roundMs, 0.95)} ms  max=${Math.max(...roundMs)} ms`);
}
console.log(`contention backoffs taken       ${contended.length}`);
console.log(`worst attempt reached           ${worst} of ${BUDGET}`);
console.log(`headroom at this load           ${BUDGET - worst} attempt(s) unused`);
if (errors.size) {
  console.log('distinct backend error codes:');
  for (const [code, n] of errors) console.log(`  ${code}: ${n}`);
} else {
  console.log('distinct backend error codes:   none -- nothing escaped the adapter');
}
process.exit(failures === 0 ? 0 : 1);
