// Section D, offline. Every row is a pure function over a payload, so all of it
// costs zero quota and needs no hosted endpoint.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { CapturingLogger } from '../../shared/log.ts';
import {
  CHECK_SUITE_CONCLUSIONS, deliveryIdempotencyKey, mapCheckConclusion, mapDelivery,
  taskFromBranch, verifySignature,
} from './map.ts';

const SECRET = 's3cret';
const REPO = 'Sibhimanyu/inventory-tracker-github';

function sign(body: string): string {
  return `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
}

function ctx(log = new CapturingLogger()) {
  return {
    resolveProject: (r: string) => (r === REPO ? 'proj_inventory' : null),
    resolveTask: taskFromBranch,
    log,
  };
}

// ---- D1, D2, D3 ------------------------------------------------------------

test('D1 a valid HMAC over the raw body verifies', () => {
  const body = JSON.stringify({ hello: 'world' });
  assert.deepEqual(verifySignature(body, sign(body), SECRET), { ok: true });
  // Over the RAW bytes, not a re-serialisation: a body that round-trips through
  // JSON.parse/stringify can change whitespace and key order, and the signature
  // is over what arrived.
  const raw = Buffer.from(body, 'utf8');
  assert.deepEqual(verifySignature(raw, sign(body), SECRET), { ok: true });
});

test('D2 a tampered body is rejected', () => {
  const body = JSON.stringify({ hello: 'world' });
  const sig = sign(body);
  assert.deepEqual(verifySignature(`${body} `, sig, SECRET), { ok: false, reason: 'mismatch' });
  assert.deepEqual(
    verifySignature(JSON.stringify({ hello: 'worlds' }), sig, SECRET),
    { ok: false, reason: 'mismatch' },
  );
  assert.deepEqual(verifySignature(body, sign(body), 'wrong-secret').ok, false);
});

test('D3 a short or malformed signature REJECTS rather than throwing', () => {
  // crypto.timingSafeEqual throws on a length mismatch, so `sha256=ab` would
  // turn the verifier into a 500 instead of a rejection. Order 0006 caught this
  // on another route; the shape check is what prevents it here.
  const body = 'x';
  for (const bad of [
    'sha256=ab',
    'sha256=',
    'sha1=' + 'a'.repeat(40),
    'a'.repeat(64),
    `sha256=${'A'.repeat(64)}`,   // uppercase hex is not the format GitHub sends
    `sha256=${'a'.repeat(63)}`,
    `sha256=${'a'.repeat(65)}`,
    `sha256=${'z'.repeat(64)}`,
  ]) {
    const r = verifySignature(body, bad, SECRET);
    assert.equal(r.ok, false, `${bad} must reject`);
    assert.equal(r.ok === false && r.reason, 'malformed', `${bad} must be malformed, not a throw`);
  }
  assert.deepEqual(verifySignature(body, undefined, SECRET), { ok: false, reason: 'missing' });
  assert.deepEqual(verifySignature(body, '', SECRET), { ok: false, reason: 'missing' });
});

// ---- D4 --------------------------------------------------------------------

test('D4 a replayed delivery id produces the same idempotency key', () => {
  assert.equal(deliveryIdempotencyKey('abc-123'), 'gh_abc-123');
  assert.equal(deliveryIdempotencyKey('abc-123'), deliveryIdempotencyKey('abc-123'));
  assert.notEqual(deliveryIdempotencyKey('abc-123'), deliveryIdempotencyKey('abc-124'));
  // Underscore, not colon. Order 0008: a separator inside a composite part is
  // what a composite-key builder must reject, and the wire key is identical
  // across all three routes so a replay dedupes the same way everywhere.
  assert.ok(!deliveryIdempotencyKey('abc-123').includes(':'));
});

// ---- D5 --------------------------------------------------------------------

test('D5 push maps to branch_pushed', () => {
  const m = mapDelivery('push', {
    repository: { full_name: REPO },
    ref: 'refs/heads/agent/backend/items_api',
    after: 'c'.repeat(40),
  }, 'd1', ctx());
  assert.ok(m);
  assert.equal(m.event.kind, 'branch_pushed');
  assert.equal(m.event.actor_type, 'github');
  assert.equal(m.event.body.task_id, 'task_items_api');
  assert.equal(m.event.body.branch, 'agent/backend/items_api');
});

test('D5 a branch DELETE is not a branch_pushed', () => {
  const m = mapDelivery('push', {
    repository: { full_name: REPO },
    ref: 'refs/heads/agent/backend/items_api',
    after: '0'.repeat(40),
  }, 'd2', ctx());
  assert.equal(m, null, 'a deletion arrives as a push with an all-zero after');
});

test('D5 pull_request opened and synchronize map to pr_opened', () => {
  for (const action of ['opened', 'synchronize', 'reopened']) {
    const m = mapDelivery('pull_request', {
      repository: { full_name: REPO },
      action,
      pull_request: {
        number: 7, html_url: 'https://github.com/o/r/pull/7',
        head: { ref: 'agent/backend/items_api' },
      },
    }, `d3-${action}`, ctx());
    assert.ok(m, `${action} must map`);
    assert.equal(m.event.kind, 'pr_opened');
    assert.equal(m.event.body.pr_number, 7);
  }
});

test('D5 check_suite completed maps by conclusion', () => {
  const m = mapDelivery('check_suite', {
    repository: { full_name: REPO },
    action: 'completed',
    check_suite: {
      conclusion: 'success', head_branch: 'agent/backend/items_api',
      pull_requests: [{ number: 7, head: { ref: 'agent/backend/items_api' } }],
      app: { name: 'CI' },
    },
  }, 'd4', ctx());
  assert.ok(m);
  assert.equal(m.event.kind, 'ci_passed');
  assert.equal(m.event.body.check_name, 'CI');
});

test('D5 a check_suite that is not completed does not map', () => {
  const m = mapDelivery('check_suite', {
    repository: { full_name: REPO }, action: 'requested',
    check_suite: { conclusion: null, head_branch: 'agent/backend/items_api' },
  }, 'd5', ctx());
  assert.equal(m, null);
});

// ---- D5a -------------------------------------------------------------------

test('D5a the conclusion table is EXACTLY the normative one', () => {
  assert.deepEqual(mapCheckConclusion('success'), 'ci_passed');
  assert.deepEqual(mapCheckConclusion('failure'), 'ci_failed');
  // The ruling: a timeout is a CONCLUSIVE terminal failure, not an inconclusive
  // one. To an agent, silence reads as "not finished yet", so dropping this
  // would not merely lose information -- it would install the wrong belief.
  assert.deepEqual(mapCheckConclusion('timed_out'), 'ci_failed');
  for (const drop of ['neutral', 'cancelled', 'skipped', 'stale', 'action_required']) {
    assert.equal(mapCheckConclusion(drop), null, `${drop} must drop`);
  }
  assert.equal(mapCheckConclusion(null), null);
  assert.equal(mapCheckConclusion(undefined), null);
  // Nine documented values, and no more: an extra key here would be a mapping
  // this project never ruled on.
  assert.deepEqual(Object.keys(CHECK_SUITE_CONCLUSIONS).sort(), [
    'action_required', 'cancelled', 'failure', 'neutral', 'skipped', 'stale',
    'success', 'timed_out',
  ]);
});

test('D5a-unknown a conclusion GitHub has not invented yet DROPS', () => {
  // A permissive default is invisible until it misfires, and testing the nine
  // values that exist today cannot catch it.
  for (const synthetic of ['flaky_retry', 'quantum_superposition', 'partially_succeeded', '']) {
    assert.equal(mapCheckConclusion(synthetic), null,
      `an unknown conclusion must drop, not default into a red badge`);
  }
  // And it must not be reachable through the prototype chain either.
  assert.equal(mapCheckConclusion('toString'), null);
  assert.equal(mapCheckConclusion('constructor'), null);
});

// ---- D5b -------------------------------------------------------------------

test('D5b pull_request closed maps to merged ONLY on strict merged === true', () => {
  const mk = (merged: unknown) => mapDelivery('pull_request', {
    repository: { full_name: REPO },
    action: 'closed',
    pull_request: {
      number: 7, merged, merge_commit_sha: 'd'.repeat(40),
      head: { ref: 'agent/backend/items_api' },
    },
  }, `d6-${String(merged)}`, ctx());

  const yes = mk(true);
  assert.ok(yes);
  assert.equal(yes.event.kind, 'merged');

  assert.equal(mk(false), null, 'false is a close, not a merge');
  assert.equal(mk(undefined), null, 'absent is a close, not a merge');
  assert.equal(mk(null), null, 'null is a close, not a merge');
  // The fifth assertion, and the one that matters: `"true"` is the shape a JSON
  // quirk actually takes, and on a store where booleans round-trip as strings
  // even `"false"` is truthy in JS.
  assert.equal(mk('true'), null, 'the STRING "true" must not satisfy merged === true');
  assert.equal(mk('false'), null);
  assert.equal(mk(1), null);
});

// ---- D6 --------------------------------------------------------------------

test('D6 an unmappable repo is logged and dropped, never thrown', () => {
  const log = new CapturingLogger();
  const m = mapDelivery('push', {
    repository: { full_name: 'someone-else/their-repo' },
    ref: 'refs/heads/agent/backend/items_api',
    after: 'e'.repeat(40),
  }, 'd7', ctx(log));
  assert.equal(m, null);
  assert.equal(log.withCode('webhook.unknownRepo').length, 1,
    'dropping is right; dropping silently is not');
});

test('D6 a payload with no repository at all is dropped, not thrown', () => {
  const log = new CapturingLogger();
  assert.equal(mapDelivery('push', {}, 'd8', ctx(log)), null);
  assert.equal(mapDelivery('push', null, 'd9', ctx(log)), null);
  assert.equal(mapDelivery('push', { repository: {} }, 'd10', ctx(log)), null);
  assert.equal(log.withCode('webhook.dropped').length, 3);
});

test('D6 an unknown event type is ignored without error', () => {
  const log = new CapturingLogger();
  const m = mapDelivery('discussion_comment', {
    repository: { full_name: REPO },
  }, 'd11', ctx(log));
  assert.equal(m, null);
  assert.equal(log.withCode('webhook.ignored').length, 1);
});

// ---- branch -> task --------------------------------------------------------

test('a branch outside the agent prefix has no task, so its events drop', () => {
  assert.equal(taskFromBranch('agent/backend/items_api'), 'task_items_api');
  assert.equal(taskFromBranch('agent/frontend/items-ui'), 'task_items-ui');
  assert.equal(taskFromBranch('main'), null);
  assert.equal(taskFromBranch('feature/whatever'), null);
  assert.equal(taskFromBranch('agent/backend/'), null);
  // A human's branch must not silently move an agent's task.
  const m = mapDelivery('push', {
    repository: { full_name: REPO }, ref: 'refs/heads/main', after: 'f'.repeat(40),
  }, 'd12', ctx());
  assert.equal(m, null);
});
