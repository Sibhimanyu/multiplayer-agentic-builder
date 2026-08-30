// The browser's exact code path, run headlessly: WEB SDK, anonymous sign-in, live listener.
//
// This is not a browser and does not claim to be. What it is, precisely: the same `firebase`
// web SDK the bundle ships, the same signInAnonymously() call, and the same onSnapshot listener
// against the same security rules with the same (anonymous, non-admin) authority. The admin SDK
// bypasses rules entirely, so no amount of firebase/*.ts probing can answer "may the dashboard
// read this" -- only this can.
//
// It lives in client/ so that `firebase` resolves from client/node_modules, the very copy vite
// bundles.
//
//   node client/webprobe.mjs           sign in, subscribe, report what the board would show
//   node client/webprobe.mjs --watch   stay attached and print every pushed frame
//
// Uses only the public web config. No service-account credential is read or reachable here.
import fs from 'node:fs';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import { collection, getFirestore, onSnapshot } from 'firebase/firestore';

const env = Object.fromEntries(
  fs
    .readFileSync(new URL('./.env.local', import.meta.url), 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const PID = process.env.BUILDER_PROJECT_ID ?? 'proj_inventory';
const watch = process.argv.includes('--watch');

const app = initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  appId: env.VITE_FIREBASE_APP_ID,
});

console.log(`project ${env.VITE_FIREBASE_PROJECT_ID} / ${PID}\n`);

// ---- hop 1: sign-in. The dashboard's `auth-unavailable` state comes from exactly this. ----
let uid;
try {
  const cred = await signInAnonymously(getAuth(app));
  uid = cred.user.uid;
  console.log(`  PASS  anonymous sign-in, uid ${uid}`);
} catch (err) {
  const code = err?.code ?? 'unknown';
  console.log(`  FAIL  anonymous sign-in -- ${code}`);
  if (code === 'auth/configuration-not-found') {
    console.log('\n        Firebase Authentication is not enabled on this project.');
    console.log('        Firebase console -> Authentication -> Get started,');
    console.log('        then Sign-in method -> Anonymous -> Enable.');
    console.log('\n        The dashboard renders this as "Sign-in is unavailable" with the');
    console.log('        same instruction -- it does NOT hang on "Connecting...".');
  } else if (code === 'auth/operation-not-allowed') {
    console.log('\n        The Anonymous provider is disabled. Enable it in the console.');
  }
  process.exit(1);
}

// ---- hop 2: a live listener under the rules. permission-denied here IS the denied state. ----
const frames = [];
const done = new Promise((resolve) => {
  const unsub = onSnapshot(
    collection(getFirestore(app), 'projects', PID, 'tasks'),
    (snap) => {
      frames.push(snap.docs.map((d) => ({ id: d.id, status: d.get('status'), by: d.get('claimed_by') })));
      if (frames.length === 1) {
        console.log(`  PASS  listener delivered ${snap.size} task(s) under the security rules`);
        for (const t of frames[0]) console.log(`          ${String(t.status).padEnd(9)} ${t.id}  ${t.by ?? '-'}`);
        console.log('\nThe board would RENDER. Live push is attached.');
        if (!watch) {
          unsub();
          resolve(true);
        }
      } else {
        const t = frames.at(-1);
        console.log(`  push  frame ${frames.length}: ${t.map((x) => `${x.id}=${x.status}`).join(' ')}`);
      }
    },
    (err) => {
      if (err.code === 'permission-denied') {
        console.log('  FAIL  listener denied by the security rules (permission-denied)');
        console.log(`\n        Signed in, but uid ${uid} is not a member of ${PID}.`);
        console.log('        This is deny-by-default working, not an outage. Admit it:');
        console.log(`\n          node firebase/bridge-run.ts --admit ${uid}`);
        console.log('\n        The dashboard renders this same message, with this same command.');
      } else {
        console.log(`  FAIL  listener error -- ${err.code}: ${err.message}`);
      }
      resolve(false);
    },
  );
});

const ok = await done;
if (!watch) process.exit(ok ? 0 : 1);
