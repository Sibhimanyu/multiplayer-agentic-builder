// The DEPLOYED write path. Real Cloud Function URL, real token, real Firestore. Order 0049.
//
// firebase/auth-cases.mjs proves the handler over local HTTP. This proves the deployed thing,
// and the two are different claims: a handler that works in-process can still fail behind Cloud
// Functions on body parsing, CORS, cold start, or an IAM binding that makes the URL itself
// unreachable. "Deployed successfully" is the build step's exit code; this is the artifact.
//
//   node firebase/deployed-check.mjs
import fs from 'node:fs/promises';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createFirestoreStore } from './store.ts';
import { DEFAULT_ROLES } from '../shared/store/directory.ts';
import { CapturingLogger } from '../shared/log.ts';
import { systemClock } from '../shared/clock.ts';

const PROJECT = process.env.FB_PROJECT_ID ?? 'multiplayer-agents-eec02';
const URL_ = process.env.DRYDOCK_WRITE_URL
  ?? `https://us-central1-${PROJECT}.cloudfunctions.net/write`;
const STAMP = Date.now().toString(36);
const PID = `proj_dep_${STAMP}`;

let failed = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed += 1;
};

const env = Object.fromEntries(
  (await fs.readFile('client/.env.local', 'utf8')).split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const log = new CapturingLogger();
const app = initializeApp({ projectId: PROJECT }, `dep-${Date.now()}`);
const db = getFirestore(app);
const store = createFirestoreStore({ db, log, clock: systemClock, debounce_ms: 0 });

console.log('DEPLOYED WRITE PATH');
console.log(`  url      ${URL_}`);
console.log(`  project  ${PROJECT}, namespace ${PID}\n`);

const call = async (token, payload) => {
  const r = await fetch(URL_, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 200) }; }
  return { status: r.status, body };
};

try {
  // A real identity from live Firebase Auth.
  const su = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${env.VITE_FIREBASE_API_KEY}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }),
  });
  const session = await su.json();
  const UID = session.localId;
  const TOKEN = session.idToken;
  check(!!TOKEN, `real Firebase identity (uid ${String(UID).slice(0, 8)}...)`);

  // The URL must be REACHABLE and must refuse an unauthenticated call. A 403 from IAM here
  // rather than 401 from our handler would mean the function is private and the whole path is
  // unreachable for a teammate -- a deploy that "succeeded" and does not work.
  const anon = await call(null, { project_id: PID, op: 'claim', body: {} });
  check(anon.status === 401, `the deployed URL is reachable and refuses no-token with OUR 401 (got ${anon.status})`);
  check(/no bearer token/.test(String(anon.body.error ?? '')), 'and the message is the handler\'s, so the request reached our code');

  check((await call('garbage.token.here', { project_id: PID, op: 'claim', body: {} })).status === 401,
    'a FORGED token -> 401 from the deployed function (verification runs in production)');

  // Set up a project the caller is a member of.
  await store.ensureProject(PID, { project_name: 'Deployed', repo_url: 'Sibhimanyu/inventory-tracker' });
  await store.seedTasks(PID, [{
    task_id: 'task_api', title: 'API', kind: 'backend', status: 'open', claimed_by: null, branch: null,
    pr_url: null, pr_number: null, ci: null, depends_on: [], blocked_by: null, blocked_reason: null,
    file_scope: [], updated_at: systemClock.iso(),
  }]);
  await store.registerAgent(PID, {
    agent_id: UID, role_slug: 'backend', member_label: 'teammate', initials: 'TM', harness: 'claude-code',
  });
  await db.collection('projects').doc(PID).collection('members').doc(UID)
    .set({ uid: UID, role: 'backend', label: 'teammate', revoked: false, added_at: systemClock.iso() });
  for (const def of Object.values(DEFAULT_ROLES)) {
    await db.collection('projects').doc(PID).collection('roles').doc(def.slug).set(def);
  }

  // THE ALLOWED WRITE, through the deployed function.
  const allowed = await call(TOKEN, {
    project_id: PID, op: 'acquire_scope', body: { task_id: 'task_api', agent_id: UID, globs: ['functions/items/**'] },
  });
  check(allowed.status === 200, `ALLOWED: backend locks functions/items/** -> ${allowed.status}`);

  // The ARTIFACT: the lock exists in Firestore, written by the DEPLOYED function's admin
  // credentials -- while firestore.rules still says `allow write: if false` for every client.
  const locks = await db.collection('projects').doc(PID).collection('locks').get();
  check(locks.docs.some((d) => d.id === UID), 'and the lock DOCUMENT exists, written server-side');

  // THE REFUSAL, same URL, same token.
  const refused = await call(TOKEN, {
    project_id: PID, op: 'acquire_scope', body: { task_id: 'task_api', agent_id: UID, globs: ['client/**'] },
  });
  check(refused.status === 403, `REFUSED: backend locks client/** -> ${refused.status}`);
  check(String(refused.body.requested ?? '').includes('client/**'), 'and the deployed response names the refused glob');

  const whole = await call(TOKEN, {
    project_id: PID, op: 'acquire_scope', body: { task_id: 'task_api', agent_id: UID, globs: ['**'] },
  });
  check(whole.status === 403, 'REFUSED: `**` -> 403 in production too');
} finally {
  await store.close();
  await deleteApp(app);
}

console.log(`\n${failed === 0 ? 'DEPLOYED WRITE PATH VERIFIED' : `FAILED (${failed})`}`);
process.exit(failed === 0 ? 0 : 1);
