// `flotilla handoff` and the claim-side delivery.
//
// Real git, a real bare origin, a fake API client -- the same split ship.test.ts makes, for the
// same reason. What a handoff promises is about git (the work is on the branch before the claim
// is let go; the receiver's checkout lands on it; a dirty tree is never touched), and a mocked
// runner would assert strings passed to a function that never ran. The API is faked because its
// half is held to account by the conformance suite and functions/src/api.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { git } from './blackboard.ts';
import {
  branchForTask, continueOnBranch, deliverHandoff, performHandoff, releaseLockFor, type HandoffClient,
} from './handoff.ts';
import { LAYOUT, renderCurrentTask } from './agentic.ts';
import { readPending } from './outbox.ts';
import { handle } from './mcp.ts';
import type { Handoff, HandoffResult, ScopeLock, Snapshot, TaskView } from '../shared/store/types.ts';
import type { Logger } from '../shared/log.ts';

const nullLog: Logger = { debug() {}, info() {}, warn() {}, error() {} };

async function repo(): Promise<{ dir: string; root: string; origin: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flotilla-handoff-test-'));
  const root = path.join(dir, 'work');
  const origin = path.join(dir, 'origin.git');
  await fs.mkdir(path.join(root, 'web'), { recursive: true });
  await git(['init', '--bare', '-b', 'main', origin], dir);
  await git(['init', '-b', 'main'], root);
  await git(['config', 'user.email', 'test@example.com'], root);
  await git(['config', 'user.name', 'Test'], root);
  await git(['remote', 'add', 'origin', origin], root);
  await fs.writeFile(path.join(root, 'web', 'index.html'), 'base\n');
  await fs.writeFile(path.join(root, 'README'), 'base\n');
  await git(['add', '-A'], root);
  await git(['commit', '-m', 'base'], root);
  await git(['push', 'origin', 'main'], root);
  return { dir, root, origin, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

/** A second machine: a fresh clone of the same origin. */
async function teammate(dir: string, origin: string): Promise<string> {
  const other = path.join(dir, 'teammate');
  await git(['clone', '-q', origin, other], dir);
  await git(['config', 'user.email', 't@example.com'], other);
  await git(['config', 'user.name', 'T'], other);
  return other;
}

const TASK = 'task_fix_the_filter';
const BRANCH = 'agent/frontend/fix-the-filter';

function taskView(over: Partial<TaskView> = {}): TaskView {
  return {
    task_id: TASK, title: 'Fix the filter', kind: 'frontend', status: 'in_progress',
    claimed_by: 'ag_me', branch: null, pr_url: null, pr_number: null, ci: null,
    depends_on: [], blocked_by: null, blocked_reason: null, file_scope: ['web/**'],
    updated_at: '2026-09-30T00:00:00.000Z', ...over,
  };
}

/** A fake API that records what it was asked, and answers the handoff the way the server does. */
function fakeClient(opts: {
  task?: TaskView; locks?: ScopeLock[]; answer?: HandoffResult; after?: TaskView;
} = {}) {
  const calls = { handoff: [] as { task_id: string; note: string; branch: string | null; head_sha: string | null }[], releaseScope: 0, snapshots: 0 };
  const snap = (task: TaskView | undefined): { snapshot: Snapshot; etag: string } => ({
    etag: 'e',
    snapshot: {
      project_id: 'p', seq: 1, generated_at: '', project_name: 'p', repo_url: '',
      tasks: task ? [task] : [], agents: [], contracts: [],
      locks: opts.locks ?? [{ agent_id: 'ag_me', task_id: TASK, globs: ['web/**'], acquired_at: '' }],
    },
  });
  const client: HandoffClient = {
    whoami: async () => ({ agent_id: 'ag_me', role_slug: 'frontend' }),
    readSnapshot: async () => {
      calls.snapshots++;
      return snap(calls.snapshots > 1 && opts.after ? opts.after : (opts.task ?? taskView()));
    },
    handoffTask: async (task_id, h) => {
      calls.handoff.push({ task_id, ...h });
      return opts.answer ?? {
        ok: true, seq: 7,
        handoff: { from: { agent_id: 'ag_me', label: 'Me' }, handed_off_by: 'ag_me', ...h, at: '2026-09-30T01:00:00.000Z' },
      };
    },
    releaseScope: async () => { calls.releaseScope++; },
  };
  return { client, calls };
}

const remoteTip = async (root: string, branch: string): Promise<string> =>
  (await git(['ls-remote', 'origin', `refs/heads/${branch}`], root)).stdout.trim().split(/\s+/)[0] ?? '';

// ---- the three branches the command has -------------------------------------------------

test('no note: refused before anything is pushed or sent, and pointed at release', async () => {
  const { root, cleanup } = await repo();
  try {
    await fs.writeFile(path.join(root, 'web', 'index.html'), 'half done\n');
    const { client, calls } = fakeClient();
    for (const note of ['', '   ', undefined]) {
      const r = await performHandoff({ root, task_id: TASK, note, client, log: nullLog });
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.reason, 'no_note');
      assert.match(!r.ok ? r.message : '', /flotilla release/);
    }
    assert.equal(calls.snapshots, 0, 'refused before any network call');
    assert.equal(calls.handoff.length, 0);
    assert.equal(await remoteTip(root, BRANCH), '', 'nothing was pushed');
  } finally { await cleanup(); }
});

test('happy path: the checkpoint is pushed FIRST, then the handoff names it, then the lock goes', async () => {
  const { root, cleanup } = await repo();
  try {
    await fs.writeFile(path.join(root, 'web', 'index.html'), 'half done\n');
    await fs.writeFile(path.join(root, 'README'), 'not mine to ship\n');
    const statusBefore = (await git(['status', '--porcelain'], root)).stdout;
    const { client, calls } = fakeClient();

    const r = await performHandoff({ root, task_id: TASK, note: '  GET done; POST next  ', client, log: nullLog });
    assert.equal(r.ok, true);
    if (!r.ok) return;

    const tip = await remoteTip(root, BRANCH);
    assert.match(tip, /^[0-9a-f]{40}$/, 'the branch exists on origin');
    assert.deepEqual(r.pushed?.files, ['web/index.html'], 'the in-scope file, and only it');
    assert.equal((await git(['show', `${tip}:web/index.html`], root)).stdout, 'half done\n');
    assert.equal((await git(['show', `${tip}:README`], root)).stdout, 'base\n', 'out of scope stays out');

    assert.deepEqual(calls.handoff, [{ task_id: TASK, note: 'GET done; POST next', branch: BRANCH, head_sha: tip }]);
    assert.equal(calls.releaseScope, 1, 'the lock is released through the release path');
    assert.deepEqual(r.released_lock, ['web/**']);
    // Exactly as `ship --wip`: the human's tree is untouched.
    assert.equal((await git(['status', '--porcelain'], root)).stdout, statusBefore);
  } finally { await cleanup(); }
});

test('not the claimant: nothing of theirs is pushed, the server refuses, nothing is released', async () => {
  const { root, cleanup } = await repo();
  try {
    await fs.writeFile(path.join(root, 'web', 'index.html'), 'my own unrelated edit\n');
    const { client, calls } = fakeClient({
      task: taskView({ claimed_by: 'ag_other', branch: 'agent/frontend/fix-the-filter' }),
      locks: [{ agent_id: 'ag_other', task_id: TASK, globs: ['web/**'], acquired_at: '' }],
      answer: { ok: false, owner: 'ag_other' },
    });
    const r = await performHandoff({ root, task_id: TASK, note: 'let me take it', client, log: nullLog });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, 'not_claimant');
    assert.equal(!r.ok && r.owner, 'ag_other');
    assert.match(!r.ok ? r.message : '', /held by ag_other/);
    assert.equal(await remoteTip(root, BRANCH), '', 'a non-claimant never pushes');
    assert.equal(calls.releaseScope, 0, 'and never frees a lock');
    // It still ASKED -- the owner case is the server's decision -- pointing at the card's branch.
    assert.equal(calls.handoff[0]?.branch, 'agent/frontend/fix-the-filter');
    assert.equal(calls.handoff[0]?.head_sha, null);
  } finally { await cleanup(); }
});

// ---- the edges -----------------------------------------------------------------------------

test('a failed push hands off nothing and keeps the claim', async () => {
  const { root, cleanup } = await repo();
  try {
    await fs.writeFile(path.join(root, 'web', 'index.html'), 'half done\n');
    await git(['remote', 'set-url', 'origin', path.join(root, 'no-such-origin.git')], root);
    const { client, calls } = fakeClient();
    const r = await performHandoff({ root, task_id: TASK, note: 'n', client, log: nullLog });
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.reason, 'ship_failed');
    assert.match(!r.ok ? r.message : '', /you still hold/);
    assert.equal(calls.handoff.length, 0, 'work that never left the machine is never handed off');
    assert.equal(calls.releaseScope, 0);
  } finally { await cleanup(); }
});

test('no scope and no branch: the note still travels, pointing at nothing', async () => {
  const { root, cleanup } = await repo();
  try {
    const { client, calls } = fakeClient({ locks: [] });
    const r = await performHandoff({ root, task_id: TASK, note: 'read the code, no edits yet', client, log: nullLog });
    assert.equal(r.ok, true);
    assert.deepEqual(calls.handoff[0], { task_id: TASK, note: 'read the code, no edits yet', branch: null, head_sha: null });
    assert.equal(calls.releaseScope, 0, 'no lock was held for this task, so none is released');
  } finally { await cleanup(); }
});

test('a replayed handoff whose first attempt landed is a success, not a refusal', async () => {
  const { root, cleanup } = await repo();
  try {
    const landed: Handoff = { from: { agent_id: 'ag_me', label: 'Me' }, handed_off_by: 'ag_me', note: 'n', branch: null, head_sha: null, at: 'x' };
    const { client } = fakeClient({
      locks: [], answer: { ok: false, owner: null },
      after: taskView({ claimed_by: null, status: 'open', handoffs: [landed] }),
    });
    const r = await performHandoff({ root, task_id: TASK, note: 'n', client, log: nullLog });
    assert.equal(r.ok, true);
    // Control: a DIFFERENT note on the card is still a refusal.
    const other = fakeClient({ locks: [], answer: { ok: false, owner: null }, after: taskView({ claimed_by: null, handoffs: [{ ...landed, note: 'else' }] }) });
    const r2 = await performHandoff({ root, task_id: TASK, note: 'n', client: other.client, log: nullLog });
    assert.equal(!r2.ok && r2.reason, 'not_claimant');
  } finally { await cleanup(); }
});

test('releaseLockFor frees only this task\'s lock', async () => {
  let released = 0;
  const c = { releaseScope: async () => { released++; } };
  const locks: ScopeLock[] = [{ agent_id: 'a', task_id: 'task_other', globs: ['x/**'], acquired_at: '' }];
  assert.deepEqual(await releaseLockFor(c, locks, 'a', 'task_mine'), []);
  assert.equal(released, 0, 'another task\'s lock is left alone');
  assert.deepEqual(await releaseLockFor(c, [...locks, { agent_id: 'a', task_id: 'task_mine', globs: ['y/**'], acquired_at: '' }], 'a', 'task_mine'), ['y/**']);
  assert.equal(released, 1);
});

// ---- the receiving half -------------------------------------------------------------------

async function handedOffTo(): Promise<{ dir: string; root: string; origin: string; other: string; h: Handoff; cleanup: () => Promise<void> }> {
  const r = await repo();
  await fs.writeFile(path.join(r.root, 'web', 'index.html'), 'half done\n');
  const { client, calls } = fakeClient();
  const out = await performHandoff({ root: r.root, task_id: TASK, note: 'GET done; POST next', client, log: nullLog });
  assert.equal(out.ok, true);
  const other = await teammate(r.dir, r.origin);
  const sent = calls.handoff[0]!;
  const h: Handoff = { from: { agent_id: 'ag_me', label: 'Me' }, handed_off_by: 'ag_me', note: sent.note, branch: sent.branch, head_sha: sent.head_sha, at: '2026-09-30T01:00:00.000Z' };
  return { ...r, other, h };
}

test('the next claimant, on a clean tree, is checked out onto the handed-off branch', async () => {
  const { other, h, cleanup } = await handedOffTo();
  try {
    // Flotilla's own files are there, as they are after `claim` writes the tree: not dirt.
    await fs.mkdir(path.join(other, '.agentic'), { recursive: true });
    await fs.writeFile(path.join(other, '.agentic', 'state.json'), '{}\n');
    await fs.writeFile(path.join(other, 'AGENTS.md'), '# role\n');

    const task = taskView({ claimed_by: 'ag_next', handoffs: [h] });
    const lines = await deliverHandoff(other, task, nullLog);
    assert.ok(lines.some((l) => l.includes('GET done; POST next')), 'the person sees the note');
    assert.ok(lines.some((l) => l.includes(`checked out ${BRANCH}`)));
    assert.equal((await git(['rev-parse', '--abbrev-ref', 'HEAD'], other)).stdout.trim(), BRANCH);
    assert.equal(await fs.readFile(path.join(other, 'web', 'index.html'), 'utf8'), 'half done\n', 'the work is in the tree');

    const inbox = (await fs.readFile(path.join(other, LAYOUT.inbox), 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].kind, 'handoff_received');
    assert.equal(inbox[0].body.note, 'GET done; POST next');
    assert.equal(inbox[0].body.branch, BRANCH);
    assert.equal(inbox[0].body.checked_out, true);
  } finally { await cleanup(); }
});

test('a dirty tree is never touched: the claimant is told the commands instead', async () => {
  const { other, h, cleanup } = await handedOffTo();
  try {
    await fs.writeFile(path.join(other, 'README'), 'my own work in progress\n');
    const r = await continueOnBranch(other, h);
    assert.equal(r.checked_out, false);
    assert.match(!r.checked_out ? r.reason : '', /git fetch origin agent\/frontend\/fix-the-filter/);
    assert.equal((await git(['rev-parse', '--abbrev-ref', 'HEAD'], other)).stdout.trim(), 'main');
    assert.equal(await fs.readFile(path.join(other, 'README'), 'utf8'), 'my own work in progress\n');

    // And the agent still gets the note, with the hint.
    await deliverHandoff(other, taskView({ handoffs: [h] }), nullLog);
    const line = JSON.parse((await fs.readFile(path.join(other, LAYOUT.inbox), 'utf8')).trim());
    assert.equal(line.body.checked_out, false);
    assert.match(line.body.continue_hint, /working tree has changes/);
  } finally { await cleanup(); }
});

test('a local branch with commits the handoff lacks is not reset', async () => {
  const { other, h, cleanup } = await handedOffTo();
  try {
    await git(['checkout', '-q', '-b', BRANCH], other);
    await fs.writeFile(path.join(other, 'README'), 'local commit\n');
    await git(['commit', '-qam', 'mine'], other);
    await git(['checkout', '-q', 'main'], other);
    const r = await continueOnBranch(other, h);
    assert.equal(r.checked_out, false);
    assert.match(!r.checked_out ? r.reason : '', /has commits/);
  } finally { await cleanup(); }
});

test('no handoff on the task: nothing printed, nothing checked out, nothing in the inbox', async () => {
  const { root, cleanup } = await repo();
  try {
    assert.deepEqual(await deliverHandoff(root, taskView(), nullLog), []);
    assert.equal(await fs.readFile(path.join(root, LAYOUT.inbox), 'utf8').catch(() => 'absent'), 'absent');
  } finally { await cleanup(); }
});

test('a handoff with no branch says so rather than fetching nothing', async () => {
  const r = await continueOnBranch('/nonexistent', { from: { agent_id: 'a', label: 'a' }, handed_off_by: 'a', note: 'n', branch: null, head_sha: null, at: 'x' });
  assert.equal(r.checked_out, false);
  assert.match(!r.checked_out ? r.reason : '', /nothing was pushed/);
});

test('ship continues on the handed-off branch, and falls back to its own without one', () => {
  const h: Handoff = { from: { agent_id: 'a', label: 'a' }, handed_off_by: 'a', note: 'n', branch: 'agent/backend/items', head_sha: null, at: 'x' };
  assert.equal(branchForTask('frontend', { task_id: 'task_items', handoffs: [h] }), 'agent/backend/items');
  assert.equal(branchForTask('frontend', { task_id: 'task_items' }), 'agent/frontend/items');
  assert.equal(branchForTask('frontend', { task_id: 'task_items', handoffs: [{ ...h, branch: null }] }), 'agent/frontend/items');
});

test('current-task.md carries the history, newest first; a never-handed-off task has none', () => {
  const h = (note: string, at: string): Handoff => ({ from: { agent_id: 'a', label: 'Bea' }, handed_off_by: 'a', note, branch: BRANCH, head_sha: 'e'.repeat(40), at });
  const md = renderCurrentTask(taskView({ handoffs: [h('first pass', '1'), h('second pass', '2')] }));
  assert.match(md, /## Handed off to you/);
  assert.ok(md.indexOf('second pass') < md.indexOf('first pass'), 'newest first');
  assert.match(md, /agent\/frontend\/fix-the-filter/);
  assert.doesNotMatch(renderCurrentTask(taskView()), /Handed off/);
});

// ---- the agent's own way in: outbox and MCP ------------------------------------------------

test('the outbox accepts handoff_requested as a request kind', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flotilla-handoff-outbox-'));
  try {
    await fs.mkdir(path.join(root, '.agentic'), { recursive: true });
    await fs.writeFile(path.join(root, LAYOUT.outbox), [
      JSON.stringify({ kind: 'handoff_requested', body: { task_id: TASK, note: 'out of budget' } }),
      JSON.stringify({ kind: 'handoff_whenever', body: {} }), // control: an unknown kind is still refused
      '',
    ].join('\n'));
    const pending = await readPending(root, nullLog);
    assert.deepEqual(pending.map((p) => p.kind), ['handoff_requested']);
    assert.equal(pending[0]!.body.note, 'out of budget');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('the MCP handoff tool refuses no note, and otherwise queues one outbox line', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flotilla-handoff-mcp-'));
  try {
    await fs.mkdir(path.join(root, '.agentic', 'tasks'), { recursive: true });
    await fs.writeFile(path.join(root, LAYOUT.current_task), `# Fix\n\ntask_id: ${TASK}\n`);
    const deps = { client: {}, root, log: nullLog, allowedScope: async () => [] } as never;
    const call = async (args: Record<string, unknown>) => {
      const r = await handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'handoff', arguments: args } }, deps);
      return (r as never as { result: { content: { text: string }[] } }).result.content[0]!.text;
    };

    assert.match(await call({ note: '  ' }), /Not queued.*flotilla release/);
    assert.equal(await fs.readFile(path.join(root, LAYOUT.outbox), 'utf8').catch(() => ''), '', 'nothing queued');

    assert.match(await call({ note: 'GET done' }), /Queued a handoff of task_fix_the_filter/);
    const pending = await readPending(root, nullLog);
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.kind, 'handoff_requested');
    assert.deepEqual(pending[0]!.body, { task_id: TASK, note: 'GET done' });
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
