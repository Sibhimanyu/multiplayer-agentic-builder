// Does the BROWSER's read actually succeed against the deployed security rules?
//
// The dashboard is unauthenticated today (no sign-in anywhere in client/src), and
// firestore.rules gates every read behind isMember(pid). If the rules in this repo are the
// deployed ones, the browser gets PERMISSION_DENIED and the board renders empty — which looks
// exactly like "the push subscriber is broken". This probe tells the two apart.
//
// It uses the REST API with the PUBLIC web config, unauthenticated, which is precisely the
// authority a browser has before sign-in. It never touches the service-account credential and
// never prints the key.
import fs from 'node:fs/promises';

const env = Object.fromEntries(
  (await fs.readFile(new URL('../client/.env.local', import.meta.url), 'utf8'))
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const pid = env.VITE_FIREBASE_PROJECT_ID;
const key = env.VITE_FIREBASE_API_KEY;

const args = process.argv.slice(2);
const anon = args.includes('--anon');
const doc = args.find((a) => !a.startsWith('--')) ?? 'projects/proj_inventory/tasks/task_items_crud';
const url = `https://firestore.googleapis.com/v1/projects/${pid}/databases/(default)/documents/${doc}?key=${key}`;

// --anon performs the EXACT call the browser makes: identitytoolkit accounts:signUp with no
// credentials, which is what the Firebase web SDK's signInAnonymously() is underneath. If the
// provider is off, this is where it says so -- and it says so far more precisely than the
// admin config endpoint, which describes paid Identity Platform rather than Firebase Auth.
const headers = {};
if (anon) {
  const su = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ returnSecureToken: true }),
  });
  const body = await su.json();
  if (!su.ok) {
    console.log(`anonymous sign-in: FAILED HTTP ${su.status} -- ${body.error?.message}`);
    if (body.error?.message === 'ADMIN_ONLY_OPERATION') {
      console.log('  Anonymous sign-in is DISABLED for this project.');
      console.log('  Firebase console -> Authentication -> Sign-in method -> Anonymous -> Enable.');
    }
    process.exit(1);
  }
  console.log(`anonymous sign-in: OK, uid ${body.localId}`);
  headers.Authorization = `Bearer ${body.idToken}`;
}

const res = await fetch(url, { headers });
const text = await res.text();
console.log(`${anon ? 'anonymous' : 'unauthenticated'} read of ${doc}`);
console.log(`  project: ${pid}   HTTP ${res.status}`);
if (res.ok) {
  const fields = JSON.parse(text).fields ?? {};
  console.log('  ALLOWED — the browser can read without signing in.');
  console.log(`  status=${fields.status?.stringValue}  claimed_by=${fields.claimed_by?.stringValue ?? 'null'}`);
} else {
  const msg = (() => {
    try {
      return JSON.parse(text).error?.status ?? JSON.parse(text).error?.message;
    } catch {
      return text.slice(0, 160);
    }
  })();
  console.log(`  DENIED — ${msg}`);
  console.log('  The dashboard will render an empty board until sign-in exists or rules allow it.');
}
