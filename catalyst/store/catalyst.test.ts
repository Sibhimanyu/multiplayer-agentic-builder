// The adapter's wire contract, driven through an injected fetch. No cloud needed:
// what is under test is how HTTP statuses and payloads become the store taxonomy,
// and that mapping is the entire contract with the retry policy.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { CatalystStore, UNPROVISIONED_OPERATIONS, createCatalystStore } from './catalyst.ts';
import {
  NotProvisionedError, StoreAuthError, StoreBusyError, StoreError, StoreOfflineError, isRetryable,
} from '../../shared/store/errors.ts';
import { CapturingLogger } from '../../shared/log.ts';

const BASE = 'https://example.invalid/server/coordination';
const TOKEN = 'agt_test_token';
const PROJECT = 'proj_inventory';

interface Recorded { url: string; init: RequestInit }

function stub(
  responder: (url: string, init: RequestInit) => Response | Promise<Response> | never,
): { store: CatalystStore; calls: Recorded[]; log: CapturingLogger } {
  const calls: Recorded[] = [];
  const log = new CapturingLogger();
  const store = createCatalystStore({
    base_url: BASE, token: TOKEN, log,
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return responder(String(input), init ?? {});
    }) as typeof globalThis.fetch,
  });
  return { store, calls, log };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { 'Content-Type': 'application/json', ...headers },
  });
}

describe('wire details', () => {
  test('the token goes in X-Agent-Token, NEVER Authorization', async () => {
    // Authorization is reserved by the API Gateway: it validates any value there
    // as a Zoho OAuth token before the function is invoked, so the request never
    // arrives. Ruled canonical in order 0017.
    const { store, calls } = stub(() => json({ ok: true }));
    await store.claimTask(PROJECT, 'task_a', 'agent_be01');

    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers['X-Agent-Token'], TOKEN);
    assert.equal('Authorization' in headers, false);
    assert.equal('authorization' in headers, false);
  });

  test('the idempotency key travels in a header, not the body', async () => {
    const { store, calls } = stub(() => json({ event_id: 'evt_1', seq: 1, duplicate: false }));
    await store.appendEvent(PROJECT,
      { layer: 'coordination', kind: 'task_claimed', actor_type: 'agent', actor_id: 'x', body: {} },
      'key-1');
    const headers = calls[0].init.headers as Record<string, string>;
    assert.equal(headers['X-Idempotency-Key'], 'key-1');
    assert.equal(JSON.parse(String(calls[0].init.body)).idempotency_key, undefined);
  });

  test('agent_id is never sent, because the server resolves it from the token', async () => {
    // Sending it would be rejected as a forged field (H4). It stays in the
    // signature only because the interface is shared with a backend where the
    // caller does supply it.
    const { store, calls } = stub(() => json({ ok: true }));
    await store.claimTask(PROJECT, 'task_a', 'agent_pretend_to_be_someone');
    const body = JSON.parse(String(calls[0].init.body));
    assert.equal('agent_id' in body, false);
    assert.equal('actor_id' in body, false);
  });

  test('freshness reports poll mode, not live', async () => {
    const { store } = stub(() => json({}));
    assert.deepEqual(store.freshness, { mode: 'poll', stale_ms: 5_000 });
  });
});

describe('normal outcomes are 200, not errors', () => {
  test('a lost claim returns {ok:false, owner} and does not throw', async () => {
    const { store } = stub(() => json({ ok: false, owner: 'agent_other', claimed_at: '2026-08-26T12:00:00.000Z' }));
    const out = await store.claimTask(PROJECT, 'task_a', 'agent_be01');
    assert.equal(out.ok, false);
    assert.ok(!out.ok && out.owner === 'agent_other');
  });

  test('a refusal that names no owner IS an error, because it is unusable', async () => {
    const { store } = stub(() => json({ ok: false }));
    await assert.rejects(() => store.claimTask(PROJECT, 'task_a', 'agent_be01'), /without naming an owner/);
  });

  test('a scope conflict returns the conflicts and does not throw', async () => {
    const conflicts = [{ agent_id: 'agent_fe01', task_id: 'task_ui', globs: ['client/**'], acquired_at: 'x' }];
    const { store } = stub(() => json({ ok: false, conflicts }));
    const out = await store.acquireScope(PROJECT, 'agent_be01', 'task_a', ['client/src/x.ts']);
    assert.equal(out.ok, false);
    assert.ok(!out.ok && out.conflicts[0].agent_id === 'agent_fe01');
  });

  test('a duplicate append returns duplicate:true with the original seq', async () => {
    const { store } = stub(() => json({ event_id: 'evt_000001', seq: 1, duplicate: true }));
    const out = await store.appendEvent(PROJECT,
      { layer: 'coordination', kind: 'task_claimed', actor_type: 'agent', actor_id: 'x', body: {} }, 'k');
    assert.deepEqual(out, { event_id: 'evt_000001', seq: 1, duplicate: true });
  });

  test('releasing a claim you do not own is a no-op, not a throw', async () => {
    const { store } = stub(() => json({ ok: true, released: false, reason: 'not_owner' }));
    await assert.doesNotReject(() => store.releaseTask(PROJECT, 'task_a', 'agent_be01'));
  });
});

describe('status mapping is the contract with the retry policy', () => {
  test('401 -> StoreAuthError, and it is NOT retryable', async () => {
    const { store } = stub(() => json({ error: 'unauthorized', message: 'token revoked' }, 401));
    await assert.rejects(() => store.listPresence(PROJECT), (err: unknown) => {
      assert.ok(err instanceof StoreAuthError);
      assert.equal(isRetryable(err), false, 'retrying a revoked token burns quota forever');
      return true;
    });
  });

  test('403 -> StoreAuthError too', async () => {
    const { store } = stub(() => json({ message: 'forbidden' }, 403));
    await assert.rejects(() => store.listPresence(PROJECT), StoreAuthError);
  });

  test('429 -> StoreBusyError, retryable, honouring Retry-After', async () => {
    const { store } = stub(() => json({ message: 'slow down' }, 429, { 'Retry-After': '3' }));
    await assert.rejects(() => store.listPresence(PROJECT), (err: unknown) => {
      assert.ok(err instanceof StoreBusyError);
      assert.equal(isRetryable(err), true);
      assert.equal((err as StoreBusyError).retry_after_ms, 3000);
      return true;
    });
  });

  test('429 also reads retry_after_ms from the body when there is no header', async () => {
    const { store } = stub(() => json({ message: 'busy', retry_after_ms: 2500 }, 429));
    await assert.rejects(() => store.listPresence(PROJECT), (err: unknown) => {
      assert.equal((err as StoreBusyError).retry_after_ms, 2500);
      return true;
    });
  });

  test('503 and 500 -> StoreOfflineError, so the caller queues to its outbox', async () => {
    for (const status of [500, 502, 503, 504]) {
      const { store } = stub(() => json({ message: 'down' }, status));
      await assert.rejects(() => store.listPresence(PROJECT), StoreOfflineError, `status ${status}`);
    }
  });

  test('400 -> StoreError, a bad request rather than a server fault', async () => {
    const { store } = stub(() => json({ message: 'bad cursor' }, 400));
    await assert.rejects(() => store.listPresence(PROJECT), (err: unknown) => {
      assert.ok(err instanceof StoreError);
      assert.equal(err instanceof StoreOfflineError, false);
      assert.equal(isRetryable(err), false);
      return true;
    });
  });

  test('a transport failure is OFFLINE, not a bad request', async () => {
    // The distinction decides whether the write is queued or discarded.
    const { store } = stub(() => { throw new TypeError('fetch failed'); });
    await assert.rejects(() => store.readEvents(PROJECT, 0), (err: unknown) => {
      assert.ok(err instanceof StoreOfflineError);
      assert.equal(isRetryable(err), true);
      return true;
    });
  });

  test('a non-JSON error body still yields a usable message', async () => {
    const { store } = stub(() => new Response('<html>502 Bad Gateway</html>', { status: 502 }));
    await assert.rejects(() => store.listPresence(PROJECT), (err: unknown) => {
      assert.ok(err instanceof StoreOfflineError);
      assert.match(String((err as StoreError).backend_message), /Bad Gateway/);
      return true;
    });
  });
});

describe('the Stratus-gated operations refuse rather than fake', () => {
  test('readSnapshot throws NotProvisionedError naming the operation and resource', async () => {
    const { store } = stub(() => json({}));
    await assert.rejects(() => store.readSnapshot(PROJECT), (err: unknown) => {
      assert.ok(err instanceof NotProvisionedError);
      const e = err as NotProvisionedError;
      assert.equal(e.operation, 'readSnapshot');
      assert.match(e.resource, /Stratus bucket/);
      // The backend's own words are kept, so whoever reads it knows what to do.
      assert.match(String(e.backend_message), /in session/);
      return true;
    });
  });

  test('subscribe throws rather than firing once with empty state', () => {
    // Firing with an empty Snapshot would let A10 pass against fabricated state,
    // which is worse than not implementing it.
    const { store } = stub(() => json({}));
    assert.throws(() => store.subscribe(PROJECT, 0, () => {}), NotProvisionedError);
  });

  test('neither makes a network call, so nothing can look like it half-worked', async () => {
    const { store, calls } = stub(() => json({}));
    await store.readSnapshot(PROJECT).catch(() => {});
    try { store.subscribe(PROJECT, 0, () => {}); } catch { /* expected */ }
    assert.deepEqual(calls, []);
  });

  test('A17: the unavailable set is declared, so a harness reports instead of guessing', () => {
    assert.deepEqual([...UNPROVISIONED_OPERATIONS], ['readSnapshot', 'subscribe']);
    // Never undefined: "nothing missing" and "this adapter does not say" are
    // different answers and a caller cannot tell them apart from undefined.
    assert.ok(Array.isArray(UNPROVISIONED_OPERATIONS));
  });

  test('A17: NotProvisionedError is NOT retryable', () => {
    // A provisioning gate does not clear because you asked twice. Retrying it
    // burns quota and hides a setup step behind what looks like flakiness.
    assert.equal(isRetryable(new NotProvisionedError('readSnapshot', 'a bucket')), false);
  });

  test('A17: it names the operation AND the resource a human must provision', () => {
    const err = new NotProvisionedError('readSnapshot', 'the Stratus bucket');
    assert.equal(err.operation, 'readSnapshot');
    assert.equal(err.resource, 'the Stratus bucket');
    assert.match(err.message, /readSnapshot is unavailable/);
  });
});

describe('caps', () => {
  test('asking for more than 300 events logs the cap', async () => {
    const { store, log } = stub(() => json({ events: [], next_cursor: 0, has_more: false }));
    await store.readEvents(PROJECT, 0, 1000);
    assert.ok(log.has('store.events.capped'));
    assert.equal(log.withCode('store.events.capped')[0].fields.requested, 1000);
  });
});
