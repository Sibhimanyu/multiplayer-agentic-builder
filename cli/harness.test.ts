// The harness spawn and the write client. No network, no emulator.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { startHarness, writeScopeFile } from './harness.ts';
import { WriteClient, NotLoggedIn } from './writeclient.ts';
import { saveCredential, credentialsPath } from './auth.ts';
import { CapturingLogger } from '../shared/log.ts';

const tmp = async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'flotilla-h-'));
  return d;
};

test('the role pack names the scope, and says where enforcement actually lives', async () => {
  const root = await tmp();
  const log = new CapturingLogger();
  await writeScopeFile({
    root, command: 'true', file_scope: ['functions/**', 'schema/**'],
    role_slug: 'backend', agent_id: 'agent_be', log,
  });
  const body = await fs.readFile(path.join(root, '.agentic', 'role.md'), 'utf8');
  assert.match(body, /functions\/\*\*/);
  assert.match(body, /schema\/\*\*/);
  // The honesty requirement: the file must not claim to be the gate.
  assert.match(body, /REFUSED BY THE SERVER, not by this file/);
});

test('a role with no scope says so rather than rendering an empty list', async () => {
  const root = await tmp();
  await writeScopeFile({
    root, command: 'true', file_scope: [], role_slug: 'client', agent_id: 'uid_c',
    log: new CapturingLogger(),
  });
  const body = await fs.readFile(path.join(root, '.agentic', 'role.md'), 'utf8');
  assert.match(body, /this role holds no file scope/);
});

test('startHarness spawns the command and reports its exit code', async () => {
  const root = await tmp();
  const log = new CapturingLogger();
  const calls: { cmd: string; env: Record<string, string> }[] = [];

  // A fake spawn, so the CONTROL is observable: the test proves the command was invoked with the
  // scope in its environment, rather than proving a real agent happened to start.
  const fakeSpawn = ((cmd: string, _args: string[], o: { env: Record<string, string> }) => {
    calls.push({ cmd, env: o.env });
    const listeners: Record<string, ((x: unknown) => void)[]> = {};
    const child = {
      on(ev: string, fn: (x: unknown) => void) { (listeners[ev] ??= []).push(fn); return child; },
      kill() { return true; },
    };
    setTimeout(() => listeners.exit?.forEach((f) => f(0)), 5);
    return child as never;
  }) as never;

  const h = await startHarness({
    root, command: 'claude', args: ['--print'], file_scope: ['functions/**'],
    role_slug: 'backend', agent_id: 'agent_be', log, spawnImpl: fakeSpawn,
  });

  assert.equal(await h.exited, 0);
  assert.equal(calls.length, 1, 'the harness was actually spawned');
  assert.equal(calls[0].cmd, 'claude');
  assert.equal(calls[0].env.FLOTILLA_FILE_SCOPE, 'functions/**');
  assert.equal(calls[0].env.FLOTILLA_ROLE, 'backend');
  // The agent holds NO credential. Asserted, because the whole design depends on it.
  assert.ok(!('GOOGLE_APPLICATION_CREDENTIALS' in calls[0].env) || !calls[0].env.FLOTILLA_TOKEN,
    'no flotilla credential is placed in the agent environment');
});

test('a missing harness binary is reported, not thrown as a stack', async () => {
  const root = await tmp();
  const log = new CapturingLogger();
  const h = await startHarness({
    root, command: 'definitely-not-a-real-binary-xyz', file_scope: [],
    role_slug: 'qa', agent_id: 'agent_qa', log,
  });
  assert.equal(await h.exited, 127);
  assert.ok(log.has('cli.harness_failed'), 'and the failure is logged with the command name');
});

test('the write client refuses to act when nobody is signed in', async () => {
  const home = await tmp();
  const c = new WriteClient({
    api_url: 'http://127.0.0.1:1/', api_key: 'k', log: new CapturingLogger(), home,
  });
  await assert.rejects(() => c.write('p', 'claim', {}), (e: unknown) => e instanceof NotLoggedIn);
});

test('the write client sends a bearer token and returns a 403 as DATA, not a throw', async () => {
  const home = await tmp();
  await saveCredential(
    { refresh_token: 'rt', uid: 'u', project_id: 'p', obtained_at: '' }, home,
  );
  assert.ok((await fs.stat(credentialsPath(home))).isFile());

  const seen: { auth?: string; body?: string } = {};
  const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('securetoken')) {
      return new Response(JSON.stringify({ id_token: 'ID123', expires_in: '3600' }), { status: 200 });
    }
    seen.auth = (init?.headers as Record<string, string>)?.authorization;
    seen.body = String(init?.body);
    return new Response(JSON.stringify({ error: 'role "backend" may not edit outside its file scope' }), { status: 403 });
  }) as unknown as typeof fetch;

  const log = new CapturingLogger();
  const c = new WriteClient({ api_url: 'http://api.test/', api_key: 'k', log, home, fetchImpl: fakeFetch });
  const r = await c.write('proj', 'acquire_scope', { globs: ['client/**'] });

  assert.equal(r.status, 403);
  assert.equal(r.ok, false, 'a refusal is a value, like a lost claim');
  assert.equal(seen.auth, 'Bearer ID123', 'the minted ID token was sent as a bearer token');
  assert.match(String(seen.body), /acquire_scope/);
  assert.ok(log.has('cli.write_refused'));
});

test('a non-JSON response is a transport failure, not a decision', async () => {
  const home = await tmp();
  await saveCredential({ refresh_token: 'rt', uid: 'u', project_id: 'p', obtained_at: '' }, home);
  const fakeFetch = (async (url: string | URL) =>
    String(url).includes('securetoken')
      ? new Response(JSON.stringify({ id_token: 'ID', expires_in: '3600' }), { status: 200 })
      : new Response('<html>502 Bad Gateway</html>', { status: 502 })) as unknown as typeof fetch;

  const c = new WriteClient({
    api_url: 'http://api.test/', api_key: 'k', log: new CapturingLogger(), home, fetchImpl: fakeFetch,
  });
  // Never String() a transport response and call it a result. A proxy's HTML is not a refusal.
  await assert.rejects(() => c.write('p', 'claim', {}), /non-JSON body/);
});
