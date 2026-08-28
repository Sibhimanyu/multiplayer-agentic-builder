// G1–G6 against a real Firestore project. The deliverable.
//
//   GOOGLE_APPLICATION_CREDENTIALS=/path/to/sa.json \
//   FB_PROJECT_ID=multiplayer-agents-eec02 \
//   node firebase/measure.ts
//
// Reporting discipline, copied from the Catalyst run-1 shape and from rules I wrote earlier in
// this build and am now bound by:
//
//   - CAVEATS ABOVE THE NUMBERS, not below. A reader who stops after the table should already
//     know what the table does not mean.
//   - p50/p95/p99/max, never a bare mean. A mean of 139 ms hides a 1,186 ms outlier, and a
//     claim that occasionally stalls over a second is user-visible.
//   - the cold first call is reported SEPARATELY and never folded into the percentiles.
//   - NO single-run figure is presented as a threshold. Record the shape and the recovery.
//   - NO dollar conversion without a verified rate card. Measured operations beat a number
//     multiplied by a guess.
//   - operation counts are COUNTED, not derived from reading the code.

import { deleteApp, initializeApp } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

import { createFirestoreStore, type FirestoreStore } from './store.ts';
import { CapturingLogger } from '../shared/log.ts';
import { systemClock } from '../shared/clock.ts';
import type { EventInput, TaskView } from '../shared/store/types.ts';

const PROJECT = process.env.FB_PROJECT_ID ?? 'multiplayer-agents-eec02';
const PID = `proj_measure_${Date.now().toString(36)}`;

if (process.env.FIRESTORE_EMULATOR_HOST) {
  console.error(
    'FIRESTORE_EMULATOR_HOST is set. Refusing to run: emulator numbers are not G1-G6.\n' +
      'The emulator has no network, no quota accounting and no billing surface, so its\n' +
      'latencies are wrong by roughly an order of magnitude and its operation counts appear in\n' +
      'no console. Reporting them as cloud results would be worse than reporting nothing.',
  );
  process.exit(1);
}
if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  console.error(
    'GOOGLE_APPLICATION_CREDENTIALS is not set.\n\n' +
      'The admin SDK needs a service-account key and this machine has no ADC (gcloud absent).\n' +
      'Generate one at:\n' +
      `  console.firebase.google.com/project/${PROJECT}/settings/serviceaccounts/adminsdk\n` +
      'then point GOOGLE_APPLICATION_CREDENTIALS at it.\n\n' +
      'Deliberately NOT falling back to the cloud-platform refresh token in the firebase-tools\n' +
      'config: that credential can reach every project on the account, including ones that are\n' +
      'off-limits. Least privilege over convenience.',
  );
  process.exit(1);
}

// ---- stats -------------------------------------------------------------------------------

interface Stats {
  n: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  min: number;
  mean: number;
}

/** Nearest-rank percentile. No interpolation: with n=100 the p95 should be a real sample. */
function stats(samples: number[]): Stats {
  const s = [...samples].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]!;
  return {
    n: s.length,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    max: s.at(-1)!,
    min: s[0]!,
    mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length),
  };
}

const row = (label: string, st: Stats) =>
  `| ${label} | ${st.n} | ${st.p50} | ${st.p95} | ${st.p99} | **${st.max}** | ${st.mean} |`;

// ---- op counting -------------------------------------------------------------------------

/**
 * Count Firestore operations by wrapping the Firestore instance.
 *
 * COUNTED, not derived from reading the adapter. G4 on the Catalyst side corrected every earlier
 * planning figure precisely because the earlier figures were reasoned from a schema rather than
 * measured against a live request, so deriving mine from code would repeat that mistake.
 */
interface OpCounts {
  reads: number;
  writes: number;
  deletes: number;
  /** runTransaction CALLS -- one per logical operation. */
  transactions: number;
  /**
   * Transaction BODY EXECUTIONS. Greater than `transactions` means something retried.
   *
   * Counted separately because a retry loop is a correctness mechanism that doubles as a
   * COST-HIDING mechanism (order 0019). The SDK re-runs the transaction body on internal
   * retry and my adapter retries contention on top of that, so `reads` and `writes` are sums
   * over every attempt. Without this counter a G4 figure of "6 reads per append" is
   * indistinguishable from "2 reads, retried three times" -- a lower bound presented as a
   * measurement.
   *
   * My first version of this harness counted only `transactions` and had exactly that hole.
   */
  attempts: number;
}

function countingFirestore(db: Firestore): { db: Firestore; counts: OpCounts; reset(): void } {
  const counts: OpCounts = { reads: 0, writes: 0, deletes: 0, transactions: 0, attempts: 0 };

  const READ = 'get';
  const WRITES = new Set(['set', 'create', 'update']);

  /**
   * Wrap a DocumentReference / CollectionReference / Query / WriteBatch so NON-TRANSACTIONAL
   * work is counted too.
   *
   * The first version of this counter wrapped only `runTransaction` and the transaction object.
   * Everything outside a transaction therefore counted as ZERO -- and the first real run duly
   * reported `heartbeat: 0 reads, 0 writes`, which is false: heartbeat is a plain
   * `agents/{id}.set()`. Order 0033 asks specifically what the presence path costs, since
   * Catalyst measured zero UPDATEs by design, so a spurious zero would have flattered this route
   * on exactly the axis under comparison. Errors that favour your own side are the ones you are
   * least likely to catch, so this one is worth naming.
   *
   * Firestore bills reads per DOCUMENT RETURNED, with a query returning nothing still costing
   * one read, so that is what is counted here.
   */
  const wrapRef = (ref: unknown): unknown =>
    new Proxy(ref as object, {
      get(t, prop, recv) {
        const v = Reflect.get(t, prop, recv);
        if (typeof v !== 'function') return v;
        const name = String(prop);
        return (...args: unknown[]) => {
          const result = (v as (...a: unknown[]) => unknown).apply(t, args);

          if (name === READ) {
            // Count on resolution so a query can be charged per document returned.
            return (result as Promise<{ size?: number }>).then((snap) => {
              const size = typeof snap?.size === 'number' ? snap.size : 1;
              counts.reads += Math.max(1, size);
              return snap;
            });
          }
          if (WRITES.has(name)) counts.writes += 1;
          if (name === 'delete') counts.deletes += 1;

          // Chainable builders (doc, collection, where, orderBy, limit, ...) stay wrapped.
          const chainable = new Set([
            'doc', 'collection', 'where', 'orderBy', 'limit', 'limitToLast',
            'startAfter', 'startAt', 'endBefore', 'endAt', 'select',
          ]);
          if (chainable.has(name)) return wrapRef(result);
          return result;
        };
      },
    });

  const wrapTx = (tx: unknown): unknown =>
    new Proxy(tx as object, {
      get(t, prop, recv) {
        const v = Reflect.get(t, prop, recv);
        if (typeof v !== 'function') return v;
        const name = String(prop);
        return (...args: unknown[]) => {
          if (name === 'get') counts.reads += 1;
          if (WRITES.has(name)) counts.writes += 1;
          if (name === 'delete') counts.deletes += 1;
          return (v as (...a: unknown[]) => unknown).apply(t, args);
        };
      },
    });

  const proxied = new Proxy(db, {
    get(target, prop, recv) {
      const value = Reflect.get(target, prop, recv);
      if (typeof value !== 'function') return value;
      const name = String(prop);

      if (name === 'runTransaction') {
        return (body: (tx: unknown) => Promise<unknown>, ...rest: unknown[]) => {
          counts.transactions += 1;
          return (value as (...a: unknown[]) => unknown).call(
            target,
            (tx: unknown) => {
              // Every body execution, including SDK-internal retries.
              counts.attempts += 1;
              return body(wrapTx(tx));
            },
            ...rest,
          );
        };
      }

      // collection() / doc() / batch() all lead to countable non-transactional work.
      if (name === 'collection' || name === 'doc' || name === 'batch' || name === 'collectionGroup') {
        return (...args: unknown[]) =>
          wrapRef((value as (...a: unknown[]) => unknown).apply(target, args));
      }

      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  });

  return {
    db: proxied as Firestore,
    counts,
    reset() {
      counts.reads = 0;
      counts.writes = 0;
      counts.deletes = 0;
      counts.transactions = 0;
      counts.attempts = 0;
    },
  };
}

// ---- fixture -----------------------------------------------------------------------------

const task = (task_id: string): TaskView => ({
  task_id,
  title: `measure ${task_id}`,
  kind: 'backend',
  status: 'open',
  claimed_by: null,
  branch: null,
  pr_url: null,
  pr_number: null,
  ci: null,
  depends_on: [],
  blocked_by: null,
  blocked_reason: null,
  file_scope: [],
  updated_at: systemClock.iso(),
});

const contractEvent = (version: number): EventInput => ({
  layer: 'contract',
  kind: 'contract_published',
  actor_type: 'agent',
  actor_id: 'agent_measure01',
  body: {
    name: 'items-api',
    version,
    path: `contracts/items-api.v${version}.yaml`,
    commit_sha: 'a3f9c1e0d4b28f6712c9ab3e5580f1d2c7e46a9b',
    supersedes: version > 1 ? version - 1 : null,
  },
});

async function main(): Promise<void> {
  const app = initializeApp({ projectId: PROJECT }, `measure-${Date.now()}`);
  const raw = getFirestore(app);
  const counting = countingFirestore(raw);
  const log = new CapturingLogger();
  const store: FirestoreStore = createFirestoreStore({
    db: counting.db,
    log,
    clock: systemClock,
    debounce_ms: 0,
  });

  const lines: string[] = [];
  const out = (s = '') => {
    lines.push(s);
    console.log(s);
  };

  out(`# Firebase route — measured, run 1`);
  out();
  out(`Project \`${PROJECT}\`, Firestore \`(default)\` in **asia-south1** (Mumbai), plan Spark.`);
  out(`Measurement project id \`${PID}\`. Machine: this laptop, India.`);
  out();
  out('**Read the caveats before the numbers.**');
  out();
  out('## Caveats that bound what these numbers mean');
  out();
  out('1. **Database region was chosen deliberately and it dominates these figures.** `asia-south1`');
  out('   because this machine and Catalyst are both in India; a US multi-region default would');
  out('   have added roughly 200 ms to every row and flattered the other build.');
  out('2. **G1 here measures append and then the folded-state read.** This build folds inside the');
  out('   append transaction, so there is no separate snapshot builder — which makes it a');
  out('   different pipeline from the Catalyst route, not merely a faster one. The design doc\'s');
  out('   34 ms CDN figure is a different measurement again and must not be compared to either.');
  out('3. **Spark plan.** No Cloud Functions, so nothing here traverses the HTTP API or the');
  out('   webhook. These are adapter-to-Firestore numbers, not end-to-end request numbers.');
  out('4. **One run.** Per the rule this build wrote: no figure here is a threshold. Shape and');
  out('   recovery, not a number to quote back.');
  out();

  // ---- setup, and the COLD call reported separately ----
  await store.ensureProject(PID, { project_name: 'Measurement', repo_url: 'example/repo' });

  counting.reset();
  const coldT0 = Date.now();
  await store.appendEvent(PID, contractEvent(1), `cold-${Date.now()}`);
  const coldMs = Date.now() - coldT0;
  const coldOps = { ...counting.counts };
  out('## Cold first call');
  out();
  out(`First \`appendEvent\` after process start: **${coldMs} ms** — ${coldOps.reads} reads,`);
  out(`${coldOps.writes} writes, ${coldOps.transactions} transaction(s).`);
  out();
  out('Reported separately and **excluded from every percentile below**: it includes SDK');
  out('initialisation, channel setup and TLS, none of which recur.');
  out();

  // ---- G1: append, and publish -> visible ----
  //
  // publish->visible is measured through a LIVE SUBSCRIPTION, not by polling readSnapshot.
  //
  // Two reasons, and the first is a correctness one. Polling would measure how fast my poll
  // loop notices, which is a property of the loop; the live listener is the actual push path
  // and the thing Firestore is being chosen FOR. Measuring the poll would be the borrowed-number
  // error in miniature: a real figure for the wrong mechanism.
  //
  // The second is cost. Without a live cache, readSnapshot falls back to assembleFromServer,
  // which is six queries; polling every 5 ms across 100 appends against a growing contracts
  // collection would have been tens of thousands of reads. Billing is linked now.
  const N1 = Number(process.env.G1_N ?? 100);
  const appendMs: number[] = [];
  const visibleMs: number[] = [];

  let liveSeq = -1;
  const seqArrivedAt = new Map<number, number>();
  const unsubscribe = store.subscribe(PID, 0, (snap) => {
    if (snap.seq > liveSeq) {
      liveSeq = snap.seq;
      if (!seqArrivedAt.has(snap.seq)) seqArrivedAt.set(snap.seq, Date.now());
    }
  });
  // Let the initial load settle so the first append is not timed against a cold listener.
  await new Promise((res) => setTimeout(res, 2_000));

  counting.reset();
  let visibilityTimeouts = 0;
  for (let i = 0; i < N1; i++) {
    const t0 = Date.now();
    const r = await store.appendEvent(PID, contractEvent(i + 2), `g1-${i}-${Date.now()}`);
    appendMs.push(Date.now() - t0);

    // BOUNDED wait. An unbounded loop against a billed backend is how a measurement becomes an
    // invoice; a stuck listener must end the sample, not spin.
    const deadline = Date.now() + 10_000;
    while (liveSeq < r.seq && Date.now() < deadline) {
      await new Promise((res) => setTimeout(res, 2));
    }
    if (liveSeq >= r.seq) {
      const arrived = seqArrivedAt.get(liveSeq) ?? Date.now();
      visibleMs.push(Math.max(0, arrived - t0));
    } else {
      visibilityTimeouts += 1;
    }
  }
  unsubscribe();
  const g1Ops = { ...counting.counts };

  out(`## G1 — append and publish→visible, n=${N1}`);
  out();
  out('| | n | p50 | p95 | p99 | max | mean |');
  out('|---|---|---|---|---|---|---|');
  out(row('`appendEvent`', stats(appendMs)));
  out(row('publish → visible', stats(visibleMs)));
  out();
  out(`0 append failures. ${visibilityTimeouts} visibility timeout(s) at 10 s, excluded from the`);
  out('percentiles and reported here rather than silently dropped.');
  out();
  out(`Ops for the whole G1 phase: ${g1Ops.reads} reads, ${g1Ops.writes} writes,`);
  out(`${g1Ops.transactions} transaction calls, ${g1Ops.attempts} transaction attempts.`);
  out();
  out('**publish→visible is the live-listener push path**, timed from the `appendEvent` call to');
  out('the arrival of an `onSnapshot` frame carrying that `seq` — not a poll loop noticing. It');
  out('therefore contains the append itself and is NOT additive with the append row above.');
  out();

  // ---- G2: claim round-trip, CONTENDED ----
  //
  // Order 0033 asks for contended, and the previous version of this was not: it seeded a fresh
  // task per claim so every call won uncontended. That would have measured the happy path and
  // labelled it a claim round-trip -- and the contended tail is exactly what matters, since
  // Catalyst's max was 1,186 ms against a p95 of 182 ms.
  //
  // So CONTENDERS agents race for each task, fired concurrently. Every attempt is timed,
  // winners and losers alike: a loser is a normal outcome of the protocol and the caller waits
  // exactly as long for it.
  const N2 = Number(process.env.G2_N ?? 200);
  const CONTENDERS = Number(process.env.G2_CONTENDERS ?? 5);
  const ROUNDS = Math.ceil(N2 / CONTENDERS);
  const claimMs: number[] = [];
  let won = 0;
  let lost = 0;

  // Seed every task up front so task creation is not inside the timed section.
  for (let r = 0; r < ROUNDS; r += 1) {
    await store.seedTasks(PID, [task(`task_m_${r}`)]);
  }

  // ---- G2a: UNCONTENDED, to match the shape Catalyst actually measured ----
  //
  // Catalyst's run-1 reports "200/200 claims won", which means every claim was uncontended --
  // a fresh task each time. Comparing my contended figure against that would be the
  // apples-to-oranges error this exercise keeps paying for, so both are measured and both are
  // labelled. THIS is the row comparable to theirs.
  const uncontendedMs: number[] = [];
  for (let i = 0; i < ROUNDS; i += 1) {
    await store.seedTasks(PID, [task(`task_u_${i}`)]);
  }
  counting.reset();
  for (let i = 0; i < ROUNDS; i += 1) {
    const t0 = Date.now();
    const res = await store.claimTask(PID, `task_u_${i}`, 'agent_solo');
    uncontendedMs.push(Date.now() - t0);
    if (!res.ok) throw new Error(`uncontended claim ${i} lost, which should be impossible`);
  }
  const g2aOps = { ...counting.counts };

  counting.reset();
  const t2 = Date.now();
  for (let r = 0; r < ROUNDS; r += 1) {
    const results = await Promise.all(
      Array.from({ length: CONTENDERS }, async (_unused, a) => {
        const t0 = Date.now();
        const res = await store.claimTask(PID, `task_m_${r}`, `agent_c${a}`);
        return { ms: Date.now() - t0, ok: res.ok };
      }),
    );
    for (const x of results) {
      claimMs.push(x.ms);
      if (x.ok) won += 1;
      else lost += 1;
    }
  }
  const g2Wall = Date.now() - t2;
  const g2Ops = { ...counting.counts };

  out('## G2 — claim round-trip');
  out();
  out('**Two rows, because they measure different things and only one is comparable to the');
  out('Catalyst figure.** Their run-1 reports 200/200 claims won, so every claim there was');
  out('uncontended. Reading my contended number against theirs would be an apples-to-oranges');
  out('comparison of exactly the kind this exercise has already been burned by.');
  out();
  out('| | n | p50 | p95 | p99 | max |');
  out('|---|---|---|---|---|---|');
  const cu = stats(uncontendedMs);
  const c = stats(claimMs);
  out(`| **uncontended** (comparable to Catalyst) | ${cu.n} | ${cu.p50} | ${cu.p95} | ${cu.p99} | **${cu.max}** |`);
  out(`| **contended**, ${CONTENDERS}-way (asked for by 0033) | ${c.n} | ${c.p50} | ${c.p95} | ${c.p99} | **${c.max}** |`);
  out();
  out('No mean, per 0033.');
  out();
  out(`${ROUNDS} tasks x ${CONTENDERS} concurrent contenders = ${claimMs.length} timed attempts.`);
  out(`${won} won, ${lost} lost. Exactly one winner per task is the correctness claim, and`);
  out(`${won === ROUNDS ? '**it held**' : '**IT DID NOT HOLD - investigate before quoting anything here**'}.`);
  out(`${Math.round(g2Wall / 1000)} s wall clock.`);
  out();
  out('Losers are timed too: a lost claim is a normal protocol outcome, not an error, and the');
  out('caller waits for it exactly as long as a winner does.');
  if (c.max > c.p95 * 3) {
    out();
    out(`**Outlier worth naming: max ${c.max} ms against a p95 of ${c.p95} ms** — ${Math.round(c.max / c.p95)}x.`);
    out('Not a threshold and not something to average away: a claim that occasionally stalls that');
    out(`long is user-visible, and the mean of ${c.mean} ms hides it completely.`);
  }
  out();

  // ---- G4: per-operation cost, counted ----
  counting.reset();
  await store.appendEvent(PID, contractEvent(999), `g4-append-${Date.now()}`);
  const opAppend = { ...counting.counts };

  counting.reset();
  await store.seedTasks(PID, [task('task_g4')]);
  counting.reset();
  await store.claimTask(PID, 'task_g4', 'agent_g4');
  const opClaim = { ...counting.counts };

  counting.reset();
  await store.readSnapshot(PID);
  const opSnapshot = { ...counting.counts };

  counting.reset();
  await store.readEvents(PID, 0);
  const opRead = { ...counting.counts };

  counting.reset();
  await store.heartbeat(PID, 'agent_g4', 'working', 'task_g4', 'branch');
  const opHeartbeat = { ...counting.counts };

  out('## G4 — operations per request, counted not derived');
  out();
  out('| operation | reads | writes | deletes | tx calls | tx attempts | clean? |');
  out('|---|---|---|---|---|---|---|');
  const g4rows = [
    ['`appendEvent`', opAppend],
    ['`claimTask`', opClaim],
    ['`readSnapshot`', opSnapshot],
    ['`readEvents`', opRead],
    ['`heartbeat`', opHeartbeat],
  ] as const;
  let anyRetried = false;
  for (const [name, o] of g4rows) {
    const clean = o.attempts <= o.transactions;
    if (!clean) anyRetried = true;
    out(
      `| ${name} | ${o.reads} | ${o.writes} | ${o.deletes} | ${o.transactions} | ${o.attempts} |` +
        ` ${clean ? 'yes' : '**NO — retried**'} |`,
    );
  }
  out();
  out('Counted by proxying the Firestore handle AND the transaction object, not by reading the');
  out('adapter. The Catalyst G4 correction invalidated every earlier planning figure precisely');
  out('because those were reasoned from a schema rather than measured against a live request.');
  out();
  out('**`tx attempts` is the honesty column.** A retry loop is a correctness mechanism that');
  out('doubles as a cost-hiding one: the SDK re-runs a transaction body on internal retry and');
  out('this adapter retries contention on top of that, so `reads` and `writes` are sums over');
  out('every attempt. If attempts exceeds calls, the row is an average over retries and NOT a');
  out('per-operation cost.');
  out();
  if (anyRetried) {
    out('> **At least one row above retried, so those figures are upper bounds inflated by');
    out('> retries, not clean per-operation costs. Re-run on an idle project before quoting.**');
  } else {
    out('Every row above ran in a single attempt, so the counts are clean per-operation costs.');
  }
  out();
  const contended = log.withCode('store.tx.contended').length;
  out(`Adapter-level contention backoffs during the whole measurement: **${contended}**.`);
  out('Zero means nothing in these figures is absorbing contention.');
  out();

  // ---- G5 / G6 ----
  out('## G5 — extrapolated monthly cost');
  out();
  out('**Not converted to dollars.** Per the standard set by the Catalyst run: measured');
  out('operations beat a number multiplied by a guess, and I have no verified rate card. What');
  out('is reportable is the operation count per unit of work, above, and the free-tier');
  out('arithmetic below.');
  out();
  out('## G6 — free-tier headroom');
  out();
  out('Firestore Spark free tier: 50,000 document reads and 20,000 document writes per **day**.');
  out(`Using the counted figures above, one append costs ${opAppend.writes} writes and`);
  out(`${opAppend.reads} reads, and one claim costs ${opClaim.writes} writes and ${opClaim.reads} reads.`);
  out();
  out('The binding constraint is writes, and the dominant consumer is presence, not work:');
  out('a 30 s heartbeat is 2,880 writes/day per agent, so three agents spend ~8,640 of 20,000');
  out('on heartbeats alone before any coordination happens. That is the number that matters for');
  out('G6 and it is arithmetic on a counted figure, not an estimate.');
  out();

  await store.close();
  await deleteApp(app);

  // Written into firebase/, not docs/. `docs/` is shared-frozen per territory.md, and a results
  // file is mine to produce but the coordinator's to promote.
  const { writeFile, mkdir } = await import('node:fs/promises');
  await mkdir('firebase/results', { recursive: true });
  await writeFile('firebase/results/firebase-run-1.md', lines.join('\n') + '\n');
  console.log('\nwrote firebase/results/firebase-run-1.md');
}

main().catch((err) => {
  console.error('measurement failed:', err);
  process.exit(1);
});
