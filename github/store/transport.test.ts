// Order 0020: "verify the error mapping through an injected transport."
//
// The status -> error mapping IS the contract with the retry policy, and getting
// one case wrong is worse than failing outright: a retried 401 loops forever, an
// un-retried 429 drops a write. These run against an injected transport, so they
// cost zero quota and cover cases that are impractical to provoke on demand --
// a 429 carrying Retry-After, a mid-flight transport drop.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  StoreAuthError, StoreBusyError, StoreError, StoreOfflineError, isRetryable,
  NotProvisionedError,
} from '../../shared/store/errors.ts';
import { classifyGitFatal, mapHttpStatus, parsePorcelain } from './transport.ts';
import type { HttpResponse } from './transport.ts';

function res(status: number, headers: Record<string, string> = {}, body = ''): HttpResponse {
  return { status, headers, body };
}

test('401 is StoreAuthError and is NOT retryable', () => {
  const e = mapHttpStatus(res(401), { operation: 'claimTask' });
  assert.ok(e instanceof StoreAuthError);
  assert.equal(isRetryable(e), false, 'retrying a revoked token burns quota and never succeeds');
});

test('403 with permission denied is StoreAuthError, not a wait', () => {
  const e = mapHttpStatus(res(403, { 'x-ratelimit-remaining': '4987' }), { operation: 'claimTask' });
  assert.ok(e instanceof StoreAuthError);
  assert.equal(isRetryable(e), false);
});

test('403 with an EXHAUSTED quota is StoreBusyError, because it is a wait', () => {
  // GitHub returns 403 for both a permission problem and a rate limit.
  // Collapsing them would either retry a permission error forever or drop a
  // write that only needed to wait. The headers decide -- structured fields.
  const e = mapHttpStatus(
    res(403, { 'x-ratelimit-remaining': '0', 'retry-after': '30' }),
    { operation: 'appendEvent' },
  );
  assert.ok(e instanceof StoreBusyError, 'an exhausted quota is retryable, not an auth failure');
  assert.equal(isRetryable(e), true);
  assert.equal((e as StoreBusyError).retry_after_ms, 30_000, 'Retry-After must be honoured');
});

test('429 is StoreBusyError and carries Retry-After', () => {
  const e = mapHttpStatus(res(429, { 'retry-after': '2' }), { operation: 'appendEvent' });
  assert.ok(e instanceof StoreBusyError);
  assert.equal((e as StoreBusyError).retry_after_ms, 2_000);
  assert.equal(isRetryable(e), true);
});

test('429 with no Retry-After is still busy, with no fabricated advice', () => {
  const e = mapHttpStatus(res(429), { operation: 'appendEvent' }) as StoreBusyError;
  assert.ok(e instanceof StoreBusyError);
  assert.equal(e.retry_after_ms, undefined, 'inventing a wait would be a guess presented as advice');
});

test('a past x-ratelimit-reset is treated as no advice, not as zero wait', () => {
  const past = Math.floor(Date.now() / 1000) - 60;
  const e = mapHttpStatus(
    res(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(past) }),
    { operation: 'appendEvent' },
  ) as StoreBusyError;
  assert.ok(e instanceof StoreBusyError);
  assert.equal(e.retry_after_ms, undefined, 'a zero wait would make the retry a tight loop');
});

test('5xx is StoreOfflineError, so the caller queues instead of discarding', () => {
  for (const s of [500, 502, 503, 504]) {
    const e = mapHttpStatus(res(s), { operation: 'appendEvent' });
    assert.ok(e instanceof StoreOfflineError, `${s} must be offline`);
    assert.equal(isRetryable(e), true);
  }
});

test('other 4xx is a named StoreError, never a catch-all', () => {
  const e = mapHttpStatus(res(422, {}, 'Unprocessable'), { operation: 'appendEvent' });
  assert.ok(e instanceof StoreError);
  assert.ok(!(e instanceof StoreAuthError));
  assert.ok(!(e instanceof StoreBusyError));
  assert.ok(!(e instanceof StoreOfflineError));
  assert.equal(isRetryable(e), false, 'an unnamed failure is not known to be safe to repeat');
  assert.equal(e.cause_code, '422');
});

test('NotProvisionedError is never retryable even though it extends StoreError', () => {
  const e = new NotProvisionedError('readSnapshot', 'a Stratus bucket');
  assert.equal(isRetryable(e), false, 'a provisioning gate does not clear because you asked twice');
  assert.match(e.message, /readSnapshot/);
  assert.match(e.message, /Stratus bucket/);
});

// ---- git rc=128 classification --------------------------------------------
//
// Probe I measured that rc=128 collapses auth, offline, DNS and missing-repo
// into ONE exit code -- classes that need opposite responses. Order 0017 forbids
// telling them apart from git's stderr, so the resolution goes through a
// structured channel and these tests pin each branch.

test('rc=128 with a transport failure is StoreOfflineError', async () => {
  const e = await classifyGitFatal(async () => 'transport-failure', 'claimTask', 'fatal: could not resolve host');
  assert.ok(e instanceof StoreOfflineError);
  assert.equal(isRetryable(e), true, 'offline means queue to the outbox and keep working');
});

test('rc=128 with a 401 from the probe is StoreAuthError', async () => {
  const e = await classifyGitFatal(async () => res(401), 'claimTask', 'fatal: Authentication failed');
  assert.ok(e instanceof StoreAuthError);
  assert.equal(isRetryable(e), false);
});

test('rc=128 with a 404 from the probe is a named StoreError, not offline', async () => {
  const e = await classifyGitFatal(async () => res(404), 'claimTask', 'remote: Repository not found');
  assert.ok(e instanceof StoreError);
  assert.ok(!(e instanceof StoreOfflineError), 'a missing repo does not fix itself by retrying');
  assert.equal(isRetryable(e), false);
});

test('rc=128 while the API is fine is offline, so the write is queued not lost', async () => {
  const e = await classifyGitFatal(async () => res(200), 'appendEvent', 'fatal: the remote end hung up');
  assert.ok(e instanceof StoreOfflineError);
  assert.equal(isRetryable(e), true);
});

test('a probe that THROWS is offline, not an unhandled crash', async () => {
  const e = await classifyGitFatal(async () => { throw new Error('socket'); }, 'claimTask', '');
  assert.ok(e instanceof StoreOfflineError);
});

// ---- porcelain parsing -----------------------------------------------------
//
// This is the parser that stands between the adapter and the defect probe L
// found: rc=0 does NOT mean "I won the claim".

test('porcelain distinguishes a real create from the no-op that rc cannot', () => {
  const win = parsePorcelain(
    'To https://github.com/o/r.git\n*\tabc:refs/claims/t1\t[new reference]\nDone\n',
  );
  assert.equal(win.length, 1);
  assert.equal(win[0]!.flag, '*');
  assert.equal(win[0]!.remote_ref, 'refs/claims/t1');

  const noop = parsePorcelain(
    'To https://github.com/o/r.git\n=\tabc:refs/claims/t1\t[up to date]\nDone\n',
  );
  assert.equal(noop[0]!.flag, '=', 'the no-op must be visible; both of these are rc=0');

  const lost = parsePorcelain(
    'To https://github.com/o/r.git\n!\tabc:refs/claims/t1\t[rejected] (stale info)\nDone\n',
  );
  assert.equal(lost[0]!.flag, '!');
});

test('porcelain reports every ref of an atomic push, including the rolled-back one', () => {
  // Measured shape from probe M: the ref that actually collided says
  // "(stale info)", the one rolled back says "(atomic push failed)".
  const refs = parsePorcelain(
    'To https://github.com/o/r.git\n'
    + '!\tabc:refs/agentic/p/dedupe/k1\t[rejected] (stale info)\n'
    + '!\tdef:refs/agentic/p/ev/0000000001\t[rejected] (atomic push failed)\n'
    + 'Done\n',
  );
  assert.equal(refs.length, 2);
  assert.ok(refs.every((r) => r.flag === '!'));
  // The adapter deliberately does NOT branch on those summaries -- it re-reads
  // the dedupe ref instead. This asserts only that both refs are reported, so a
  // future change cannot silently see one of them.
  assert.deepEqual(refs.map((r) => r.remote_ref).sort(), [
    'refs/agentic/p/dedupe/k1', 'refs/agentic/p/ev/0000000001',
  ]);
});

test('porcelain ignores the To/Done frame and a delete line', () => {
  const refs = parsePorcelain(
    'To https://github.com/o/r.git\n-\t:refs/claims/t1\t[deleted]\nDone\n',
  );
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.flag, '-');
  assert.equal(refs[0]!.remote_ref, 'refs/claims/t1');
});
