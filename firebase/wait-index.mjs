// Wait for the collection-group index on members.uid to finish building, then prove listProjects
// works against production.
//
// Firestore index builds are asynchronous: `firebase deploy --only firestore:indexes` returns
// as soon as the build is ACCEPTED, not when it is ready, and the query keeps answering
// FAILED_PRECONDITION until it is. Polling the query itself is the honest readiness check --
// asking the index API whether it says READY would test a different thing than the one that has
// to work.
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createFirestoreDirectory } from './directory.ts';
import { CapturingLogger } from '../shared/log.ts';

const PROJECT = process.env.FB_PROJECT_ID ?? 'multiplayer-agents-eec02';
const UID = process.argv[2] ?? 'uid_sibhi';
const DEADLINE_MS = 10 * 60_000;

const app = initializeApp({ projectId: PROJECT }, `waitidx-${Date.now()}`);
const directory = createFirestoreDirectory({ db: getFirestore(app), log: new CapturingLogger() });

const started = Date.now();
let ready = false;
let lastErr = '';

while (Date.now() - started < DEADLINE_MS) {
  try {
    const projects = await directory.listProjects(UID);
    ready = true;
    console.log(`index ready after ${Math.round((Date.now() - started) / 1000)}s\n`);
    console.log(`projects for ${UID}:`);
    for (const p of projects) console.log(`  ${p.role.padEnd(9)} ${p.project_id.padEnd(26)} ${p.repo_url}`);
    if (projects.length === 0) console.log('  (none)');
    break;
  } catch (err) {
    lastErr = String(err?.message ?? err);
    if (!/FAILED_PRECONDITION|requires a COLLECTION_GROUP|requires an index/i.test(lastErr)) {
      console.error(`unexpected error, not an index build: ${lastErr}`);
      break;
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

await deleteApp(app);
if (!ready) {
  console.error(`index not ready within ${DEADLINE_MS / 60000} min. Last: ${lastErr.slice(0, 200)}`);
  process.exit(1);
}
