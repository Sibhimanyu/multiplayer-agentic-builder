// A9, reproduced outside the suite that cannot run here.
//
// shared/store/conformance.ts:287 asserts AgentPresence.stale is false one second early, true
// two seconds later, and clears on a fresh heartbeat with no repair step -- all driven by
// advanceTime, a FAKE CLOCK. Order 0040 moves presence to RTDB, and the single way that breaks
// A9 is if `stale` starts coming from server state instead of being derived.
//
// The conformance suite runs against the Firestore emulator, and the emulator will not start on
// this machine: firebase-tools requires JDK 21+ and an older JDK is installed. So A9 is
// UNRUNNABLE here. Rather than change presence and claim the suite still passes, this asserts
// A9's exact sequence two ways:
//
//   1. through the real store against production Firestore, with an injected clock
//   2. through derivePresence() directly -- the derivation BOTH backends share, including the
//      RTDB one, which has no instance to run against
//
// (2) is the one that matters for the port swap: if the shared derivation stays clock-driven,
// RTDB cannot break A9, because RTDB never supplies `stale`.
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createFirestoreStore } from './store.ts';
import { toPresence } from './presence.ts';
import { STALE_AFTER_MS } from '../shared/store/types.ts';
import { CapturingLogger } from '../shared/log.ts';

if (process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FIRESTORE_EMULATOR_HOST set; refusing. Real Firestore only.');
  process.exit(1);
}

const PROJECT = process.env.FB_PROJECT_ID ?? 'multiplayer-agents-eec02';
const PID = `proj_a9_${Date.now().toString(36)}`;
const AGENT = 'agent_a9';

let t = Date.now();
const clock = { now: () => t, iso: () => new Date(t).toISOString(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };
const advance = (ms) => { t += ms; };

let failed = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed += 1;
};

// ---------------- 2. the shared derivation, which is what RTDB would feed ----------------
console.log('derivePresence() -- the derivation both backends share:\n');
{
  const row = { agent_id: AGENT, status: 'working', last_heartbeat_ms: t };
  check(toPresence(row, clock).stale === false, 'fresh heartbeat is not stale');
  check(toPresence(row, clock).status === 'working', 'and keeps its reported status');

  advance(STALE_AFTER_MS - 1_000);
  check(toPresence(row, clock).stale === false, 'not stale one second early');

  advance(2_000);
  check(toPresence(row, clock).stale === true, 'stale flips past the 90s timeout');

  // "Derived, not stored": a fresh heartbeat clears it with no repair step.
  const beaten = { ...row, last_heartbeat_ms: t };
  check(toPresence(beaten, clock).stale === false, 'a fresh heartbeat clears it with no repair step');

  // The two signals are independent, which is the whole design of order 0040.
  const dropped = { ...beaten, connected: false };
  check(toPresence(dropped, clock).status === 'offline', 'onDisconnect (connected:false) reports status offline');
  check(toPresence(dropped, clock).stale === false, 'and does NOT make it stale -- different signal, different meaning');
  const absent = toPresence({ agent_id: AGENT, status: 'working', last_heartbeat_ms: t }, clock);
  check(absent.status === 'working', 'absent `connected` means no opinion, not offline');
  check(toPresence({ ...beaten, revoked: true }, clock).status === 'revoked', 'revoked outranks both');
}

// ---------------- 1. the same sequence through the real store ----------------
console.log('\nreal Firestore, same sequence, injected clock:\n');
const app = initializeApp({ projectId: PROJECT }, `a9-${Date.now()}`);
const store = createFirestoreStore({ db: getFirestore(app), log: new CapturingLogger(), clock, debounce_ms: 0 });

const presenceOf = async () => (await store.listPresence(PID)).find((p) => p.agent_id === AGENT);

try {
  await store.ensureProject(PID, { project_name: 'a9', repo_url: 'x/y' });
  await store.registerAgent(PID, {
    agent_id: AGENT, role_slug: 'backend-builder', member_label: 'sibhi', initials: 'A9', harness: 'claude-code',
  });

  await store.heartbeat(PID, AGENT, 'working', 'task_items_api', 'feat/items');
  const fresh = await presenceOf();
  check(fresh?.stale === false, 'fresh.stale === false');
  check(fresh?.status === 'working', 'fresh.status === working');
  check(!!fresh?.last_heartbeat_at, 'last_heartbeat_at is set');

  advance(STALE_AFTER_MS - 1_000);
  check((await presenceOf())?.stale === false, 'not stale one second early');

  advance(2_000);
  check((await presenceOf())?.stale === true, 'stale flips past the 90s timeout');

  await store.heartbeat(PID, AGENT, 'working', 'task_items_api', 'feat/items');
  check((await presenceOf())?.stale === false, 'a fresh heartbeat clears it, no repair step');
} finally {
  await store.close();
  await deleteApp(app);
}

console.log(`\n${failed === 0 ? 'A9 EQUIVALENT PASSED' : `A9 EQUIVALENT FAILED (${failed})`}`);
console.log('NOT a substitute for the suite: A9 itself is unrun because the emulator needs JDK 21+.');
process.exit(failed === 0 ? 0 : 1);
