// Why is an uncontended claim ~6x slower than an append, when it is only 2 more reads and
// 1 more write in the same transaction?
//
// Run 1 measured, on real Firestore in asia-south1:
//     appendEvent            p50 186 ms
//     claimTask uncontended  p50 1167 ms
//
// I have a hypothesis — the 100 appends immediately preceding it all wrote the SAME counter
// document, and Firestore rate-limits sustained writes to one document, so G2 inherited a
// backlog. But a hypothesis is not a result (order 0028), and the cheap way to tell is to run
// the same claims in a FRESH project namespace with no prior appends.
//
// Two outcomes, both informative:
//   ~250 ms  -> the ordering inside run 1 was a confound; the run-1 G2 figure is contaminated
//   ~1100 ms -> claiming really is that much dearer than appending, and the reason is unknown
//
// ~40 claims. Negligible cost.
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createFirestoreStore } from './store.ts';
import { CapturingLogger } from '../shared/log.ts';
import { systemClock } from '../shared/clock.ts';

if (process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FIRESTORE_EMULATOR_HOST set; refusing. Real Firestore only.');
  process.exit(1);
}

const PROJECT = process.env.FB_PROJECT_ID ?? 'multiplayer-agents-eec02';
const N = Number(process.env.PROBE_N ?? 40);

const app = initializeApp({ projectId: PROJECT }, `probe-claim-${Date.now()}`);
const db = getFirestore(app);
const log = new CapturingLogger();
const store = createFirestoreStore({ db, log, clock: systemClock, debounce_ms: 0 });

const pct = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
};
const line = (label, xs) =>
  `${label.padEnd(34)} n=${xs.length}  p50=${pct(xs, 0.5)}  p95=${pct(xs, 0.95)}  max=${Math.max(...xs)}`;

const task = (id) => ({
  task_id: id, title: id, kind: 'backend', status: 'open', claimed_by: null,
  branch: null, pr_url: null, pr_number: null, ci: null, depends_on: [],
  blocked_by: null, blocked_reason: null, file_scope: [], updated_at: systemClock.iso(),
});

// FRESH namespace: no prior appends, so no counter-document backlog to inherit.
const PID = `proj_probe_${Date.now().toString(36)}`;
await store.ensureProject(PID, { project_name: 'claim probe', repo_url: 'example/repo' });

for (let i = 0; i < N; i++) await store.seedTasks(PID, [task(`t_${i}`)]);

// A: claims with NOTHING appended beforehand.
const cold = [];
for (let i = 0; i < N; i++) {
  const t0 = Date.now();
  const r = await store.claimTask(PID, `t_${i}`, 'agent_probe');
  cold.push(Date.now() - t0);
  if (!r.ok) throw new Error(`uncontended claim ${i} lost — impossible`);
}

// B: appends in the SAME namespace, for a same-project comparison.
const appends = [];
for (let i = 0; i < N; i++) {
  const t0 = Date.now();
  await store.appendEvent(
    PID,
    { layer: 'human', kind: 'task_progress', actor_type: 'agent', actor_id: 'agent_probe', body: { i } },
    `probe-append-${i}-${Date.now()}`,
  );
  appends.push(Date.now() - t0);
}

// C: claims AFTER those appends, same namespace — the run-1 ordering.
for (let i = 0; i < N; i++) await store.seedTasks(PID, [task(`u_${i}`)]);
const after = [];
for (let i = 0; i < N; i++) {
  const t0 = Date.now();
  const r = await store.claimTask(PID, `u_${i}`, 'agent_probe2');
  after.push(Date.now() - t0);
  if (!r.ok) throw new Error(`uncontended claim ${i} lost — impossible`);
}

console.log(`\nreal Firestore, ${PROJECT}, asia-south1, client Asia/Kolkata\n`);
console.log(line('A. claim, no prior appends', cold));
console.log(line('B. append, same namespace', appends));
console.log(line('C. claim, after 40 appends', after));
console.log(`\ncontention backoffs during probe: ${log.withCode('store.tx.contended').length}`);

await store.close();
await deleteApp(app);
