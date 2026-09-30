// The MCP wire protocol, asserted.
//
// A HANDSHAKE THAT IS SUBTLY WRONG FAILS SILENTLY: Claude Code simply does not list the server,
// with no error on either side. So the handshake, the notification rule (a message with no id
// must get NO reply) and the "a tool error is a result, not a protocol error" rule are all
// pinned here rather than discovered later in a session that just quietly has no tools.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handle, TOOLS, renderFleet, renderAssignment } from './mcp.ts';
import type { Logger } from '../shared/log.ts';

const nullLog: Logger = { debug() {}, info() {}, warn() {}, error() {} };
const deps = (over: Record<string, unknown> = {}) =>
  ({ client: {}, root: '/tmp', log: nullLog, allowedScope: async () => ['client/**'], ...over }) as never;

test('initialize echoes a protocol version the client asked for', async () => {
  const r = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } }, deps());
  assert.equal((r as never as { result: { protocolVersion: string } }).result.protocolVersion, '2024-11-05');
  assert.equal((r as never as { id: number }).id, 1);
});

test('an unknown protocol version falls back to one we know', async () => {
  const r = await handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } }, deps());
  assert.equal((r as never as { result: { protocolVersion: string } }).result.protocolVersion, '2025-06-18');
});

test('a notification gets no reply at all', async () => {
  assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, deps()), null);
});

test('tools/list returns five usable tools', async () => {
  const r = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/list' }, deps());
  const tools = (r as never as { result: { tools: typeof TOOLS } }).result.tools;
  assert.equal(tools.length, 5);
  for (const t of tools) {
    assert.ok(t.name && t.description.length > 40, `${t.name} needs a description an agent can act on`);
    assert.equal(t.inputSchema.type, 'object');
  }
});

test('an unknown method is a -32601, not a crash', async () => {
  const r = await handle({ jsonrpc: '2.0', id: 4, method: 'nope/nope' }, deps());
  assert.equal((r as never as { error: { code: number } }).error.code, -32601);
});

test('a tool that throws returns an error RESULT, keeping the connection alive', async () => {
  const r = await handle(
    { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'fleet_status', arguments: {} } },
    deps({ client: { readSnapshot: async () => { throw new Error('network is down'); } } }),
  );
  const res = (r as never as { result: { isError: boolean; content: { text: string }[] } }).result;
  assert.equal(res.isError, true);
  assert.match(res.content[0]!.text, /network is down/);
});

const snap = {
  project_name: 'inv',
  agents: [
    { agent_id: 'a1', member_label: 'Priya', role_slug: 'frontend', harness: 'codex', status: 'working', current_task: 't1', last_heartbeat_at: new Date().toISOString(), stale: false },
    { agent_id: 'me', member_label: 'Sibhi', role_slug: 'backend', harness: 'claude-code', status: 'working', current_task: null, last_heartbeat_at: null, stale: true },
  ],
  locks: [{ agent_id: 'a1', task_id: 't1', globs: ['web/**'], acquired_at: '' }],
  tasks: [{ task_id: 't1', title: 'Fix the filter' }],
} as never;

test('the fleet reads as prose: you are marked, stale is offline, held scopes are warned', () => {
  const f = renderFleet(snap, 'me');
  assert.match(f, /Sibhi \(you\)/);
  assert.match(f, /OFFLINE/);
  assert.match(f, /Do NOT edit these/);
  assert.match(f, /web\/\*\*/);
});

test('(control) no warning is emitted when nobody holds a scope', () => {
  assert.doesNotMatch(renderFleet({ ...(snap as object), locks: [] } as never, 'me'), /Do NOT edit/);
});

test('an unassigned agent is still told what its role may write', () => {
  const a = renderAssignment({ agent_id: 'me', role_slug: 'frontend' }, ['client/**'], null);
  assert.match(a, /No task is claimed/);
  assert.match(a, /client\/\*\*/);
});

const staleFact = {
  path: 'contracts/items.v2.yaml', commit_sha: 'a'.repeat(40), committed_at: 1, pins: ['web/**'],
  problems: [], status: 'stale', moved: [{ sha: 'b'.repeat(40), subject: 'Rework filter', committed_at: 2 }],
  more: false, dangling: [],
};

test('blackboard_facts lists stale facts first, and says so when none are', async () => {
  const txt = async (facts: unknown[]) =>
    ((await handle(
      { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'blackboard_facts', arguments: {} } },
      deps({ facts: async () => facts }),
    )) as never as { result: { content: { text: string }[] } }).result.content[0]!.text;

  const withStale = await txt([staleFact, { ...staleFact, path: 'schema/x.sql', status: 'unpinned', pins: [] }]);
  assert.match(withStale, /^STALE \(1\)/);
  assert.match(withStale, /Rework filter/);
  assert.match(withStale, /schema\/x\.sql: unpinned/);
  assert.match(await txt([{ ...staleFact, status: 'fresh' }]), /No fact is stale/);
  assert.match(await txt([]), /holds no facts/);
});

test('my_assignment flags stale facts about the files this agent holds, and only those', async () => {
  const client = {
    whoami: async () => ({ agent_id: 'me', role_slug: 'frontend' }),
    readSnapshot: async () => ({
      snapshot: { tasks: [], agents: [], locks: [{ agent_id: 'me', task_id: 't1', globs: ['web/**'], acquired_at: '' }] },
    }),
  };
  const ask = async (facts: unknown[]) =>
    ((await handle(
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'my_assignment', arguments: {} } },
      deps({ client, facts: async () => facts }),
    )) as never as { result: { content: { text: string }[] } }).result.content[0]!.text;

  assert.match(await ask([staleFact]), /Facts to re-verify:[\s\S]*\n- contracts\/items\.v2\.yaml \(pins web\/\*\*\)/);
  // The other branch: a stale fact about somebody else's directory is not this agent's concern.
  assert.doesNotMatch(await ask([{ ...staleFact, pins: ['server/**'] }]), /Facts to re-verify/);
});
