// Scope locks, including the race the missing transaction leaves open.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { handleAcquireScope, handleReleaseScope, lockKeyFor } from './index.ts';
import type { LockRecord, ScopePort } from './index.ts';
import { DuplicateValueError } from '../../catalyst/lib/duplicate.ts';
import { CapturingLogger } from '../../shared/log.ts';
import type { Principal } from '../_lib/auth.ts';

const PROJECT = 'proj_inventory';
const now = (): string => '2026-08-26T12:00:00.000Z';

function principal(over: Partial<Principal> = {}): Principal {
  return {
    agent_id: 'agent_be01', project_id: PROJECT, role_slug: 'backend',
    member_id: 'm', member_label: 'Bea Backend', can_merge: false, ...over,
  };
}

/** In-memory lock table with a real unique constraint on lock_key. */
class FakeLocks implements ScopePort {
  rows: LockRecord[] = [];
  /** Locks injected between the pre-check and the re-check, to force the race. */
  injectOnInsert: LockRecord[] = [];

  listLocks = async (): Promise<LockRecord[]> => [...this.rows];

  insertLock = async (row: {
    lock_key: string; agent_id: string; task_id: string; globs: string; acquired_at: string;
  }): Promise<void> => {
    if (this.rows.some((r) => r.lock_key === row.lock_key)) {
      throw new DuplicateValueError('Duplicate value for lock_key. Please give a different value');
    }
    this.rows.push({
      lock_key: row.lock_key, agent_id: row.agent_id, task_id: row.task_id,
      globs: JSON.parse(row.globs), acquired_at: row.acquired_at,
    });
    // Simulate a competitor whose insert landed inside our window.
    this.rows.push(...this.injectOnInsert);
    this.injectOnInsert = [];
  };

  deleteLock = async (lock_key: string): Promise<void> => {
    this.rows = this.rows.filter((r) => r.lock_key !== lock_key);
  };

  deleteLocksForAgent = async (_p: string, agent_id: string): Promise<number> => {
    const before = this.rows.length;
    this.rows = this.rows.filter((r) => r.agent_id !== agent_id);
    return before - this.rows.length;
  };
}

describe('acquireScope', () => {
  test('A8: disjoint globs are both granted', async () => {
    const db = new FakeLocks();
    const log = new CapturingLogger();
    const a = await handleAcquireScope(db, principal(), { project_id: PROJECT, task_id: 'task_api', globs: ['functions/**'] }, now, log);
    const b = await handleAcquireScope(db, principal({ agent_id: 'agent_fe01' }), { project_id: PROJECT, task_id: 'task_ui', globs: ['client/src/**'] }, now, log);
    assert.deepEqual(a.body, { ok: true });
    assert.deepEqual(b.body, { ok: true });
    assert.equal(db.rows.length, 2);
  });

  test('A7: intersecting globs are rejected and the conflict is named', async () => {
    const db = new FakeLocks();
    const log = new CapturingLogger();
    await handleAcquireScope(db, principal({ agent_id: 'agent_fe01' }), { project_id: PROJECT, task_id: 'task_ui', globs: ['client/src/**'] }, now, log);

    const res = await handleAcquireScope(db, principal(), { project_id: PROJECT, task_id: 'task_api', globs: ['client/src/store/catalyst.ts'] }, now, log);
    const body = res.body as { ok: boolean; conflicts: { agent_id: string; task_id: string; globs: string[] }[] };
    assert.equal(body.ok, false);
    assert.equal(body.conflicts.length, 1);
    assert.equal(body.conflicts[0].agent_id, 'agent_fe01');
    assert.equal(body.conflicts[0].task_id, 'task_ui');
    assert.deepEqual(body.conflicts[0].globs, ['client/src/**']);
    assert.equal(db.rows.length, 1, 'a rejected acquire must not leave a lock behind');
  });

  test('a rejection is not an error and is not logged as one', async () => {
    const db = new FakeLocks();
    const log = new CapturingLogger();
    await handleAcquireScope(db, principal({ agent_id: 'agent_fe01' }), { project_id: PROJECT, task_id: 'task_ui', globs: ['client/**'] }, now, log);
    await handleAcquireScope(db, principal(), { project_id: PROJECT, task_id: 'task_api', globs: ['client/**'] }, now, log);
    assert.equal(log.lines.filter((l) => l.level === 'error').length, 0);
  });

  test('re-acquiring the same lock is idempotent, not a failure', async () => {
    const db = new FakeLocks();
    const log = new CapturingLogger();
    const body = { project_id: PROJECT, task_id: 'task_api', globs: ['functions/**'] };
    await handleAcquireScope(db, principal(), body, now, log);
    const again = await handleAcquireScope(db, principal(), body, now, log);
    assert.deepEqual(again.body, { ok: true });
    assert.equal(db.rows.length, 1);
    assert.ok(log.has('scope.already_held'));
  });

  test('THE RACE: a conflicting lock landing mid-insert is caught by the re-check', async () => {
    // No transaction exists, so the check and the insert cannot be atomic. The
    // re-check is what stops both agents proceeding with overlapping scope.
    const db = new FakeLocks();
    const log = new CapturingLogger();
    // agent_aa01 sorts BELOW agent_be01, so its lock_key is lower and it wins.
    db.injectOnInsert = [{
      lock_key: lockKeyFor(PROJECT, 'agent_aa01', 'task_other'),
      agent_id: 'agent_aa01', task_id: 'task_other',
      globs: ['functions/**'], acquired_at: now(),
    }];

    const res = await handleAcquireScope(db, principal(), { project_id: PROJECT, task_id: 'task_api', globs: ['functions/claim/**'] }, now, log);
    const body = res.body as { ok: boolean; conflicts: unknown[] };
    assert.equal(body.ok, false, 'losing the re-check must be reported as a conflict');
    assert.equal(body.conflicts.length, 1);
    // And our own lock was rolled back, not left dangling.
    assert.equal(db.rows.some((r) => r.agent_id === 'agent_be01'), false);
    assert.ok(log.has('scope.lost_race'));
  });

  test('THE RACE, other side: the lower key keeps its lock', async () => {
    const db = new FakeLocks();
    const log = new CapturingLogger();
    // agent_zz99 sorts ABOVE agent_be01, so we hold the lower key and win.
    db.injectOnInsert = [{
      lock_key: lockKeyFor(PROJECT, 'agent_zz99', 'task_other'),
      agent_id: 'agent_zz99', task_id: 'task_other',
      globs: ['functions/**'], acquired_at: now(),
    }];

    const res = await handleAcquireScope(db, principal(), { project_id: PROJECT, task_id: 'task_api', globs: ['functions/claim/**'] }, now, log);
    assert.deepEqual(res.body, { ok: true });
    assert.ok(db.rows.some((r) => r.agent_id === 'agent_be01'), 'the winner keeps its lock');
    assert.ok(log.has('scope.won_race'));
  });

  test('the tie-break is deterministic, so two racers cannot both yield', async () => {
    // Both sides compute the same comparison from the same data. Exactly one of
    // (a beats b) and (b beats a) is true for distinct keys.
    const a = lockKeyFor(PROJECT, 'agent_aa01', 'task_x');
    const b = lockKeyFor(PROJECT, 'agent_be01', 'task_y');
    assert.notEqual(a, b);
    assert.equal([a < b, b < a].filter(Boolean).length, 1);
  });

  test('an empty or malformed glob list is rejected', async () => {
    const db = new FakeLocks();
    const log = new CapturingLogger();
    for (const globs of [[], undefined, 'functions/**', [''], [42]]) {
      await assert.rejects(
        () => handleAcquireScope(db, principal(), { project_id: PROJECT, task_id: 'task_api', globs }, now, log),
      );
    }
    assert.equal(db.rows.length, 0);
  });

  test('a forged agent_id is rejected before any lock is taken', async () => {
    const db = new FakeLocks();
    const log = new CapturingLogger();
    await assert.rejects(
      () => handleAcquireScope(db, principal(), { project_id: PROJECT, task_id: 'task_api', globs: ['a/**'], agent_id: 'agent_other' }, now, log),
      /resolved server-side/,
    );
    assert.equal(db.rows.length, 0);
  });
});

describe('releaseScope', () => {
  test('releases every lock the agent holds and is idempotent', async () => {
    const db = new FakeLocks();
    const log = new CapturingLogger();
    await handleAcquireScope(db, principal(), { project_id: PROJECT, task_id: 'task_a', globs: ['a/**'] }, now, log);
    await handleAcquireScope(db, principal(), { project_id: PROJECT, task_id: 'task_b', globs: ['b/**'] }, now, log);
    await handleAcquireScope(db, principal({ agent_id: 'agent_fe01' }), { project_id: PROJECT, task_id: 'task_c', globs: ['c/**'] }, now, log);

    const first = await handleReleaseScope(db, principal(), { project_id: PROJECT }, log);
    assert.deepEqual(first.body, { ok: true, released: 2 });
    assert.equal(db.rows.length, 1, 'another agent’s lock is untouched');

    const second = await handleReleaseScope(db, principal(), { project_id: PROJECT }, log);
    assert.deepEqual(second.body, { ok: true, released: 0 }, 'releasing nothing is not an error');
  });
});
