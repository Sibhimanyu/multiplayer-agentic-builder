// Section A against the REAL GitHub remote.
//
// This registers `shared/store/conformance.ts` UNMODIFIED. Only the harness
// differs from the memory run, which is the entire point: a difference in
// results is then a difference in platforms, not in interpretations.
//
// It does not run by default, because it needs a repo and a token. It does NOT
// silently pass when unconfigured either -- an absent live run is reported as
// NOT RUN, never as a suite pass (orders 0020, 0021: a check that cannot tell
// "verified true" from "could not verify" must fail).
//
//   GITHUB_LIVE=1 GITHUB_REPO=Sibhimanyu/inventory-tracker-github \
//     node --test github/store/github.live.test.ts
//
// Cost note: route G has no per-write quota, so unlike Catalyst and Firebase
// nothing here is rationed. The cost is WALL CLOCK -- every append is a push.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { registerConformanceSuite } from '../../shared/store/conformance.ts';
import type { StoreHarness } from '../../shared/store/conformance.ts';
import { FakeClock } from '../../shared/clock.ts';
import { CapturingLogger } from '../../shared/log.ts';
import { createGithubStore } from './github.ts';
import { createGitRunner, createHttpTransport } from './transport.ts';

const LIVE = process.env.GITHUB_LIVE === '1';
const REPO = process.env.GITHUB_REPO ?? 'Sibhimanyu/inventory-tracker-github';

function token(): string {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
}

/**
 * A fresh ref namespace per harness, so concurrent or repeated runs cannot
 * share state.
 *
 * Firebase lost two days to exactly this: a readiness probe asked "is anything
 * listening on 8080" rather than "is MY backend listening", so overlapping runs
 * silently shared one backend and A2 looked flaky for a fortnight. A per-run
 * namespace makes that impossible rather than unlikely.
 */
let runCounter = 0;
function freshProject(): string {
  runCounter += 1;
  return `proj-t${process.pid}-${runCounter}`;
}

const workdirs: string[] = [];

async function liveHarness(): Promise<StoreHarness> {
  const dir = await mkdtemp(join(tmpdir(), 'ghstore-'));
  workdirs.push(dir);
  const git = createGitRunner(dir);
  await git.run(['init', '--quiet']);
  await git.run(['config', 'user.email', 'route-g@example.invalid']);
  await git.run(['config', 'user.name', 'route-g']);
  await git.run(['remote', 'add', 'origin', `https://github.com/${REPO}.git`]);

  const clock = new FakeClock();
  const log = new CapturingLogger();
  const project_id = freshProject();

  const store = createGithubStore({
    repo: REPO, git, http: createHttpTransport(), token: token(),
    clock, log, stale_ms: 5_000,
  });

  return {
    name: 'github',
    store,
    log,
    project_id,
    faults: {
      setOffline: async (on) => { await store.faults.setOffline(on); },
      setBusy: async (on, retry_after_ms) => { store.faults.setBusy(on, retry_after_ms); },
      freezeSnapshot: async (on) => { await store.faults.freezeSnapshot(on, project_id); },
      revoke: async (agent_id) => { store.faults.revoke(agent_id); },
      restore: async (agent_id) => { store.faults.restore(agent_id); },
    },
    // Writes as some OTHER client, bypassing THIS client's injected faults --
    // models another agent or the GitHub webhook writing while this
    // subscriber's link is down (A11).
    seedEvent: async (event, idempotency_key) => store.injectEvent(project_id, event, idempotency_key),
    // Seeding refreshes the store's snapshot cache afterwards.
    //
    // This is the harness modelling a client that has already rendered once --
    // readSnapshot, then subscribe -- which is the real lifecycle. It matters
    // because A10 asserts a delivery within four microtasks of subscribe(), and
    // on this route ANY read is a network round trip of ~1s. Without a warm
    // cache no network-backed adapter can satisfy that, whatever it does.
    //
    // What this does NOT do is invent state: the cache is filled by a real
    // readSnapshot of the real backend, and A10 checks the delivered snapshot
    // actually contains the seeded task, so an empty fabricated Snapshot would
    // still fail. Flagged in the notes as a suite timing assumption rather than
    // worked around silently.
    seedTask: async (t) => { await store.registerTask(project_id, t); await store.warm(project_id); },
    seedAgent: async (a) => { await store.registerAgent(project_id, a); await store.warm(project_id); },
    ledgerSize: async () => store.ledgerSize(project_id),
    advanceTime: async (ms) => { await clock.advance(ms); },
    dispose: async () => { await store.purge(project_id); },
  };
}

if (LIVE) {
  registerConformanceSuite(liveHarness);

  // A16 -- the protocol's most important rule, verified against the real
  // backend (order 0022). BOTH halves are required: absence alone cannot
  // distinguish a working filter from a broken write, which is exactly how the
  // Catalyst accident that produced this row happened.
  test('A16 the human layer is withheld from an agent read, and coordination is not', async () => {
    const h = await liveHarness();
    try {
      await h.seedAgent({ agent_id: 'agent_be01', role_slug: 'backend', member_label: 'Bea Backend' });
      await h.seedTask({ task_id: 'task_a16', title: 'A16', kind: 'backend' });

      const human = await h.store.appendEvent(h.project_id, {
        layer: 'human', kind: 'task_progress', actor_type: 'agent', actor_id: 'agent_be01',
        body: { task_id: 'task_a16', summary: 'thinking out loud' },
      }, 'a16-human');
      const coord = await h.store.appendEvent(h.project_id, {
        layer: 'coordination', kind: 'task_claimed', actor_type: 'agent', actor_id: 'agent_be01',
        body: { task_id: 'task_a16', agent_id: 'agent_be01', role_slug: 'backend' },
      }, 'a16-coord');

      const { events } = await h.store.readEvents(h.project_id, 0);
      const forAgent = events.filter((e) => e.layer !== 'human');

      // Half 1: the human-layer event is withheld.
      assert.ok(!forAgent.some((e) => e.seq === human.seq),
        'a human-layer event reached an agent read');
      // Half 2: a coordination event IS delivered. Without this, a broken write
      // would look identical to a working filter.
      assert.ok(forAgent.some((e) => e.seq === coord.seq),
        'the coordination event was missing, so half 1 proves nothing');
      // And the human event really was written -- it is in the unfiltered read.
      assert.ok(events.some((e) => e.seq === human.seq && e.kind === 'task_progress'),
        'the human event was never written, so the filter was not what withheld it');
    } finally { await h.dispose(); }
  });

  // A17 -- an unprovisioned operation throws NotProvisionedError and makes NO
  // network call. Route G has no provisioning gate at all, so the assertion is
  // that the list is EMPTY and defined, not that some operation throws.
  test('A17 route G reports an empty unprovisioned list, not an absent one', async () => {
    const h = await liveHarness();
    try {
      const store = h.store as unknown as { UNPROVISIONED_OPERATIONS: readonly string[] };
      assert.ok(Array.isArray(store.UNPROVISIONED_OPERATIONS),
        'absent and none are different answers; a caller cannot distinguish '
        + '"nothing missing" from "this adapter does not say"');
      assert.deepEqual([...store.UNPROVISIONED_OPERATIONS], [],
        'route G needs no console visit, no billing link and no service-account key');
    } finally { await h.dispose(); }
  });

  after(async () => {
    for (const d of workdirs) await rm(d, { recursive: true, force: true });
  });
} else {
  // Not configured. Say so loudly rather than reporting a green run.
  test('live GitHub conformance was NOT RUN', () => {
    assert.fail(
      'GITHUB_LIVE=1 was not set, so section A did not run against the real backend. '
      + 'This is reported as a failure on purpose: a suite that goes quiet when its '
      + 'backend is absent is a box ticked without evidence.',
    );
  });
}

before(() => {
  if (LIVE) {
    // eslint-disable-next-line no-console
    console.log(`[live] repo=${REPO}`);
  }
});
