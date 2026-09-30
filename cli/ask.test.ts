// `flotilla ask`: a ticket from a line of code, and from marker comments.
//
// The scan runs against a real git repository, because "which files does it read" is answered by
// `git ls-files` and a list handed in by the test would skip the question. Tickets are filed into
// the real in-memory store's createTask, so "idempotent" means what the production path means by
// it -- the store reporting an existing id -- rather than a Set the test keeps.
//
//   node --test cli/ask.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  askTaskId, kindFor, markersIn, parseAskArgs, parseTarget, resolveTarget, runAsk, runScan, snippet,
  type AskDeps, type CreateTask,
} from './ask.ts';
import { git } from './blackboard.ts';
import { createMemoryStore } from '../shared/store/memory.ts';

// The marker word is assembled here too, for the reason cli/ask.ts gives: written out after a
// comment opener, this test file would itself be a marker in this repository.
const M = ['FLOTILLA', ':'].join('');

// ---- arguments -----------------------------------------------------------------------------

test('a target is a file and a line, or a file and a range', () => {
  assert.deepEqual(parseTarget('server/items.ts:12'), { file: 'server/items.ts', start: 12, end: 12 });
  assert.deepEqual(parseTarget('server/items.ts:12-20'), { file: 'server/items.ts', start: 12, end: 20 });
  // Split on the LAST colon, so a path containing one still parses.
  assert.deepEqual(parseTarget('odd:name.ts:3'), { file: 'odd:name.ts', start: 3, end: 3 });
});

test('a malformed target is refused, never guessed', () => {
  for (const bad of ['server/items.ts', 'server/items.ts:', ':12', 'f.ts:abc', 'f.ts:1-', 'f.ts:-3', 'f.ts:1-2-3']) {
    assert.ok('error' in parseTarget(bad), `${bad} should be refused`);
  }
  assert.match((parseTarget('f.ts:0') as { error: string }).error, /count from 1/);
  assert.match((parseTarget('f.ts:9-3') as { error: string }).error, /ends before it starts/);
});

test('ask arguments: the request is every word after the target, flags anywhere', () => {
  const a = parseAskArgs(['--kind', 'qa', 'test/a.ts:4', 'cover', 'the', 'empty', 'case']);
  assert.deepEqual(a, { scan: false, dry_run: false, kind: 'qa', target: 'test/a.ts:4', request: 'cover the empty case' });
  assert.deepEqual(parseAskArgs(['--scan', '--dry-run']), { scan: true, dry_run: true });

  const err = (argv: string[]) => (parseAskArgs(argv) as { error?: string }).error ?? '';
  assert.match(err(['test/a.ts:4']), /usage/, 'a target with no request');
  assert.match(err([]), /usage/);
  assert.match(err(['a.ts:1', 'x', '--kind', 'wizard']), /--kind must be one of/);
  assert.match(err(['a.ts:1', 'x', '--kind']), /needs a value/);
  assert.match(err(['--scan', 'a.ts:1']), /takes no target/);
  assert.match(err(['--scan', '--id', 'task_x']), /stable id/);
  assert.match(err(['a.ts:1', 'x', '--frobnicate']), /unknown flag/);
});

// ---- the snippet ---------------------------------------------------------------------------

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

test('the snippet numbers the lines, marks the range, and shows context either side', () => {
  const s = snippet(numbered(20), 10, 11) as string;
  assert.deepEqual(s.split('\n'), [
    '   7  line 7', '   8  line 8', '   9  line 9',
    '> 10  line 10', '> 11  line 11',
    '  12  line 12', '  13  line 13', '  14  line 14',
  ]);
  // At the top of the file there is no context above to show.
  assert.equal((snippet(numbered(5), 1, 1) as string).split('\n')[0], '> 1  line 1');
});

test('the snippet is capped in lines and in line length', () => {
  const s = snippet(numbered(500), 10, 400, { context: 3, max_lines: 10 }) as string;
  const lines = s.split('\n');
  assert.equal(lines.length, 11, 'ten lines of code and one saying what was left out');
  // Lines 7..403 is 397 lines with context; 10 shown leaves 387.
  assert.match(lines[10]!, /\.\.\. 387 more line\(s\) not shown/);

  const wide = snippet(`${'x'.repeat(5000)}\n`, 1, 1, { max_line_chars: 50 }) as string;
  assert.ok(wide.length < 80, `a minified line is cut, got ${wide.length} chars`);
  assert.match(wide, / \.\.\.$/);
});

test('a line past the end of the file is refused', () => {
  assert.match((snippet(numbered(5), 6, 6) as { error: string }).error, /has 5 line/);
  assert.match((snippet(numbered(5), 4, 9) as { error: string }).error, /line 9 is past the end/);
});

// ---- the kind ------------------------------------------------------------------------------

test('the kind is the role whose fence covers the file', () => {
  assert.deepEqual(kindFor('functions/src/api.ts'), { kind: 'backend' });
  assert.deepEqual(kindFor('client/src/App.tsx'), { kind: 'frontend' });
  assert.deepEqual(kindFor('test/e2e.spec.ts'), { kind: 'qa' });
});

test('the PROJECT fence wins over the template', () => {
  const scopes = { backend: ['server/**'], frontend: ['web/**'] };
  assert.deepEqual(kindFor('web/app.ts', scopes), { kind: 'frontend' });
  // client/** is the template's frontend fence; this project redrew it, so nothing covers it.
  assert.ok('error' in kindFor('client/app.ts', scopes));
});

test('no fence covers the file: refused, with the way out named', () => {
  // The owner's `**` is not a fence and must not make every file "covered".
  const r = kindFor('README.md');
  assert.ok('error' in r);
  assert.match(r.error, /no role's fence covers README\.md/);
  assert.match(r.error, /--kind/);
});

test('two fences cover the file: refused as ambiguous, both named', () => {
  const r = kindFor('shared/x.ts', { backend: ['shared/**'], frontend: ['shared/**'] });
  assert.ok('error' in r);
  assert.deepEqual(r.candidates, ['frontend', 'backend']);
  assert.match(r.error, /more than one role's fence/);
});

// ---- running it, against real files --------------------------------------------------------

async function repo(files: Record<string, string>): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ask-'));
  await git(['init', '-q', '--initial-branch=main'], root);
  for (const [rel, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fs.writeFile(path.join(root, rel), body, 'utf8');
  }
  await git(['add', '-A'], root);
  return root;
}

/** The real store's createTask, so "already exists" is the store's answer, not the test's. */
function memoryCreate(): { create: CreateTask; count: () => Promise<number>; get: (id: string) => Promise<Record<string, unknown> | undefined> } {
  const store = createMemoryStore({});
  store.createProject('p1', 'P', 'o/r');
  return {
    create: async (t) => {
      const r = await store.createTask('p1', t, { actor_type: 'member', actor_id: 'uid_me' });
      return { created: r.ok, task_id: r.task_id };
    },
    count: async () => (await store.readSnapshot('p1'))!.snapshot.tasks.length,
    get: async (id) => (await store.readSnapshot('p1'))!.snapshot.tasks.find((x) => x.task_id === id) as never,
  };
}

const deps = (root: string, create: CreateTask, lines: string[] = []): AskDeps =>
  ({ root, scopes: {}, create, out: (s) => lines.push(s) });

test('ask files one ticket carrying the file, the range, the code and the request', async () => {
  const root = await repo({ 'functions/items.ts': numbered(30) });
  const mem = memoryCreate();
  const said: string[] = [];
  const code = await runAsk(
    { scan: false, dry_run: false, target: 'functions/items.ts:12-13', request: 'reject a negative qty here' },
    deps(root, mem.create, said),
  );
  assert.equal(code, 0, said.join('\n'));
  const id = askTaskId('functions/items.ts', 'reject a negative qty here');
  const t = await mem.get(id);
  assert.ok(t, `filed as ${id}`);
  assert.equal(t.title, 'reject a negative qty here');
  assert.equal(t.kind, 'backend');
  assert.deepEqual(t.file_scope, ['functions/items.ts']);
  const d = String(t.description);
  assert.match(d, /Where: functions\/items\.ts:12-13/);
  assert.match(d, /> 12  line 12/);
  assert.match(d, /  15  line 15/, 'with context below');
  assert.match(d, /reject a negative qty here/);
});

test('ask --kind overrides a file no fence covers', async () => {
  const root = await repo({ 'README.md': '# hi\n' });
  const mem = memoryCreate();
  const said: string[] = [];
  const args = { scan: false, dry_run: false, target: 'README.md:1', request: 'say what this is' };
  assert.equal(await runAsk(args, deps(root, mem.create, said)), 1, 'refused without --kind');
  assert.match(said.join('\n'), /no role's fence covers README\.md/);
  assert.equal(await mem.count(), 0, 'and nothing was filed');

  assert.equal(await runAsk({ ...args, kind: 'docs' }, deps(root, mem.create)), 0);
  assert.equal((await mem.get(askTaskId('README.md', 'say what this is')))?.kind, 'docs');
});

test('ask refuses a missing file, a path outside the repo, and a line past the end', async () => {
  const root = await repo({ 'functions/a.ts': 'one\n' });
  const mem = memoryCreate();
  for (const [target, why] of [
    ['functions/nope.ts:1', /does not exist/],
    ['../elsewhere.ts:1', /outside this repository/],
    ['functions/a.ts:7', /past the end/],
    ['functions:1', /is not a file/],
  ] as const) {
    const said: string[] = [];
    assert.equal(await runAsk({ scan: false, dry_run: false, target, request: 'x' }, deps(root, mem.create, said)), 1, target);
    assert.match(said.join('\n'), why);
  }
  assert.equal(await mem.count(), 0);
  // The path is normalised, so ./functions/a.ts and functions/a.ts are one ticket.
  assert.deepEqual(await resolveTarget(root, './functions/a.ts'), { rel: 'functions/a.ts', text: 'one\n' });
});

test('markers are found after any comment opener, and not in prose or placeholders', () => {
  const text = [
    `// ${M} add a retry`,
    `x = 1  # ${M} explain this constant`,
    `-- ${M} index this column`,
    `/* ${M} split this function */`,
    ` * ${M} document the return value`,
    `<!-- ${M} fix the heading -->`,
    `; ${M} lisp style`,
    'the word flotilla: in lowercase is prose',
    `quoted in backticks \`// ${M} not a marker\``,
    `// ${M} <request>`,
    `// ${M}`,
  ].join('\n');
  const got = markersIn('f', text);
  assert.deepEqual(got.map((m) => m.request), [
    'add a retry', 'explain this constant', 'index this column', 'split this function',
    'document the return value', 'fix the heading', 'lisp style',
  ]);
  assert.deepEqual(got.map((m) => m.line), [1, 2, 3, 4, 5, 6, 7]);
});

test('scan files one ticket per marker, and a re-scan files nothing twice', async () => {
  const root = await repo({
    'functions/items.ts': `export function create() {\n  // ${M} reject a negative qty\n  return 1;\n}\n`,
    'client/App.tsx': `// ${M} show the empty state\nexport const App = () => null;\n`,
    'README.md': `<!-- ${M} write an intro -->\n`,
    'test/fixture.bin': `\0\0binary // ${M} not text\n`,
  });
  // An UNTRACKED file with a marker: not part of the repository, so not a request to the team.
  await fs.writeFile(path.join(root, 'functions/scratch.ts'), `// ${M} my own note\n`, 'utf8');

  const mem = memoryCreate();
  const first = await runScan({ scan: true, dry_run: false }, deps(root, mem.create));
  // THE CONTROL: the scan found the markers. Without it, a scanner that matched nothing would
  // pass the idempotency assertions below by filing nothing twice -- and nothing once.
  assert.equal(first.markers, 3, 'three markers in tracked text files');
  assert.equal(first.created.length, 2);
  assert.deepEqual(first.skipped.map((s) => s.where), ['README.md:1'], 'README is inside no fence');
  assert.equal(await mem.count(), 2);

  // Code inserted ABOVE a marker moves its line; the id does not depend on it.
  await fs.writeFile(path.join(root, 'client/App.tsx'), `import x from 'y';\n\n// ${M} show the empty state\nexport const App = () => null;\n`, 'utf8');

  const said: string[] = [];
  const again = await runScan({ scan: true, dry_run: false }, deps(root, mem.create, said));
  assert.equal(again.markers, 3);
  assert.deepEqual(again.created, [], 'nothing new was filed');
  assert.deepEqual(again.existing.sort(), [...first.created].sort(), 'every one was already there');
  assert.equal(await mem.count(), 2, 'the board still holds exactly two');
  assert.match(said.join('\n'), /0 created, 2 already existed, 1 skipped/);
});

test('scan --dry-run files nothing and says what it would', async () => {
  const root = await repo({ 'functions/a.ts': `// ${M} tidy this\n` });
  const mem = memoryCreate();
  const said: string[] = [];
  const r = await runScan({ scan: true, dry_run: true }, deps(root, mem.create, said));
  assert.equal(r.markers, 1, 'the control: there was something to preview');
  assert.equal(await mem.count(), 0);
  assert.match(said.join('\n'), /would file task_ask_tidy_this_[0-9a-f]{8} {2}functions\/a\.ts:1/);
  assert.match(said.join('\n'), /Nothing was filed/);
});

// ---- the command, through main() -----------------------------------------------------------
//
// In ONE test, in order, because registerProjectCommands is process-global: the unregistered
// branch has to be observed before anything registers.

test('flotilla ask: dry-run needs no backend, filing does; unread fences fall back to the template', async () => {
  const { main, registerProjectCommands } = await import('./index.ts');
  const root = await repo({ 'functions/a.ts': `// ${M} tidy this\n`, 'README.md': `<!-- ${M} intro -->\n` });
  const prev = process.env.BUILDER_ROOT;
  process.env.BUILDER_ROOT = root;
  try {
    assert.equal(await main(['ask', 'functions/a.ts:1', 'tidy', '--dry-run']), 0, 'a preview is local');
    assert.equal(await main(['ask', 'functions/a.ts:1', 'tidy']), 1, 'filing without a backend is refused');
    assert.equal(await main(['ask', 'functions/a.ts']), 1, 'bad usage');

    const mem = memoryCreate();
    registerProjectCommands({
      createTask: (_root: string, t: Parameters<CreateTask>[0]) => mem.create(t),
      // A fence read that fails must not stop the ticket: the template still covers functions/.
      roleScopes: async () => { throw new Error('offline'); },
    } as never);
    assert.equal(await main(['ask', 'functions/a.ts:1', 'tidy']), 0);
    assert.equal((await mem.get(askTaskId('functions/a.ts', 'tidy')))?.kind, 'backend');

    // A scan that skips a marker exits 1, because someone has to act on it...
    assert.equal(await main(['ask', '--scan']), 1);
    // ...and one where every marker is filed or already there exits 0.
    assert.equal(await main(['ask', '--scan', '--kind', 'docs']), 0);
    assert.equal(await mem.count(), 3, 'tidy (ask), tidy this (marker), intro (as docs)');
  } finally {
    if (prev === undefined) delete process.env.BUILDER_ROOT;
    else process.env.BUILDER_ROOT = prev;
  }
});

test('the same request in two files is two tickets; the id is stable across runs', () => {
  assert.equal(askTaskId('a.ts', 'add a retry'), askTaskId('a.ts', 'add a retry'));
  assert.notEqual(askTaskId('a.ts', 'add a retry'), askTaskId('b.ts', 'add a retry'));
  assert.match(askTaskId('a.ts', '!!!'), /^task_ask_note_[0-9a-f]{8}$/, 'a request with no letters still gets an id');
});
