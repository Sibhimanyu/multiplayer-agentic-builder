// Which platform APIs are actually enabled? Verify, do not inherit.
//
// Order 0049 says Cloud Functions APIs are disabled and the service account cannot enable them.
// That was true when written; the user has since been asked to click a link. "Blocked" is a
// claim with a timestamp, and the whole deploy question turns on it, so it gets checked rather
// than assumed -- the same reason the JDK turned out to be installed all along.
import { initializeApp, applicationDefault } from 'firebase-admin/app';

const PROJECT = process.env.FB_PROJECT_ID ?? 'multiplayer-agents-eec02';
const app = initializeApp({ projectId: PROJECT, credential: applicationDefault() }, `apick-${Date.now()}`);
const token = await app.options.credential.getAccessToken();
const auth = { Authorization: `Bearer ${token.access_token}` };

const SERVICES = [
  'cloudfunctions.googleapis.com',
  'cloudbuild.googleapis.com',
  'artifactregistry.googleapis.com',
  'run.googleapis.com',
  'eventarc.googleapis.com',
  'firestore.googleapis.com',
  'identitytoolkit.googleapis.com',
  'firebasedatabase.googleapis.com',
];

console.log(`project ${PROJECT}\n`);
let enabled = 0;
for (const s of SERVICES) {
  const res = await fetch(`https://serviceusage.googleapis.com/v1/projects/${PROJECT}/services/${s}`, { headers: auth });
  if (!res.ok) {
    console.log(`  ?        ${s}  (HTTP ${res.status} -- cannot read state)`);
    continue;
  }
  const state = (await res.json()).state ?? 'UNKNOWN';
  if (state === 'ENABLED') enabled += 1;
  console.log(`  ${state === 'ENABLED' ? 'ENABLED ' : 'DISABLED'} ${s}`);
}

// Billing: Cloud Functions requires Blaze, so this is the other half of the same question.
const bill = await fetch(`https://cloudbilling.googleapis.com/v1/projects/${PROJECT}/billingInfo`, { headers: auth });
if (bill.ok) {
  const b = await bill.json();
  console.log(`\nbilling: ${b.billingEnabled ? 'ENABLED (Blaze)' : 'NOT ENABLED (Spark)'}`);
} else {
  console.log(`\nbilling: cannot read (HTTP ${bill.status}); the service account lacks billing.viewer`);
}

const fnReady = SERVICES.slice(0, 3).length;
console.log(`\n${enabled}/${SERVICES.length} services enabled. Functions needs the first ${fnReady}.`);
