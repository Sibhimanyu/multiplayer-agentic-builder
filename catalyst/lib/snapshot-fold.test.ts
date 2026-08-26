// The snapshot fold. Pure, so every case is cheap to assert.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { foldSnapshot } from './snapshot-fold.ts';
import type { FoldInput } from './snapshot-fold.ts';
import type { Event, EventKind } from '../../shared/store/types.ts';
import { LAYER_OF, STALE_AFTER_MS } from '../../shared/store/types.ts';
import { CapturingLogger } from '../../shared/log.ts';

const NOW = Date.UTC(2026, 7, 26, 12, 0, 0);

function ev(seq: number, kind: EventKind, body: Record<string, unknown>, at = '2026-08-26T11:00:00.000Z'): Event {
  return {
    event_id: `evt_${seq}`, project_id: 'proj_inventory', seq, layer: LAYER_OF[kind], kind,
    actor_type: 'agent', actor_id: 'agent_be01', created_at: at, body,
  };
}

function input(over: Partial<FoldInput> = {}): FoldInput {
  return {
    project_id: 'proj_inventory',
    events: [], tasks: [], agents: [], claims: [], locks: [], presence: [],
    now_ms: NOW, ...over,
  };
}

const TASK_DEF = {
  task_id: 'task_items_api', title: 'Items API', kind: 'backend',
  depends_on: '["task_schema"]', file_scope: '["functions/**"]',
};

describe('snapshot fold', () => {
  test('task definitions become open tasks with their scope parsed', () => {
    const s = foldSnapshot(input({ tasks: [TASK_DEF] }));
    assert.equal(s.tasks.length, 1);
    assert.equal(s.tasks[0].status, 'open');
    assert.deepEqual(s.tasks[0].depends_on, ['task_schema']);
    assert.deepEqual(s.tasks[0].file_scope, ['functions/**']);
  });

  test('snapshot.seq is the highest seq applied, which is what "stale not lost" compares', () => {
    const s = foldSnapshot(input({
      tasks: [TASK_DEF],
      events: [ev(7, 'pr_opened', { task_id: 'task_items_api', pr_number: 1 }), ev(41, 'ci_failed', { task_id: 'task_items_api' })],
    }));
    assert.equal(s.seq, 41);
  });

  test('ORDERING IS BY seq, never by created_at', () => {
    // created_at is metadata (order 0017) and carries second resolution here, so
    // a batch shares one timestamp. Sorting by it would reorder silently.
    // These two events have the SAME timestamp and opposite seq order.
    const same = '2026-08-26T11:00:00.000Z';
    const s = foldSnapshot(input({
      tasks: [TASK_DEF],
      events: [
        ev(20, 'merged', { task_id: 'task_items_api' }, same),
        ev(10, 'pr_opened', { task_id: 'task_items_api', pr_number: 4 }, same),
      ],
    }));
    // seq 20 (merged) is last, so merged must win despite arriving first in the array.
    assert.equal(s.tasks[0].status, 'merged');
    assert.equal(s.seq, 20);
  });

  test('a claim moves an open task to claimed and names the owner', () => {
    const s = foldSnapshot(input({
      tasks: [TASK_DEF],
      claims: [{ task_id: 'task_items_api', agent_id: 'agent_be01', claimed_at: '2026-08-26T11:00:00.000Z' }],
    }));
    assert.equal(s.tasks[0].status, 'claimed');
    assert.equal(s.tasks[0].claimed_by, 'agent_be01');
  });

  test('a claim does NOT override a later lifecycle status', () => {
    // The claim table is live state; the event stream has moved the task on.
    const s = foldSnapshot(input({
      tasks: [TASK_DEF],
      events: [ev(5, 'pr_opened', { task_id: 'task_items_api', pr_number: 3, pr_url: 'u' })],
      claims: [{ task_id: 'task_items_api', agent_id: 'agent_be01', claimed_at: 'x' }],
    }));
    assert.equal(s.tasks[0].status, 'pr_open');
    assert.equal(s.tasks[0].claimed_by, 'agent_be01');
  });

  test('the CI badge survives without opening the card (E7 depends on this)', () => {
    const s = foldSnapshot(input({
      tasks: [TASK_DEF],
      events: [
        ev(1, 'pr_opened', { task_id: 'task_items_api', pr_number: 7, pr_url: 'https://x/7' }),
        ev(2, 'ci_failed', { task_id: 'task_items_api' }),
      ],
    }));
    assert.equal(s.tasks[0].ci, 'failed');
    assert.equal(s.tasks[0].pr_number, 7);
  });

  test('contracts fold to pointers and never regress to an older version', () => {
    const s = foldSnapshot(input({
      events: [
        ev(1, 'contract_published', { name: 'items-api', version: 1, path: 'contracts/items-api.v1.yaml', commit_sha: 'a', supersedes: null }),
        ev(2, 'contract_published', { name: 'items-api', version: 2, path: 'contracts/items-api.v2.yaml', commit_sha: 'b', supersedes: 1 }),
        ev(3, 'contract_published', { name: 'items-api', version: 1, path: 'contracts/items-api.v1.yaml', commit_sha: 'a', supersedes: null }),
      ],
    }));
    assert.equal(s.contracts.length, 1);
    assert.equal(s.contracts[0].version, 2, 'a republished v1 must not overwrite v2');
    assert.equal(s.contracts[0].supersedes, 1);
  });

  test('presence: absent from Cache means offline AND stale', () => {
    const s = foldSnapshot(input({
      agents: [{ agent_id: 'agent_be01', role_slug: 'backend', member_label: 'Bea Backend', harness: 'claude-code', revoked: 'false' }],
    }));
    assert.equal(s.agents[0].status, 'offline');
    assert.equal(s.agents[0].stale, true);
    assert.equal(s.agents[0].last_heartbeat_at, null);
  });

  test('presence: stale is derived from the 90s timeout, never stored', () => {
    const agents = [{ agent_id: 'agent_be01', role_slug: 'backend', member_label: 'Bea Backend', harness: 'claude-code', revoked: 'false' }];
    const fresh = foldSnapshot(input({
      agents, presence: [{ agent_id: 'agent_be01', status: 'working', current_task: 'task_items_api', branch: 'b', at_ms: NOW - 1_000 }],
    }));
    assert.equal(fresh.agents[0].stale, false);
    assert.equal(fresh.agents[0].status, 'working');

    const stale = foldSnapshot(input({
      agents, presence: [{ agent_id: 'agent_be01', status: 'working', current_task: null, branch: null, at_ms: NOW - STALE_AFTER_MS - 1 }],
    }));
    assert.equal(stale.agents[0].stale, true);
  });

  test('revoked wins over a live heartbeat, and the STRING "false" does not revoke', () => {
    const presence = [{ agent_id: 'agent_be01', status: 'working' as const, current_task: null, branch: null, at_ms: NOW }];
    const revoked = foldSnapshot(input({
      agents: [{ agent_id: 'agent_be01', role_slug: 'backend', member_label: 'B B', harness: 'claude-code', revoked: 'true' }],
      presence,
    }));
    assert.equal(revoked.agents[0].status, 'revoked');

    const live = foldSnapshot(input({
      agents: [{ agent_id: 'agent_be01', role_slug: 'backend', member_label: 'B B', harness: 'claude-code', revoked: 'false' }],
      presence,
    }));
    assert.equal(live.agents[0].status, 'working');
  });

  test('initials come from the label, for the dashboard avatar', () => {
    const s = foldSnapshot(input({
      agents: [{ agent_id: 'a', role_slug: 'r', member_label: 'Bea Backend', harness: 'manual', revoked: 'false' }],
    }));
    assert.equal(s.agents[0].initials, 'BB');
  });

  test('locks parse their globs from JSON text', () => {
    const s = foldSnapshot(input({
      locks: [{ agent_id: 'agent_be01', task_id: 'task_items_api', globs: '["functions/**","shared/*.ts"]', acquired_at: 'x' }],
    }));
    assert.deepEqual(s.locks[0].globs, ['functions/**', 'shared/*.ts']);
  });

  test('an unparseable JSON column is logged, never silently emptied', () => {
    const log = new CapturingLogger();
    const s = foldSnapshot(input({
      tasks: [{ ...TASK_DEF, file_scope: 'not json at all' }], log,
    }));
    assert.deepEqual(s.tasks[0].file_scope, []);
    assert.ok(log.has('fold.unparseable_json_column'),
      'an empty file_scope would otherwise look like "this task locks nothing"');
  });

  test('an unhandled event kind is logged rather than ignored', () => {
    const log = new CapturingLogger();
    const rogue = { ...ev(1, 'merged', {}), kind: 'invented_kind' as EventKind };
    foldSnapshot(input({ events: [rogue], log }));
    assert.ok(log.has('fold.unhandled_kind'));
  });

  test('presence and locks are capped, and the drop is logged', () => {
    const log = new CapturingLogger();
    const many = Array.from({ length: 205 }, (_u, i) => ({
      agent_id: `agent_${i}`, role_slug: 'r', member_label: `A ${i}`, harness: 'manual', revoked: 'false',
    }));
    const s = foldSnapshot(input({ agents: many, log }));
    assert.equal(s.agents.length, 100);
    assert.ok(log.withCode('fold.capped').some((l) => l.fields.what === 'presence'));
    assert.equal(log.withCode('fold.capped')[0].fields.dropped, 105);
  });

  test('an event for an unknown task does not throw or invent a task', () => {
    const s = foldSnapshot(input({ events: [ev(1, 'merged', { task_id: 'task_ghost' })] }));
    assert.equal(s.tasks.length, 0);
    assert.equal(s.seq, 1, 'the event still counts as folded');
  });
});
