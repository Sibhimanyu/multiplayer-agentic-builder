import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { ensureIgnored } from './gitignore.ts';

const tmp = () => fs.mkdtemp(path.join(os.tmpdir(), 'flotilla-gitignore-'));
const read = (root: string) => fs.readFile(path.join(root, '.gitignore'), 'utf8');

test('creates .gitignore with both entries when there is none', async () => {
  const root = await tmp();
  assert.deepEqual(await ensureIgnored(root), ['.agentic/', '.flotilla-token', 'AGENTS.md']);
  const lines = (await read(root)).split('\n');
  assert.ok(lines.includes('.agentic/'));
  assert.ok(lines.includes('.flotilla-token'));
});

test('adds only what is missing, and keeps what was there', async () => {
  const root = await tmp();
  await fs.writeFile(path.join(root, '.gitignore'), 'node_modules/\n.agentic/\n');
  assert.deepEqual(await ensureIgnored(root), ['.flotilla-token', 'AGENTS.md']);
  const text = await read(root);
  assert.ok(text.startsWith('node_modules/\n.agentic/\n'));
  assert.equal(text.split('\n').filter((l) => l === '.agentic/').length, 1);
});

test('a second run changes nothing', async () => {
  const root = await tmp();
  await ensureIgnored(root);
  const before = await read(root);
  assert.deepEqual(await ensureIgnored(root), []);
  assert.equal(await read(root), before);
});

test('a hand-written variant counts as present', async () => {
  const root = await tmp();
  await fs.writeFile(path.join(root, '.gitignore'), '/.agentic\n/.flotilla-token\nAGENTS.md');
  assert.deepEqual(await ensureIgnored(root), []);
});

test('a file without a trailing newline is not glued onto', async () => {
  const root = await tmp();
  await fs.writeFile(path.join(root, '.gitignore'), 'dist');
  await ensureIgnored(root);
  assert.ok((await read(root)).startsWith('dist\n'));
});

test('inside a git repo it writes .git/info/exclude and leaves the tree clean', async () => {
  const root = await tmp();
  const { git } = await import('./blackboard.ts');
  await git(['init', '-q'], root);
  assert.deepEqual(await ensureIgnored(root), ['.agentic/', '.flotilla-token', 'AGENTS.md']);
  await assert.rejects(fs.stat(path.join(root, '.gitignore')), 'no .gitignore is created');
  const exclude = await fs.readFile(path.join(root, '.git', 'info', 'exclude'), 'utf8');
  assert.ok(exclude.split('\n').includes('.flotilla-token'));

  // And git really ignores the token: it is not reported as untracked.
  await fs.writeFile(path.join(root, '.flotilla-token'), 'secret\n');
  assert.equal((await git(['status', '--porcelain'], root)).stdout, '');
});

test('entries already in a committed .gitignore are not repeated in the exclude file', async () => {
  const root = await tmp();
  const { git } = await import('./blackboard.ts');
  await git(['init', '-q'], root);
  await fs.writeFile(path.join(root, '.gitignore'), '.agentic/\n');
  assert.deepEqual(await ensureIgnored(root), ['.flotilla-token', 'AGENTS.md']);
});
