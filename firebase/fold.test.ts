// The Firestore adapter's projection. Pure: no emulator.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyEvent, emptyProjection } from './fold.ts';
import type { Event, EventKind } from '../shared/store/types.ts';
import { LAYER_OF } from '../shared/store/types.ts';

let seq = 0;
const ev = (kind: EventKind, body: Record<string, unknown>): Event => ({
  seq: ++seq, kind, layer: LAYER_OF[kind], actor_type: 'agent', actor_id: 'x',
  body, created_at: new Date(Date.UTC(2026, 8, 23, 0, 0, seq)).toISOString(),
} as unknown as Event);

function projectionWith(task_id: string) {
  const p = emptyProjection();
  applyEvent(p, ev('task_created', { task_id, title: 'T', kind: 'backend' }));
  return p;
}

test('a released claim returns the card to open with no owner', () => {
  const p = projectionWith('task_a');
  applyEvent(p, ev('task_claimed', { task_id: 'task_a', agent_id: 'agent_1' }));
  applyEvent(p, ev('branch_pushed', { task_id: 'task_a', branch: 'agent/x/a' }));
  // Control: the card really is held and in progress before the release.
  assert.equal(p.tasks.get('task_a')!.status, 'in_progress');
  assert.equal(p.tasks.get('task_a')!.claimed_by, 'agent_1');

  applyEvent(p, ev('task_unblocked', { task_id: 'task_a', was_blocked_by: null, reason_resolved: 'claim reaped: silent' }));
  assert.equal(p.tasks.get('task_a')!.status, 'open');
  assert.equal(p.tasks.get('task_a')!.claimed_by, null);
});

test('after a release, a second agent can claim the card', () => {
  const p = projectionWith('task_a');
  applyEvent(p, ev('task_claimed', { task_id: 'task_a', agent_id: 'agent_1' }));
  applyEvent(p, ev('task_unblocked', { task_id: 'task_a', was_blocked_by: null, reason_resolved: 'released by owner' }));
  const out = applyEvent(p, ev('task_claimed', { task_id: 'task_a', agent_id: 'agent_2' }));
  assert.deepEqual(out.ignored, []);
  assert.equal(p.tasks.get('task_a')!.claimed_by, 'agent_2');
  assert.equal(p.tasks.get('task_a')!.status, 'claimed');
});

test('a released blocked card also goes to open', () => {
  const p = projectionWith('task_a');
  applyEvent(p, ev('task_claimed', { task_id: 'task_a', agent_id: 'agent_1' }));
  applyEvent(p, ev('task_blocked', { task_id: 'task_a', reason: 'waiting' }));
  applyEvent(p, ev('task_unblocked', { task_id: 'task_a', was_blocked_by: null, reason_resolved: 'released by owner' }));
  assert.equal(p.tasks.get('task_a')!.status, 'open');
  assert.equal(p.tasks.get('task_a')!.blocked_reason, null);
});

test('releasing a shipped card leaves it where it is', () => {
  const p = projectionWith('task_a');
  applyEvent(p, ev('task_claimed', { task_id: 'task_a', agent_id: 'agent_1' }));
  applyEvent(p, ev('task_completed', { task_id: 'task_a' }));
  applyEvent(p, ev('task_unblocked', { task_id: 'task_a', was_blocked_by: null, reason_resolved: 'claim reaped: silent' }));
  assert.equal(p.tasks.get('task_a')!.status, 'needs_review');
});

test('a cancelled ticket is terminal and has no owner', () => {
  const p = projectionWith('task_a');
  applyEvent(p, ev('task_claimed', { task_id: 'task_a', agent_id: 'agent_1' }));
  applyEvent(p, ev('task_cancelled', { task_id: 'task_a', reason: 'duplicate' }));
  assert.equal(p.tasks.get('task_a')!.status, 'cancelled');
  assert.equal(p.tasks.get('task_a')!.claimed_by, null);
  // And nothing moves it again.
  const out = applyEvent(p, ev('task_claimed', { task_id: 'task_a', agent_id: 'agent_2' }));
  assert.equal(out.ignored.length, 1);
  assert.equal(p.tasks.get('task_a')!.status, 'cancelled');
});
