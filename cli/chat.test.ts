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
import { chatPage } from './chatpage.ts';
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

// ---- order 0083. The design review's findings, as assertions. ----

test('the fonts are served without a nonce, because a browser cannot send one', async () => {
  const { url, close } = await serveChat(deps());
  try {
    const base = url.split('?')[0]!;
    // NO NONCE, NO HEADER -- exactly what a browser sends for a font referenced from CSS. The
    // first version of this route sat behind the nonce check and 403'd every request, so the
    // page rendered in system-ui and looked like the fix had not been applied.
    const res = await fetch(`${base}brand/fonts/PlexSans-400.woff2`);
    assert.equal(res.status, 200, 'a font must not need the nonce');
    assert.equal(res.headers.get('content-type'), 'font/woff2');
    const buf = new Uint8Array(await res.arrayBuffer());
    // BYTES, NOT STATUS. A 200 proves nothing here: the same trap as the catch-all rewrite that
    // served index.html for a missing install.sh for a day. wOF2 is the woff2 magic number.
    assert.ok(buf.length > 5_000, `expected real font bytes, got ${buf.length}`);
    assert.deepEqual([...buf.slice(0, 4)], [0x77, 0x4f, 0x46, 0x32], 'must start with wOF2');
  } finally { close(); }
});

test('the font route cannot be walked out of, and is not a general file server', async () => {
  const { url, close } = await serveChat(deps());
  try {
    const base = url.split('?')[0]!;
    for (const p of [
      'brand/fonts/../../../etc/passwd',
      'brand/fonts/..%2f..%2fpackage.json',
      'brand/fonts/PlexSans-400.woff2.map',
      'brand/fonts/Inter-400.woff2',
      'brand/fonts/',
    ]) {
      const res = await fetch(`${base}${p}`);
      assert.notEqual(res.status, 200, `${p} must not be served`);
    }
  } finally { close(); }
});

test('the board link is present when configured and absent when not', async () => {
  const withBoard = await readContext({ ...deps(), boardUrl: 'https://p1.web.app' });
  assert.equal(withBoard.board_url, 'https://p1.web.app');
  // A project with no hosting has no board. The page hides the button rather than rendering a
  // link that 404s, so the field must be absent rather than an empty string.
  const without = await readContext(deps());
  assert.equal('board_url' in without, false, 'no board must mean no key, not an empty one');
});

test('the page holds no font-size below the 11px floor, and no half-pixel', async () => {
  const html = chatPage('n');
  // DESIGN.md "Type": integers only, 11px floor. This page is the one surface written entirely
  // against the scale, so it is the one that can be asserted rather than migrated -- the board
  // still carries known half-pixel debt.
  const sizes = [...html.matchAll(/font-size:\s*([0-9.]+)px/g)].map((m) => Number(m[1]));
  // The control FIRST: a regex that matches nothing would pass every assertion below.
  assert.ok(sizes.length === 0 || sizes.every((s) => Number.isInteger(s) && s >= 11),
    `off-scale literals: ${sizes.filter((s) => !Number.isInteger(s) || s < 11).join(', ')}`);
  const tokens = [...html.matchAll(/--t-([0-7]):(\d+)px/g)].map((m) => Number(m[2]));
  assert.ok(tokens.length >= 6, `expected the scale to be declared, found ${tokens.length} steps`);
  assert.ok(tokens.every((t) => Number.isInteger(t) && t >= 11), `below the floor: ${tokens}`);
  // And every font-size goes through the scale rather than a literal.
  assert.equal(sizes.length, 0, `literal font-size values remain: ${sizes.join(', ')}`);
});

test('the opening screen is starter prompts, not a welcome paragraph', async () => {
  const html = chatPage('n');
  // The old page opened with "Your agent is on this machine, and it knows where it stands." and
  // three lines explaining what it could do -- happy talk above 600px of dead void, with no
  // action in it. The replacement is buttons written from live state.
  assert.ok(!/knows where it stands/.test(html), 'the happy-talk welcome must be gone');
  assert.match(html, /id="prompts"/, 'the starter prompts container must exist');
  assert.match(html, /function starters/, 'the prompts must be generated from context');
  // And it must say upfront that it cannot edit, rather than letting the user find out by
  // being refused. Being honest about a limit replenishes goodwill; discovering it drains it.
  assert.match(html, /cannot edit files/);
  // Nothing in the starter set may offer an edit, because the agent would be refused.
  assert.ok(!/\bEdit the\b|\bFix the bug and\b/.test(html));
});

test('a failed poll blanks every region, not just the header', async () => {
  const html = chatPage('n');
  // It used to set the header to "offline" and leave the rail reading "loading…" forever: two
  // different answers to "is this connected" on one screen.
  assert.match(html, /function paintOffline/);
  for (const id of ['task', 'fleet', 'contested']) {
    assert.ok(new RegExp(`el\\('${id}'\\)\\.innerHTML`).test(html)
      || new RegExp(`'${id}'`).test(html), `paintOffline must reset #${id}`);
  }
});

test('the rail survives a narrow window instead of being deleted', async () => {
  const html = chatPage('n');
  // `aside{display:none}` under 860px silently removed the live fleet context -- the reason the
  // page exists -- from any split screen. It moves above the conversation now.
  assert.ok(!/aside\{display:none\}/.test(html), 'the rail must not be display:none anywhere');
  assert.match(html, /overflow-wrap:anywhere/, 'the task id must be allowed to break');
});
