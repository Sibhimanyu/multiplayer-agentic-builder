// Does the contention counter register AT ALL? The positive control for a2-production.mjs.
//
// A2 reported "0 contention backoffs" against BOTH production and the emulator. Zero is exactly
// what a broken counter reports, and the emulator is known to contend -- the suite fails there.
// So before reading any zero as evidence, force contention and check the instrument moves.
//
// Forces it the crude way: N concurrent appendEvent calls, which all read-modify-write the SAME
// counter document. That is the one document every append in this design serialises on.
//
//   node firebase/contention-probe.mjs --emulator [N]
//   node firebase/contention-probe.mjs [N]            (production -- costs N writes)
//
// Reports backoffs taken, worst attempt reached against the budget, and whether StoreBusyError
// escaped. A run where nothing contends is reported as INCONCLUSIVE, not as a pass: "no
// contention observed" and "contention absorbed" are different claims.
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createFirestoreStore } from './store.ts';
import { CapturingLogger } from '../shared/log.ts';
import { systemClock } from '../shared/clock.ts';

const EMULATOR = process.argv.includes('--emulator');
if (EMULATOR) process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080';
else if (process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FIRESTORE_EMULATOR_HOST set but --emulator not passed; refusing to guess.');
  process.exit(1);
}

const N = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 64);
const PROJECT = process.env.FB_PROJECT_ID ?? 'multiplayer-agents-eec02';
const PID = `proj_cont_${Date.now().toString(36)}`;
const BUDGET = 6;

const log = new CapturingLogger();
const app = initializeApp({ projectId: PROJECT }, `cont-${Date.now()}`);
const store = createFirestoreStore({ db: getFirestore(app), log, clock: systemClock, debounce_ms: 0 });

console.log(`${EMULATOR ? 'EMULATOR' : 'PRODUCTION'} -- ${N} concurrent appendEvent on one counter document`);
console.log(`mechanism: ${EMULATOR ? 'pessimistic locking with a lock timeout' : 'optimistic concurrency'}\n`);

let escaped = null;
const t0 = Date.now();
try {
  await store.ensureProject(PID, { project_name: 'contention probe', repo_url: 'x/y' });
  const results = await Promise.allSettled(
    Array.from({ length: N }, (_u, i) =>
      store.appendEvent(
        PID,
        { layer: 'human', kind: 'task_progress', actor_type: 'agent', actor_id: 'agent_p', body: { i } },
        `cont-${PID}-${i}`,
      ),
    ),
  );
  const rejected = results.filter((r) => r.status === 'rejected');
  if (rejected.length) {
    escaped = rejected[0].reason;
    console.log(`${rejected.length}/${N} appends REJECTED`);
  } else {
    // Not "it did not throw" -- check every append actually produced a positive seq.
    const bad = results.filter((r) => !(r.value?.seq > 0));
    console.log(`${N}/${N} appends resolved; ${bad.length} without a usable seq`);
  }
} finally {
  await store.close();
  await deleteApp(app);
}
const elapsed = Date.now() - t0;

const contended = log.withCode('store.tx.contended');
const attempts = contended.map((l) => Number(l.fields?.attempt ?? 0));
const worst = attempts.length ? Math.max(...attempts) : 0;

console.log(`\nelapsed                     ${elapsed} ms`);
console.log(`contention backoffs taken   ${contended.length}`);
console.log(`worst attempt reached       ${worst} of ${BUDGET}`);
if (contended.length) {
  const waits = contended.map((l) => Number(l.fields?.wait_ms ?? 0));
  console.log(`backoff waits               min ${Math.min(...waits)} ms, max ${Math.max(...waits)} ms`);
}
if (escaped) {
  console.log(`\nESCAPED: ${escaped.name}: ${escaped.backend_message ?? escaped.message}`);
  console.log(`  grpc_code=${escaped.grpc_code}`);
}

if (contended.length === 0) {
  console.log('\nINCONCLUSIVE -- nothing contended, so this run says nothing about the instrument.');
  console.log('  Raise N, or load the backend concurrently. "No contention observed" is not');
  console.log('  "contention absorbed", and must not be reported as one.');
  process.exit(2);
}
console.log(`\nINSTRUMENT WORKS -- the counter registers contention (${contended.length} backoffs).`);
console.log(escaped ? 'And the budget was EXHAUSTED at this load.' : `Budget held: ${BUDGET - worst} attempt(s) unused.`);
process.exit(escaped ? 1 : 0);
