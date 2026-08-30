// Does the cached revocation check still refuse a revoked agent? Against REAL Firestore.
//
// Order 0039 ruling 2 approved DELETING the revocation read from heartbeat. It cannot be
// deleted: shared conformance A14 requires heartbeat to throw StoreAuthError for a revoked
// agent, and that suite is frozen. So the read was made cheap instead of absent -- cached, for
// heartbeat only -- and this file exists because a change made to keep a test passing is
// worthless if the test never runs.
//
// And here it cannot run: firebase-tools refuses to start the Firestore emulator on this
// machine ("no longer supports Java version before 21"), so firebase/store.test.ts and the
// conformance suite are both unavailable. Rather than claim the change is safe on the strength
// of reading it, this asserts the same behaviour against production Firestore, which is the
// stronger evidence anyway.
//
// Costs a few dozen operations in a throwaway namespace. Negligible.
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createFirestoreStore } from './store.ts';
import { StoreAuthError } from '../shared/store/errors.ts';
import { CapturingLogger } from '../shared/log.ts';

if (process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FIRESTORE_EMULATOR_HOST set; refusing. This is about real Firestore.');
  process.exit(1);
}

const PROJECT = process.env.FB_PROJECT_ID ?? 'multiplayer-agents-eec02';
const PID = `proj_revcheck_${Date.now().toString(36)}`;
const AGENT = 'agent_rev01';
const WINDOW_MS = 90_000; // REVOCATION_CACHE_MS, = STALE_AFTER_MS

// A controllable clock so the 90 s window is tested deterministically instead of by waiting.
// This is a time SOURCE, not a sleep: nothing in the transport path awaits it, which is the
// distinction that made the earlier FakeClock hang possible.
let t = Date.now();
const clock = {
  now: () => t,
  iso: () => new Date(t).toISOString(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

const app = initializeApp({ projectId: PROJECT }, `revcheck-${Date.now()}`);
const db = getFirestore(app);
const store = createFirestoreStore({ db, log: new CapturingLogger(), clock, debounce_ms: 0 });
const agentDoc = db.collection('projects').doc(PID).collection('agents').doc(AGENT);

let failed = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed += 1;
};
const throwsAuth = async (fn) => {
  try {
    await fn();
    return false;
  } catch (err) {
    return err instanceof StoreAuthError;
  }
};

console.log(`real Firestore, ${PROJECT}, asia-south1, namespace ${PID}\n`);

await store.ensureProject(PID, { project_name: 'revocation check', repo_url: 'x/y' });
await store.registerAgent(PID, {
  agent_id: AGENT, role_slug: 'backend-builder', member_label: 'x', initials: 'RV', harness: 'manual',
});

// --- A14's exact sequence: revoke FIRST, then call. The cache is cold, so it reads and denies.
await agentDoc.set({ revoked: true }, { merge: true });
check(await throwsAuth(() => store.heartbeat(PID, AGENT, 'working')), 'A14 shape: revoked-then-heartbeat throws StoreAuthError (cold cache)');
check(await throwsAuth(() => store.claimTask(PID, 'task_x', AGENT)), 'and claimTask throws too (never cached)');

// --- the deny is never cached, so repeating it re-reads and denies again rather than going stale.
check(await throwsAuth(() => store.heartbeat(PID, AGENT, 'working')), 'a second heartbeat is denied too (denies are not cached)');

// --- un-revoking takes effect IMMEDIATELY, which is the reason denies are not cached. The
//     first version of this cached both outcomes and left a re-instated agent unable to beat
//     for the full window; this assertion is what caught it.
await agentDoc.set({ revoked: false }, { merge: true });
check(!(await throwsAuth(() => store.heartbeat(PID, AGENT, 'working'))), 'un-revoking is honoured on the very next heartbeat, with no window');

// --- now the window itself: the cache is warm from that heartbeat. Revoke behind its back.
await agentDoc.set({ revoked: true }, { merge: true });

check(!(await throwsAuth(() => store.heartbeat(PID, AGENT, 'working'))), `within the window a revoked agent still beats -- THIS IS THE STATED ${WINDOW_MS} ms BOUND, not a bug`);

// The board is not fooled meanwhile: it reads `revoked` from the document, not from this cache.
const presence = await store.listPresence(PID);
check(presence.find((p) => p.agent_id === AGENT)?.status === 'revoked', 'and the board shows it as `revoked` throughout, because readers use the document');

// --- past the window, it must refuse again.
t += WINDOW_MS + 1_000;
check(await throwsAuth(() => store.heartbeat(PID, AGENT, 'working')), `past ${WINDOW_MS} ms the cache expires and heartbeat refuses`);

// --- and authority-granting operations were never cached at any point.
check(await throwsAuth(() => store.appendEvent(PID, {
  layer: 'coordination', kind: 'task_completed', actor_type: 'agent', actor_id: AGENT, body: {},
}, `rev-${Date.now()}`)), 'appendEvent still pays a fresh read and refuses immediately');

console.log(`\n${failed === 0 ? 'REVOCATION CHECK PASSED' : `REVOCATION CHECK FAILED (${failed})`}`);
await store.close();
await deleteApp(app);
process.exit(failed === 0 ? 0 : 1);
