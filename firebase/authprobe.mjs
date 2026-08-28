// One authenticated read against real Firestore, to confirm the service-account key works
// before spending anything meaningful. Deliberately trivial: a single empty-collection query.
//
// Never reads, prints or copies the credential itself — only whether it authenticates.
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

if (process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FIRESTORE_EMULATOR_HOST is set; refusing. This probe is about REAL Firestore.');
  process.exit(1);
}

const PROJECT = process.env.FB_PROJECT_ID ?? 'multiplayer-agents-eec02';

try {
  const app = initializeApp({ projectId: PROJECT }, `probe-${Date.now()}`);
  const db = getFirestore(app);
  const t0 = Date.now();
  const snap = await db.collection('__authprobe').limit(1).get();
  console.log(`AUTH OK — real Firestore reachable in ${PROJECT}`);
  console.log(`  docs returned: ${snap.size}   round trip: ${Date.now() - t0} ms`);
  process.exit(0);
} catch (e) {
  console.error('AUTH FAILED:', String(e?.message ?? e).slice(0, 240));
  process.exit(1);
}
