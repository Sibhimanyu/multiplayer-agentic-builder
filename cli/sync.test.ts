import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { git } from './blackboard.ts';
import { dropLanded, landedChanges } from './sync.ts';

/** A working clone and a second clone standing in for "the merge happened on GitHub". */
async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flotilla-sync-'));
  const origin = path.join(dir, 'origin.git');
  const root = path.join(dir, 'work');
  const other = path.join(dir, 'other');
  await git(['init', '--bare', '-b', 'main', origin], dir);
  for (const r of [root, other]) {
    await git(['clone', '-q', origin, r], dir);
    await git(['config', 'user.email', 't@example.com'], r);
    await git(['config', 'user.name', 'T'], r);
  }
  await fs.mkdir(path.join(other, 'server'));
  await fs.writeFile(path.join(other, 'server', 'index.js'), 'base\n');
  await git(['add', '-A'], other); await git(['commit', '-qm', 'base'], other); await git(['push', '-q', 'origin', 'HEAD:main'], other);
  await git(['pull', '-q', 'origin', 'main'], root);
  const land = async (file: string, body: string, msg: string) => {
    await fs.mkdir(path.dirname(path.join(other, file)), { recursive: true });
    await fs.writeFile(path.join(other, file), body);
    await git(['add', '-A'], other); await git(['commit', '-qm', msg], other); await git(['push', '-q', 'origin', 'HEAD:main'], other);
  };
  return { root, land, fetch: () => git(['fetch', '-q', 'origin'], root) };
}

test('a shipped edit that has since merged is landed, even after later commits', async () => {
  const { root, land, fetch } = await setup();
  await fs.writeFile(path.join(root, 'server', 'index.js'), 'fixed\n'); // the shipped edit, still local
  await land('server/index.js', 'fixed\n', 'PR #2');
  await land('server/index.js', 'fixed\nplus PR #3\n', 'PR #3');         // upstream moved on
  await fetch();

  const r = await landedChanges(root, 'origin/main');
  assert.deepEqual(r, { landed: ['server/index.js'], kept: [] });
  await dropLanded(root, r.landed);
  assert.equal((await git(['merge', '--ff-only', '-q', 'origin/main'], root)).code, 0, 'the pull now goes through');
  assert.equal(await fs.readFile(path.join(root, 'server', 'index.js'), 'utf8'), 'fixed\nplus PR #3\n');
});

test('an edit that differs from anything merged is kept', async () => {
  const { root, land, fetch } = await setup();
  await fs.writeFile(path.join(root, 'server', 'index.js'), 'fixed, then more work\n');
  await land('server/index.js', 'fixed\n', 'PR #2');
  await fetch();
  assert.deepEqual(await landedChanges(root, 'origin/main'), { landed: [], kept: ['server/index.js'] });
});

test('an untracked file that merged is landed and removed; one that did not is kept', async () => {
  const { root, land, fetch } = await setup();
  await fs.mkdir(path.join(root, 'docs'));
  await fs.writeFile(path.join(root, 'docs', 'api.md'), '# API\n');
  await fs.writeFile(path.join(root, 'docs', 'notes.md'), 'mine\n');
  await land('docs/api.md', '# API\n', 'docs');
  await fetch();
  const r = await landedChanges(root, 'origin/main');
  assert.deepEqual(r, { landed: ['docs/api.md'], kept: ['docs/notes.md'] });
  await dropLanded(root, r.landed);
  await assert.rejects(fs.stat(path.join(root, 'docs', 'api.md')));
  assert.equal(await fs.readFile(path.join(root, 'docs', 'notes.md'), 'utf8'), 'mine\n');
});

test('a deletion, the token and the agent tree are never touched', async () => {
  const { root, fetch } = await setup();
  await fs.rm(path.join(root, 'server', 'index.js'));
  await fs.writeFile(path.join(root, '.flotilla-token'), 'secret\n');
  await fetch();
  const r = await landedChanges(root, 'origin/main');
  assert.deepEqual(r, { landed: [], kept: ['server/index.js'] });
});
