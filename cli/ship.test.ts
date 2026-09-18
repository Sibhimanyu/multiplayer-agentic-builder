// `flotilla ship`. Order 0085.
//
// These run against a REAL git repository in a temp dir, not a mocked runner. The whole claim of
// this module is about what git does to a working tree -- that the index is untouched, that HEAD
// does not move, that a file outside the scope stays out of the commit. A fake runner would
// assert that the right strings were passed to a function that never ran, which is exactly the
// kind of test that passes while the feature is broken.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { git } from './blackboard.ts';
import { ShipError, branchFor, classifyChanges, inScope, parseStatus, scopeForTask, shipScope, slugFor } from './ship.ts';
import type { Logger } from '../shared/log.ts';

const nullLog: Logger = { debug() {}, info() {}, warn() {}, error() {} };

/** A repo with an `origin` it can really push to: origin is a bare repo next door. */
async function repo(): Promise<{ root: string; origin: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flotilla-ship-test-'));
  const root = path.join(dir, 'work');
  const origin = path.join(dir, 'origin.git');
  await fs.mkdir(root, { recursive: true });
  await git(['init', '--bare', '-b', 'main', origin], dir);
  await git(['init', '-b', 'main'], root);
  await git(['config', 'user.email', 'test@example.com'], root);
  await git(['config', 'user.name', 'Test'], root);
  await git(['remote', 'add', 'origin', origin], root);
  await fs.mkdir(path.join(root, 'web'), { recursive: true });
  await fs.mkdir(path.join(root, 'server'), { recursive: true });
  await fs.writeFile(path.join(root, 'web', 'index.html'), 'base\n');
  await fs.writeFile(path.join(root, 'server', 'index.js'), 'base\n');
  await git(['add', '-A'], root);
  await git(['commit', '-m', 'base'], root);
  await git(['push', 'origin', 'main'], root);
  return { root, origin, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
}

const req = (root: string, scope: string[]) => ({
  root, scope,
  branch: 'agent/frontend/fix-the-filter',
  agent_id: 'ag_1', role_slug: 'frontend',
  task_id: 'task_fix_the_filter', task_title: 'Fix the filter',
});

/** What a commit actually contains, as `path` lines. */
const filesIn = async (root: string, sha: string): Promise<string[]> =>
  (await git(['ls-tree', '-r', '--name-only', sha], root)).stdout.trim().split('\n').filter(Boolean);

test('ships only what is inside the held scope', async () => {
  const { root, cleanup } = await repo();
  try {
    await fs.writeFile(path.join(root, 'web', 'index.html'), 'agent did this\n');
    await fs.writeFile(path.join(root, 'server', 'index.js'), 'someone else did this\n');

    const r = await shipScope(req(root, ['web/**']), nullLog);
    assert.equal(r.unchanged, false);
    assert.deepEqual(r.files, ['web/index.html']);
    // NAMED, not silently dropped: the most confusing possible outcome is work that exists in
    // the tree, is absent from the branch, and was never mentioned.
    assert.deepEqual(r.skipped, ['server/index.js']);

    const shipped = await git(['show', `${r.commit_sha}:web/index.html`], root);
    assert.equal(shipped.stdout, 'agent did this\n');
    // The out-of-scope file is in the commit at its BASE content, never the edited content.
    const other = await git(['show', `${r.commit_sha}:server/index.js`], root);
    assert.equal(other.stdout, 'base\n', 'a neighbour\'s uncommitted edit must not ride along');
  } finally { await cleanup(); }
});

test('the working tree, HEAD and the index are all untouched', async () => {
  const { root, cleanup } = await repo();
  try {
    const headBefore = (await git(['rev-parse', 'HEAD'], root)).stdout.trim();
    const branchBefore = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], root)).stdout.trim();
    await fs.writeFile(path.join(root, 'web', 'index.html'), 'agent did this\n');
    const statusBefore = (await git(['status', '--porcelain'], root)).stdout;

    await shipScope(req(root, ['web/**']), nullLog);

    // THE AGENT IS EDITING THIS TREE RIGHT NOW. If any of these four move, a file it has open
    // changes under it mid-edit.
    assert.equal((await git(['rev-parse', 'HEAD'], root)).stdout.trim(), headBefore);
    assert.equal((await git(['rev-parse', '--abbrev-ref', 'HEAD'], root)).stdout.trim(), branchBefore);
    assert.equal((await git(['status', '--porcelain'], root)).stdout, statusBefore,
      'the human\'s own index must not have gained the agent\'s files');
    assert.equal(await fs.readFile(path.join(root, 'web', 'index.html'), 'utf8'), 'agent did this\n');
  } finally { await cleanup(); }
});

test('the credential is never committed, even when the scope is **', async () => {
  const { root, cleanup } = await repo();
  try {
    // An owner's scope really is `**`, so nothing about the glob match keeps the token out.
    await fs.writeFile(path.join(root, '.flotilla-token'), 'secret-agent-token\n');
    await fs.mkdir(path.join(root, '.agentic'), { recursive: true });
    await fs.writeFile(path.join(root, '.agentic', 'outbox.jsonl'), '{}\n');
    await fs.writeFile(path.join(root, 'AGENTS.md'), '# frontend\n');
    await fs.writeFile(path.join(root, 'web', 'index.html'), 'real work\n');

    const r = await shipScope({ ...req(root, ['**']), branch: 'agent/owner/everything' }, nullLog);
    const tree = await filesIn(root, r.commit_sha);
    assert.ok(!tree.includes('.flotilla-token'), 'the agent token must never reach a branch');
    assert.ok(!tree.some((f) => f.startsWith('.agentic/')), '.agentic is per-machine state');
    assert.ok(!tree.includes('AGENTS.md'), 'one member\'s role file is not shared-branch content');
    assert.ok(tree.includes('web/index.html'));
    // And they are not reported as "skipped" either: they were never candidates.
    assert.deepEqual(r.skipped, []);
  } finally { await cleanup(); }
});

test('a deletion inside the scope is recorded as a deletion', async () => {
  const { root, cleanup } = await repo();
  try {
    await fs.rm(path.join(root, 'web', 'index.html'));
    const r = await shipScope(req(root, ['web/**']), nullLog);
    const tree = await filesIn(root, r.commit_sha);
    // `git add` without --all stages content and ignores removals, so a file the agent deleted
    // would silently come back on the branch.
    assert.ok(!tree.includes('web/index.html'), 'a deleted file must not survive on the branch');
    assert.ok(tree.includes('server/index.js'), 'and nothing else may be dropped with it');
  } finally { await cleanup(); }
});

test('a second ship builds on the first rather than orphaning it', async () => {
  const { root, cleanup } = await repo();
  try {
    await fs.writeFile(path.join(root, 'web', 'index.html'), 'first\n');
    const a = await shipScope(req(root, ['web/**']), nullLog);
    await fs.writeFile(path.join(root, 'web', 'a.js'), 'second\n');
    const b = await shipScope(req(root, ['web/**']), nullLog);

    assert.notEqual(a.commit_sha, b.commit_sha);
    const parent = (await git(['rev-parse', `${b.commit_sha}^`], root)).stdout.trim();
    assert.equal(parent, a.commit_sha, 'the second commit must have the first as its parent');
    // And the first ship's content survives into the second.
    assert.equal((await git(['show', `${b.commit_sha}:web/index.html`], root)).stdout, 'first\n');
  } finally { await cleanup(); }
});

test('re-shipping unchanged work is a no-op, not an empty commit', async () => {
  const { root, cleanup } = await repo();
  try {
    await fs.writeFile(path.join(root, 'web', 'index.html'), 'done\n');
    const a = await shipScope(req(root, ['web/**']), nullLog);
    const b = await shipScope(req(root, ['web/**']), nullLog);
    assert.equal(b.unchanged, true, 'a re-drain after a crash must not stack empty commits');
    assert.equal(b.commit_sha, a.commit_sha);
  } finally { await cleanup(); }
});

test('nothing changed in scope is a no-op, not a failure', async () => {
  const { root, cleanup } = await repo();
  try {
    // An agent may finish a task whose work was all reading.
    const r = await shipScope(req(root, ['web/**']), nullLog);
    assert.equal(r.unchanged, true);
    assert.deepEqual(r.files, []);
  } finally { await cleanup(); }
});

test('it refuses to push anywhere but agent/<role>/<task>', async () => {
  const { root, cleanup } = await repo();
  try {
    await fs.writeFile(path.join(root, 'web', 'index.html'), 'x\n');
    // The ref is built from a role slug and a task id, BOTH of which arrive over the network.
    // This function pushes to whatever ref it is handed, and `main` is one bad string away.
    for (const branch of ['main', 'refs/heads/main', 'agent/main', '../main', 'agent/a/b/c']) {
      await assert.rejects(
        () => shipScope({ ...req(root, ['web/**']), branch }, nullLog),
        ShipError,
        `${branch} must be refused`,
      );
    }
    // The control: the legitimate shape still works, so this is not "everything is refused".
    const ok = await shipScope(req(root, ['web/**']), nullLog);
    assert.equal(ok.unchanged, false);
  } finally { await cleanup(); }
});

test('holding no scope refuses rather than defaulting to everything', async () => {
  const { root, cleanup } = await repo();
  try {
    await fs.writeFile(path.join(root, 'server', 'index.js'), 'x\n');
    await assert.rejects(() => shipScope(req(root, []), nullLog), ShipError);
  } finally { await cleanup(); }
});

test('parseStatus reads the NUL format, including renames', () => {
  // `-z` because a filename may contain a newline; the readable format escapes those in a way
  // that does not round-trip.
  assert.deepEqual(parseStatus('?? web/new.js\0 M web/old.js\0'), ['web/new.js', 'web/old.js']);
  // A rename emits the ORIGINAL path as its own field. Both sides are needed or the commit
  // records an add with no matching delete.
  assert.deepEqual(parseStatus('R  web/new.js\0web/old.js\0'), ['web/new.js', 'web/old.js']);
  assert.deepEqual(parseStatus(''), []);
});

test('inScope matches paths against held globs', () => {
  assert.ok(inScope('web/index.html', ['web/**']));
  assert.ok(inScope('web/deep/nested/a.js', ['web/**']));
  assert.ok(!inScope('server/index.js', ['web/**']));
  assert.ok(inScope('server/index.js', ['**']));
  assert.ok(inScope('docs/a.md', ['docs/*.md']));
  assert.ok(!inScope('docs/deep/a.md', ['docs/*.md']));
});

test('branch names survive a task id that is not branch-safe', () => {
  assert.equal(branchFor('frontend', 'task_fix_the_filter'), 'agent/frontend/fix-the-filter');
  assert.equal(slugFor('task_A__B'), 'a-b');
  // git rejects a ref ending in a slash with a message that never mentions the task, so an id
  // that slugs to nothing still has to produce a nameable branch.
  assert.equal(slugFor('task_'), 'task');
  assert.equal(slugFor('!!!'), 'task');
});

test('the dry run and the commit agree on every file', async () => {
  const { root, cleanup } = await repo();
  try {
    await fs.writeFile(path.join(root, 'web', 'index.html'), 'mine\n');
    await fs.writeFile(path.join(root, 'server', 'index.js'), 'theirs\n');
    await fs.writeFile(path.join(root, '.flotilla-token'), 'secret\n');

    // What --dry-run prints, and what shipScope actually does, now come from one function.
    // They did not: the preview reported .flotilla-token as "outside your scope", which is not
    // why it is excluded and is flatly false for an owner holding **.
    const status = await git(['status', '--porcelain', '-z', '-uall'], root);
    const preview = classifyChanges(parseStatus(status.stdout), ['web/**']);
    const r = await shipScope(req(root, ['web/**']), nullLog);

    assert.deepEqual(preview.files, r.files);
    assert.deepEqual(preview.skipped, r.skipped);
    assert.ok(!preview.skipped.includes('.flotilla-token'),
      'the credential is not a scope question, and must not be described as one');
  } finally { await cleanup(); }
});

test('one branch gets one task\'s lock, never the union of every claim', () => {
  // An agent CAN hold two claims: that is how the currentTask bug surfaced in the first place.
  const locks = [
    { agent_id: 'me', task_id: 'task_docs', globs: ['docs/**'] },
    { agent_id: 'me', task_id: 'task_web', globs: ['web/**'] },
    { agent_id: 'other', task_id: 'task_api', globs: ['server/**'] },
  ];
  // The union would put web/ files on the docs branch, under a commit title that never mentions
  // them, and the reviewer of that PR would have no way to tell.
  assert.deepEqual(scopeForTask(locks, 'me', 'task_docs'), ['docs/**']);
  assert.deepEqual(scopeForTask(locks, 'me', 'task_web'), ['web/**']);
  // And never a lock belonging to someone else, however the task id is spelled.
  assert.deepEqual(scopeForTask(locks, 'me', 'task_api'), []);
});
