// Entry 18, tested adversarially instead of argued.
//
// Order 0018 calls Catalyst's scope-lock race the largest asymmetry in the
// register, and is careful about why: entry 2 cost a naming convention, but
// entry 18 costs a RESIDUAL CORRECTNESS WINDOW that can be narrowed and not
// closed, because the primitive needed to close it does not exist there. Two
// agents with OVERLAPPING BUT NON-IDENTICAL globs both pass the pre-check;
// `is_unique` cannot stop them because their keys differ.
//
// I claimed route G closes that window with a generation ref used as a
// compare-and-swap. A7 and A8 pass -- but neither of them tests this. They cover
// intersecting and disjoint globs under ordinary conditions; neither injects a
// competitor at the one instant that matters, BETWEEN the pre-check read and the
// push. So "window zero" was a property of the mechanism as reasoned, not as
// measured, and Catalyst had already tested ITS mitigation from both sides.
//
// This file injects the competitor at exactly that instant. Same shape as the
// coordinator's own probe generalising from HEAD/HEAD~1: a correct conclusion
// resting on evidence that did not cover the case.
//
//   GITHUB_LIVE=1 node --test github/store/scope-race.live.test.ts

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { FakeClock } from '../../shared/clock.ts';
import { CapturingLogger } from '../../shared/log.ts';
import { createGithubStore } from './github.ts';
import { createGitRunner, createHttpTransport } from './transport.ts';
import type { HttpTransport } from './transport.ts';

const LIVE = process.env.GITHUB_LIVE === '1';
const REPO = process.env.GITHUB_REPO ?? 'Sibhimanyu/inventory-tracker-github';

function token(): string {
  return process.env.GITHUB_TOKEN
    ?? execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
}

const dirs: string[] = [];

async function makeStore(project_id: string, wrap?: (t: HttpTransport) => HttpTransport) {
  const dir = await mkdtemp(join(tmpdir(), 'ghrace-'));
  dirs.push(dir);
  const git = createGitRunner(dir);
  await git.run(['init', '--quiet']);
  await git.run(['config', 'user.email', 'race@example.invalid']);
  await git.run(['config', 'user.name', 'race']);
  await git.run(['remote', 'add', 'origin', `https://github.com/${REPO}.git`]);
  const base = createHttpTransport();
  return createGithubStore({
    repo: REPO, git, http: wrap ? wrap(base) : base, token: token(),
    clock: new FakeClock(), log: new CapturingLogger(), stale_ms: 5_000,
  });
}

if (LIVE) {
  test('entry 18: a competitor injected between the pre-check and the push cannot both win', async () => {
    const project_id = `proj-race${process.pid}`;
    let injected = false;

    // B is the competitor. It acquires a lock that OVERLAPS A's without being
    // identical -- the exact case is_unique cannot catch, because the two lock
    // keys differ.
    const b = await makeStore(project_id);

    // A's transport is wrapped so that the instant A finishes reading the locks
    // it is about to reason about, B slips in and acquires. A then pushes with a
    // generation that is already stale.
    const a = await makeStore(project_id, (base) => async (url, init) => {
      const res = await base(url, init);
      if (!injected && url.includes(`/matching-refs/agentic/${project_id}/locks/`)) {
        injected = true;
        const won = await b.acquireScope(project_id, 'agent_bbb', 'task_b', ['src/**']);
        assert.deepEqual(won, { ok: true }, 'the injected competitor must actually acquire');
      }
      return res;
    });

    try {
      await a.purge(project_id);

      // 'src/api/**' intersects 'src/**' but is not equal to it.
      const result = await a.acquireScope(project_id, 'agent_aaa', 'task_a', ['src/api/**']);

      assert.ok(injected, 'the competitor never ran, so this test proves nothing');

      // The whole point: A must NOT hold a lock that overlaps B's.
      assert.equal(result.ok, false,
        'A acquired an overlapping scope despite B winning the race -- the window is open');
      if (result.ok === false) {
        // Correlation, not count (order 0009): the conflict must name the
        // ACTUAL holder, not merely report that a conflict happened.
        assert.ok(result.conflicts.length >= 1, 'a rejection must name its conflicts');
        assert.ok(result.conflicts.some((c) => c.agent_id === 'agent_bbb'),
          `conflict must name the real holder agent_bbb, got ${JSON.stringify(result.conflicts.map((c) => c.agent_id))}`);
        assert.ok(result.conflicts.some((c) => c.globs.includes('src/**')),
          'conflict must carry the holder\'s globs so the caller can pick another task');
      }

      // And exactly one lock exists on the remote, held by B.
      const snap = await b.readSnapshot(project_id);
      assert.ok(snap);
      const holders = snap.snapshot.locks.map((l) => l.agent_id).sort();
      assert.deepEqual(holders, ['agent_bbb'],
        `exactly one lock must survive the race, found ${JSON.stringify(holders)}`);
    } finally {
      await a.purge(project_id);
    }
  });

  test('entry 18 control: with NO competitor injected, the same call succeeds', async () => {
    // Without this, a broken acquireScope that rejected everything would pass
    // the test above. Absence alone cannot distinguish a working CAS from a
    // store that never acquires anything -- A16's shape, one layer over.
    const project_id = `proj-ctl${process.pid}`;
    const a = await makeStore(project_id);
    try {
      await a.purge(project_id);
      const result = await a.acquireScope(project_id, 'agent_aaa', 'task_a', ['src/api/**']);
      assert.deepEqual(result, { ok: true },
        'the uncontended path must still acquire, or the test above proves nothing');
    } finally {
      await a.purge(project_id);
    }
  });

  after(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });
} else {
  test('entry 18 adversarial scope race was NOT RUN', () => {
    assert.fail('GITHUB_LIVE=1 was not set. Reported as a failure on purpose: '
      + 'a suite that goes quiet when its backend is absent is a box ticked without evidence.');
  });
}
