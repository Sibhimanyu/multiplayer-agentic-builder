// MB1a / MB1b, and genuine concurrency against the emulator.
//
// Order 0008 asks for two things: confirm the corrected mandatory behaviour 1, and stop
// trusting that transactions work because the documentation says so.
//
// The second is the point of this file. The Catalyst workspace's dry-run double caught a
// concurrency bug by running twelve concurrent appends and watching one pass and eleven fail —
// a bug no amount of reading would have surfaced. My equivalent of that double is the emulator,
// so the honest thing is to run the same shape of test rather than to reason that
// `runTransaction` handles it.
//
// The append path here is genuinely contended: EVERY append reads and writes one counter
// document at projects/{pid}/meta/ledger. That document is the single hottest thing in the
// design, so if there is a concurrency defect in this build it lives here.
//
//   npm --prefix firebase run test:concurrency

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

import { createFirestoreStore, scopedKeyFor, type FirestoreStore } from './store.ts';
import { CapturingLogger } from '../shared/log.ts';
import { isRetryable, StoreBusyError } from '../shared/store/errors.ts';
import { withRetry } from '../shared/store/retry.ts';
import { FakeClock } from '../shared/clock.ts';
import type { AppendResult, EventInput, TaskView } from '../shared/store/types.ts';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

if (!EMULATOR) {
  test('append concurrency and MB1a/1b', { skip: 'FIRESTORE_EMULATOR_HOST unset' }, () => {});
}

if (EMULATOR) {
  let app: App;
  let db: Firestore;
  let store: FirestoreStore;
  const clock = new FakeClock();
  const log = new CapturingLogger();
  const stamp = Date.now().toString(36);
  // Fixed up front so the correlation assertions can address each record by its own key.
  const keys32 = Array.from({ length: 32 }, () => randomUUID());

  const progress = (n: number): EventInput => ({
    layer: 'human',
    kind: 'task_progress',
    actor_type: 'agent',
    actor_id: 'agent_be000001',
    body: { task_id: 'task_items_crud', n },
  });

  const task = (task_id: string): TaskView => ({
    task_id,
    title: 'Items CRUD',
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
    updated_at: clock.iso(),
  });

  const project = async (suffix: string): Promise<string> => {
    const pid = `proj_conc_${suffix}_${stamp}`;
    await store.ensureProject(pid, { project_name: pid, repo_url: 'example/repo' });
    await store.seedTasks(pid, [task('task_items_crud')]);
    return pid;
  };

  before(() => {
    app = initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? 'demo-bakeoff' }, `conc-${Date.now()}`);
    db = getFirestore(app);
    store = createFirestoreStore({ db, log, clock, debounce_ms: 0 });
  });

  after(async () => {
    await store.close();
    await deleteApp(app);
  });

  // ---- MB1a: the client-supplied key must be scoped per project --------------------

  test('MB1a the SAME client-supplied idempotency key in two projects is two events', async () => {
    // The failure mode the order describes: a client in project A sends a key that collides
    // with one project B used, B's append absorbs as a duplicate and returns someone else's
    // seq. HTTP 200, a plausible seq, event never written. Silent cross-tenant event loss.
    const [a, b] = await Promise.all([project('1a_a'), project('1a_b')]);
    const shared_key = `deliberately-colliding-${randomUUID()}`;

    const inA = await store.appendEvent(a, progress(1), shared_key);
    const inB = await store.appendEvent(b, progress(2), shared_key);

    assert.equal(inA.duplicate, false, 'first project: a new event');
    assert.equal(
      inB.duplicate,
      false,
      'second project MUST also be new. A duplicate here is the cross-tenant loss.',
    );
    assert.notEqual(
      inA.event_id,
      inB.event_id,
      'two distinct events must have distinct event_id. Equal ids here were a real bug: ' +
        'event_id was derived from the unscoped key, so one identity covered two tenants.',
    );

    // And each project can actually read its own back.
    const eventsA = (await store.readEvents(a, 0)).events;
    const eventsB = (await store.readEvents(b, 0)).events;
    assert.equal(eventsA.length, 1);
    assert.equal(eventsB.length, 1);
    assert.equal(eventsA[0]!.body.n, 1, "A's event body is A's");
    assert.equal(eventsB[0]!.body.n, 2, "B's event body is B's");
    assert.equal(eventsA[0]!.project_id, a);
    assert.equal(eventsB[0]!.project_id, b);
  });

  test('MB1a scoping is structural here, not a concatenation to get wrong', async () => {
    // Catalyst needs `<project_id>:<idempotency_key>` and a builder that rejects a separator
    // inside either part, because "a:b"+"c" would otherwise collide with "a"+"b:c".
    //
    // I originally reasoned that this build needed no composite key at all, since the document
    // already lives UNDER projects/{pid}. That was true of the document and FALSE of event_id,
    // which was derived from the same unscoped hash. Both are scoped now, and the parts are
    // hashed separately so there is no separator to police.
    const pid = await project('1a_struct');
    const key = 'k';
    const r = await store.appendEvent(pid, progress(7), key);

    const doc = await db
      .collection('projects').doc(pid)
      .collection('events').doc(scopedKeyFor(pid, key))
      .get();
    assert.ok(doc.exists, 'the event is addressed by the PROJECT-SCOPED hash');
    assert.equal(doc.get('seq'), r.seq);
    assert.equal(doc.get('idempotency_key'), key, 'the original key is retained for audit');

    // The parts are hashed separately, so there is no separator to be ambiguous about:
    // ("a:b","c") and ("a","b:c") cannot collide the way a concatenated composite key would.
    assert.notEqual(scopedKeyFor('a:b', 'c'), scopedKeyFor('a', 'b:c'), 'no separator ambiguity');
    assert.notEqual(scopedKeyFor('a', 'b'), scopedKeyFor('b', 'a'), 'order matters');
  });

  // ---- MB1b: the record stores the seq actually received ---------------------------

  test('MB1b the dedupe record stores the ACTUAL seq, not a pre-allocation candidate', async () => {
    const pid = await project('1b');

    // Contend the counter first, so any candidate computed before allocation settled would be
    // stale by the time the write lands.
    await Promise.all(Array.from({ length: 8 }, (_, i) => store.appendEvent(pid, progress(i), randomUUID())));

    const key = randomUUID();
    const written = await store.appendEvent(pid, progress(99), key);

    // The event document IS the dedupe record in this design, and it is written in the same
    // transaction as the counter increment, so the recorded seq cannot be a candidate: if the
    // transaction retried, planAppend recomputed everything from the re-read counter.
    const doc = await db
      .collection('projects').doc(pid)
      .collection('events').doc(scopedKeyFor(pid, key))
      .get();
    assert.equal(doc.get('seq'), written.seq, 'stored seq == returned seq');

    // A replay returns the ORIGINAL seq, read back from that same record.
    const replay = await store.appendEvent(pid, progress(99), key);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.seq, written.seq, 'a replay must return the seq the event actually got');
    assert.equal(replay.event_id, written.event_id);

    // And the counter agrees with the highest event, so nothing was allocated and abandoned.
    const counter = await db.collection('projects').doc(pid).collection('meta').doc('ledger').get();
    const { events } = await store.readEvents(pid, 0);
    const maxSeq = Math.max(...events.map((e) => e.seq));
    assert.equal(counter.get('seq'), maxSeq, 'the counter matches the highest event seq');
  });

  test('A1b correlation: each record pairs with an event at that seq AND the same key', async () => {
    // Order 0009's rule, applied. The obvious assertion --
    //   "for each idempotency record, some event exists at that seq"
    // -- passes while every record is cross-wired to the wrong event. Counts right, correlation
    // wrong, which is precisely the corruption 1b exists to prevent. So pair them.
    //
    // Written even though runTransaction makes this correct BY CONSTRUCTION, because that is the
    // easiest kind of guarantee to lose in a refactor: move the counter increment outside the
    // transaction and nothing here would fail if the coverage were only implicit.
    const pid = await project('a1b');
    const N = 12;
    const keys = Array.from({ length: N }, () => randomUUID());

    const results = await Promise.all(
      keys.map((k, i) => store.appendEvent(pid, progress(i), k)),
    );

    const { events } = await store.readEvents(pid, 0);
    const bySeq = new Map(events.map((e) => [e.seq, e]));

    for (let i = 0; i < N; i++) {
      const key = keys[i]!;
      const r = results[i]!;
      const event = bySeq.get(r.seq);

      assert.ok(event, `no event at seq ${r.seq}`);
      // The pairing assertion. Without this the test cannot tell the bug from the fix.
      const stored = await db
        .collection('projects').doc(pid)
        .collection('events').doc(scopedKeyFor(pid, key))
        .get();
      assert.ok(stored.exists, `no record for key ${key}`);
      assert.equal(
        stored.get('seq'),
        r.seq,
        `record for key ${key} must carry the seq that key's append received`,
      );
      assert.equal(
        stored.get('event_id'),
        r.event_id,
        'the record and the returned event_id must be the same event',
      );
      assert.equal(
        event.body.n,
        i,
        `seq ${r.seq} must hold the body appended with key ${key}, not another caller's`,
      );
    }
  });

  test('A1c a replay AFTER contention returns the settled seq of a real, correctly-keyed event', async () => {
    const pid = await project('a1c');
    const key = randomUUID();

    // Contend hard around the target append, so a candidate seq computed before allocation
    // settled would be visibly wrong rather than accidentally right.
    const [target] = await Promise.all([
      store.appendEvent(pid, progress(500), key),
      ...Array.from({ length: 11 }, (_, i) => store.appendEvent(pid, progress(i), randomUUID())),
    ]);

    const replay = await store.appendEvent(pid, progress(500), key);
    assert.equal(replay.duplicate, true);
    assert.equal(replay.seq, target!.seq, 'the replay must return the SETTLED seq');

    // ... and that seq must belong to a real event carrying this key's payload, not merely
    // to some event that happens to exist at that number.
    const { events } = await store.readEvents(pid, 0);
    const at = events.find((e) => e.seq === replay.seq);
    assert.ok(at, 'the replayed seq must name a real event');
    assert.equal(at!.event_id, target!.event_id, 'and it must be THIS key\'s event');
    assert.equal(at!.body.n, 500, "and carry this key's body, not a contender's");
  });

  // ---- genuine concurrency against the hottest document in the design --------------

  test('12 concurrent appends all land, with 12 distinct strictly-ascending seq', async () => {
    // Deliberately the same shape as the test that caught the Catalyst bug: twelve at once,
    // where one passed and eleven failed. Every one of these contends the SAME counter
    // document, which is the single hottest thing in this design.
    const pid = await project('12');
    const N = 12;

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) => store.appendEvent(pid, progress(i), randomUUID())),
    );

    assert.equal(results.length, N);
    assert.equal(results.filter((r) => !r.duplicate).length, N, 'all twelve must be new events');

    const seqs = results.map((r) => r.seq).sort((x, y) => x - y);
    assert.equal(new Set(seqs).size, N, `all ${N} seq must be distinct, got ${seqs.join(',')}`);
    // Gap-free is stronger than the spec requires (gaps are legal) but it is what a counter
    // document inside a transaction actually delivers, so assert it and notice if it changes.
    for (let i = 1; i < seqs.length; i++) {
      assert.equal(seqs[i], seqs[i - 1]! + 1, `seq must be gap-free: ${seqs.join(',')}`);
    }

    const { events } = await store.readEvents(pid, 0);
    assert.equal(events.length, N, 'the ledger must contain all twelve');
    for (let i = 1; i < events.length; i++) {
      assert.ok(events[i]!.seq > events[i - 1]!.seq, 'readEvents must return strictly ascending');
    }
  });

  test('32-way contention surfaces StoreBusyError with adapter retry DISABLED', async () => {
    // MEASURED, and it changes a G9 note from theoretical to real. At 32 concurrent appends the
    // single counter document at projects/{pid}/meta/ledger exhausts the SDK's internal
    // transaction retries and the emulator returns `10 ABORTED: Transaction lock timeout`.
    //
    // My first version of this test asserted all 32 appends resolve. That was asserting the
    // wrong thing. The store contract says StoreBusyError is a NORMAL, retryable outcome, not
    // an error — so a raw appendEvent refusing under heavy contention is the adapter behaving
    // exactly as specified. What has to be true is that the mapping is retryable and the caller
    // recovers, and that is what this now tests.
    // tx_attempts: 1 so the adapter does NOT absorb contention, which is the only way to
    // observe the raw ceiling. In normal operation the adapter retries it (see
    // withContentionRetry) precisely so callers and the shared suite never see this.
    const pid = await project('32_raw');
    const bare = createFirestoreStore({ db, log, clock, debounce_ms: 0, tx_attempts: 1 });
    const N = 32;

    const settled = await Promise.allSettled(
      Array.from({ length: N }, (_, i) => bare.appendEvent(pid, progress(i), randomUUID())),
    );
    const rejected = settled.filter((r) => r.status === 'rejected');

    // Whatever did fail must have failed RETRYABLY. A StoreError here would mean the caller has
    // no defined recovery and the append is simply lost.
    for (const r of rejected) {
      const err = (r as PromiseRejectedResult).reason;
      assert.ok(
        err instanceof StoreBusyError,
        `contention must surface as StoreBusyError, got ${String(err)}`,
      );
      assert.equal(isRetryable(err), true, 'and it must be retryable');
    }

    // Nothing that RESOLVED may share a seq: partial refusal must not corrupt what did land.
    const ok = settled
      .filter((r) => r.status === 'fulfilled')
      .map((r) => (r as PromiseFulfilledResult<AppendResult>).value.seq);
    assert.equal(new Set(ok).size, ok.length, 'no two successful appends may share a seq');
    assert.equal((await bare.readEvents(pid, 0)).events.length, ok.length, 'ledger matches successes');
    await bare.close();

    console.log(
      `    [measured] 32-way contention, adapter retry OFF: ${ok.length} landed, ` +
        `${rejected.length} refused as StoreBusyError`,
    );
  });

  test('32 concurrent appends ALL land once the caller honours the retry contract', async () => {
    // The same 32, through the shared withRetry the CLI uses. This is the assertion that
    // matters: the ceiling is real, and the documented recovery clears it.
    const pid = await project('32_retry');
    const N = 32;

    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        withRetry(() => store.appendEvent(pid, progress(i), keys32[i]!), {
          attempts: 8,
          op: 'appendEvent',
          log,
        }).then((r) => r.value),
      ),
    );

    assert.equal(new Set(results.map((r) => r.seq)).size, N, 'all 32 distinct seq');
    assert.equal((await store.readEvents(pid, 0)).events.length, N, 'nothing lost');

    // Correlation, not count (Order 0009): each key's record must carry that key's own seq.
    for (let i = 0; i < N; i++) {
      const doc = await db
        .collection('projects').doc(pid)
        .collection('events').doc(scopedKeyFor(pid, keys32[i]!))
        .get();
      assert.ok(doc.exists, `key ${i} has no record`);
      assert.equal(doc.get('seq'), results[i]!.seq, `key ${i} record must carry its own seq`);
    }
  });

  test('concurrent replays of ONE key produce one event and one seq', async () => {
    // At-least-once delivery from the outbox means this happens for real: a CLI restart can
    // re-drain the same line while the original request is still in flight.
    const pid = await project('replay');
    const key = randomUUID();

    const results = await Promise.all(
      Array.from({ length: 10 }, () => store.appendEvent(pid, progress(1), key)),
    );

    const seqs = new Set(results.map((r) => r.seq));
    assert.equal(seqs.size, 1, `every caller must get the same seq, got ${[...seqs].join(',')}`);
    assert.equal(results.filter((r) => !r.duplicate).length, 1, 'exactly one caller wrote it');
    assert.equal((await store.readEvents(pid, 0)).events.length, 1, 'exactly one event on the ledger');
  });

  test('concurrent claims and appends together do not corrupt either', async () => {
    // The two contended paths at once: claimTask writes a claim doc AND appends, so it touches
    // the counter too. Running them interleaved is the closest thing here to the real demo.
    const pid = await project('mixed');
    await store.seedTasks(pid, [task('task_a'), task('task_b')]);

    // Retry-wrapped, for the reason established above: under this much contention on one
    // counter document a raw call may legitimately refuse with StoreBusyError, and the caller's
    // job is to back off. Testing it unwrapped would be testing that the contract is not the
    // contract.
    const retried = <T>(fn: () => Promise<T>) =>
      withRetry(fn, { attempts: 8, op: 'mixed', log }).then((r) => r.value);

    const work: Promise<unknown>[] = [];
    for (let i = 0; i < 6; i++) work.push(retried(() => store.appendEvent(pid, progress(i), randomUUID())));
    for (let i = 0; i < 6; i++) work.push(retried(() => store.claimTask(pid, 'task_a', `agent_race${i}`)));
    for (let i = 0; i < 6; i++) work.push(retried(() => store.claimTask(pid, 'task_b', `agent_other${i}`)));
    await Promise.all(work);

    const { events } = await store.readEvents(pid, 0);
    const seqs = events.map((e) => e.seq);
    assert.equal(new Set(seqs).size, seqs.length, 'no duplicate seq across mixed contention');
    for (let i = 1; i < seqs.length; i++) {
      assert.ok(seqs[i]! > seqs[i - 1]!, 'still strictly ascending');
    }

    // Exactly one winner per task, which is A2's guarantee under a noisier workload.
    const claimed = events.filter((e) => e.kind === 'task_claimed');
    const perTask = new Map<string, number>();
    for (const e of claimed) {
      const t = String(e.body.task_id);
      perTask.set(t, (perTask.get(t) ?? 0) + 1);
    }
    assert.equal(perTask.get('task_a'), 1, 'exactly one task_claimed for task_a');
    assert.equal(perTask.get('task_b'), 1, 'exactly one task_claimed for task_b');

    // Order 0009: correlate, do not count. "One task_claimed exists" and "a claim row exists"
    // would both pass while the event named a different agent than the row -- so assert the
    // WINNER matches. A board showing the wrong owner is the failure this catches.
    for (const t of ['task_a', 'task_b']) {
      const owner = await store.claimOwner(pid, t);
      assert.ok(owner, `${t} must have an owner`);
      const claimEvent = claimed.find((e) => String(e.body.task_id) === t);
      assert.ok(claimEvent, `${t} must have a task_claimed event`);
      assert.equal(
        claimEvent!.body.agent_id,
        owner,
        `the task_claimed for ${t} must name the agent that actually holds the claim row`,
      );
      assert.equal(claimEvent!.actor_id, owner, 'and the actor must be that same agent');
    }
  });

  test('the only error-level log lines are exhausted retries, never anything unexpected', async () => {
    // A lost claim and a duplicate append are NORMAL outcomes, and contention that produces
    // error-level noise teaches operators to ignore the error log.
    //
    // My first version asserted ZERO error lines, which was too strong and made this test
    // intermittently red. `retry.exhausted` at error level is CORRECT when retries genuinely
    // exhaust — the shared withRetry is right to shout about it. Asserting it never happens
    // was asserting that sustained contention cannot occur, which is false.
    //
    // What must hold is that no UNEXPECTED error category appears. That still fails on a real
    // defect and no longer fails on the system working as designed.
    const errors = log.lines.filter((l) => l.level === 'error');
    const unexpected = errors.filter((l) => l.code !== 'retry.exhausted');
    assert.deepEqual(
      unexpected,
      [],
      `unexpected error-level lines: ${JSON.stringify(unexpected)}`,
    );
  });
}
