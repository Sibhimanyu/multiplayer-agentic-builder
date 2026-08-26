// Presence via Cache. The assertions that matter are the two Cache quirks and
// the zero-durable-write guarantee.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { handleHeartbeat, handleListPresence, PRESENCE_TTL_MS, presenceKey, readPresence } from './index.ts';
import type { PresenceDeps, PresencePort } from './index.ts';
import { STALE_AFTER_MS } from '../../shared/store/types.ts';
import { CapturingLogger } from '../../shared/log.ts';
import type { Principal } from '../_lib/auth.ts';

const PROJECT = 'proj_inventory';
const NOW = Date.UTC(2026, 7, 26, 12, 0, 0);

function principal(over: Partial<Principal> = {}): Principal {
  return {
    agent_id: 'agent_be01', project_id: PROJECT, role_slug: 'backend',
    member_id: 'm', member_label: 'Bea Backend', can_merge: false, ...over,
  };
}

/** Cache double that reproduces the two documented quirks. */
class FakeCache implements PresencePort {
  store = new Map<string, { value: string | null; ttl_ms: number }>();
  puts = 0;
  /** Any TTL-less write is a bug: it would reset the TTL to 48 hours. */
  ttlless_writes = 0;

  put = async (key: string, value: string, ttl_ms: number): Promise<void> => {
    this.puts += 1;
    if (!ttl_ms || ttl_ms <= 0) this.ttlless_writes += 1;
    this.store.set(key, { value, ttl_ms });
  };

  get = async (key: string): Promise<string | null> => this.store.get(key)?.value ?? null;

  getMany = async (keys: string[]): Promise<Map<string, string | null>> => {
    const out = new Map<string, string | null>();
    for (const k of keys) {
      const hit = this.store.get(k);
      if (hit) out.set(k, hit.value);
    }
    return out;
  };

  /** Catalyst's delete() leaves the key present with a NULL value. */
  quirkyDelete(key: string): void {
    if (this.store.has(key)) this.store.set(key, { value: null, ttl_ms: PRESENCE_TTL_MS });
  }
}

function deps(cache: FakeCache, agentIds: string[], now = NOW): PresenceDeps & { log: CapturingLogger } {
  const log = new CapturingLogger();
  return { port: cache, log, now_ms: () => now, listAgentIds: async () => agentIds };
}

describe('heartbeat', () => {
  test('writes to Cache with an EXPLICIT TTL and nothing else', async () => {
    const cache = new FakeCache();
    const d = deps(cache, ['agent_be01']);
    const res = await handleHeartbeat(d, principal(), {
      project_id: PROJECT, status: 'working', current_task: 'task_items_api', branch: 'agent/backend/task_items_api',
    });
    assert.equal(res.status, 204);
    assert.equal(cache.puts, 1);
    assert.equal(cache.ttlless_writes, 0, 'a TTL-less write resets the TTL to 48 hours');
    assert.equal(cache.store.get(presenceKey(PROJECT, 'agent_be01'))?.ttl_ms, PRESENCE_TTL_MS);
  });

  test('500 heartbeats cost 500 Cache puts and ZERO durable writes', async () => {
    // The whole reason presence is not a Data Store row: 1,000 UPDATEs per MONTH
    // means a 20s heartbeat from one agent would exhaust the tier in 5.6 hours.
    const cache = new FakeCache();
    const d = deps(cache, ['agent_be01']);
    for (let i = 0; i < 500; i += 1) {
      await handleHeartbeat(d, principal(), { project_id: PROJECT, status: 'working' });
    }
    assert.equal(cache.puts, 500);
    assert.equal(cache.store.size, 1, 'one key per agent, overwritten');
  });

  test('agent_id comes from the token, so liveness cannot be faked for another agent', async () => {
    const cache = new FakeCache();
    const d = deps(cache, ['agent_be01', 'agent_fe01']);
    await assert.rejects(
      () => handleHeartbeat(d, principal(), { project_id: PROJECT, status: 'working', agent_id: 'agent_fe01' }),
      /resolved server-side/,
    );
    assert.equal(cache.puts, 0);
  });

  test('an unknown status is rejected rather than stored', async () => {
    const cache = new FakeCache();
    const d = deps(cache, ['agent_be01']);
    await assert.rejects(() => handleHeartbeat(d, principal(), { project_id: PROJECT, status: 'vibing' }));
    assert.equal(cache.puts, 0);
  });

  test('a cross-project heartbeat is refused', async () => {
    const cache = new FakeCache();
    const d = deps(cache, ['agent_be01']);
    await assert.rejects(() => handleHeartbeat(d, principal(), { project_id: 'proj_other', status: 'working' }));
  });
});

describe('reading presence', () => {
  test('a fresh heartbeat is not stale; past 90s it is', async () => {
    const cache = new FakeCache();
    await handleHeartbeat(deps(cache, ['agent_be01'], NOW), principal(), { project_id: PROJECT, status: 'working' });

    const fresh = await handleListPresence(deps(cache, ['agent_be01'], NOW + 1_000), principal(), PROJECT);
    const f = (fresh.body as { presence: { stale: boolean; status: string }[] }).presence;
    assert.equal(f[0].stale, false);
    assert.equal(f[0].status, 'working');

    const later = await handleListPresence(deps(cache, ['agent_be01'], NOW + STALE_AFTER_MS + 1), principal(), PROJECT);
    assert.equal((later.body as { presence: { stale: boolean }[] }).presence[0].stale, true);
  });

  test('QUIRK: a key that delete() left with a NULL value counts as absent', async () => {
    const cache = new FakeCache();
    await handleHeartbeat(deps(cache, ['agent_be01']), principal(), { project_id: PROJECT, status: 'working' });
    cache.quirkyDelete(presenceKey(PROJECT, 'agent_be01'));

    const entries = await readPresence(deps(cache, ['agent_be01']), PROJECT);
    assert.deepEqual(entries, [], 'a null value is absent, not a zero-valued heartbeat');
  });

  test('an agent that never sent a heartbeat is simply absent', async () => {
    const cache = new FakeCache();
    const entries = await readPresence(deps(cache, ['agent_be01', 'agent_fe01']), PROJECT);
    assert.deepEqual(entries, []);
  });

  test('a value with no usable timestamp is treated as absent, not as live', async () => {
    // Guessing "now" here would make a dead agent look alive, which is exactly
    // the wrong direction to fail.
    const cache = new FakeCache();
    const d = deps(cache, ['agent_be01']);
    await cache.put(presenceKey(PROJECT, 'agent_be01'), JSON.stringify({ status: 'working' }), PRESENCE_TTL_MS);
    assert.deepEqual(await readPresence(d, PROJECT), []);
    assert.ok(d.log.has('presence.no_timestamp'));
  });

  test('an unparseable value is treated as absent and logged', async () => {
    const cache = new FakeCache();
    const d = deps(cache, ['agent_be01']);
    await cache.put(presenceKey(PROJECT, 'agent_be01'), 'not json', PRESENCE_TTL_MS);
    assert.deepEqual(await readPresence(d, PROJECT), []);
    assert.ok(d.log.has('presence.unparseable'));
  });

  test('presence keys are project-scoped', async () => {
    assert.notEqual(presenceKey('proj_a', 'agent_1'), presenceKey('proj_b', 'agent_1'));
  });
});
