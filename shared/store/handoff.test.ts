// The shared half of a handoff: note rule, who may, where the card goes. Pure, no backend.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  cleanBranch, cleanHandoffNote, cleanSha, handoffEventBody, handoffFromEvent, latestHandoff,
  mayHandOff, statusAfterHandoff, withHandoff, HANDOFF_HISTORY_MAX,
} from './handoff.ts';
import type { Handoff } from './types.ts';

test('a note is required, and the refusal points at release', () => {
  assert.deepEqual(cleanHandoffNote('  GET done  '), { ok: true, note: 'GET done' });
  for (const empty of ['', '   ', undefined, null, 42]) {
    const r = cleanHandoffNote(empty);
    assert.equal(r.ok, false, String(empty));
    // The whole point of the refusal: a handoff with nothing to say IS a release.
    assert.match((r as { error: string }).error, /flotilla release/);
  }
});

test('only the claimant or an owner may hand off', () => {
  assert.deepEqual(mayHandOff('agent_a', 'agent_a', false), { ok: true });
  assert.deepEqual(mayHandOff('agent_a', 'agent_owner', true), { ok: true }, 'an owner rescues an absent teammate');
  const other = mayHandOff('agent_a', 'agent_b', false);
  assert.equal(other.ok, false);
  assert.equal((other as { owner: string }).owner, 'agent_a', 'the refusal names who holds it');
  // Nobody holds it: nothing to hand off, even for an owner.
  assert.deepEqual(mayHandOff(null, 'agent_owner', true).ok, false);
  assert.equal((mayHandOff(null, 'agent_a', false) as { owner: null }).owner, null);
});

test('in-flight cards reopen; shipped and terminal cards stay put', () => {
  for (const s of ['claimed', 'in_progress', 'blocked'] as const) assert.equal(statusAfterHandoff(s), 'open', s);
  for (const s of ['open', 'needs_review', 'pr_open', 'merged', 'done', 'cancelled'] as const) assert.equal(statusAfterHandoff(s), s, s);
});

test('branch and sha are kept only in their real shapes', () => {
  assert.equal(cleanBranch('agent/backend/items-api'), 'agent/backend/items-api');
  assert.equal(cleanBranch('main'), null, 'a handoff must never point the next claimant at main');
  assert.equal(cleanBranch(undefined), null);
  assert.equal(cleanSha('c'.repeat(40)), 'c'.repeat(40));
  assert.equal(cleanSha('abc'), null);
});

test('an event body round-trips, and a label falls back to the id', () => {
  const body = handoffEventBody('task_a', {
    from: { agent_id: 'agent_a', label: '' }, handed_off_by: 'agent_a', note: 'n',
    branch: null, head_sha: null,
  });
  const r = handoffFromEvent(body, '2026-09-30T00:00:00.000Z');
  assert.equal(r.ok, true);
  const h = (r as { handoff: Handoff }).handoff;
  assert.deepEqual(h.from, { agent_id: 'agent_a', label: 'agent_a' });
  assert.equal(h.at, '2026-09-30T00:00:00.000Z', 'at is the event clock, never the machine');
  assert.equal(handoffFromEvent({ ...body, note: '' }, 'x').ok, false);
});

test('history keeps the newest, drops the oldest, and counts what fell off', () => {
  const h = (n: number): Handoff => ({ from: { agent_id: 'a', label: 'a' }, handed_off_by: 'a', note: `n${n}`, branch: null, head_sha: null, at: `${n}` });
  let list: Handoff[] | undefined;
  let dropped = 0;
  for (let i = 0; i < HANDOFF_HISTORY_MAX + 3; i++) {
    const r = withHandoff(list, h(i));
    list = r.handoffs;
    dropped += r.dropped;
  }
  assert.equal(list!.length, HANDOFF_HISTORY_MAX);
  assert.equal(dropped, 3);
  assert.equal(latestHandoff({ handoffs: list })!.note, `n${HANDOFF_HISTORY_MAX + 2}`);
  assert.equal(latestHandoff({}), null);
  assert.equal(latestHandoff(null), null);
});
