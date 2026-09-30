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

// ---- task_handed_off ----------------------------------------------------------------------

import { HANDOFF_HISTORY_MAX, handoffEventBody } from '../shared/store/handoff.ts';

const handedOff = (task_id: string, note: string, extra: Record<string, unknown> = {}) =>
  ev('task_handed_off', {
    ...handoffEventBody(task_id, {
      from: { agent_id: 'agent_1', label: 'Bea' }, handed_off_by: 'agent_1', note,
      branch: 'agent/backend/a', head_sha: 'b'.repeat(40),
    }),
    ...extra,
  });

test('a handoff releases the card to open and keeps the note, branch and sha', () => {
  const p = projectionWith('task_a');
  applyEvent(p, ev('task_claimed', { task_id: 'task_a', agent_id: 'agent_1' }));
  // Control: held before the handoff.
  assert.equal(p.tasks.get('task_a')!.claimed_by, 'agent_1');

  const out = applyEvent(p, handedOff('task_a', 'GET done, POST next'));
  assert.deepEqual(out.ignored, []);
  const t = p.tasks.get('task_a')!;
  assert.equal(t.status, 'open');
  assert.equal(t.claimed_by, null);
  assert.equal(t.branch, 'agent/backend/a', 'the handed-off branch is where the work is');
  assert.equal(t.handoffs?.length, 1);
  assert.equal(t.handoffs![0]!.note, 'GET done, POST next');
  assert.equal(t.handoffs![0]!.head_sha, 'b'.repeat(40));
  // And it can be claimed again without an illegal transition.
  assert.deepEqual(applyEvent(p, ev('task_claimed', { task_id: 'task_a', agent_id: 'agent_2' })).ignored, []);
});

test('handing off a shipped card leaves its column and still records the note', () => {
  const p = projectionWith('task_a');
  applyEvent(p, ev('task_claimed', { task_id: 'task_a', agent_id: 'agent_1' }));
  applyEvent(p, ev('task_completed', { task_id: 'task_a' }));
  assert.equal(p.tasks.get('task_a')!.status, 'needs_review');
  const out = applyEvent(p, handedOff('task_a', 'review comments to address'));
  assert.deepEqual(out.ignored, [], 'not an illegal transition: the status is deliberately left alone');
  assert.equal(p.tasks.get('task_a')!.status, 'needs_review');
  assert.equal(p.tasks.get('task_a')!.handoffs?.at(-1)?.note, 'review comments to address');
});

test('a handoff with no note or no sender changes nothing and says why', () => {
  const p = projectionWith('task_a');
  applyEvent(p, ev('task_claimed', { task_id: 'task_a', agent_id: 'agent_1' }));
  const noNote = applyEvent(p, handedOff('task_a', 'x', { note: '  ' }));
  assert.equal(noNote.ignored.length, 1);
  const noFrom = applyEvent(p, handedOff('task_a', 'x', { from_agent_id: '' }));
  assert.equal(noFrom.ignored.length, 1);
  assert.equal(p.tasks.get('task_a')!.claimed_by, 'agent_1', 'an unusable handoff released nothing');
  assert.equal(p.tasks.get('task_a')!.handoffs, undefined);
});

test('handoff history is capped, oldest dropped, and the drop is reported', () => {
  const p = projectionWith('task_a');
  let reported = 0;
  for (let i = 0; i < HANDOFF_HISTORY_MAX + 1; i++) {
    applyEvent(p, ev('task_claimed', { task_id: 'task_a', agent_id: 'agent_1' }));
    reported += applyEvent(p, handedOff('task_a', `n${i}`)).ignored.length;
  }
  const notes = p.tasks.get('task_a')!.handoffs!.map((h) => h.note);
  assert.equal(notes.length, HANDOFF_HISTORY_MAX);
  assert.equal(notes[0], 'n1');
  assert.equal(notes.at(-1), `n${HANDOFF_HISTORY_MAX}`);
  assert.equal(reported, 1, 'exactly the one overflowing handoff is reported');
});
