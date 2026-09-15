// Enable one Google API by name.
//
// Order 0049 recorded that the service account is denied serviceusage.services.enable. That was
// true for the RTDB management API in order 0045 -- and firebase-tools has just enabled
// cloudfunctions, cloudbuild and artifactregistry on this same credential, so the permission
// exists now. "Blocked" is a claim with a timestamp; this re-checks it rather than inheriting it.
import { initializeApp, applicationDefault } from 'firebase-admin/app';

const PROJECT = process.env.FB_PROJECT_ID ?? 'multiplayer-agents-eec02';
const service = process.argv[2];
if (!service) { console.error('usage: node firebase/enable-api.mjs <service.googleapis.com>'); process.exit(1); }

const app = initializeApp({ projectId: PROJECT, credential: applicationDefault() }, `en-${Date.now()}`);
const token = await app.options.credential.getAccessToken();

const res = await fetch(
  `https://serviceusage.googleapis.com/v1/projects/${PROJECT}/services/${service}:enable`,
  { method: 'POST', headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json' }, body: '{}' },
);
const body = await res.text();
console.log(`enable ${service}: HTTP ${res.status}`);
if (!res.ok) {
  console.log(body.slice(0, 400));
  process.exit(1);
}
console.log('enabled (propagation can take a minute)');
