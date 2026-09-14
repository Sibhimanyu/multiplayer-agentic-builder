// Runs the SHARED ProjectDirectory conformance suite against Cloud Firestore, via the emulator.
//
// shared/store/directory-conformance.ts is imported UNMODIFIED, same as section A. This file's
// whole job is to supply a DirectoryHarness and get out of the way.
//
// Emulator rather than a live project: D3 uses a collectionGroup query over every members
// document in the database, and D1-D7 create a project each. Against production that is real
// writes into the project the measurements live in, every run.
//
// Run it with:  node scripts/emul-suite.mjs firebase/directory.test.ts

import { after, before, test } from 'node:test';
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

import { registerDirectoryConformanceSuite } from '../shared/store/directory-conformance.ts';
import { createFirestoreDirectory } from './directory.ts';
import { CapturingLogger } from '../shared/log.ts';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = process.env.GCLOUD_PROJECT ?? 'demo-bakeoff';

if (!EMULATOR) {
  test('section D against Firestore', { skip: 'FIRESTORE_EMULATOR_HOST unset' }, () => {});
}

let app: App;
let db: Firestore;
let counter = 0;

if (EMULATOR) {
  before(() => {
    app = initializeApp({ projectId: PROJECT }, `directory-${Date.now()}`);
    db = getFirestore(app);
  });

  after(async () => {
    await deleteApp(app);
  });

  registerDirectoryConformanceSuite(async () => {
    const log = new CapturingLogger();
    return {
      name: 'firestore',
      directory: createFirestoreDirectory({ db, log }),
      // Unique per call, not per file: D2 creates a project and then deliberately collides with
      // it, so two tests sharing an id would make D2 pass for the wrong reason.
      freshProjectId: () => `proj_d_${Date.now().toString(36)}_${counter++}`,
      dispose: async () => {},
    };
  });
}
