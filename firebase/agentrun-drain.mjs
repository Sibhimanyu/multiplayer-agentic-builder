// Did the REAL agent's line publish through the REAL bridge?
//
// This is the claim under test: "a real agent is indistinguishable from echo". The agent has
// written to outbox.jsonl without being told the envelope; the bridge now reads it exactly as it
// would read a scripted line. Whatever happens here is the answer.
//
//   node firebase/agentrun-drain.mjs <root> <project_id>
import fs from 'node:fs/promises';
import path from 'node:path';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

import { createFirestoreStore } from './store.ts';
import { drainOnce } from '../cli/bridge.ts';
import { LAYOUT } from '../cli/agentic.ts';
import { CapturingLogger } from '../shared/log.ts';
import { systemClock } from '../shared/clock.ts';

const PROJECT = process.env.FB_PROJECT_ID ?? 'multiplayer-agents-eec02';
const ROOT = process.argv[2];
const PID = process.argv[3];

let failed = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed += 1;
};

const log = new CapturingLogger();
const app = initializeApp({ projectId: PROJECT }, `drain-${Date.now()}`);
const store = createFirestoreStore({ db: getFirestore(app), log, clock: systemClock, debounce_ms: 0 });

console.log(`draining the REAL agent's outbox\n  root ${path.basename(ROOT)}\n  pid  ${PID}\n`);

try {
  const before = await fs.readFile(path.join(ROOT, LAYOUT.outbox), 'utf8');
  check(before.trim().split('\n').length === 1, 'the agent wrote exactly one line');

  const r = await drainOnce({ root: ROOT, project_id: PID, store, log });
  check(r.published === 1 && r.failed === 0, `the bridge published it unmodified (${r.published} published, ${r.failed} failed)`);

  // The ARTIFACT: it is on the ledger, with the layer the SERVER assigned rather than the one
  // the agent guessed.
  const { events } = await store.readEvents(PID, 0);
  const blocked = events.find((e) => e.kind === 'task_blocked');
  check(!!blocked, 'task_blocked is on the ledger');
  check(blocked?.body.task_id === 'task_items_qty', 'naming the task the agent was given');
  check(/no items handler exists/.test(String(blocked?.body.reason ?? '')), 'carrying the agent\'s own reason');

  // The agent GUESSED an envelope: it wrote v/seq/layer/ts as well as kind/body. The reader
  // takes only kind and body, so the guess was harmless -- but it was a guess, and the ledger
  // shows whose values won.
  check(blocked?.seq >= 1, `seq was assigned by the SERVER (${blocked?.seq}), not taken from the agent's line`);
  check(blocked?.layer === 'coordination', `layer came from LAYER_OF (${blocked?.layer}), not from the agent's field`);
  check(blocked?.actor_type === 'agent', 'and actor_type is agent');

  const cursor = await fs.readFile(path.join(ROOT, LAYOUT.outbox_cursor), 'utf8').catch(() => '0');
  const size = (await fs.stat(path.join(ROOT, LAYOUT.outbox))).size;
  check(Number(cursor.trim()) === size, `the outbox cursor advanced to EOF after publish (${cursor.trim()} == ${size})`);
} finally {
  await store.close();
  await deleteApp(app);
}

console.log(`\n${failed === 0 ? 'THE REAL AGENT\'S LINE PUBLISHED' : `FAILED (${failed})`}`);
process.exit(failed === 0 ? 0 : 1);
