// Runs section A against the in-process adapter.
//
// shared/store/catalyst.test.ts and the Firebase build's equivalent register the
// SAME suite with their own harness. That is the whole point: only the harness
// differs, so a difference in results is a difference in platforms.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { registerConformanceSuite } from './conformance.ts';
import type { StoreHarness } from './conformance.ts';
import { createMemoryStore } from './memory.ts';
import { FakeClock } from '../clock.ts';
import { CapturingLogger } from '../log.ts';

const PROJECT = 'proj_inventory';

async function memoryHarness(): Promise<StoreHarness> {
  const clock = new FakeClock();
  const log = new CapturingLogger();
  const store = createMemoryStore({ clock, log });
  store.createProject(PROJECT, 'Inventory Tracker', 'https://github.com/acme/inventory');

  return {
    name: 'memory',
    store,
    log,
    project_id: PROJECT,
    faults: {
      setOffline: async (on) => store.faults.setOffline(on),
      setBusy: async (on, retry_after_ms) => store.faults.setBusy(on, retry_after_ms),
      freezeSnapshot: async (on) => store.faults.freezeSnapshot(on),
      revoke: async (agent_id) => store.faults.revoke(PROJECT, agent_id),
      restore: async (agent_id) => store.faults.restore(PROJECT, agent_id),
    },
    seedEvent: async (event, idempotency_key) => store.injectEvent(PROJECT, event, idempotency_key),
    seedTask: async (t) => store.addTask(PROJECT, t),
    seedAgent: async (a) => store.addAgent(PROJECT, a),
    ledgerSize: async () => store.ledgerSize(PROJECT),
    advanceTime: async (ms) => { await clock.advance(ms); },
    dispose: async () => {},
  };
}

registerConformanceSuite(memoryHarness);

// ---- memory-only properties ------------------------------------------------
// These are not section A items. They guard the two claims the memory adapter
// makes about itself, both of which the Catalyst build depends on being true.

test('memory: heartbeats never cost a durable row update', async () => {
  const h = await memoryHarness();
  const store = h.store as ReturnType<typeof createMemoryStore>;
  await h.seedAgent({ agent_id: 'agent_be01', role_slug: 'backend', member_label: 'Bea Backend' });

  for (let i = 0; i < 500; i += 1) {
    await store.heartbeat(h.project_id, 'agent_be01', 'working', null, 'feat/items');
  }
  assert.equal(store.stats.durable_updates, 0, 'a heartbeat reached durable storage');
  assert.equal(store.stats.cache_puts, 500);
});

test('memory: appended events are deep-frozen, so mutation is impossible not merely unlikely', async () => {
  const h = await memoryHarness();
  await h.seedAgent({ agent_id: 'agent_be01', role_slug: 'backend', member_label: 'Bea Backend' });
  const { seq } = await h.store.appendEvent(
    h.project_id,
    { layer: 'human', kind: 'task_progress', actor_type: 'agent', actor_id: 'agent_be01', body: { summary: 'one' } },
    'freeze-1',
  );
  const { events } = await h.store.readEvents(h.project_id, seq - 1, 1);
  const event = events[0];
  assert.throws(() => { (event as { seq: number }).seq = 999; }, TypeError);
  assert.throws(() => { (event.body as { summary: string }).summary = 'two'; }, TypeError);
});

test('memory: an event kind on the wrong layer is rejected, never silently corrected', async () => {
  const h = await memoryHarness();
  await h.seedAgent({ agent_id: 'agent_be01', role_slug: 'backend', member_label: 'Bea Backend' });
  await assert.rejects(
    () => h.store.appendEvent(
      h.project_id,
      // task_progress is human-layer. Claiming it is coordination-layer would
      // deliver agent chatter to every agent -- the one rule the protocol calls
      // its most important.
      { layer: 'coordination', kind: 'task_progress', actor_type: 'agent', actor_id: 'agent_be01', body: {} },
      'layer-1',
    ),
    /layer mismatch/,
  );
});

test('memory: the reaper releases a claim whose agent went stale past the timeout', async () => {
  const h = await memoryHarness();
  const store = h.store as ReturnType<typeof createMemoryStore>;
  await h.seedTask({ task_id: 'task_a', title: 'A', kind: 'backend' });
  await h.seedAgent({ agent_id: 'agent_be01', role_slug: 'backend', member_label: 'Bea Backend' });
  await store.claimTask(h.project_id, 'task_a', 'agent_be01');
  await store.heartbeat(h.project_id, 'agent_be01', 'working', 'task_a');

  assert.deepEqual(store.reapStaleClaims(h.project_id, 15 * 60_000), []);
  await h.advanceTime(16 * 60_000);
  assert.deepEqual(store.reapStaleClaims(h.project_id, 15 * 60_000), [{ task_id: 'task_a', agent_id: 'agent_be01' }]);

  // Released, so another agent can take it (F12).
  await h.seedAgent({ agent_id: 'agent_fe01', role_slug: 'frontend', member_label: 'Fern Frontend' });
  assert.deepEqual(await store.claimTask(h.project_id, 'task_a', 'agent_fe01'), { ok: true });
});
