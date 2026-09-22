// docs/board.html is generated, and this is what keeps it honest.
//
// The board is the picture everyone reasons from: six roles, what each owns, what a ticket goes
// through, and which steps are not built yet. A hand-written version of that page is a lie
// waiting for the next release -- add a role, add a ticket type, ship the webhook, and the
// drawing still shows last month while reading as current.
//
// So: scripts/board.ts derives it, and these tests assert (1) the committed file matches a fresh
// render, and (2) the derivation actually tracks the source rather than merely appearing to.
// The second half matters more. A generator that ignores its inputs regenerates identically
// forever and passes check #1 every time.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ROLES, ROLE_SLUGS } from '../shared/store/directory.ts';
import { TASK_KINDS } from '../shared/store/tasks.ts';
import { missingNotes } from '../scripts/board.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BOARD = path.join(root, 'docs', 'board.html');

const board = (): string => fs.readFileSync(BOARD, 'utf8');

test('the committed board matches a fresh render', () => {
  // `npm run board:check` is the same comparison the author runs. Wiring it into the suite is
  // what turns "remember to regenerate" into a red build.
  const r = execFileSync('node', ['scripts/board.ts', '--check'], {
    cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
  assert.match(r, /up to date/);
});

test('every role reaches the board, with its real file scope', () => {
  const html = board();
  // THE CONTROL FIRST: an empty role list would pass every assertion below.
  assert.ok(ROLE_SLUGS.length >= 5, `expected the real role set, got ${ROLE_SLUGS.length}`);

  for (const slug of ROLE_SLUGS) {
    const name = slug[0]!.toUpperCase() + slug.slice(1);
    assert.ok(html.includes(`>${name}<`), `role ${slug} is missing from the board`);

    for (const glob of DEFAULT_ROLES[slug].file_scope) {
      // `**` is rendered as the word "everything": a glob on a page for non-engineers is noise.
      const shown = glob === '**' ? 'everything' : glob;
      assert.ok(html.includes(`>${shown}<`),
        `${slug} owns ${glob} and the board does not say so`);
    }
  }
});

test('a scope a role does NOT have never appears against it', () => {
  // The inverse of the test above, and the one that catches a generator printing every glob in
  // every row. `functions/` belongs to backend; frontend must not be shown holding it.
  const html = board();
  const row = /<div class="rrow[^"]*">\s*<div class="rname">Frontend[\s\S]*?<\/div>\s*<\/div>/.exec(html);
  assert.ok(row, 'could not find the frontend row');
  assert.ok(row![0].includes('client/'), 'frontend must be shown owning client/');
  assert.ok(!row![0].includes('functions/'), 'frontend must NOT be shown owning the server');
});

test('the privileged capabilities are the inverted ones', () => {
  const html = board();
  // Filled chips are the board's entire colour system: they mean "can change production". If
  // `deploy` stopped inverting, the page would still look fine and would stop saying anything.
  assert.match(html, /<span class="cap hot">deploy<\/span>/);
  assert.match(html, /<span class="cap hot">invite<\/span>/);
  // And an ordinary capability must NOT be filled.
  assert.match(html, /<span class="cap">claim<\/span>/);
  assert.ok(!/<span class="cap hot">claim<\/span>/.test(html), 'claim is not a production change');
});

test('a ticket type no role owns is reported as a gap, derived not typed', () => {
  const html = board();
  const slugs = new Set<string>(ROLE_SLUGS);
  const unowned = TASK_KINDS.filter((k) => !slugs.has(k));
  // Control: if every kind had an owner this test would assert nothing, so say which case ran.
  assert.ok(TASK_KINDS.length >= 3, `expected the real ticket types, got ${TASK_KINDS.length}`);
  for (const k of unowned) {
    assert.ok(html.includes(`no role owns ${k}`),
      `${k} is a ticket type with no role and the board does not flag it`);
  }
  for (const k of TASK_KINDS.filter((x) => slugs.has(x))) {
    assert.ok(!html.includes(`no role owns ${k}`), `${k} HAS a role; it must not be flagged`);
  }
});

test('the PR and merge steps are marked from the source, not from memory', () => {
  const html = board();
  // `githubWebhook` is the only thing authorised to emit branch_pushed / pr_opened / merged.
  // Whether it is EXPORTED is therefore whether those steps work at all, and the board reads it
  // rather than repeating what was true when the page was written.
  const exported = /^export\s+const\s+githubWebhook\b/m.test(
    fs.readFileSync(path.join(root, 'functions/src/index.ts'), 'utf8'));
  const deadSteps = (html.match(/class="step dead"/g) ?? []).length;

  if (exported) {
    assert.equal(deadSteps, 0,
      'githubWebhook is exported, so no step may still be drawn as unbuilt');
    assert.ok(!html.includes('Steps 6 and 7 are manual'));
    assert.match(html, /7 of 7 steps built/);
  } else {
    assert.equal(deadSteps, 2,
      'githubWebhook is not exported, so the PR and merge steps must be drawn as unbuilt');
    assert.ok(html.includes('Steps 6 and 7 are manual'));
    assert.match(html, /5 of 7 steps built/);
  }
});

test('the board says it is generated, so nobody hand-edits it', () => {
  // A generated file that does not announce itself gets edited by hand once, and then the next
  // `npm run board` silently throws that work away.
  assert.match(board(), /GENERATED BY scripts\/board\.ts/);
  assert.match(board(), /npm run board/);
});

test('a new role fails loudly with instructions, not a stack trace', () => {
  // The one thing a role still needs by hand is its one-line note. Adding a seventh role used to
  // crash the generator with `Cannot read properties of undefined (reading 'replace')` from
  // inside the HTML escaper -- a trace naming the escaper and not the missing note. Verified by
  // actually adding a role: the message now names the role and the constant to edit.
  assert.deepEqual(missingNotes(), [],
    `these roles have no note in scripts/board.ts ROLE_NOTE: ${missingNotes().join(', ')}`);
});
