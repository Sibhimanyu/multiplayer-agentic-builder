// What a Google identity changes, and the config that stops the CLI being single-project.
//
// THE ASSERTION THAT MATTERS: a second login as the same account returns the SAME uid.
//
// An anonymous uid is per-browser and disposable -- sign in twice, get two identities. Membership
// is keyed by uid, so if a real login behaved that way, every role assignment would evaporate the
// first time someone logged in again and the whole permission model would silently mean nothing
// across sessions. It is the kind of thing that looks fine in one test run and fails a week later.
//
// Google sign-in cannot be driven headlessly -- it needs a browser and a human. So the stable-uid
// property is asserted against a CUSTOM TOKEN for a fixed uid, which exercises the same
// identity-to-uid mapping through the same Firebase Auth: mint twice, sign in twice, compare. And
// the contrast case is run alongside it, because "the uid was stable" means nothing unless
// something in the same run is shown to be unstable.
//
//   node firebase/identity-cases.mjs
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

import { loadConfig, saveConfig, writeUrl, boardUrl, NotConfigured, configPath } from '../cli/config.ts';

const PROJECT = process.env.FB_PROJECT_ID ?? 'multiplayer-agents-eec02';
const STAMP = Date.now().toString(36);

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
const API_KEY = env.VITE_FIREBASE_API_KEY;

const app = initializeApp({ projectId: PROJECT }, `ident-${Date.now()}`);
const auth = getAuth(app);

console.log('IDENTITY + CONFIG\n');

const HOME = path.resolve('.agentic', `home-${STAMP}`);
try {
  // ============================================================ 1. stable uid
  console.log('1. a second login as the same account returns the SAME uid');

  // A fixed "person". In production this is the Google account; here it is a stable subject
  // exercising the same Firebase uid mapping.
  const PERSON = `person_${STAMP}`;
  const signInWithCustomToken = async () => {
    const custom = await auth.createCustomToken(PERSON);
    const res = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${API_KEY}`,
      { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: custom, returnSecureToken: true }) },
    );
    const body = await res.json();
    if (!res.ok) throw new Error(`custom-token sign-in failed: ${JSON.stringify(body).slice(0, 200)}`);
    return body;
  };

  // The uid is read from the ID TOKEN, not from a `localId` field: signInWithCustomToken does
  // not return one, so comparing that field compared undefined to undefined and PASSED. Caught
  // by the assertion right above it, which is why "the uid exists" is checked before "the uid
  // matches" -- an equality test on two absent values is the purest form of a vacuous pass.
  const uidOf = (idToken) => {
    const claims = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
    return claims.user_id ?? claims.sub;
  };

  const first = uidOf((await signInWithCustomToken()).idToken);
  const secondSession = await signInWithCustomToken();
  const second = uidOf(secondSession.idToken);
  check(!!first && first === PERSON, `first login  -> uid ${first}`);
  check(first === second, `second login -> THE SAME uid (${second})`);
  check(!!secondSession.idToken, 'and a real second ID token was issued, so these are two sign-ins');

  // THE CONTRAST. Without this, "the uid was stable" could just mean the test signed in once.
  // Anonymous is what an unstable identity looks like, in the same run, through the same API.
  const anon = async () => {
    const r = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ returnSecureToken: true }),
    });
    return (await r.json()).localId;
  };
  const a1 = await anon();
  const a2 = await anon();
  check(a1 !== a2, `CONTRAST: two anonymous sign-ins give DIFFERENT uids (${String(a1).slice(0, 8)}... vs ${String(a2).slice(0, 8)}...)`);
  check(!!a1 && !!a2, 'and anonymous still works -- it is the onboarding path that shows a uid on the denied screen');

  // Membership is keyed by uid, so a stable uid is exactly what makes a role assignment survive.
  check(
    first === second && a1 !== a2,
    'so a role assigned to a stable uid survives re-login, and one assigned to an anonymous uid would not',
  );

  // ============================================================ 2. config
  console.log('\n2. the project id is configuration, not a constant');

  delete process.env.DRYDOCK_PROJECT;
  delete process.env.DRYDOCK_API_KEY;
  let threw = null;
  try { await loadConfig(HOME); } catch (e) { threw = e; }
  check(threw instanceof NotConfigured, 'unconfigured FAILS rather than defaulting to somebody\'s project');
  check(/drydock init --project/.test(threw?.message ?? ''), 'and the error names the command to run');

  const cfg = { project_id: 'someone-elses-proj', api_key: 'AIzaFake', region: 'us-central1' };
  const file = await saveConfig(cfg, HOME);
  check(file === configPath(HOME), `written to ~/.drydock/config.json`);
  const loaded = await loadConfig(HOME);
  check(loaded.project_id === 'someone-elses-proj', 'and read back');

  // DERIVED, not stored: there is no second constant to drift.
  check(writeUrl(loaded) === 'https://us-central1-someone-elses-proj.cloudfunctions.net/write',
    `the function URL is derived from the project id (${writeUrl(loaded)})`);
  check(boardUrl(loaded) === 'https://someone-elses-proj.web.app', 'and so is the board URL');

  process.env.DRYDOCK_PROJECT = 'override-proj';
  check((await loadConfig(HOME)).project_id === 'override-proj', 'DRYDOCK_PROJECT overrides the file');
  check(writeUrl(await loadConfig(HOME)).includes('override-proj'), 'and the derived URL follows the override');
  delete process.env.DRYDOCK_PROJECT;

  const st = await fs.stat(file);
  check((st.mode & 0o777) === 0o644, `config.json is 0644 (${(st.mode & 0o777).toString(8)}) -- it holds nothing secret`);
  const credDir = await fs.stat(path.dirname(file));
  check((credDir.mode & 0o777) === 0o700, 'while ~/.drydock itself stays 0700');
} finally {
  await deleteApp(app);
  await fs.rm(HOME, { recursive: true, force: true });
  void os;
}

console.log(`\n${failed === 0 ? 'IDENTITY + CONFIG PASSED' : `FAILED (${failed})`}`);
process.exit(failed === 0 ? 0 : 1);
