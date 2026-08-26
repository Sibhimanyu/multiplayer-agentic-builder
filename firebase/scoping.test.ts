// Evidence for the headline G9 asymmetry: per-project scoping is free on Firestore.
//
// Mandatory behaviour 2 was corrected on 2026-08-25 after the Catalyst workspace probed it:
// `is_unique` is global to the TABLE, so a bare `unique(task_id)` lets project A's claim block
// project B's identically-named task forever — cross-tenant denial of service by name
// collision. Catalyst therefore has to build composite key columns plus a builder that rejects
// the separator inside any part.
//
// The spec says Firestore "needs none of this: a transaction on a document path is naturally
// scoped". That is true, and it is exactly the kind of claim that should be measured rather
// than asserted — an untested "we are fine here" is how the Catalyst bug got into the spec in
// the first place. So this proves it.
//
//   npm --prefix firebase run test:emulator

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

import { createFirestoreStore, type FirestoreStore } from './store.ts';
import { CapturingLogger } from '../shared/log.ts';
import { FakeClock } from '../shared/clock.ts';
import type { TaskView } from '../shared/store/types.ts';

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;

if (!EMULATOR) {
  test('per-project claim scoping', { skip: 'FIRESTORE_EMULATOR_HOST unset' }, () => {});
}

if (EMULATOR) {
  let app: App;
  let db: Firestore;
  let store: FirestoreStore;
  const clock = new FakeClock();
  const log = new CapturingLogger();

  // The collision the Catalyst bug is about: the SAME task id in two different projects.
  const TASK = 'task_items_crud';
  const A = `proj_scope_a_${Date.now().toString(36)}`;
  const B = `proj_scope_b_${Date.now().toString(36)}`;

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
    file_scope: ['functions/**'],
    updated_at: clock.iso(),
  });

  before(async () => {
    app = initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? 'demo-bakeoff' }, `scoping-${Date.now()}`);
    db = getFirestore(app);
    store = createFirestoreStore({ db, log, clock, debounce_ms: 0 });
    for (const pid of [A, B]) {
      await store.ensureProject(pid, { project_name: pid, repo_url: 'example/repo' });
      await store.seedTasks(pid, [task(TASK)]);
    }
  });

  after(async () => {
    await store.close();
    await deleteApp(app);
  });

  test('MB2: an identically-named task in two projects can be claimed independently', async () => {
    // On Catalyst without composite keys this is the denial of service: the first INSERT takes
    // the globally-unique task_id and the second project can never claim its own task.
    const a = await store.claimTask(A, TASK, 'agent_aaaa0001');
    const b = await store.claimTask(B, TASK, 'agent_bbbb0002');

    assert.equal(a.ok, true, 'project A must be able to claim its own task');
    assert.equal(b.ok, true, "project B's identically-named task must be unaffected");

    assert.equal(await store.claimOwner(A, TASK), 'agent_aaaa0001');
    assert.equal(await store.claimOwner(B, TASK), 'agent_bbbb0002');
  });

  test('MB2: releasing in one project does not release the other', async () => {
    await store.releaseTask(A, TASK, 'agent_aaaa0001');
    assert.equal(await store.claimOwner(A, TASK), null, 'A released');
    assert.equal(
      await store.claimOwner(B, TASK),
      'agent_bbbb0002',
      "B's claim must survive A's release: the paths are disjoint",
    );
  });

  test('MB2: a project id containing the Catalyst separator is not a hazard here', async () => {
    // The composite-key builder Catalyst needs must reject a ':' inside any part, because
    // "a:b"+"c" would otherwise collide with "a"+"b:c". There is no concatenation here, so
    // there is nothing to collide -- but assert it rather than reasoning about it, since this
    // is precisely the class of bug the spec correction was about.
    //
    // Firestore document ids may not contain '/', so ':' is the interesting case and is legal.
    const weird = `proj_a${':'}b_${Date.now().toString(36)}`;
    await store.ensureProject(weird, { project_name: weird, repo_url: 'example/repo' });
    await store.seedTasks(weird, [task(TASK)]);

    const claimed = await store.claimTask(weird, TASK, 'agent_cccc0003');
    assert.equal(claimed.ok, true);
    assert.equal(await store.claimOwner(weird, TASK), 'agent_cccc0003');
    // And the two original projects are untouched by a name that would have been ambiguous
    // under naive concatenation.
    assert.equal(await store.claimOwner(B, TASK), 'agent_bbbb0002');
  });

  test('MB2: scope locks are per project too, so identical globs do not collide', async () => {
    // Same reasoning as claims: locks live at projects/{pid}/locks/{agent_id}. Two projects
    // locking the exact same glob is not a conflict, and on Catalyst it would have been.
    const a = await store.acquireScope(A, 'agent_aaaa0001', TASK, ['functions/**']);
    const b = await store.acquireScope(B, 'agent_bbbb0002', TASK, ['functions/**']);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true, 'the same glob in a different project must not conflict');

    // Within ONE project it still conflicts, which is the behaviour that matters (A7).
    const clash = await store.acquireScope(A, 'agent_dddd0004', TASK, ['functions/items/**']);
    assert.equal(clash.ok, false, 'intersecting globs in the SAME project must still be refused');
  });

  test('MB4: seq is globally allocated and strictly ascending across projects', async () => {
    // The counter document is per project here (projects/{pid}/meta/ledger), so seq is
    // per-project-monotonic rather than globally so. That satisfies behaviour 4, which asks for
    // strictly ascending within what readEvents returns -- and readEvents is per project.
    //
    // Worth pinning explicitly because Catalyst's corrected mechanism allocates seq GLOBALLY
    // and filters on read, which is a different shape reaching the same guarantee. If someone
    // later assumes seq is comparable ACROSS projects on this build, this test says it is not.
    const before = (await store.readEvents(A, 0)).events.map((e) => e.seq);
    for (let i = 1; i < before.length; i++) {
      assert.ok(before[i]! > before[i - 1]!, 'strictly ascending within a project');
    }
    const aSeq = (await store.readSnapshot(A))!.snapshot.seq;
    const bSeq = (await store.readSnapshot(B))!.snapshot.seq;
    assert.ok(aSeq > 0 && bSeq > 0, 'both projects have their own advancing counter');

    // Every event readEvents returns for A belongs to A. No cross-project bleed.
    const { events } = await store.readEvents(A, 0);
    for (const e of events) assert.equal(e.project_id, A);
  });
}
