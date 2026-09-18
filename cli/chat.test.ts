// The loopback chat server. Order 0082.
//
// THE NONCE AND THE HOST CHECK ARE THE SECURITY OF THIS FEATURE, so they are asserted rather
// than assumed. This endpoint spawns a coding agent with write access to the repository: any page
// in any browser tab can POST to 127.0.0.1, so a missing nonce means a visited website could
// drive the user's agent. Both are tested with a control that proves the happy path still works,
// because "everything is refused" would pass a test that only checks refusals.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { serveChat, readContext, type ChatDeps } from './chat.ts';
import type { Logger } from '../shared/log.ts';

const nullLog: Logger = { debug() {}, info() {}, warn() {}, error() {} };

const snap = {
  project_name: 'Inventory Tracker',
  agents: [
    { agent_id: 'me', member_label: 'Sibhi', role_slug: 'frontend', harness: 'claude-code', status: 'working', current_task: 't1', last_heartbeat_at: new Date().toISOString(), stale: false },
    { agent_id: 'other', member_label: 'Marcus', role_slug: 'backend', harness: 'codex', status: 'working', current_task: null, last_heartbeat_at: null, stale: true },
  ],
  locks: [
    { agent_id: 'me', task_id: 't1', globs: ['client/**'], acquired_at: '' },
    { agent_id: 'other', task_id: 't2', globs: ['server/**'], acquired_at: '' },
  ],
  tasks: [{ task_id: 't1', title: 'Fix the filter', status: 'in_progress', claimed_by: 'me', file_scope: ['client/**'] }],
};

const deps = (): ChatDeps => ({
  client: {
    whoami: async () => ({ agent_id: 'me', role_slug: 'frontend', project_id: 'p1' }),
    readSnapshot: async () => ({ snapshot: snap, etag: 'x' }),
  } as never,
  root: '/tmp',
  log: nullLog,
  mcpConfig: '/tmp/mcp.json',
  agent: 'claude',
  allowedScope: async () => ['client/**'],
});

test('the sidebar separates what YOU hold from what others hold', async () => {
  const c = await readContext(deps());
  assert.equal(c.project, 'Inventory Tracker');
  assert.equal(c.role, 'frontend');
  assert.deepEqual(c.scope, ['client/**']);
  assert.equal(c.task?.task_id, 't1');
  // The one fact a designer most needs: the globs someone ELSE holds, never their own.
  assert.deepEqual(c.contested, ['server/**']);
  assert.ok(c.agents.find((a) => a.you)?.holds.includes('client/**'));
  assert.equal(c.agents.find((a) => a.label === 'Marcus')?.stale, true);
});

test('a request with no nonce is refused, and one with it is served', async () => {
  const { url, close } = await serveChat(deps());
  try {
    const base = url.split('?')[0]!;
    const nonce = new URL(url).searchParams.get('n')!;

    // The control FIRST: without it, "everything 403s" would pass this test.
    const good = await fetch(url);
    assert.equal(good.status, 200, 'the nonced URL must serve the page');
    assert.match(await good.text(), /Flotilla chat/);

    assert.equal((await fetch(base)).status, 403, 'no nonce must be refused');
    assert.equal((await fetch(`${base}?n=wrong`)).status, 403, 'a wrong nonce must be refused');

    // The header form is what the page itself uses for fetches.
    const viaHeader = await fetch(`${base}api/context`, { headers: { 'x-flotilla-nonce': nonce } });
    assert.equal(viaHeader.status, 200);
  } finally { close(); }
});

test('sending with no nonce cannot run the agent', async () => {
  const { url, close } = await serveChat(deps());
  try {
    const base = url.split('?')[0]!;
    const res = await fetch(`${base}api/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'do something dangerous' }),
    });
    assert.equal(res.status, 403);
  } finally { close(); }
});

test('an off-loopback Host is refused even with a good nonce', async () => {
  const { url, close } = await serveChat(deps());
  try {
    const u = new URL(url);
    const nonce = u.searchParams.get('n')!;
    // A RAW SOCKET, NOT fetch. `Host` is a forbidden header name, so fetch silently strips it and
    // the server sees 127.0.0.1 — the first version of this test passed the wrong request and
    // reported the check working when it had never been exercised.
    const status = await new Promise<number>((resolve, reject) => {
      const sock = connect(Number(u.port), '127.0.0.1', () => {
        sock.write(
          `GET /?n=${nonce} HTTP/1.1\r\nHost: evil.example.com\r\nConnection: close\r\n\r\n`,
        );
      });
      let buf = '';
      sock.on('data', (d) => { buf += d; });
      sock.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d{3})/.exec(buf)?.[1] ?? 0)));
      sock.on('error', reject);
    });
    assert.equal(status, 403, 'a rebound Host must be refused');
  } finally { close(); }
});

test('an empty message is rejected before the agent is spawned', async () => {
  const { url, close } = await serveChat(deps());
  try {
    const nonce = new URL(url).searchParams.get('n')!;
    const res = await fetch(`${url.split('?')[0]}api/send`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-flotilla-nonce': nonce },
      body: JSON.stringify({ message: '   ' }),
    });
    assert.equal(res.status, 400);
  } finally { close(); }
});
