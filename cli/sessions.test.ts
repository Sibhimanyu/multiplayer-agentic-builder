// The agent's side of shared sessions: the edit guard, its install, and one sync pass.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import type { ApiClient } from './client.ts';
import {
  CLAUDE_SETTINGS,
  FENCE_FILE,
  MESSAGES_FILE,
  installGuardHook,
  readFence,
  runGuard,
  syncSessions,
  writeFence,
} from './sessions.ts';
import type { Message, ScopeRequest } from '../shared/store/sessions.ts';
import type { Logger } from '../shared/log.ts';

const quiet: Logger = { info() {}, warn() {}, error() {}, debug() {} } as unknown as Logger;

async function checkout(task: string | null = 'task_t14'): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flotilla-sessions-'));
  await writeFence(root, { role_slug: 'priya', file_scope: ['slides/05-*.html'], task_id: null, granted: [] });
  if (task) {
    await fs.mkdir(path.join(root, '.agentic/tasks'), { recursive: true });
    await fs.writeFile(path.join(root, '.agentic/tasks/current-task.md'), `task_id: ${task}\n`);
  }
  return root;
}

const call = (root: string, file: string) =>
  JSON.stringify({ tool_name: 'Edit', cwd: root, tool_input: { file_path: path.join(root, file) } });

// ---- the guard -------------------------------------------------------------------------------

test('the guard lets an edit inside the seat through and stops one outside it', async () => {
  const root = await checkout();
  assert.deepEqual(await runGuard(call(root, 'slides/05-results.html'), root), { code: 0, message: '' });
  const r = await runGuard(call(root, 'slides/02-intro.html'), root);
  assert.equal(r.code, 2);
  assert.match(r.message, /request_scope/);
});

test('a grant counts only for the ticket it was given for', async () => {
  const root = await checkout('task_t14');
  await writeFence(root, { role_slug: 'priya', file_scope: ['slides/05-*.html'], task_id: 'task_t14', granted: ['slides/02-intro.html'] });
  assert.equal((await runGuard(call(root, 'slides/02-intro.html'), root)).code, 0);
  await fs.writeFile(path.join(root, '.agentic/tasks/current-task.md'), 'task_id: task_next\n');
  assert.equal((await runGuard(call(root, 'slides/02-intro.html'), root)).code, 2, 'the next ticket does not inherit it');
});

test('the guard finds the checkout from a subdirectory', async () => {
  const root = await checkout();
  const sub = path.join(root, 'slides');
  await fs.mkdir(sub, { recursive: true });
  const r = await runGuard(JSON.stringify({ cwd: sub, tool_input: { file_path: '02-intro.html' } }), sub);
  assert.equal(r.code, 2);
});

test('outside any Flotilla checkout, or on input it cannot read, the guard allows', async () => {
  const bare = await fs.mkdtemp(path.join(os.tmpdir(), 'flotilla-bare-'));
  assert.equal((await runGuard(call(bare, 'anything.txt'), bare)).code, 0);
  const root = await checkout();
  assert.equal((await runGuard('not json', root)).code, 0);
  assert.equal((await runGuard(JSON.stringify({ tool_input: {} }), root)).code, 0);
});

// ---- installing it -------------------------------------------------------------------------------

test('installing the guard merges into existing settings and is idempotent', async () => {
  const root = await checkout();
  const file = path.join(root, CLAUDE_SETTINGS);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'say done' }] }] } }));

  assert.equal(await installGuardHook(root), true);
  assert.equal(await installGuardHook(root), false, 'a second install changes nothing');
  const cfg = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(cfg.model, 'opus', 'other settings survive');
  assert.equal(cfg.hooks.Stop.length, 1, 'other hooks survive');
  assert.equal(cfg.hooks.PreToolUse.length, 1);
  assert.equal(cfg.hooks.PreToolUse[0].hooks[0].command, 'flotilla guard');
});

// ---- one sync pass ---------------------------------------------------------------------------

function fakeClient(o: {
  messages?: Message[];
  requests?: ScopeRequest[];
  locks?: { agent_id: string; task_id: string; globs: string[]; acquired_at: string }[];
  acquire?: { ok: true } | { ok: false; conflicts: [] };
}) {
  const acquired: { task: string; globs: string[] }[] = [];
  const client = {
    async readMessages(since: number) { return (o.messages ?? []).filter((m) => m.sent_at_ms > since); },
    async myScopeRequests() { return o.requests ?? []; },
    async readSnapshot() { return { snapshot: { locks: o.locks ?? [] }, etag: '' }; },
    async acquireScope(task: string, globs: string[]) { acquired.push({ task, globs }); return o.acquire ?? { ok: true }; },
  } as unknown as ApiClient;
  return { client, acquired };
}

const msg = (id: string, from: string, at: number): Message => ({
  message_id: id, from_id: from, from_kind: 'member', from_label: 'Sam', to: 'agent_p', to_label: 'Priya',
  body: `hello ${id}`, in_reply_to: null, sent_at_ms: at,
});
const req = (o: Partial<ScopeRequest>): ScopeRequest => ({
  request_id: 'r1', agent_id: 'agent_p', label: 'Priya', role_slug: 'priya', globs: ['slides/02-intro.html'],
  reason: 'typo', task_id: 'task_t14', status: 'granted', grant: 'task', claimed_at: 'c1', decided_by: 'Sam',
  decided_at_ms: 1, denied_reason: null, created_at_ms: 1, ...o,
});
const me = { agent_id: 'agent_p', role_slug: 'priya', file_scope: ['slides/05-*.html'] };

test('messages and answers are delivered once each, and the agent\'s own messages are not echoed', async () => {
  const root = await checkout();
  const { client } = fakeClient({ messages: [msg('m1', 'uid_sam', 10), msg('m2', 'agent_p', 11)], requests: [req({ status: 'denied', grant: null, denied_reason: 'mine' })] });
  const lines: string[] = [];
  const first = await syncSessions(root, client, me, (l) => lines.push(l), quiet);
  assert.deepEqual([first.messages, first.decisions], [1, 1]);
  const second = await syncSessions(root, client, me, (l) => lines.push(l), quiet);
  assert.deepEqual([second.messages, second.decisions], [0, 0], 'nothing twice');

  const file = (await fs.readFile(path.join(root, MESSAGES_FILE), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(file.map((l) => l.kind), ['message', 'scope_denied']);
  assert.ok(lines.some((l) => l.includes('hello m1')) && !lines.some((l) => l.includes('hello m2')));
});

test('a grant for the current ticket widens the lock to the union and records it in the fence', async () => {
  const root = await checkout('task_t14');
  const { client, acquired } = fakeClient({
    requests: [req({})],
    locks: [{ agent_id: 'agent_p', task_id: 'task_t14', globs: ['slides/05-*.html'], acquired_at: '' }],
  });
  const r = await syncSessions(root, client, me, () => {}, quiet);
  assert.deepEqual(acquired, [{ task: 'task_t14', globs: ['slides/05-*.html', 'slides/02-intro.html'] }]);
  assert.deepEqual(r.widened, ['slides/02-intro.html']);
  const fence = await readFence(root);
  assert.deepEqual(fence, { role_slug: 'priya', file_scope: ['slides/05-*.html'], task_id: 'task_t14', granted: ['slides/02-intro.html'] });
});

test('a grant for another ticket, or a lock already wide enough, acquires nothing', async () => {
  const other = await checkout('task_other');
  const a = fakeClient({ requests: [req({})] });
  await syncSessions(other, a.client, me, () => {}, quiet);
  assert.deepEqual(a.acquired, [], 'grant was for task_t14');
  assert.deepEqual((await readFence(other))?.granted, []);

  const wide = await checkout('task_t14');
  const b = fakeClient({ requests: [req({})], locks: [{ agent_id: 'agent_p', task_id: 'task_t14', globs: ['slides/05-*.html', 'slides/02-intro.html'], acquired_at: '' }] });
  await syncSessions(wide, b.client, me, () => {}, quiet);
  assert.deepEqual(b.acquired, []);
});

test('a lock conflict on a granted file leaves the grant standing for the next pass', async () => {
  const root = await checkout('task_t14');
  const { client, acquired } = fakeClient({ requests: [req({})], acquire: { ok: false, conflicts: [] } });
  const r = await syncSessions(root, client, me, () => {}, quiet);
  assert.equal(acquired.length, 1);
  assert.deepEqual(r.widened, []);
  assert.deepEqual((await readFence(root))?.granted, ['slides/02-intro.html']);
});

test('the fence file lives where the guard looks for it', () => {
  assert.equal(FENCE_FILE, '.agentic/fence.json');
});
