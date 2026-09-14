// Did createProject's role-policy write actually land in PRODUCTION?
//
// New write shapes get one production run before they are believed: the emulator does not
// enforce indexes and does not police everything production does, and a transaction that writes
// six extra documents is exactly the kind of thing that passes locally and hits a limit live.
//
//   node firebase/verify-policy.mjs <project_id>
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { DEFAULT_ROLES } from '../shared/store/directory.ts';

const PROJECT = process.env.FB_PROJECT_ID ?? 'multiplayer-agents-eec02';
const PID = process.argv[2];
if (!PID) { console.error('usage: node firebase/verify-policy.mjs <project_id>'); process.exit(1); }

const app = initializeApp({ projectId: PROJECT }, `vp-${Date.now()}`);
const db = getFirestore(app);

let failed = 0;
const check = (ok, label) => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`); if (!ok) failed += 1; };

const roles = await db.collection('projects').doc(PID).collection('roles').get();
console.log(`role policy for ${PID} in PRODUCTION ${PROJECT}\n`);
check(roles.size === 6, `all six roles written (${roles.size})`);
for (const slug of Object.keys(DEFAULT_ROLES)) {
  const d = roles.docs.find((x) => x.id === slug);
  check(!!d, `${slug} present`);
  if (d) {
    const fs = d.get('file_scope');
    check(Array.isArray(fs), `${slug}: file_scope survived as an array (${JSON.stringify(fs)})`);
  }
}
// The client's EMPTY arrays are the interesting case: Firestore stores [] fine, but a backend
// that dropped empty fields would turn "no scope" into "unset", and unset reads as unbounded.
const client = roles.docs.find((x) => x.id === 'client');
check(Array.isArray(client?.get('file_scope')) && client.get('file_scope').length === 0,
  'client: an EMPTY file_scope is stored as [], not dropped -- unset would read as unbounded');

await deleteApp(app);
console.log(`\n${failed === 0 ? 'POLICY VERIFIED IN PRODUCTION' : `FAILED (${failed})`}`);
process.exit(failed === 0 ? 0 : 1);
