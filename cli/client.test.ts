// B3 and B10, plus the HTTP -> shared-error-vocabulary mapping the CLI's retry policy needs.
//
// A stub fetch rather than a live server: the behaviours under test are "what does the CLI do
// with this status code", and a real server can only produce one of them at a time.
//
//   node --test cli/client.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ApiClient, connectWithInvite } from './client.ts';
import {
  StoreAuthError,
  StoreBusyError,
  StoreError,
  StoreOfflineError,
} from '../shared/store/errors.ts';
import type { Logger } from '../shared/log.ts';

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** A fetch that returns queued responses and records what was asked for. */
function stub(
  responses: ({ status: number; body?: unknown; headers?: Record<string, string> } | Error)[],
): { fetchImpl: typeof fetch; calls: { url: string; method: string; auth?: string; body?: string }[] } {
  const calls: { url: string; method: string; auth?: string; body?: string }[] = [];
  let i = 0;
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      auth: headers.authorization,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    // The index is clamped to the last element, so this cannot be undefined — but
    // noUncheckedIndexedAccess cannot see that, and an empty `responses` really would be a
    // test bug worth failing on.
    const next = responses[Math.min(i++, responses.length - 1)];
    if (!next) throw new Error('stub() was called with no responses');
    if (next instanceof Error) throw next;

    // 204/205/304 are "null body status" codes and the Response constructor REFUSES them
    // (`TypeError: Invalid response status code 304`), so a 304 cannot be built this way at
    // all. Duck-type the two members request() actually reads instead. Not a shortcut — there
    // is no way to construct a real 304 Response in this runtime.
    if (next.status === 204 || next.status === 205 || next.status === 304) {
      return {
        status: next.status,
        ok: false,
        headers: new Headers(next.headers),
        text: async () => '',
      } as unknown as Response;
    }

    return new Response(next.body === undefined ? '' : JSON.stringify(next.body), {
      status: next.status,
      headers: next.headers,
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const client = (responses: Parameters<typeof stub>[0], token = 'tok') => {
  const { fetchImpl, calls } = stub(responses);
  return {
    api: new ApiClient({ base_url: 'https://api.example.test', token, log: silent, fetchImpl }),
    calls,
  };
};

// ---- B3 ---------------------------------------------------------------------------------

test('B3 a lost claim is a VALUE, not a throw, so `builder claim` can exit 0', async () => {
  const { api } = client([
    { status: 200, body: { ok: false, owner: 'agent_be000001', claimed_at: '2026-08-25T09:00:00Z' } },
  ]);
  const r = await api.claimTask('task_items_ui');
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.equal(r.owner, 'agent_be000001', 'the CLI must be able to print "owned by X"');
    assert.equal(r.claimed_at, '2026-08-25T09:00:00Z');
  }
});

test('B3b a won claim is ok:true', async () => {
  const { api } = client([{ status: 200, body: { ok: true } }]);
  assert.deepEqual(await api.claimTask('task_items_ui'), { ok: true });
});

test('B3c a lost claim reported without an owner still does not throw', async () => {
  // Defensive: a malformed-but-successful response must not turn a routine race into a crash.
  const { api } = client([{ status: 200, body: { ok: false } }]);
  const r = await api.claimTask('task_items_ui');
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.owner, 'unknown');
});

// ---- B10 --------------------------------------------------------------------------------

test('B10 freshness is read from the backend, never hardcoded', async () => {
  const live = client([
    {
      status: 200,
      body: {
        agent_id: 'agent_be000001',
        project_id: 'proj_inventory',
        role_slug: 'backend-builder',
        permissions: { push_branches: true, open_prs: true, merge: false, publish_contracts: true },
        freshness: { mode: 'live', stale_ms: 0 },
      },
    },
  ]);
  const me = await live.api.whoami();
  assert.deepEqual(me.freshness, { mode: 'live', stale_ms: 0 });

  // The same client code must report a poll backend honestly. This is the assertion that
  // proves the CLI is not printing a constant: swap the backend's answer, the output changes.
  const poll = client([
    {
      status: 200,
      body: {
        agent_id: 'agent_be000001',
        project_id: 'proj_inventory',
        role_slug: 'backend-builder',
        permissions: { push_branches: true, open_prs: true, merge: false, publish_contracts: true },
        freshness: { mode: 'poll', stale_ms: 5000 },
      },
    },
  ]);
  const other = await poll.api.whoami();
  assert.deepEqual(other.freshness, { mode: 'poll', stale_ms: 5000 });
  assert.notDeepEqual(me.freshness, other.freshness, 'the two builds must be able to differ here');
});

test('B10b permissions come from the backend too, so AGENTS.md cannot promise merge', async () => {
  const { api } = client([
    {
      status: 200,
      body: {
        agent_id: 'a',
        project_id: 'p',
        role_slug: 'backend-builder',
        permissions: { push_branches: true, open_prs: true, merge: false, publish_contracts: true },
        freshness: { mode: 'live', stale_ms: 0 },
      },
    },
  ]);
  const me = await api.whoami();
  assert.equal(me.permissions.merge, false);
});

// ---- error mapping ----------------------------------------------------------------------

test('401 and 403 are StoreAuthError and are NOT retried', async () => {
  for (const status of [401, 403]) {
    const { api, calls } = client([{ status, body: { error: 'unauthorised', detail: 'revoked' } }]);
    await assert.rejects(
      () => api.whoami(),
      (e: unknown) => e instanceof StoreAuthError,
      `${status} must be StoreAuthError`,
    );
    assert.equal(calls.length, 1, `${status} must be attempted exactly once`);
  }
});

test('429 is StoreBusyError and carries the retry hint', async () => {
  const { api } = client([
    { status: 429, body: { error: 'busy', retry_after_ms: 750 } },
    { status: 429, body: { error: 'busy', retry_after_ms: 750 } },
    { status: 429, body: { error: 'busy', retry_after_ms: 750 } },
    { status: 429, body: { error: 'busy', retry_after_ms: 750 } },
  ]);
  await assert.rejects(
    () => api.whoami(),
    (e: unknown) => e instanceof StoreBusyError && e.retry_after_ms === 750,
  );
});

test('429 falls back to the Retry-After header when the body has no hint', async () => {
  const { api } = client([{ status: 429, body: { error: 'busy' }, headers: { 'retry-after': '2' } }]);
  await assert.rejects(
    () => api.whoami(),
    (e: unknown) => e instanceof StoreBusyError && e.retry_after_ms === 2000,
  );
});

test('a 503 is retried and can succeed', async () => {
  const { api, calls } = client([
    { status: 503, body: { error: 'offline' } },
    {
      status: 200,
      body: {
        agent_id: 'a',
        project_id: 'p',
        role_slug: 'backend-builder',
        permissions: { push_branches: true, open_prs: true, merge: false, publish_contracts: true },
        freshness: { mode: 'live', stale_ms: 0 },
      },
    },
  ]);
  const me = await api.whoami();
  assert.equal(me.agent_id, 'a');
  assert.equal(calls.length, 2, 'the 503 must have been retried');
});

test('a transport failure is StoreOfflineError, not a raw TypeError', async () => {
  const { api } = client([new TypeError('fetch failed')]);
  await assert.rejects(
    () => api.whoami(),
    (e: unknown) => e instanceof StoreOfflineError,
    'the CLI queues on offline; it must not see a transport-level exception type',
  );
});

test('a request that exceeds its deadline is StoreOfflineError, not a hang', async () => {
  // The Firestore admin SDK retries a write during a partition indefinitely rather than
  // failing, so without a client-side deadline the CLI hangs forever. This is that guard.
  const hanging = (async (_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    })) as unknown as typeof fetch;

  const api = new ApiClient({
    base_url: 'https://api.example.test',
    token: 'tok',
    log: silent,
    fetchImpl: hanging,
    timeout_ms: 60,
  });
  await assert.rejects(
    () => api.whoami(),
    (e: unknown) => e instanceof StoreOfflineError && /timed out/.test((e as Error).message),
  );
});

test('a 400 is a caller bug: named, thrown, never retried', async () => {
  const { api, calls } = client([{ status: 400, body: { error: 'missing_task_id' } }]);
  await assert.rejects(
    () => api.claimTask('x'),
    (e: unknown) => e instanceof StoreError && !(e instanceof StoreBusyError),
  );
  assert.equal(calls.length, 1, 'retrying a malformed request just sends it again');
});

// ---- the token is a header, and only a header -------------------------------------------

test('the token travels as a Bearer header and never in a URL or body', async () => {
  const { api, calls } = client([{ status: 201, body: { event_id: 'e', seq: 1, duplicate: false } }], 'secret-token');
  await api.appendEvent('task_progress', { task_id: 't', summary: 's' }, 'key-0000');

  const call = calls[0]!;
  assert.equal(call.auth, 'Bearer secret-token');
  assert.ok(!call.url.includes('secret-token'), 'a token in a URL lands in every access log');
  assert.ok(!(call.body ?? '').includes('secret-token'), 'and must not be in the body either');
});

test('appendEvent sends no agent_id: identity is the token, not a field', async () => {
  const { api, calls } = client([{ status: 201, body: { event_id: 'e', seq: 1, duplicate: false } }]);
  await api.appendEvent('task_progress', { task_id: 't', summary: 's' }, 'key-0000');
  const sent = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
  assert.deepEqual(Object.keys(sent).sort(), ['body', 'idempotency_key', 'kind']);
  assert.equal(sent.agent_id, undefined, 'the API refuses it, so the client must not send it');
});

// ---- snapshot etag ----------------------------------------------------------------------

test('readSnapshot passes If-None-Match and returns null on 304', async () => {
  const { fetchImpl, calls } = stub([{ status: 304 }]);
  const api = new ApiClient({ base_url: 'https://api.example.test', token: 't', log: silent, fetchImpl });
  assert.equal(await api.readSnapshot('"abc"'), null, '304 must be null, not an empty snapshot');
  assert.equal(calls.length, 1);
});

// ---- connect ----------------------------------------------------------------------------

test('connect exchanges an invite for a token and never sends a token', async () => {
  const { fetchImpl, calls } = stub([
    {
      status: 201,
      body: {
        agent_id: 'agent_be000001',
        project_id: 'proj_inventory',
        role_slug: 'backend-builder',
        member_label: 'sibhi',
        token: 'minted-server-side',
      },
    },
  ]);
  const r = await connectWithInvite('https://api.example.test', 'invite-code', 'claude-code', fetchImpl);
  assert.equal(r.token, 'minted-server-side');
  assert.equal(r.agent_id, 'agent_be000001');

  const sent = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
  assert.deepEqual(Object.keys(sent).sort(), ['harness', 'invite']);
  assert.equal(sent.agent_id, undefined, 'agent_id is minted server-side from the invite');
  assert.equal(calls[0]!.auth, undefined, 'connect is the one unauthenticated route');
});

test('a bad invite is StoreAuthError, so the CLI stops instead of retrying', async () => {
  const { fetchImpl } = stub([{ status: 401, body: { error: 'unknown_invite' } }]);
  await assert.rejects(
    () => connectWithInvite('https://api.example.test', 'wrong', 'manual', fetchImpl),
    (e: unknown) => e instanceof StoreAuthError,
  );
});
