// Runs checklist section A against Cloud Firestore, via the emulator.
//
// Identical suite as the memory run, only the adapter swapped (non-negotiable H). Run with:
//
//   npm run test:firestore
//
// which is:
//   firebase emulators:exec --only firestore --project demo-bakeoff \
//     'node --test shared/store/firestore.conformance.test.ts'
//
// The emulator is required rather than a live project on purpose: A2 alone performs 1,000
// transactions, and against a real project that is 1,000 billable writes plus 2,000 reads
// against an uncapped bill, every time the suite runs.

import { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

import { runConformance, type ConformanceTarget, type LogLine } from './conformance.ts';
import { createFirestoreStore, type FirestoreStore } from './firestore.ts';
import { StoreBusyError, StoreOfflineError } from './errors.ts';
import { FakeClock } from './memory.ts';
import type { Logger } from './types.ts';
import { startTcpCutter, type TcpCutter } from './testing/tcp-cutter.ts';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
assert.ok(
  EMULATOR,
  'FIRESTORE_EMULATOR_HOST is not set. Run via `npm run test:firestore` — this suite must ' +
    'never point at a real project: A2 alone is 1,000 transactions.',
);

const PROJECT = process.env.GCLOUD_PROJECT ?? 'demo-bakeoff';

let cutter: TcpCutter;
let app: App;
let db: Firestore;

before(async () => {
  const [host, port] = EMULATOR!.split(':');
  // Route the SDK through a proxy we can sever, so A11 tests a real dropped socket rather
  // than a mocked one.
  cutter = await startTcpCutter({ host: host || '127.0.0.1', port: Number(port) });
  process.env.FIRESTORE_EMULATOR_HOST = cutter.address;
  app = initializeApp({ projectId: PROJECT }, `conformance-${Date.now()}`);
  db = getFirestore(app);
  db.settings({ ignoreUndefinedProperties: false });
});

after(async () => {
  await cutter.close();
  await deleteApp(app);
});

function capturingLogger(): { log: Logger; take: () => LogLine[] } {
  let lines: LogLine[] = [];
  return {
    log: {
      info: (msg, meta) => lines.push({ level: 'info', msg, meta }),
      warn: (msg, meta) => lines.push({ level: 'warn', msg, meta }),
    },
    take: () => {
      const out = lines;
      lines = [];
      return out;
    },
  };
}

/**
 * Wrap the store so forceBusy / setOffline can inject the two retryable failures.
 *
 * Being explicit about what this is: the Firestore emulator cannot be made to return
 * RESOURCE_EXHAUSTED or go unreachable on demand, so A15 and A15c exercise the ADAPTER's
 * mapping and the CALLER's backoff, not the backend's throttle. The mapping itself
 * (gRPC 8 -> StoreBusyError) is covered directly in firestore.errors.test.ts. This is recorded
 * as a partial in docs/handoff/impl-firebase-notes.md rather than claimed as a full pass.
 */
function withFaults(store: FirestoreStore) {
  let busy = 0;
  let offline = false;
  /**
   * Returns a rejected promise rather than throwing synchronously. The real adapter's methods
   * are async, so a synchronous throw here would be a different failure shape than production
   * and would slip past assert.rejects.
   */
  const gate = (): Promise<never> | null => {
    if (offline) {
      return Promise.reject(new StoreOfflineError('backend unreachable (injected)', 'firestore'));
    }
    if (busy > 0) {
      busy -= 1;
      return Promise.reject(new StoreBusyError('rate limited (injected)', 'firestore', 100));
    }
    return null;
  };
  const proxied = new Proxy(store, {
    get(t, prop, recv) {
      const val = Reflect.get(t, prop, recv);
      if (typeof val !== 'function') return val;
      const WRITE_OPS = new Set([
        'appendEvent',
        'claimTask',
        'releaseTask',
        'acquireScope',
        'releaseScope',
        'heartbeat',
        'readEvents',
        'readSnapshot',
        'listPresence',
      ]);
      if (!WRITE_OPS.has(String(prop))) return val.bind(t);
      return (...args: unknown[]) => {
        const blocked = gate();
        if (blocked) return blocked;
        return (val as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
  return {
    store: proxied as FirestoreStore,
    forceBusy: (n: number) => {
      busy = n;
    },
    setOffline: (on: boolean) => {
      offline = on;
    },
  };
}

let run = 0;

runConformance(async (): Promise<ConformanceTarget> => {
  // A fresh project id per test keeps 1,000 claim documents from one test out of the next
  // one's lock-table read, and means no teardown deletion is needed at all.
  const project_id = `proj_conf_${run++}_${Date.now().toString(36)}`;
  const clock = new FakeClock();
  const { log, take } = capturingLogger();

  const real = createFirestoreStore({
    db,
    log,
    clock,
    debounce_ms: 5, // tight, so tests do not sit waiting on the coalescing window
    resubscribe_after_offline_ms: 500,
  });
  const { store, forceBusy, setOffline } = withFaults(real);

  await real.ensureProject(project_id, {
    project_name: 'Inventory Tracker',
    repo_url: 'example/inventory-tracker',
  });

  return {
    name: 'firestore',
    store,
    project_id,
    // 50 rounds x 20 claims = 1,000 transactions against the emulator. Slow but it is the
    // headline correctness claim of the whole platform choice, so it runs in full.
    claim_repeats: Number(process.env.CLAIM_REPEATS ?? 50),
    // A network round trip plus the 5ms coalescing window. Used only for "and then nothing
    // else arrived" assertions, so it costs wall-clock but buys a non-flaky suite.
    settle_ms: 250,
    seedTasks: (tasks) => real.seedTasks(project_id, tasks),
    registerAgent: (a) => real.registerAgent(project_id, a),
    takeLogs: take,
    caps: {
      // The stale derivation is adapter-side arithmetic against an injected clock, not a
      // backend feature, so A9 is a genuine test here and not a skip.
      advanceClock: (ms) => clock.advance(ms),
      // A real end-to-end revocation: the flag lands in Firestore and assertNotRevoked reads
      // it back on the next write.
      revoke: (agent_id, on) => real.setRevoked(project_id, agent_id, on),
      forceBusy,
      setOffline,
      // A genuinely severed TCP connection, not a mock.
      dropConnection: () => cutter.cut(),
      restoreConnection: () => cutter.heal(),
      why_not: {
        snapshotLag:
          'Firestore has no debounced snapshot publication to lag: readSnapshot reads the ' +
          'live listener cache, so seq cannot trail the ledger. The read-your-own-writes ' +
          'window this box tests does not exist on this platform. Verified instead by the ' +
          'decideRepublish unit test in shared/store/republish.test.ts.',
      },
    },
    teardown: async () => {
      await real.close();
    },
  };
});
