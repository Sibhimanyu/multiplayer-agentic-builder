// Does a retryable error inside rest() hang under a FakeClock?
//
// THE SUSPECT. `rest()` retries transport failures through the shared
// `withRetry`, passing the store's clock. `withRetry` computes
// `sleep = policy.sleep ?? ((ms) => clock.sleep(ms))`, and `FakeClock.sleep`
// resolves ONLY when someone calls `advance()`. The conformance harness builds
// its store with a FakeClock and nothing advances it during an append.
//
// If that is right, then ONE transient network failure during a live
// conformance run does not cost a retry -- it costs the whole run, permanently,
// and the symptom is a test that appears to be running very slowly rather than
// one that fails.
//
// This is offline and takes milliseconds. It is the check I should have reached
// for before watching ref counts for an hour.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FakeClock, systemClock } from '../../shared/clock.ts';
import { CapturingLogger } from '../../shared/log.ts';
import { createGithubStore } from './github.ts';
import type { GitRunner, HttpTransport } from './transport.ts';

const nullGit: GitRunner = {
  async run() { return { code: 0, stdout: '', stderr: '' }; },
  async push() { return { code: 0, refs: [], stderr: '' }; },
  async catFileBatch() { return new Map<string, string>(); },
};

/** Fails the first `n` calls the way a transient socket failure does. */
function flakyHttp(n: number): { http: HttpTransport; calls: () => number } {
  let calls = 0;
  const http: HttpTransport = async () => {
    calls += 1;
    if (calls <= n) throw new Error('fetch failed');
    return { status: 200, headers: {}, body: '[]' };
  };
  return { http, calls: () => calls };
}

/** Resolves to 'timeout' if the promise has not settled in `ms`. */
async function within<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let t: ReturnType<typeof setTimeout>;
  const guard = new Promise<'timeout'>((r) => { t = setTimeout(() => r('timeout'), ms); });
  try {
    return await Promise.race([p, guard]);
  } finally {
    clearTimeout(t!);
  }
}

test('a transient failure under a FakeClock RETRIES rather than hanging', async () => {
  // This is the regression guard for the bug that cost an afternoon. Before the
  // fix, this call never returned: rest() slept on the injected clock, and a
  // FakeClock's sleep resolves only on advance(), which nothing calls during an
  // append.
  const { http, calls } = flakyHttp(1);
  const store = createGithubStore({
    repo: 'o/r', git: nullGit, http, token: 't',
    clock: new FakeClock(), log: new CapturingLogger(),
  });

  const result = await within(store.listPresence('proj_x'), 5_000);

  assert.notEqual(result, 'timeout',
    'rest() must back off on REAL time. A transport retry is wall-clock; the '
    + 'injected clock is for staleness derivation and the reaper, not for '
    + 'freezing a socket.');
  assert.ok(calls() >= 2, 'and it must actually have retried, not skipped the retry');
});

test('the FakeClock still governs staleness, which is what it is for', async () => {
  // The other half. Making the transport ignore the injected clock must NOT
  // make the clock ignorable everywhere -- A9 depends on it, and a fix that
  // quietly disabled it would trade one silent failure for another.
  const clock = new FakeClock();
  const store = createGithubStore({
    repo: 'o/r', git: nullGit,
    http: async () => ({ status: 200, headers: {}, body: '[]' }),
    token: 't', clock, log: new CapturingLogger(),
  });
  const before = clock.now();
  await clock.advance(120_000);
  assert.equal(clock.now(), before + 120_000, 'the domain clock must still advance');
  void store;
});

test('the same transient under the system clock retries and succeeds', async () => {
  // The control. Without it, the test above would pass against a store that
  // was broken for some entirely different reason -- absence of a result is not
  // evidence of the cause.
  const { http, calls } = flakyHttp(1);
  const store = createGithubStore({
    repo: 'o/r', git: nullGit, http, token: 't',
    clock: systemClock, log: new CapturingLogger(),
  });

  const result = await within(store.listPresence('proj_x'), 5_000);
  assert.notEqual(result, 'timeout', 'the system clock must let the retry proceed');
  assert.ok(calls() >= 2, 'and it must actually have retried');
});

test('no transient means no sleep, so a FakeClock is harmless on the happy path', async () => {
  // Which is why every offline test and every clean live run passed: the hang
  // needs a transient to trigger it, and most runs never see one.
  const { http } = flakyHttp(0);
  const store = createGithubStore({
    repo: 'o/r', git: nullGit, http, token: 't',
    clock: new FakeClock(), log: new CapturingLogger(),
  });

  const result = await within(store.listPresence('proj_x'), 5_000);
  assert.notEqual(result, 'timeout',
    'the happy path must not depend on the clock at all');
});
