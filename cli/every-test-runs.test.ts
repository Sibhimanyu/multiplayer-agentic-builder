// Every test file is reachable by some npm script, and every script names a file that exists.
//
// WHY THIS EXISTS. The repository had 22 test files and `npm test` ran 11 of them. The other
// half were not disabled, not skipped, not marked todo -- they were simply in no script anybody
// ran, and nothing anywhere said so. Two distinct ways that happened:
//
//   1. A SCRIPT NAMED A FILE THAT DOES NOT EXIST. `firebase`'s `test:own` listed
//      `functions/src/reaper.test.ts`; the file is `firebase/reaper.test.ts`. `node --test` exits
//      non-zero on a missing path, so `npm --prefix firebase test` failed immediately -- which is
//      why nobody ran it, which is why the Firestore conformance suite had never run in CI.
//
//   2. A FILE WAS IN NO SCRIPT AT ALL. `firebase/directory.test.ts` -- the ProjectDirectory
//      conformance suite, one of the two port contracts this whole design rests on -- was
//      referenced by nothing.
//
// Neither is visible in a diff, in a test summary, or in a green build. A suite that does not run
// reports nothing, and "nothing" and "passing" look identical from outside. This is the same
// shape as the collection-group index guard: derive the requirement from the source rather than
// maintaining a list by hand, and assert a CONTROL so a broken scan cannot pass vacuously.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { globsIntersect } from '../shared/globs.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Tracked test files. `git ls-files` rather than a walk: an untracked scratch file is not a suite. */
function testFiles(): string[] {
  return execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter((f) => /\.test\.(ts|tsx)$/.test(f))
    // The skills directory is a vendored third-party checkout, not this repository's tests.
    .filter((f) => !f.startsWith('.claude/'));
}

/** Every package.json whose scripts may run tests. */
const MANIFESTS = ['package.json', 'firebase/package.json', 'functions/package.json', 'client/package.json'];

/**
 * Every path-like token across every script, with the quoting node --test uses stripped.
 *
 * Deliberately crude: it collects anything that LOOKS like a test path rather than parsing shell.
 * A parser would be wrong in a different way on every script, and the question here is only
 * "is this file mentioned anywhere", which a token scan answers honestly.
 */
function referencedTokens(): { script: string; token: string }[] {
  const out: { script: string; token: string }[] = [];
  for (const m of MANIFESTS) {
    const abs = path.join(root, m);
    if (!fs.existsSync(abs)) continue;
    const pkg = JSON.parse(fs.readFileSync(abs, 'utf8')) as { scripts?: Record<string, string> };
    const prefix = path.dirname(m) === '.' ? '' : `${path.dirname(m)}/`;
    for (const [name, body] of Object.entries(pkg.scripts ?? {})) {
      for (const raw of body.match(/[A-Za-z0-9_./*-]*\.test\.[a-z]+/g) ?? []) {
        // `cd .. &&` is how every firebase script runs: those paths are already repo-relative.
        const repoRel = /(^|\/)\.\.\//.test(body) || body.includes('cd ..') ? raw : `${prefix}${raw}`;
        out.push({ script: `${m}:${name}`, token: repoRel.replace(/^\.\//, '') });
      }
    }
  }
  return out;
}

const isGlob = (t: string) => t.includes('*');

test('every script names a test file that actually exists', () => {
  const missing: string[] = [];
  for (const { script, token } of referencedTokens()) {
    if (isGlob(token)) continue;             // a glob matching nothing is the next test's job
    if (!fs.existsSync(path.join(root, token))) missing.push(`${script} -> ${token}`);
  }
  // `node --test` exits non-zero on a missing path, so ONE bad entry takes the whole suite down
  // and it stays down until someone happens to run that script by hand. That is how the Firestore
  // conformance suite went un-run: `test:own` pointed at functions/src/reaper.test.ts, which has
  // never existed.
  assert.deepEqual(missing, [], `scripts point at files that do not exist:\n  ${missing.join('\n  ')}`);
});

test('every test file is reachable from some npm script', () => {
  const files = testFiles();
  // THE CONTROL, FIRST. A scan that finds nothing would otherwise pass this file completely,
  // which is precisely the failure mode being guarded against.
  assert.ok(files.length >= 15, `expected to find the repo's test files, found ${files.length}`);

  const tokens = referencedTokens();
  assert.ok(tokens.length >= 10, `expected scripts to name test files, found ${tokens.length}`);

  const orphans = files.filter((f) =>
    !tokens.some(({ token }) => (isGlob(token) ? globsIntersect(token, f) : token === f)));

  // A suite in no script is not "disabled" -- it is invisible. It reports nothing, and nothing
  // and passing look identical from outside the build.
  assert.deepEqual(orphans, [],
    `these test files are run by no npm script:\n  ${orphans.join('\n  ')}`);
});

test('the fast suite and the emulator suite do not overlap', () => {
  // Overlap is not a correctness bug, it is a time bug: the emulator suite is minutes long and
  // running a pure unit file inside it buys nothing. Stated as an assertion so the split stays
  // deliberate rather than drifting one file at a time.
  const fast = referencedTokens().filter((t) => t.script === 'package.json:test');
  const slow = referencedTokens().filter((t) => t.script.startsWith('firebase/package.json:'));
  const both = testFiles().filter((f) =>
    fast.some(({ token }) => (isGlob(token) ? globsIntersect(token, f) : token === f)) &&
    slow.some(({ token }) => (isGlob(token) ? globsIntersect(token, f) : token === f)));
  assert.deepEqual(both, [], `run in both the fast and the emulator suite:\n  ${both.join('\n  ')}`);
});

test('no test outside firebase/ imports firebase-admin by bare specifier', () => {
  // THE TWO-COPIES TRAP. firebase-admin is installed three times -- root, firebase/, functions/ --
  // and Node resolves a bare specifier from the importing file's own directory upward. A test
  // under functions/ therefore gets a DIFFERENT module instance than firebase/store.ts does, and
  // `FieldValue.increment()` from one is not `instanceof` the transform class of the other. The
  // SDK reports the sentinel as an ordinary object:
  //
  //   Couldn't serialize object of type "NumericIncrementTransform" (found in field
  //   "rollup.counts.open")
  //
  // which surfaced as `502 !== 200` on a claim test and read as a claim bug. It was not: claiming
  // works in production, where one deployed function has one copy. This cost an hour to find and
  // is invisible in a diff.
  //
  // firebase/admin-sdk.ts exists for this: it sits beside the firebase/ install and re-exports,
  // so a RELATIVE import of it hands every caller the same instance store.ts uses.
  const offenders: string[] = [];
  for (const f of testFiles()) {
    if (f.startsWith('firebase/')) continue;   // already beside the install it resolves
    const src = fs.readFileSync(path.join(root, f), 'utf8');
    // A type-only import pulls in no runtime module, so it cannot create a second instance.
    const bad = (src.match(/^import\s+(?!type\b)[^;]*?from\s+'firebase-admin[^']*';/gm) ?? [])
      .filter((line) => !/^import\s+type\b/.test(line));
    if (bad.length > 0) offenders.push(`${f}: ${bad[0]!.replace(/\s+/g, ' ')}`);
  }
  assert.deepEqual(offenders, [],
    `import through ../firebase/admin-sdk.ts instead:\n  ${offenders.join('\n  ')}`);
});

test('the emulator runner only names groups that exist as scripts', () => {
  // scripts/emul-groups.sh delegates to `npm --prefix firebase run test:<group>` so the FILE
  // lists live in exactly one place. That delegation is only safe if every group it names is a
  // real script: a typo would print `=== stres ===`, fail, and look like a failing test group
  // rather than a missing one.
  const sh = fs.readFileSync(path.join(root, 'scripts/emul-groups.sh'), 'utf8');
  const m = /^for name in (.+); do/m.exec(sh);
  assert.ok(m, 'could not find the group loop in scripts/emul-groups.sh');
  const groups = m![1]!.trim().split(/\s+/);
  assert.ok(groups.length >= 3, `expected the real group list, got ${groups.join(',')}`);

  const scripts = JSON.parse(
    fs.readFileSync(path.join(root, 'firebase/package.json'), 'utf8'),
  ).scripts as Record<string, string>;
  const missing = groups.filter((g) => !(`test:${g}` in scripts));
  assert.deepEqual(missing, [], `emul-groups.sh names groups with no script: ${missing.join(', ')}`);
});

test('run-tests.sh pins its reporter instead of inheriting one', () => {
  // `node --test` chooses its reporter from whether stdout is a TTY, and WHICH reporter that is
  // changed between releases: Node 26 writes the spec form (`ℹ pass 177`) into a pipe, Node 22
  // writes TAP (`# pass 177`). run-tests.sh parses that summary to fail on cancelled/todo counts
  // the `fail` number hides, so an unpinned reporter lets the runtime change the thing being
  // parsed. A node downgrade from 26.3.1 to 22.23.1 did exactly that and turned every run into
  // "could not read a full summary from the runner" while all 177 tests were passing.
  const sh = fs.readFileSync(path.join(root, 'scripts/run-tests.sh'), 'utf8');
  assert.match(sh, /--test-reporter=spec/,
    'run-tests.sh must pin --test-reporter, or a runtime upgrade silently changes its input');
  // And it must still read the other form, so a runtime that ignores the flag degrades to
  // parsing rather than to refusing every run.
  assert.match(sh, /\^\(ℹ\|#\)/, 'the summary parse must accept both reporters');
});
