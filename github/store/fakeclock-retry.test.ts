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

/** A git runner whose push wedges the first `n` times, as a stuck send-pack does. */
function wedgingGit(n: number): { git: GitRunner; pushes: () => number } {
  let pushes = 0;
  const git: GitRunner = {
    async run() { return { code: 0, stdout: '', stderr: '' }; },
    async catFileBatch() { return new Map<string, string>(); },
    async push(args) {
      pushes += 1;
      if (pushes <= n) {
        // What createGitRunner now returns when it kills a child on deadline.
        return { code: 128, refs: [], stderr: 'git exceeded 45000 ms', timed_out: true };
      }
      const ref = (args.find((a) => a.includes(':refs/')) ?? ':refs/x').split(':')[1]!;
      return {
        code: 0,
        refs: [{ flag: '*' as const, spec: 'abc:' + ref, remote_ref: ref, summary: '[new reference]' }],
        stderr: '',
      };
    },
  };
  return { git, pushes: () => pushes };
}

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

test('a WEDGED git push is retried, not fatal, and is counted', async () => {
  // git has no default timeout. A stuck send-pack waited forever and took the
  // caller with it -- measured on the fifth append of an A5 run while
  // github.com was reachable from the same machine in the same minute. The
  // runner now kills the child at its deadline; this asserts the adapter treats
  // that as the transient it is.
  const { git, pushes } = wedgingGit(1);
  const store = createGithubStore({
    repo: 'o/r', git,
    http: async () => ({ status: 200, headers: {}, body: '[]' }),
    token: 't', clock: new FakeClock(), log: new CapturingLogger(),
  });

  const result = await within(store.claimTask('proj_x', 'task_a', 'agent_a'), 8_000);

  assert.notEqual(result, 'timeout', 'a wedged push must not hang the caller');
  assert.deepEqual(result, { ok: true }, 'and the retry must actually succeed');
  assert.ok(pushes() >= 2, 'it must have retried the push');
  assert.equal(store.stats.git_timeouts, 1,
    'and counted the timeout, so a G-figure cannot hide a run that only '
    + 'completed because a wedged push was retried');
});

test('a push that wedges every time FAILS loudly rather than hanging', async () => {
  // The other half. Retrying forever would turn a broken remote into the same
  // silent stall the deadline exists to prevent.
  const { git } = wedgingGit(99);
  const store = createGithubStore({
    repo: 'o/r', git,
    http: async () => ({ status: 200, headers: {}, body: '[]' }),
    token: 't', clock: new FakeClock(), log: new CapturingLogger(),
  });

  const result = await within(
    store.claimTask('proj_x', 'task_a', 'agent_a').then(
      () => 'resolved' as const,
      (e: Error) => e.name,
    ),
    15_000,
  );
  assert.notEqual(result, 'timeout', 'exhausting retries must not hang either');
  assert.equal(result, 'StoreOfflineError',
    'and it must surface as the retryable-but-exhausted error the caller queues on');
});
