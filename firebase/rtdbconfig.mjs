// Does this project actually have a Realtime Database instance, and can I create one?
//
// Order 0040 moves presence to RTDB. Before writing an adapter against it, establish that the
// backing service exists -- the previous order spent its whole budget building on an auth
// provider that had never been switched on. Verify, then build.
//
//   node firebase/rtdbconfig.mjs            list instances
//   node firebase/rtdbconfig.mjs --create   create the default instance
//
// Reads the credential by path via ADC. Never prints it.
import { initializeApp, applicationDefault } from 'firebase-admin/app';

const PROJECT = process.env.FB_PROJECT_ID ?? 'multiplayer-agents-eec02';
const app = initializeApp({ projectId: PROJECT, credential: applicationDefault() }, `rtdbcfg-${Date.now()}`);
const token = await app.options.credential.getAccessToken();
const auth = { Authorization: `Bearer ${token.access_token}` };
const base = `https://firebasedatabase.googleapis.com/v1beta/projects/${PROJECT}/locations`;

// Enabling an API is free and reversible; it is the service being USED that bills. Attempted
// only when asked, so a plain list stays read-only.
if (process.argv.includes('--enable-api')) {
  const en = await fetch(
    `https://serviceusage.googleapis.com/v1/projects/${PROJECT}/services/firebasedatabase.googleapis.com:enable`,
    { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' },
  );
  console.log(`enable firebasedatabase.googleapis.com: HTTP ${en.status}`);
  if (!en.ok) {
    console.log(`  ${(await en.text()).slice(0, 300)}`);
    console.log('  The service account likely lacks serviceusage.services.enable.');
  } else {
    // Enablement is eventually consistent; a list immediately after can still 403.
    await new Promise((r) => setTimeout(r, 8_000));
  }
}

const list = await fetch(`${base}/-/instances`, { headers: auth });
const body = await list.text();
if (!list.ok) {
  console.error(`LIST FAILED HTTP ${list.status}: ${body.slice(0, 300)}`);
  if (list.status === 403) {
    console.error('  The Firebase Realtime Database API may not be enabled on the project.');
  }
  process.exit(1);
}

const instances = JSON.parse(body).instances ?? [];
console.log(`project ${PROJECT}`);
if (instances.length === 0) console.log('  RTDB instances: NONE');
for (const i of instances) {
  console.log(`  ${i.name?.split('/').pop()}  type=${i.type}  state=${i.state}`);
  console.log(`    url: ${i.databaseUrl}`);
}

if (process.argv[2] !== '--create') process.exit(instances.length > 0 ? 0 : 1);
if (instances.length > 0) {
  console.log('  an instance already exists; nothing to do.');
  process.exit(0);
}

// asia-southeast1 is the nearest RTDB location to the Firestore database's asia-south1.
// RTDB has no asia-south1 region, which is itself worth recording: presence and the ledger
// cannot be co-located on this platform.
const region = process.env.RTDB_LOCATION ?? 'asia-southeast1';
const id = `${PROJECT}-default-rtdb`;
const create = await fetch(`${base}/${region}/instances?databaseId=${id}`, {
  method: 'POST',
  headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'DEFAULT_DATABASE' }),
});
const out = await create.text();
if (!create.ok) {
  console.error(`CREATE FAILED HTTP ${create.status}: ${out.slice(0, 400)}`);
  process.exit(1);
}
console.log(`  created ${id} in ${region}`);
console.log(`  url: ${JSON.parse(out).databaseUrl}`);
