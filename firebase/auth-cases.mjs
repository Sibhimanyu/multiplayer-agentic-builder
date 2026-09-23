// Multi-user auth, end to end. Order 0049.
//
// WHAT IS REAL HERE, stated up front because the deployed/local distinction is the point:
//
//   REAL  Firebase Auth. Tokens are minted by the live identitytoolkit endpoint with the public
//         web API key, and verified by admin.auth().verifyIdToken() against Google's rotating
//         public keys. Nothing about identity is stubbed.
//   REAL  Firestore. Membership documents and role policy are read from production.
//   REAL  HTTP. handleWrite is mounted on a node:http server and called over the wire with an
//         Authorization header -- not invoked as a function. Asserting the handler's return
//         value would not prove a request ever carried a token.
//   NOT DEPLOYED. The same handler is not yet behind a Cloud Function URL: the Functions APIs
//         are not enabled on this project. Everything below is VERIFIED LOCAL, and the deployed
//         claim is made separately or not at all.
//
//   node firebase/auth-cases.mjs
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

import { createFirestoreStore } from './store.ts';
import { handleWrite } from '../functions/src/write-api.ts';
import {
  loadCredential, loginUrl, loopbackReady, mintIdToken, newNonce, saveCredential, startLoopback,
} from '../cli/auth.ts';
import { DEFAULT_ROLES } from '../shared/store/directory.ts';
import { CapturingLogger } from '../shared/log.ts';
import { systemClock } from '../shared/clock.ts';

if (process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FIRESTORE_EMULATOR_HOST set; refusing. Token verification needs real Auth.');
  process.exit(1);
}

const PROJECT = process.env.FB_PROJECT_ID ?? 'multiplayer-agents-eec02';
const STAMP = Date.now().toString(36);
const PID = `proj_auth_${STAMP}`;
const HOME = path.resolve('.agentic', `home-${STAMP}`);

let failed = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed += 1;
};

// The public web config. Identifies the project; authorises nothing.
const env = Object.fromEntries(
  (await fs.readFile('client/.env.local', 'utf8')).split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const API_KEY = env.VITE_FIREBASE_API_KEY;

const log = new CapturingLogger();
const app = initializeApp({ projectId: PROJECT }, `authcases-${Date.now()}`);
const db = getFirestore(app);
const auth = getAuth(app);
const store = createFirestoreStore({ db, log, clock: systemClock, debounce_ms: 0 });

console.log(`MULTI-USER AUTH -- real Firebase Auth + real Firestore + real HTTP`);
console.log(`project ${PROJECT}, namespace ${PID}\n`);

let server;
try {
  // ============================================================ 1. the loopback flow
  console.log('1. flotilla login -- loopback, nonce, credential store');

  const lb = startLoopback({ log, timeout_ms: 30_000 });
  const port = await loopbackReady(lb);
  check(port > 0 && port !== 80 && port !== 8080, `listener is on a RANDOM port (${port})`);
  check(lb.nonce.length >= 40, `nonce is long and random (${lb.nonce.length} chars)`);
  check(newNonce() !== newNonce(), 'nonces differ between calls');

  const url = new URL(loginUrl('https://example.test', port, lb.nonce));
  check(url.searchParams.get('nonce') === lb.nonce && url.searchParams.get('port') === String(port),
    'the browser URL carries the nonce and the port');

  const post = (payload) => fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });

  // THE ATTACK: another page the user visits posts a token at our listener. Without the nonce
  // check this signs the victim's CLI into the ATTACKER's account.
  const evil = await post({ nonce: 'not-the-nonce', refresh_token: 'attacker', uid: 'uid_attacker' });
  check(evil.status === 403, `a response with the WRONG nonce is refused (${evil.status})`);
  // And it must not have KILLED the pending login -- otherwise any page the user visits is a
  // denial of service on `flotilla login`. The legitimate response below proves it survived.

  // THE CONTROL: the same listener, same shape, correct nonce -- so the 403 above is the nonce
  // check working, not the listener rejecting everything.
  const real = await post({ nonce: lb.nonce, refresh_token: 'rt_real', uid: 'uid_real', email: 'a@b.c' });
  check(real.status === 200, `the SAME listener ACCEPTS the correct nonce (${real.status})`);
  const got = await lb.result;
  check(got.refresh_token === 'rt_real' && got.uid === 'uid_real', 'and the credential arrives at the CLI');

  const replay = await post({ nonce: lb.nonce, refresh_token: 'rt_second', uid: 'uid_second' });
  check(replay.status === 409, `the nonce is SINGLE USE; a replay is refused (${replay.status})`);
  lb.close();

  // The credential store. Mode is asserted on the artifact, not on the flag passed to writeFile,
  // because umask can mask it.
  const file = await saveCredential({
    refresh_token: 'rt_real', uid: 'uid_real', project_id: PROJECT, obtained_at: systemClock.iso(),
  }, HOME);
  const st = await fs.stat(file);
  check((st.mode & 0o777) === 0o600, `credentials.json is mode 600 (got ${(st.mode & 0o777).toString(8)})`);
  const dirSt = await fs.stat(path.dirname(file));
  check((dirSt.mode & 0o777) === 0o700, `~/.flotilla is mode 700 (got ${(dirSt.mode & 0o777).toString(8)})`);
  const stored = await loadCredential(HOME);
  check(stored?.refresh_token === 'rt_real', 'the REFRESH token is what was stored');
  check(!('id_token' in (stored ?? {})), 'and no id_token was persisted -- they expire in an hour');

  // ============================================================ 2. a real identity
  console.log('\n2. a REAL Firebase identity, and minting from the refresh token');
  const signUp = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ returnSecureToken: true }),
  });
  const session = await signUp.json();
  check(signUp.ok && !!session.idToken, `signed in against live Firebase Auth (uid ${String(session.localId).slice(0, 8)}...)`);
  const UID = session.localId;

  const minted = await mintIdToken(
    { refresh_token: session.refreshToken, uid: UID, project_id: PROJECT, obtained_at: '' }, API_KEY,
  );
  check(minted.id_token.length > 100, 'a fresh ID token was minted FROM the refresh token');
  check(minted.expires_in > 0 && minted.expires_in <= 3600, `and it is short-lived (${minted.expires_in}s)`);
  const ID_TOKEN = minted.id_token;

  // ============================================================ 3. the write path, over HTTP
  console.log('\n3. the write path -- real HTTP, real token, real Firestore');

  const deps = { auth, db, log, store };
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const parsed = body ? JSON.parse(body) : {};
        const out = await handleWrite(deps, req.headers.authorization, parsed);
        res.writeHead(out.status, { 'content-type': 'application/json' }).end(JSON.stringify(out.body));
      } catch (e) {
        res.writeHead(500).end(JSON.stringify({ error: String(e) }));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const API = `http://127.0.0.1:${server.address().port}`;
  const call = async (token, payload) => {
    const r = await fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(payload),
    });
    return { status: r.status, body: await r.json() };
  };

  await store.ensureProject(PID, { project_name: 'Auth', repo_url: 'flotilla-test/scratch' });
  await store.seedTasks(PID, [{
    task_id: 'task_api', title: 'API', kind: 'backend', status: 'open', claimed_by: null, branch: null,
    pr_url: null, pr_number: null, ci: null, depends_on: [], blocked_by: null, blocked_reason: null,
    file_scope: [], updated_at: systemClock.iso(),
  }]);
  await store.registerAgent(PID, {
    agent_id: UID, role_slug: 'backend', member_label: 'teammate', initials: 'TM', harness: 'claude-code',
  });

  const scope = { project_id: PID, op: 'acquire_scope', body: { task_id: 'task_api', agent_id: UID, globs: ['functions/items/**'] } };

  // No token, and a forged one. The forged case is the control for verification actually running:
  // if verifyIdToken were skipped, garbage would sail through.
  check((await call(null, scope)).status === 401, 'NO token -> 401');
  check((await call('not.a.real.token', scope)).status === 401, 'a FORGED token -> 401 (so verification runs)');

  // Real token, but not yet a member.
  const notMember = await call(ID_TOKEN, scope);
  check(notMember.status === 403 && /not a member/.test(notMember.body.error ?? ''), `a real token that is NOT a member -> 403 (${notMember.body.error})`);

  // Admit as backend, WITHOUT a role policy -- must still refuse. An unconfigured project is not
  // an unrestricted one.
  await db.collection('projects').doc(PID).collection('members').doc(UID)
    .set({ uid: UID, role: 'backend', label: 'teammate', revoked: false, added_at: systemClock.iso() });
  const noPolicy = await call(ID_TOKEN, scope);
  check(noPolicy.status === 403 && /role policy/.test(noPolicy.body.error ?? ''), 'a member with NO role policy -> 403, fail closed');

  for (const def of Object.values(DEFAULT_ROLES)) {
    await db.collection('projects').doc(PID).collection('roles').doc(def.slug).set(def);
  }

  // THE ALLOWED WRITE -- the control. Same URL, same token, same op.
  const allowed = await call(ID_TOKEN, scope);
  check(allowed.status === 200, `ALLOWED: backend locks functions/items/** -> ${allowed.status}`);
  // The ARTIFACT: the lock document exists in Firestore, not merely a 200.
  const locks = await db.collection('projects').doc(PID).collection('locks').get();
  check(locks.docs.some((d) => d.id === UID), 'and the lock DOCUMENT exists in Firestore');

  // THE REFUSAL -- same path, same token, a glob outside the role.
  const refused = await call(ID_TOKEN, {
    project_id: PID, op: 'acquire_scope', body: { task_id: 'task_api', agent_id: UID, globs: ['client/**'] },
  });
  check(refused.status === 403, `REFUSED: backend locks client/** -> ${refused.status}`);
  check(Array.isArray(refused.body.requested) && refused.body.requested.includes('client/**'), 'and the response names the refused glob');

  const wholeRepo = await call(ID_TOKEN, {
    project_id: PID, op: 'acquire_scope', body: { task_id: 'task_api', agent_id: UID, globs: ['**'] },
  });
  check(wholeRepo.status === 403, 'REFUSED: `**` -> 403, because containment is not intersection');

  // deploy: both directions.
  check((await call(ID_TOKEN, { project_id: PID, op: 'deploy', body: { targets: ['hosting'] } })).status === 403,
    'REFUSED: backend deploys hosting -> 403');
  const deployOk = await call(ID_TOKEN, { project_id: PID, op: 'deploy', body: { targets: ['functions'] } });
  check(deployOk.status === 501, `ALLOWED then unimplemented: backend deploys functions -> ${deployOk.status} (the gate landed before the deployer)`);

  // Revocation must take effect on the NEXT call, with no token change.
  await db.collection('projects').doc(PID).collection('members').doc(UID).set({ revoked: true }, { merge: true });
  const revoked = await call(ID_TOKEN, scope);
  check(revoked.status === 403 && /revoked/.test(revoked.body.error ?? ''), 'a REVOKED member is refused with the same still-valid token');

  // And the client seat, through the same HTTP path.
  await db.collection('projects').doc(PID).collection('members').doc(UID)
    .set({ role: 'client', revoked: false }, { merge: true });
  check((await call(ID_TOKEN, { project_id: PID, op: 'claim', body: { task_id: 'task_api' } })).status === 403,
    'a client CANNOT claim, over HTTP');
  const suggest = await call(ID_TOKEN, {
    project_id: PID, op: 'append_event',
    body: { idempotency_key: `sug-${STAMP}`, event: { layer: 'human', kind: 'task_progress', body: { summary: 'please add dark mode' } } },
  });
  check(suggest.status === 200, `a client CAN suggest, over HTTP -> ${suggest.status}`);

  // actor_id comes from the VERIFIED TOKEN, never the body. A client claiming to be someone else
  // still writes as itself.
  const forgedActor = await call(ID_TOKEN, {
    project_id: PID, op: 'append_event',
    body: { idempotency_key: `forge-${STAMP}`, event: { layer: 'human', kind: 'task_progress', actor_id: 'agent_someone_else', body: { summary: 'x' } } },
  });
  check(forgedActor.status === 200, 'a forged actor_id is accepted as a request');
  const { events } = await store.readEvents(PID, 0);
  const forged = events.find((e) => e.body.summary === 'x');
  check(forged?.actor_id === UID, `but is written as the TOKEN's uid, not the body's (${forged?.actor_id === UID ? 'uid from token' : forged?.actor_id})`);
} finally {
  server?.close();
  await store.close();
  await deleteApp(app);
  await fs.rm(HOME, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? 'AUTH CASES PASSED' : `FAILED (${failed})`}`);
console.log('VERIFIED LOCAL: real Auth, real Firestore, real HTTP. NOT verified deployed.');
process.exit(failed === 0 ? 0 : 1);
