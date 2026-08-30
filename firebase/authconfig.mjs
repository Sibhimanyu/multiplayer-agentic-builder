// Is anonymous sign-in enabled on the project, and can this service account enable it?
//
// The dashboard's whole read path now depends on signInAnonymously() succeeding, and a
// disabled provider fails with auth/operation-not-allowed -- which, from the browser, looks
// like every other auth failure. Better to establish it here, with the admin credential, than
// to guess from a red console line later.
//
//   node firebase/authconfig.mjs          report the current state
//   node firebase/authconfig.mjs --enable turn anonymous sign-in on
//
// Uses the Identity Toolkit admin API. Reads the credential by path via ADC; never prints it.
import { initializeApp, applicationDefault } from 'firebase-admin/app';

const PROJECT = process.env.FB_PROJECT_ID ?? 'multiplayer-agents-eec02';
const app = initializeApp({ projectId: PROJECT, credential: applicationDefault() }, `authcfg-${Date.now()}`);

const token = await app.options.credential.getAccessToken();
const url = `https://identitytoolkit.googleapis.com/admin/v2/projects/${PROJECT}/config`;
const auth = { Authorization: `Bearer ${token.access_token}` };

// Billing state, reported first, because initializeAuth blames billing when it fails and that
// claim needs checking rather than repeating. Read-only.
const bill = await fetch(`https://cloudbilling.googleapis.com/v1/projects/${PROJECT}/billingInfo`, {
  headers: auth,
});
if (bill.ok) {
  const b = await bill.json();
  console.log(`billing: ${b.billingEnabled ? 'ENABLED' : 'NOT ENABLED'}${b.billingAccountName ? ` (${b.billingAccountName})` : ''}`);
} else {
  console.log(`billing: could not read (HTTP ${bill.status}) -- the service account may lack billing.viewer`);
}

let get = await fetch(url, { headers: auth });

// CONFIGURATION_NOT_FOUND means Authentication has never been switched on for this project at
// all -- there is no config to read, let alone a provider to enable. Initialise it once, then
// re-read. Anonymous users are not billed, and Identity Platform's free tier is 50k MAU.
if (get.status === 404 && process.argv[2] === '--enable') {
  console.log(`project ${PROJECT}`);
  console.log('  Authentication is not initialised on this project. Initialising...');
  const init = await fetch(
    `https://identitytoolkit.googleapis.com/v2/projects/${PROJECT}/identityPlatform:initializeAuth`,
    { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' },
  );
  if (!init.ok) {
    console.error(`INITIALISE FAILED HTTP ${init.status}: ${(await init.text()).slice(0, 400)}`);
    console.error('  Do it by hand: Firebase console -> Authentication -> Get started.');
    process.exit(1);
  }
  console.log('  initialised.');
  get = await fetch(url, { headers: auth });
}

if (!get.ok) {
  console.error(`READ FAILED HTTP ${get.status}: ${(await get.text()).slice(0, 300)}`);
  if (get.status === 404) {
    console.error('  Authentication is not initialised. Re-run with --enable to initialise it.');
  }
  process.exit(1);
}
const cfg = await get.json();
const enabled = cfg.signIn?.anonymous?.enabled === true;
console.log(`project ${PROJECT}`);
console.log(`  anonymous sign-in: ${enabled ? 'ENABLED' : 'DISABLED'}`);
console.log(`  authorised domains: ${(cfg.authorizedDomains ?? []).join(', ')}`);

if (process.argv[2] !== '--enable') process.exit(enabled ? 0 : 1);
if (enabled) {
  console.log('  already enabled; nothing to do.');
  process.exit(0);
}

const patch = await fetch(`${url}?updateMask=signIn.anonymous.enabled`, {
  method: 'PATCH',
  headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ signIn: { anonymous: { enabled: true } } }),
});
if (!patch.ok) {
  console.error(`ENABLE FAILED HTTP ${patch.status}: ${(await patch.text()).slice(0, 400)}`);
  console.error('  Enable it by hand: Firebase console -> Authentication -> Sign-in method -> Anonymous.');
  process.exit(1);
}
console.log('  anonymous sign-in ENABLED.');
