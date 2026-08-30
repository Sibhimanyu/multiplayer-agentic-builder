// End-to-end proof of order 0039 ruling 1, against the REAL firestore.rules.
//
// Real Firestore cannot run this yet: Authentication is not enabled on the project, so
// signInAnonymously() fails before the rules are ever consulted. That is a console setting, not
// code. Everything the ruling actually specifies -- deny-by-default holds, an anonymous browser
// is denied, a members doc admits it, and the board then updates by PUSH -- can be proven here,
// and this file exists so it is proven rather than asserted.
//
// Run under `firebase-tools emulators:exec`, which starts the emulators, runs this, and tears
// them down. Deliberately exec rather than a long-lived `emulators:start`: a stray emulator on
// the default port once had me running suites against a foreign process and diagnosing my own
// adapter twice before checking the machine.
//
// NUMBERS FROM THIS FILE ARE NOT RESULTS. It is the emulator; latencies here mean nothing and
// none appear below. Only the ALLOW/DENY decisions and the push semantics are being tested,
// and those are the emulator's faithful part -- it runs the same rules file.
//
//   npx firebase-tools emulators:exec --only firestore,auth --project <id> "node client/sliceproof.mjs"

import { cert, initializeApp as initAdmin, deleteApp as deleteAdmin } from 'firebase-admin/app';
import { getFirestore as adminFirestore } from 'firebase-admin/firestore';
import { initializeApp } from 'firebase/app';
import { connectAuthEmulator, getAuth, signInAnonymously } from 'firebase/auth';
import { collection, connectFirestoreEmulator, getFirestore, onSnapshot } from 'firebase/firestore';

const PROJECT = process.env.GCLOUD_PROJECT ?? 'multiplayer-agents-eec02';
const PID = 'proj_sliceproof';

if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.error('Run me under `firebase-tools emulators:exec --only firestore,auth`.');
  console.error('  Both FIRESTORE_EMULATOR_HOST and FIREBASE_AUTH_EMULATOR_HOST must be set.');
  process.exit(1);
}

let failed = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- admin side: bypasses rules entirely, which is exactly why it is the seeder ----
void cert;
const admin = initAdmin({ projectId: PROJECT }, 'sliceproof-admin');
const adb = adminFirestore(admin);
const tasks = adb.collection('projects').doc(PID).collection('tasks');
const members = adb.collection('projects').doc(PID).collection('members');

await adb.collection('projects').doc(PID).set({ project_name: 'slice proof', repo_url: 'x/y' });
await tasks.doc('task_demo').set({ task_id: 'task_demo', title: 'demo', status: 'open', claimed_by: null });

// ---- browser side: web SDK, anonymous, rules ENFORCED ----
const web = initializeApp({ apiKey: 'emulator', projectId: PROJECT, appId: 'emulator' }, 'sliceproof-web');
const auth = getAuth(web);
connectAuthEmulator(auth, `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`, { disableWarnings: true });
const wdb = getFirestore(web);
const [fh, fp] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
connectFirestoreEmulator(wdb, fh, Number(fp));

console.log(`rules: firestore.rules, emulated. project ${PROJECT} / ${PID}\n`);

// 1. sign-in
const uid = (await signInAnonymously(auth)).user.uid;
check(!!uid, `anonymous sign-in returned a uid (${uid.slice(0, 8)}...)`);

/** Attach a listener and report the first thing that happens: a frame, or a denial. */
const attach = () =>
  new Promise((resolve) => {
    const frames = [];
    const unsub = onSnapshot(
      collection(wdb, 'projects', PID, 'tasks'),
      (s) => {
        frames.push(s.docs.map((d) => `${d.id}=${d.get('status')}`).join(' '));
        resolve({ ok: true, frames, unsub });
      },
      (err) => resolve({ ok: false, code: err.code }),
    );
  });

// 2. before admission: the rules must REFUSE. This is the assertion that proves the gate is
//    real; without it, a later success could just mean the rules were never enforced.
const before = await attach();
check(before.ok === false && before.code === 'permission-denied', 'listener DENIED before admission (deny-by-default holds)');

// 3. admit, exactly as `--admit` does
await members.doc(uid).set({ uid, role: 'viewer', label: 'browser (anonymous)', revoked: false });

// 4. after admission: it must render
const after = await attach();
check(after.ok === true, 'listener ALLOWED after the members doc exists');
check(after.frames?.[0]?.includes('task_demo=open'), `first frame carries the board (${after.frames?.[0]})`);

// 5. and it must move by PUSH -- no refetch, no reload. This is the slice.
let pushed = null;
if (after.ok) {
  const seen = [];
  const unsub2 = onSnapshot(collection(wdb, 'projects', PID, 'tasks'), (s) => {
    seen.push(s.docs.map((d) => `${d.id}=${d.get('status')}`).join(' '));
  });
  await sleep(300);
  const framesBefore = seen.length;
  await tasks.doc('task_demo').set({ status: 'claimed', claimed_by: 'agent_be000001' }, { merge: true });
  for (let i = 0; i < 100 && !seen.at(-1)?.includes('claimed'); i++) await sleep(50);
  pushed = seen.at(-1);
  check(!!pushed?.includes('task_demo=claimed'), `open -> claimed arrived by push (${framesBefore} -> ${seen.length} frames)`);
  unsub2();
  after.unsub?.();
}

// 6. revocation must still deny, or "member" would be a one-way door
await members.doc(uid).set({ revoked: true }, { merge: true });
const revoked = await attach();
check(revoked.ok === false && revoked.code === 'permission-denied', 'a REVOKED member is denied again');

console.log(`\n${failed === 0 ? 'SLICE PROOF PASSED' : `SLICE PROOF FAILED (${failed})`}`);
console.log('emulated rules; no latency figure here is a result.');

await deleteAdmin(admin);
process.exit(failed === 0 ? 0 : 1);
