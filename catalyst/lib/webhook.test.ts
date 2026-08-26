// Section D of the acceptance checklist, minus the pieces that need a deployed
// function. D1, D2, D3, D5 and D6 are all testable here; D4 (replay appends
// nothing) is asserted at the handler level once the ledger is reachable, and
// the key it depends on is asserted here.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  branchFromRef, deliveryIdempotencyKey, mapGithubEvent, signGithubBody,
  taskIdFromBranch, verifyGithubSignature,
} from './webhook.ts';

const SECRET = 'a-webhook-secret-that-is-not-in-git';

/**
 * A raw body written by hand, NOT by JSON.stringify -- because the whole point is
 * that GitHub's bytes are not our re-serialisation of them. This one carries the
 * three things that shift on a round trip: insignificant whitespace, a trailing
 * zero in a number, and a \\u escape.
 */
const RAW_JSON = [
  '{"zzz_last_key": 1,',
  ' "ref": "refs/heads/agent/backend/task_items_api",',
  ' "after": "a3f9c1e0d4b28f6712c9ab3e5580f1d2c7e46a9b",',
  ' "repository": {"full_name": "acme/inventory"},',
  ' "sender": {"login": "b\\u00e9a"},',
  ' "aaa_first_key": 2.50}',
].join('');
const RAW_BODY = Buffer.from(RAW_JSON, 'utf8');

describe('D1/D2/D3 signature verification', () => {
  test('D1 a valid HMAC over the raw body verifies', () => {
    const sig = signGithubBody(RAW_BODY, SECRET);
    assert.deepEqual(verifyGithubSignature(RAW_BODY, sig, SECRET), { ok: true });
  });

  test('D2 a tampered body is rejected', () => {
    const sig = signGithubBody(RAW_BODY, SECRET);
    const tampered = Buffer.from(RAW_BODY.toString('utf8').replace('acme/inventory', 'evil/repo'));
    assert.deepEqual(verifyGithubSignature(tampered, sig, SECRET), { ok: false, reason: 'mismatch' });
  });

  test('D2 a single flipped byte is rejected', () => {
    const sig = signGithubBody(RAW_BODY, SECRET);
    const tampered = Buffer.from(RAW_BODY);
    tampered[10] ^= 0x01;
    assert.equal(verifyGithubSignature(tampered, sig, SECRET).ok, false);
  });

  test('D2 the wrong secret is rejected', () => {
    const sig = signGithubBody(RAW_BODY, 'some-other-secret');
    assert.deepEqual(verifyGithubSignature(RAW_BODY, sig, SECRET), { ok: false, reason: 'mismatch' });
  });

  test('D3 the comparison is timing-safe, not ===', () => {
    // Code review is the primary evidence for D3, so make it mechanical: the
    // module must use timingSafeEqual and must not compare digests with ===.
    const src = readFileSync(new URL('./webhook.ts', import.meta.url), 'utf8');
    assert.match(src, /timingSafeEqual/, 'must use crypto.timingSafeEqual');
    assert.doesNotMatch(src, /provided\s*===\s*expected/, 'digests must never be compared with ===');
    assert.doesNotMatch(src, /expected\s*===\s*provided/);
  });

  test('D3 a signature sharing a long prefix is still rejected', () => {
    // The attack === enables: forge one byte at a time by timing the compare.
    const good = signGithubBody(RAW_BODY, SECRET).slice('sha256='.length);
    const nearly = `sha256=${good.slice(0, 60)}${good.slice(60) === '0000' ? '1111' : '0000'}`;
    assert.equal(verifyGithubSignature(RAW_BODY, nearly, SECRET).ok, false);
  });

  test('a missing header is rejected without throwing', () => {
    assert.deepEqual(verifyGithubSignature(RAW_BODY, undefined, SECRET), { ok: false, reason: 'missing' });
    assert.deepEqual(verifyGithubSignature(RAW_BODY, null, SECRET), { ok: false, reason: 'missing' });
  });

  test('a malformed header is rejected without throwing', () => {
    // timingSafeEqual throws on a length mismatch; none of these may reach it.
    for (const header of ['', 'sha1=abc', 'sha256=', 'sha256=zzzz', 'sha256=ab', `sha256=${'a'.repeat(63)}`, `sha256=${'a'.repeat(65)}`]) {
      const out = verifyGithubSignature(RAW_BODY, header, SECRET);
      assert.equal(out.ok, false, `expected rejection for ${JSON.stringify(header)}`);
    }
  });

  test('an empty secret is rejected rather than verifying everything', () => {
    const sig = signGithubBody(RAW_BODY, '');
    assert.deepEqual(verifyGithubSignature(RAW_BODY, sig, ''), { ok: false, reason: 'missing' });
  });

  test('THE RAW BODY MATTERS: a re-serialised body does not verify', () => {
    // The failure this whole design avoids. JSON.parse -> JSON.stringify changes
    // the bytes (2.50 becomes 2.5 here), so signing the round-tripped form and
    // verifying the original -- or vice versa -- silently stops matching.
    const roundTripped = Buffer.from(JSON.stringify(JSON.parse(RAW_BODY.toString('utf8'))), 'utf8');
    assert.notEqual(roundTripped.toString('utf8'), RAW_BODY.toString('utf8'),
      'test premise: the round trip must actually change the bytes');
    const sig = signGithubBody(RAW_BODY, SECRET);
    assert.equal(verifyGithubSignature(roundTripped, sig, SECRET).ok, false);
  });

  test('the digest matches an independently computed HMAC', () => {
    const expected = `sha256=${createHmac('sha256', SECRET).update(RAW_BODY).digest('hex')}`;
    assert.equal(signGithubBody(RAW_BODY, SECRET), expected);
  });
});

describe('branch and task resolution', () => {
  test('the task id is the last segment of <branch_prefix>/<task_id>', () => {
    assert.equal(taskIdFromBranch('agent/backend/task_items_api'), 'task_items_api');
    assert.equal(taskIdFromBranch('agent/frontend/task_board_ui'), 'task_board_ui');
    assert.equal(taskIdFromBranch('task_solo'), 'task_solo');
  });

  test('a branch that encodes no task returns null, which is normal traffic', () => {
    assert.equal(taskIdFromBranch('main'), null);
    assert.equal(taskIdFromBranch('agent/backend/hotfix'), null);
    assert.equal(taskIdFromBranch(''), null);
    assert.equal(taskIdFromBranch(null), null);
    assert.equal(taskIdFromBranch('TASK_UPPER'), null, 'ids are lowercase; the unique constraint is case-sensitive');
  });

  test('a ref becomes a branch', () => {
    assert.equal(branchFromRef('refs/heads/agent/backend/task_items_api'), 'agent/backend/task_items_api');
    assert.equal(branchFromRef('refs/tags/v1'), null);
    assert.equal(branchFromRef(null), null);
  });
});

describe('D5 event mapping', () => {
  const repo = { full_name: 'acme/inventory' };
  const sender = { login: 'bea' };

  test('push -> branch_pushed', () => {
    const out = mapGithubEvent({
      event: 'push',
      payload: { ref: 'refs/heads/agent/backend/task_items_api', after: 'abc123', repository: repo, sender },
    });
    assert.ok(out.ok);
    assert.equal(out.event.kind, 'branch_pushed');
    assert.equal(out.event.layer, 'coordination');
    assert.equal(out.event.actor_type, 'github');
    assert.equal(out.task_id, 'task_items_api');
    assert.deepEqual(out.event.body, {
      task_id: 'task_items_api', branch: 'agent/backend/task_items_api', commit: 'abc123',
    });
  });

  test('pull_request opened -> pr_opened', () => {
    const out = mapGithubEvent({
      event: 'pull_request',
      payload: {
        action: 'opened', repository: repo, sender,
        pull_request: { number: 7, html_url: 'https://github.com/acme/inventory/pull/7', head: { ref: 'agent/backend/task_items_api' } },
      },
    });
    assert.ok(out.ok);
    assert.equal(out.event.kind, 'pr_opened');
    assert.equal(out.event.body.pr_number, 7);
    assert.equal(out.event.body.pr_url, 'https://github.com/acme/inventory/pull/7');
  });

  test('pull_request synchronize -> branch_pushed', () => {
    const out = mapGithubEvent({
      event: 'pull_request',
      payload: {
        action: 'synchronize', repository: repo, sender,
        pull_request: { number: 7, head: { ref: 'agent/backend/task_items_api', sha: 'def456' } },
      },
    });
    assert.ok(out.ok);
    assert.equal(out.event.kind, 'branch_pushed');
    assert.equal(out.event.body.commit, 'def456');
  });

  test('pull_request closed with merged:true -> merged', () => {
    const out = mapGithubEvent({
      event: 'pull_request',
      payload: {
        action: 'closed', repository: repo, sender,
        pull_request: { number: 7, merged: true, merge_commit_sha: 'aaa111', head: { ref: 'agent/backend/task_items_api' } },
      },
    });
    assert.ok(out.ok);
    assert.equal(out.event.kind, 'merged');
    assert.equal(out.event.body.commit, 'aaa111');
  });

  test('check_suite completed -> ci_passed / ci_failed', () => {
    const base = {
      action: 'completed', repository: repo, sender,
      check_suite: { head_branch: 'agent/backend/task_items_api', pull_requests: [{ number: 7 }], app: { name: 'GitHub Actions' }, url: 'https://api.github.com/x' },
    };
    const passed = mapGithubEvent({ event: 'check_suite', payload: { ...base, check_suite: { ...base.check_suite, conclusion: 'success' } } });
    assert.ok(passed.ok);
    assert.equal(passed.event.kind, 'ci_passed');
    assert.equal(passed.event.body.pr_number, 7);
    assert.equal(passed.event.body.check_name, 'GitHub Actions');

    const failed = mapGithubEvent({ event: 'check_suite', payload: { ...base, check_suite: { ...base.check_suite, conclusion: 'failure' } } });
    assert.ok(failed.ok);
    assert.equal(failed.event.kind, 'ci_failed');
  });

  test('every mapped event is coordination-layer, never human-layer', () => {
    // A human-layer event delivered to an agent is a protocol violation.
    const deliveries = [
      { event: 'push', payload: { ref: 'refs/heads/task_a', after: 'x', repository: repo, sender } },
      { event: 'pull_request', payload: { action: 'opened', repository: repo, sender, pull_request: { number: 1, head: { ref: 'task_a' } } } },
    ];
    for (const d of deliveries) {
      const out = mapGithubEvent(d);
      assert.ok(out.ok);
      assert.equal(out.event.layer, 'coordination');
    }
  });
});

describe('D6 unmappable deliveries are dropped, never thrown', () => {
  const sender = { login: 'bea' };

  test('a payload with no repository is reported, not thrown', () => {
    const out = mapGithubEvent({ event: 'push', payload: { ref: 'refs/heads/task_a' } });
    assert.equal(out.ok, false);
    assert.match(String(!out.ok && out.reason), /repository/);
  });

  test('a branch encoding no task is reported, not thrown', () => {
    const out = mapGithubEvent({
      event: 'push',
      payload: { ref: 'refs/heads/main', after: 'x', repository: { full_name: 'acme/inventory' }, sender },
    });
    assert.equal(out.ok, false);
    assert.match(String(!out.ok && out.reason), /does not encode a task/);
    assert.equal(!out.ok && out.repo, 'acme/inventory');
  });

  test('an event kind we do not map is reported, not thrown', () => {
    for (const event of ['issues', 'star', 'workflow_job', 'ping']) {
      const out = mapGithubEvent({ event, payload: { repository: { full_name: 'acme/inventory' }, sender } });
      assert.equal(out.ok, false, `${event} should be unmapped`);
    }
  });

  test('a PR closed without merging is dropped, not mapped to merged', () => {
    const out = mapGithubEvent({
      event: 'pull_request',
      payload: {
        action: 'closed', repository: { full_name: 'acme/inventory' }, sender,
        pull_request: { number: 7, merged: false, head: { ref: 'agent/backend/task_items_api' } },
      },
    });
    assert.equal(out.ok, false, 'an abandoned PR must never read as merged');
  });

  test('an inconclusive check_suite is dropped rather than shown as failed', () => {
    for (const conclusion of ['neutral', 'cancelled', 'skipped', 'stale', 'timed_out', null]) {
      const out = mapGithubEvent({
        event: 'check_suite',
        payload: {
          action: 'completed', repository: { full_name: 'acme/inventory' }, sender,
          check_suite: { head_branch: 'agent/backend/task_items_api', conclusion },
        },
      });
      assert.equal(out.ok, false, `${String(conclusion)} must not show a CI verdict`);
    }
  });

  test('a hostile payload does not throw', () => {
    // Anything reaching this function is attacker-influenced. A throw is a 500,
    // and a 500 teaches GitHub to retry and eventually disable the hook.
    const hostile: unknown[] = [
      { event: 'push', payload: {} },
      { event: 'push', payload: { repository: 'not-an-object' } },
      { event: 'pull_request', payload: { action: 'opened', repository: { full_name: 'a/b' }, pull_request: null } },
      { event: '', payload: { repository: { full_name: 'a/b' } } },
      { event: 'check_suite', payload: { action: 'completed', repository: { full_name: 'a/b' }, check_suite: null } },
    ];
    for (const d of hostile) {
      assert.doesNotThrow(() => mapGithubEvent(d as { event: string; payload: Record<string, unknown> }));
    }
  });
});

describe('D4 replay key', () => {
  test('the idempotency key is derived from the delivery id, which GitHub reuses on retry', () => {
    assert.equal(deliveryIdempotencyKey('72d3162e-cc78-11e3-81ab-4c9367dc0958'),
      'gh_72d3162e-cc78-11e3-81ab-4c9367dc0958');
    // No colon: this becomes one PART of the composite dedupe key, and a colon
    // inside a part is exactly what compositeKey() rejects.
    assert.equal(deliveryIdempotencyKey('abc').includes(':'), false);
    // Same delivery -> same key -> the append is absorbed as a duplicate.
    assert.equal(deliveryIdempotencyKey('abc'), deliveryIdempotencyKey('abc'));
    assert.notEqual(deliveryIdempotencyKey('abc'), deliveryIdempotencyKey('abd'));
  });
});
