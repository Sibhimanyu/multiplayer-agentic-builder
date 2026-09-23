import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { WriteClient, causeCode } from './writeclient.ts';
import { CapturingLogger } from '../shared/log.ts';

const fetchFailed = (code: string) => Object.assign(new TypeError('fetch failed'), { cause: { code } });

/** A client whose token is pre-cached, so only the write fetch is exercised. */
async function client(fetchImpl: typeof fetch) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'flotilla-wc-'));
  const c = new WriteClient({ api_url: 'https://write.invalid', api_key: 'k', log: new CapturingLogger(), home, fetchImpl });
  (c as unknown as { token: unknown }).token = { value: 't', expires_at: Date.now() + 3_600_000 };
  return c;
}

const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });

test('causeCode reads the socket code undici hides on .cause', () => {
  assert.equal(causeCode(fetchFailed('ECONNREFUSED')), 'ECONNREFUSED');
  assert.equal(causeCode(new Error('x')), '');
});

test('a request that never left is retried, and succeeds', async () => {
  let calls = 0;
  const c = await client((async () => { calls++; if (calls === 1) throw fetchFailed('ECONNREFUSED'); return ok(); }) as typeof fetch);
  const r = await c.write('p', 'create_invite', {});
  assert.equal(r.ok, true);
  assert.equal(calls, 2);
});

test('a failure after the request may have arrived is reported, not replayed', async () => {
  let calls = 0;
  const c = await client((async () => { calls++; throw fetchFailed('ECONNRESET'); }) as typeof fetch);
  await assert.rejects(c.write('p', 'raise_suggestion', {}), /could not reach the write API \(ECONNRESET\)/);
  assert.equal(calls, 1, 'a suggestion must not be raised twice');
});

test('retries stop after three attempts', async () => {
  let calls = 0;
  const c = await client((async () => { calls++; throw fetchFailed('ENOTFOUND'); }) as typeof fetch);
  await assert.rejects(c.write('p', 'create_invite', {}), /ENOTFOUND/);
  assert.equal(calls, 3);
});
