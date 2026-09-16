// The rollup is a counter cache, and a counter cache's failure mode is silent drift: one missed
// decrement is permanent, invisible, and only shows up as a number nobody can explain.
//
// So these tests are less about "does it add up once" and more about the property that matters --
// applying every delta in sequence must land on the same answer as recounting from scratch.

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { applyDelta, emptyRollup, isEmptyDelta, rollupDelta, rollupFromTasks } from './rollup.ts';
import type { TaskStatus, TaskView } from './types.ts';

const task = (id: string, status: TaskStatus, o: Partial<TaskView> = {}): TaskView => ({
  task_id: id, title: id, kind: 'backend', status,
  claimed_by: null, branch: null, pr_url: null, pr_number: null, ci: null,
  depends_on: [], blocked_by: null, blocked_reason: null,
  file_scope: [], updated_at: '2026-09-16T00:00:00.000Z',
  ...o,
});

describe('rollupDelta', () => {
  it('a new task increments its column and nothing else', () => {
    const d = rollupDelta(null, task('t1', 'open'));
    assert.deepEqual(d.counts, { open: 1 });
    assert.equal(d.blocked, 0);
    assert.equal(d.ci_failed, 0);
  });

  it('moving column decrements the old and increments the new', () => {
    const d = rollupDelta(task('t1', 'open'), task('t1', 'claimed'));
    assert.deepEqual(d.counts, { open: -1, claimed: 1 });
  });

  it('a task that changes without moving column does not touch the counts', () => {
    // This is the case a naive implementation gets wrong by recomputing from status alone.
    const d = rollupDelta(task('t1', 'open'), task('t1', 'open', { title: 'renamed' }));
    assert.deepEqual(d.counts, {});
    assert.ok(isEmptyDelta(d));
  });

  it('blocked is tracked independently of column', () => {
    // A task can become blocked while staying in the same column. Deriving one from the other is
    // exactly how the two numbers drift apart.
    const d = rollupDelta(task('t1', 'in_progress'), task('t1', 'in_progress', { blocked_by: 't0' }));
    assert.deepEqual(d.counts, {});
    assert.equal(d.blocked, 1);
  });

  it('unblocking decrements it', () => {
    const d = rollupDelta(task('t1', 'in_progress', { blocked_by: 't0' }), task('t1', 'in_progress'));
    assert.equal(d.blocked, -1);
  });

  it('ci failing and recovering moves ci_failed both ways', () => {
    assert.equal(rollupDelta(task('t', 'pr_open'), task('t', 'pr_open', { ci: 'failed' })).ci_failed, 1);
    assert.equal(rollupDelta(task('t', 'pr_open', { ci: 'failed' }), task('t', 'pr_open', { ci: 'passed' })).ci_failed, -1);
    // pending is not failing, and must not count as such
    assert.equal(rollupDelta(task('t', 'pr_open', { ci: 'failed' }), task('t', 'pr_open', { ci: 'pending' })).ci_failed, -1);
  });

  it('a disappearing task decrements everything it held', () => {
    const d = rollupDelta(task('t', 'open', { blocked_by: 'x', ci: 'failed' }), null);
    assert.deepEqual(d.counts, { open: -1 });
    assert.equal(d.blocked, -1);
    assert.equal(d.ci_failed, -1);
  });

  it('null to null is empty rather than a throw', () => {
    // An event that touched nothing has already been logged as ignored. It must not also corrupt
    // a counter or take the transaction down.
    assert.ok(isEmptyDelta(rollupDelta(null, null)));
  });
});

describe('the property that stops drift', () => {
  it('replaying every delta equals recounting from scratch', () => {
    // A task's life, one transition at a time -- the sequence a real project produces.
    const history: [TaskView | null, TaskView | null][] = [
      [null, task('a', 'open')],
      [null, task('b', 'open')],
      [task('a', 'open'), task('a', 'claimed')],
      [task('b', 'open'), task('b', 'claimed')],
      [task('a', 'claimed'), task('a', 'in_progress')],
      [task('a', 'in_progress'), task('a', 'in_progress', { blocked_by: 'b' })],
      [task('a', 'in_progress', { blocked_by: 'b' }), task('a', 'in_progress')],
      [task('b', 'claimed'), task('b', 'pr_open', { ci: 'failed' })],
      [task('b', 'pr_open', { ci: 'failed' }), task('b', 'pr_open', { ci: 'passed' })],
      [task('b', 'pr_open', { ci: 'passed' }), task('b', 'merged')],
    ];

    let incremental = emptyRollup();
    for (const [before, after] of history) incremental = applyDelta(incremental, rollupDelta(before, after));

    const final = [task('a', 'in_progress'), task('b', 'merged')];
    const recounted = rollupFromTasks(final, '', 0);

    // Compared by VALUE, not by shape. The incremental side keeps a key at zero once a column has
    // been visited and emptied; the recount never creates it. Production does the same, because
    // FieldValue.increment cannot delete a key when it reaches zero -- so normalising here keeps
    // the test honest about the thing that matters (the numbers) instead of asserting a shape the
    // live write path does not produce.
    const meaningful = (c: Partial<Record<TaskStatus, number>>) =>
      Object.fromEntries(Object.entries(c).filter(([, v]) => v !== 0));

    assert.deepEqual(meaningful(incremental.counts), meaningful(recounted.counts));
    assert.equal(incremental.blocked, recounted.blocked);
    assert.equal(incremental.ci_failed, recounted.ci_failed);
  });

  it('the control: a dropped delta DOES diverge, so the check above can fail', () => {
    // Without this, "incremental equals recounted" would also pass for a comparison that never
    // looks at anything.
    let incremental = emptyRollup();
    incremental = applyDelta(incremental, rollupDelta(null, task('a', 'open')));
    // deliberately skip the open -> claimed transition
    const recounted = rollupFromTasks([task('a', 'claimed')], '', 0);
    assert.notDeepEqual(incremental.counts, recounted.counts);
  });
});

describe('applyDelta', () => {
  it('clamps at zero rather than rendering a negative count', () => {
    // A negative count is always a bug. Showing "-1 open" turns an invisible accounting error
    // into a visible one the reader cannot act on.
    const r = applyDelta(emptyRollup(), { counts: { open: -3 }, blocked: -2, ci_failed: -1 });
    assert.equal(r.counts.open, 0);
    assert.equal(r.blocked, 0);
    assert.equal(r.ci_failed, 0);
  });

  it('leaves untouched statuses alone', () => {
    const start = applyDelta(emptyRollup(), { counts: { open: 5, merged: 2 }, blocked: 0, ci_failed: 0 });
    const next = applyDelta(start, { counts: { open: -1 }, blocked: 0, ci_failed: 0 });
    assert.equal(next.counts.open, 4);
    assert.equal(next.counts.merged, 2);
  });
});
