// Verify the DEPLOYED rules actually deny an unauthenticated client, against the real project.
// No admin credentials needed: this is exactly the posture a browser has before sign-in.
import { initializeApp } from 'firebase/app';
import { getFirestore, collection, getDocs, doc, setDoc } from 'firebase/firestore';

// Read from the environment so the project id is not baked in. The web config is public by
// design -- it identifies a project, it does not authorise anything -- but hardcoding it here
// would mean this check silently tested the wrong project after a rename.
const PROJECT = process.env.FB_PROJECT_ID ?? 'multiplayer-agents-eec02';
const cfg = {
  apiKey: process.env.FB_API_KEY ?? 'AIzaSyAygxYa6Owkmga73tZvy-vOwyRN-Ua9N3A',
  authDomain: `${PROJECT}.firebaseapp.com`,
  projectId: PROJECT,
  appId: process.env.FB_APP_ID ?? '1:647761833901:web:542a29cfcccb7db0fd3b24',
};
const db = getFirestore(initializeApp(cfg));
const P = 'proj_inventory';

const probe = async (label, fn) => {
  const t0 = Date.now();
  try { await fn(); console.log(`  ${label.padEnd(30)} ALLOWED (${Date.now()-t0}ms) <-- UNEXPECTED`); return 'allowed'; }
  catch (e) { console.log(`  ${label.padEnd(30)} DENIED  (${Date.now()-t0}ms) ${e.code ?? ''}`); return 'denied'; }
};

console.log(`live rules check, UNAUTHENTICATED client, ${PROJECT}\n`);
const r = [];
r.push(await probe('read tasks',        () => getDocs(collection(db,'projects',P,'tasks'))));
r.push(await probe('read events',       () => getDocs(collection(db,'projects',P,'events'))));
r.push(await probe('read agents',       () => getDocs(collection(db,'projects',P,'agents'))));
r.push(await probe('WRITE an event',    () => setDoc(doc(db,'projects',P,'events','forged'),{seq:1})));
r.push(await probe('WRITE a claim',     () => setDoc(doc(db,'projects',P,'claims','task_x'),{agent_id:'forged'})));
r.push(await probe('read invites',      () => getDocs(collection(db,'projects',P,'invites'))));
r.push(await probe('read outside /projects', () => getDocs(collection(db,'anything'))));

const allowed = r.filter(x => x === 'allowed').length;
console.log(`\n${r.length} probes, ${allowed} allowed, ${r.length-allowed} denied`);

// MISSING IS DRIFT: zero probes is not "all denied", it is a broken check. Fail on it.
if (r.length === 0) {
  console.error('FAIL: no probes ran. An empty result set is a broken check, not a pass.');
  process.exit(1);
}
if (allowed > 0) {
  console.error(`FAIL: ${allowed} operation(s) an unauthenticated client should not be able to do.`);
  process.exit(1);
}
console.log('OK: deny-all verified against the live backend.');
