// Does anything actually emit on HEARTBEAT_INTERVAL_MS? Against real Firestore.
//
// Order 0041 ruling 3: "a constant nothing reads is how the last figure became unmeasurable."
// So this asserts the emitter runs, not that it compiles. It uses the REAL 30 s interval and
// really waits for it -- shortening the interval for the test would verify a different number
// than the one shipped, which is the exact failure mode this order is about.
//
// Runs about 100 s. A few dozen operations.
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createFirestoreStore } from './store.ts';
import { startHeartbeat } from '../cli/bridge.ts';
import { HEARTBEAT_INTERVAL_MS, STALE_AFTER_MS } from '../shared/store/types.ts';
import { CapturingLogger } from '../shared/log.ts';
import { systemClock } from '../shared/clock.ts';

if (process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FIRESTORE_EMULATOR_HOST set; refusing. Real Firestore only.');
  process.exit(1);
}

const PROJECT = process.env.FB_PROJECT_ID ?? 'multiplayer-agents-eec02';
const PID = `proj_hb_${Date.now().toString(36)}`;
const AGENT = 'agent_hb01';

let failed = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const log = new CapturingLogger();
const app = initializeApp({ projectId: PROJECT }, `hb-${Date.now()}`);
const db = getFirestore(app);
const store = createFirestoreStore({ db, log, clock: systemClock, debounce_ms: 0 });
const agentDoc = db.collection('projects').doc(PID).collection('agents').doc(AGENT);

const beatAt = async () => {
  const p = (await store.listPresence(PID)).find((x) => x.agent_id === AGENT);
  return p?.last_heartbeat_at ? Date.parse(p.last_heartbeat_at) : null;
};

console.log(`real Firestore, ${PROJECT}, asia-south1, namespace ${PID}`);
console.log(`HEARTBEAT_INTERVAL_MS = ${HEARTBEAT_INTERVAL_MS}, STALE_AFTER_MS = ${STALE_AFTER_MS}\n`);

check(
  STALE_AFTER_MS / HEARTBEAT_INTERVAL_MS === 3,
  `the interval tolerates exactly two missed beats before stale (${STALE_AFTER_MS}/${HEARTBEAT_INTERVAL_MS} = ${STALE_AFTER_MS / HEARTBEAT_INTERVAL_MS})`,
);

let stop = () => {};
try {
  await store.ensureProject(PID, { project_name: 'heartbeat', repo_url: 'x/y' });
  await store.registerAgent(PID, {
    agent_id: AGENT, role_slug: 'backend-builder', member_label: 'sibhi', initials: 'HB', harness: 'claude-code',
  });
  check((await beatAt()) === null, 'no heartbeat before the emitter starts (control)');

  stop = startHeartbeat({
    root: process.cwd(), project_id: PID, store, log, agent_id: AGENT, status: 'working',
  });

  // 1. it beats IMMEDIATELY -- a fresh agent must not be invisible for a whole interval.
  await sleep(4_000);
  const first = await beatAt();
  check(first !== null, 'a beat lands immediately on start, not one interval later');

  const p1 = (await store.listPresence(PID)).find((x) => x.agent_id === AGENT);
  check(p1?.stale === false, 'and the agent reads as not stale');
  check(p1?.status === 'working', 'with the status the emitter was given');

  // 2. it beats AGAIN, on the interval. Really waiting it out.
  console.log(`\n  ... waiting ${HEARTBEAT_INTERVAL_MS / 1000}s for the second beat\n`);
  await sleep(HEARTBEAT_INTERVAL_MS + 5_000);
  const second = await beatAt();
  const gap = second - first;
  check(second > first, `a second beat landed on schedule (gap ${gap} ms)`);
  check(
    Math.abs(gap - HEARTBEAT_INTERVAL_MS) < 5_000,
    `and the gap matches HEARTBEAT_INTERVAL_MS within 5s (${gap} vs ${HEARTBEAT_INTERVAL_MS})`,
  );

  // 3. revocation stops it. A revoked agent beating forever writes presence it is not entitled
  //    to and pays a read per beat to do it.
  await agentDoc.set({ revoked: true }, { merge: true });
  console.log(`\n  ... revoked; waiting ${(HEARTBEAT_INTERVAL_MS + 95_000) / 1000}s to see beats stop\n`);
  // Past the 90s revocation cache as well as the beat interval, so the stop is real and not
  // just the cache not having expired yet.
  await sleep(HEARTBEAT_INTERVAL_MS + 95_000);
  const afterRevoke = await beatAt();
  const beatsAfter = await beatAt();
  await sleep(HEARTBEAT_INTERVAL_MS + 5_000);
  check((await beatAt()) === beatsAfter, 'heartbeats STOP once the token is revoked');
  check(
    log.withCode('bridge.heartbeat_revoked').length > 0,
    'and the stop is logged rather than silent',
  );
  void afterRevoke;
} finally {
  stop();
  await store.close();
  await deleteApp(app);
}

console.log(`\n${failed === 0 ? 'HEARTBEAT CHECK PASSED' : `HEARTBEAT CHECK FAILED (${failed})`}`);
process.exit(failed === 0 ? 0 : 1);
