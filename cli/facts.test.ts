// Stale flags on blackboard facts: the pin syntax, and staleness against real git history.
//
// Real git, for the reason cli/blackboard.test.ts gives: "is this commit newer than that one, on
// an orphan branch" is a property of git, and a mocked runner would only prove the mock agrees
// with me. Commit times are pinned with GIT_COMMITTER_DATE so "newer" is a fact of the fixture,
// not of how fast the test machine happens to run.
//
//   node --test cli/facts.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { git } from './blackboard.ts';
import {
  blackboardRef, parsePins, readFacts, renderFactsReport, renderStaleForAgent, staleTouching, type Fact,
} from './facts.ts';
import { renderCurrentTask } from './agentic.ts';
import { staleFactsLine } from './index.ts';
import type { TaskView } from '../shared/store/types.ts';

// ---- the pin syntax ------------------------------------------------------------------------

test('a YAML contract declares pins as a top-level block list', () => {
  const r = parsePins('contracts/items-api.v2.yaml', [
    'name: items-api',
    'version: 2',
    'pins:',
    '  - server/items/**   # the handlers',
    '  - "schema/items.sql"',
    '',
    '  - server/items/**',
    'openapi: 3.1.0',
    'paths:',
    '  /items:',
    '    - not-a-pin',
  ].join('\n'));
  // Stops at the next top-level key, so `- not-a-pin` under paths: is not read; de-duplicated;
  // quotes and a trailing comment stripped.
  assert.deepEqual(r.pins, ['server/items/**', 'schema/items.sql']);
  assert.deepEqual(r.problems, []);
});

test('the flow form and the one-item scalar both read as lists', () => {
  assert.deepEqual(parsePins('contracts/a.v1.yaml', 'pins: [server/**, \'web/app.ts\']\n').pins, ['server/**', 'web/app.ts']);
  assert.deepEqual(parsePins('contracts/a.v1.yaml', 'pins: server/**\n').pins, ['server/**']);
  // A trailing slash means the directory, as it does everywhere else a glob is normalised.
  assert.deepEqual(parsePins('contracts/a.v1.yaml', 'pins: [server/]\n').pins, ['server/**']);
});

test('a markdown decision declares pins in frontmatter', () => {
  const r = parsePins('decisions/0007-qty-is-integer.md', [
    '---',
    'pins:',
    '  - server/items/validate.ts',
    '---',
    '# 0007 — qty is an integer',
    '',
    'pins: [this/is/prose/**]',
  ].join('\n'));
  assert.deepEqual(r.pins, ['server/items/validate.ts'], 'only the frontmatter is read, never the body');
  assert.deepEqual(r.problems, []);
});

test('CRLF line endings and a BOM do not hide pins', () => {
  const r = parsePins('decisions/0001-x.md', '﻿---\r\npins: [a/**]\r\n---\r\n# x\r\n');
  assert.deepEqual(r.pins, ['a/**']);
});

test('a markdown file whose --- is not on line one has no frontmatter', () => {
  // A `---` further down is a horizontal rule.
  const r = parsePins('decisions/0001-x.md', '# x\n\n---\npins: [a/**]\n---\n');
  assert.deepEqual(r, { pins: [], problems: [] });
});

test('a schema declares pins in its leading -- comment block', () => {
  const r = parsePins('schema/items.sql', [
    '',
    '-- items table',
    '-- pins:',
    '--   - server/items/**',
    'CREATE TABLE items (qty integer);',
    '-- pins: [ignored/**]',
  ].join('\n'));
  assert.deepEqual(r.pins, ['server/items/**']);
});

test('no pins key at all is unpinned, with no complaint', () => {
  assert.deepEqual(parsePins('contracts/a.v1.yaml', 'name: a\nversion: 1\n'), { pins: [], problems: [] });
  assert.deepEqual(parsePins('schema/a.sql', 'CREATE TABLE a (id int);\n'), { pins: [], problems: [] });
  // An explicit empty list is "no pins, on purpose" -- also no complaint.
  assert.deepEqual(parsePins('contracts/a.v1.yaml', 'pins: []\n'), { pins: [], problems: [] });
  // And a file type that carries no pins syntax reads as unpinned rather than guessed at.
  assert.deepEqual(parsePins('contracts/notes.txt', 'pins: [a/**]\n'), { pins: [], problems: [] });
});

test('malformed declarations are named, and the good items still count', () => {
  const unclosed = parsePins('decisions/0002-x.md', '---\npins: [a/**]\n# no closing fence\n');
  assert.deepEqual(unclosed.pins, []);
  assert.match(unclosed.problems.join('\n'), /never closes/);

  const bracket = parsePins('contracts/a.v1.yaml', 'pins: [a/**, b/**\n');
  assert.deepEqual(bracket.pins, []);
  assert.match(bracket.problems.join('\n'), /never closed/);

  const empty = parsePins('contracts/a.v1.yaml', 'pins:\nname: a\n');
  assert.deepEqual(empty.pins, []);
  assert.match(empty.problems.join('\n'), /lists nothing/);

  const mixed = parsePins('contracts/a.v1.yaml', [
    'pins:',
    '  - server/**',
    '  - ../etc/passwd',
    '  - /abs/path',
    '  - ":(top)x"',
    '  - "!server/x"',
    '  - ""',
    '  just prose, not an item',
    'pins: [second/**]',
  ].join('\n'));
  assert.deepEqual(mixed.pins, ['server/**'], 'the one valid pin survives its neighbours');
  const why = mixed.problems.join('\n');
  // One problem per refusal, each named -- the control that the loop above saw every line.
  assert.equal(mixed.problems.length, 7, why);
  for (const m of [/climbs out/, /absolute/, /pathspec magic.*:|: .*pathspec magic/, /starts with !/, /empty item/, /expected "- <glob>"/, /more than once/]) {
    assert.match(why, m);
  }
});

// ---- staleness, against real git -----------------------------------------------------------

const T = (n: number) => `${1_750_000_000 + n * 3600} +0000`;

async function commitAt(cwd: string, when: string, message: string): Promise<void> {
  const env = { GIT_COMMITTER_DATE: when, GIT_AUTHOR_DATE: when };
  const add = await git(['add', '-A'], cwd, 60_000, env);
  assert.equal(add.code, 0, add.stderr);
  const c = await git(['commit', '-q', '-m', message], cwd, 60_000, env);
  assert.equal(c.code, 0, c.stderr + c.stdout);
}

async function put(root: string, rel: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await fs.writeFile(path.join(root, rel), body, 'utf8');
}

/**
 * A repo whose code lives on main and whose facts live on an ORPHAN agentic/blackboard branch --
 * the real layout, so the comparison crosses two unrelated histories as it does in production.
 */
async function fixture(): Promise<{ root: string; bb: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'facts-'));
  await git(['init', '-q', '--initial-branch=main'], root);
  await git(['config', 'user.email', 'a@example.com'], root);
  await git(['config', 'user.name', 'A'], root);
  await put(root, 'server/items.ts', 'export const qty = 1;\n');
  await put(root, 'web/app.ts', 'render();\n');
  await commitAt(root, T(0), 'initial code');

  // The blackboard in its own worktree, so main's checkout is never switched. Beside the repo,
  // not inside it, or `git add -A` on main would pick the worktree up as an embedded repository.
  const bb = `${root}-bb`;
  assert.equal((await git(['worktree', 'add', '-q', '--detach', bb, 'HEAD'], root)).code, 0);
  assert.equal((await git(['checkout', '-q', '--orphan', 'agentic/blackboard'], bb)).code, 0);
  await git(['rm', '-rfq', '.'], bb);
  await put(bb, 'contracts/items-api.v1.yaml', 'name: items-api\nversion: 1\npins: [server/**]\n');
  await put(bb, 'contracts/items-api.v2.yaml', 'name: items-api\nversion: 2\npins:\n  - server/items.ts\n');
  await put(bb, 'decisions/0001-web-is-static.md', '---\npins: [web/**]\n---\n# web is static\n');
  await put(bb, 'decisions/0002-docs-tone.md', '---\npins: [docs/never-written/**]\n---\n# tone\n');
  await put(bb, 'schema/items.sql', 'CREATE TABLE items (qty integer);\n');
  await commitAt(bb, T(1), 'publish facts');
  return { root, bb };
}

const byPath = (facts: Fact[]) => new Map(facts.map((f) => [f.path, f]));

test('no blackboard in the checkout: no ref, no facts, and it says so', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'facts-none-'));
  await git(['init', '-q', '--initial-branch=main'], root);
  const r = await readFacts(root);
  assert.equal(r.ref, null);
  assert.deepEqual(r.facts, []);
  assert.match(renderFactsReport(r.ref, r.facts), /no blackboard here/);
});

test('fresh, stale, unpinned, superseded, and a pin that never changed', async () => {
  const { root } = await fixture();

  // Before any code moves: nothing is stale. This is the control for the assertion below -- a
  // reader that always said "stale" would fail here, not pass there.
  const before = byPath((await readFacts(root)).facts);
  assert.equal(before.size, 5, `every fact is read: ${[...before.keys()].join(', ')}`);
  assert.equal(before.get('contracts/items-api.v2.yaml')?.status, 'fresh');

  // Now the code the v2 contract pins moves, AFTER the contract was written.
  await put(root, 'server/items.ts', 'export const qty: number = 1;\n');
  await commitAt(root, T(2), 'Make qty a number');

  const { ref, facts } = await readFacts(root);
  assert.equal(ref, 'refs/heads/agentic/blackboard');
  const f = byPath(facts);

  const v2 = f.get('contracts/items-api.v2.yaml')!;
  assert.equal(v2.status, 'stale');
  assert.deepEqual(v2.moved.map((m) => m.subject), ['Make qty a number'], 'the commit that moved it, and only that one');
  assert.equal(v2.more, false);

  // v1 pins server/** too, which DID move -- and it is still not flagged, because v2 replaced it.
  assert.equal(f.get('contracts/items-api.v1.yaml')?.status, 'superseded');

  // web/** last changed at T0, before the decision at T1: older code does not make a fact stale.
  assert.equal(f.get('decisions/0001-web-is-static.md')?.status, 'fresh');

  // A pin on a path that has never had a commit is fresh -- and flagged as dangling, because a
  // pin that matches nothing can never go stale and is almost always a typo.
  const never = f.get('decisions/0002-docs-tone.md')!;
  assert.equal(never.status, 'fresh');
  assert.deepEqual(never.dangling, ['docs/never-written/**']);

  assert.equal(f.get('schema/items.sql')?.status, 'unpinned');

  const report = renderFactsReport(ref, facts);
  assert.match(report, /1 stale, 2 fresh, 1 unpinned, 1 superseded/);
  assert.match(report, /STALE +contracts\/items-api\.v2\.yaml/);
  assert.match(report, /Make qty a number/);
  assert.match(report, /matches no tracked file/);
  assert.equal(staleFactsLine(facts)?.startsWith('facts:      1 stale'), true);
});

test('re-committing the fact clears the flag: acknowledgement is git, not state', async () => {
  const { root, bb } = await fixture();
  await put(root, 'server/items.ts', 'changed\n');
  await commitAt(root, T(2), 'move the code');
  assert.equal(byPath((await readFacts(root)).facts).get('contracts/items-api.v2.yaml')?.status, 'stale');

  // Somebody re-verified it and re-committed the fact after the code moved.
  await put(bb, 'contracts/items-api.v2.yaml', 'name: items-api\nversion: 2\n# verified against server/items.ts\npins:\n  - server/items.ts\n');
  await commitAt(bb, T(3), 'reverify items-api v2');

  const after = byPath((await readFacts(root)).facts).get('contracts/items-api.v2.yaml')!;
  assert.equal(after.status, 'fresh');
  assert.deepEqual(after.moved, []);
  assert.equal(staleFactsLine((await readFacts(root)).facts), null, 'and status says nothing at all');
});

test('the remote-tracking blackboard wins over a local branch of the same name', async () => {
  const { root } = await fixture();
  assert.equal(await blackboardRef(root), 'refs/heads/agentic/blackboard');
  const sha = (await git(['rev-parse', 'agentic/blackboard'], root)).stdout.trim();
  await git(['update-ref', 'refs/remotes/origin/agentic/blackboard', sha], root);
  assert.equal(await blackboardRef(root), 'refs/remotes/origin/agentic/blackboard');
});

// ---- delivery to an agent ------------------------------------------------------------------

const stale = (p: string, pins: string[]): Fact => ({
  path: p, commit_sha: 'a'.repeat(40), committed_at: 1, pins, problems: [], status: 'stale',
  moved: [{ sha: 'b'.repeat(40), subject: 'Rename qty', committed_at: 2 }], more: false, dangling: [],
});

test('only stale facts that overlap the scope are handed to the agent', () => {
  const facts = [
    stale('contracts/items.v1.yaml', ['server/items/**']),
    stale('decisions/0001-web.md', ['web/**']),
    { ...stale('decisions/0002-fresh.md', ['server/**']), status: 'fresh' as const },
  ];
  const got = staleTouching(facts, ['server/items/handler.ts']);
  assert.deepEqual(got.map((f) => f.path), ['contracts/items.v1.yaml']);
  // And the other branch: a scope nothing pins gets nothing.
  assert.deepEqual(staleTouching(facts, ['docs/**']), []);
});

const TASK: TaskView = {
  task_id: 'task_x', title: 'Fix qty', kind: 'backend', status: 'claimed', description: 'd',
  depends_on: [], file_scope: ['server/items/**'], claimed_by: 'a1', blocked_by: null,
} as unknown as TaskView;

test('current-task.md carries the stale flags, and omits the section when there are none', () => {
  const withFlags = renderCurrentTask(TASK, [stale('contracts/items.v1.yaml', ['server/items/**'])]);
  assert.match(withFlags, /## Facts to re-verify/);
  assert.match(withFlags, /contracts\/items\.v1\.yaml \(pins server\/items\/\*\*\) — moved by bbbbbbbb "Rename qty"/);
  assert.match(withFlags, /do not edit the fact/);
  // No dates: this file must be byte-identical between builds and a date depends on the machine.
  assert.doesNotMatch(withFlags, /\d{4}-\d{2}-\d{2}/);

  assert.doesNotMatch(renderCurrentTask(TASK), /Facts to re-verify/);
  assert.deepEqual(renderStaleForAgent([]), []);
});
