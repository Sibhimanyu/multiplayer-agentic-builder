// The _lib vendoring step and its drift guard (order 0006 section 3).
//
// The guard is the whole point: vendored copies are only safe if an edit to a
// copy fails the build. A drift check that never fires is worse than none,
// because it advertises a safety property it does not have. So these tests
// deliberately introduce drift and assert it is caught.

import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  FUNCTIONS_DIR, LIB_DIR, REPO_ROOT, VENDOR_DIRNAME, functionDirs, libFiles, renderCopy, syncLib,
} from './sync-lib.ts';

/** Remove every vendored directory, so tests start from a known state. */
function clearVendored(): void {
  for (const dir of functionDirs()) {
    rmSync(join(FUNCTIONS_DIR, dir, VENDOR_DIRNAME), { recursive: true, force: true });
  }
}

after(() => { clearVendored(); });

describe('_lib vendoring', () => {
  test('sources are the non-test .ts files in functions/_lib', () => {
    const files = libFiles();
    assert.ok(files.includes('http.ts'));
    assert.ok(files.includes('auth.ts'));
    assert.equal(files.some((f) => f.endsWith('.test.ts')), false, 'tests are not deployed');
  });

  test('targets are every function directory except _lib itself', () => {
    const dirs = functionDirs();
    assert.ok(dirs.includes('claim'));
    assert.ok(dirs.includes('append'));
    assert.ok(dirs.includes('github-webhook'));
    assert.equal(dirs.includes('_lib'), false, '_lib must not vendor into itself');
  });

  test('a copy carries a DO NOT EDIT banner naming its source', () => {
    const rendered = renderCopy('http.ts', 'export const x = 1;\n');
    assert.match(rendered, /GENERATED FILE -- DO NOT EDIT/);
    assert.match(rendered, /functions\/_lib\/http\.ts/);
    assert.match(rendered, /sync-lib\.ts/, 'must say how to regenerate');
  });

  test('shared/ imports are re-pointed, since a copy sits one level deeper', () => {
    // Without this the copies compile as broken imports and it only surfaces at
    // deploy time, which is the worst possible moment to find out.
    const rendered = renderCopy('auth.ts', "import { x } from '../../shared/store/types.ts';\n");
    assert.match(rendered, /'\.\.\/\.\.\/\.\.\/shared\/store\/types\.ts'/);
    assert.doesNotMatch(rendered, /from '\.\.\/\.\.\/shared\//);
  });

  test('sync writes a copy of every source into every function directory', () => {
    clearVendored();
    const result = syncLib();

    assert.ok(result.targets.length >= 6);
    for (const target of result.targets) {
      for (const file of result.files) {
        const dest = join(FUNCTIONS_DIR, target, VENDOR_DIRNAME, file);
        assert.ok(existsSync(dest), `missing vendored copy: ${dest}`);
        assert.match(readFileSync(dest, 'utf8'), /GENERATED FILE/);
      }
    }
  });

  test('sync is idempotent: a second run reports nothing to do', () => {
    clearVendored();
    syncLib();
    const second = syncLib();
    assert.deepEqual(second.drifted, [], 'a clean re-sync must rewrite nothing');
    assert.deepEqual(second.orphans, []);
  });

  test('--check passes when the copies are in sync', () => {
    clearVendored();
    syncLib();
    const check = syncLib({ check: true });
    assert.deepEqual(check.drifted, []);
    assert.deepEqual(check.orphans, []);
  });

  test('THE GUARD: an edited copy is caught, and --check does not repair it', () => {
    clearVendored();
    syncLib();

    const victim = join(FUNCTIONS_DIR, functionDirs()[0], VENDOR_DIRNAME, 'http.ts');
    const original = readFileSync(victim, 'utf8');
    writeFileSync(victim, `${original}\n// somebody edited the copy instead of the source\n`, 'utf8');

    const check = syncLib({ check: true });
    assert.equal(check.drifted.length, 1, 'the edit must be detected');
    assert.match(check.drifted[0], /http\.ts$/);
    // check mode reports; it must not quietly fix, or CI would go green on a
    // working tree that still contains the edit.
    assert.match(readFileSync(victim, 'utf8'), /somebody edited the copy/);

    // A real sync overwrites it wholesale.
    syncLib();
    assert.equal(readFileSync(victim, 'utf8'), original);
    assert.deepEqual(syncLib({ check: true }).drifted, []);
  });

  test('THE GUARD: a missing copy is caught', () => {
    clearVendored();
    syncLib();
    const victim = join(FUNCTIONS_DIR, functionDirs()[0], VENDOR_DIRNAME, 'auth.ts');
    rmSync(victim);

    const check = syncLib({ check: true });
    assert.equal(check.drifted.length, 1);
    assert.match(check.drifted[0], /auth\.ts$/);
  });

  test('THE GUARD: an orphaned copy with no source is caught and removed', () => {
    // _lib deleted a file; the stale copy would keep compiling against something
    // that no longer exists.
    clearVendored();
    syncLib();
    const vendorDir = join(FUNCTIONS_DIR, functionDirs()[0], VENDOR_DIRNAME);
    mkdirSync(vendorDir, { recursive: true });
    writeFileSync(join(vendorDir, 'ghost.ts'), 'export const gone = true;\n', 'utf8');

    const check = syncLib({ check: true });
    assert.equal(check.orphans.length, 1);
    assert.match(check.orphans[0], /ghost\.ts$/);
    assert.ok(existsSync(join(vendorDir, 'ghost.ts')), 'check mode must not delete');

    syncLib();
    assert.equal(existsSync(join(vendorDir, 'ghost.ts')), false, 'sync must remove the orphan');
  });

  test('vendored copies are gitignored, so generated artifacts never land in git', () => {
    const gitignore = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8');
    assert.match(gitignore, new RegExp(`${VENDOR_DIRNAME}`),
      'the vendored directory must be gitignored -- copies are build output');
  });

  test('functions/_lib is the only source of truth, and it is committed', () => {
    // The inverse of the rule above: source is tracked, copies are not.
    assert.ok(readdirSync(LIB_DIR).length > 0);
    const gitignore = readFileSync(join(REPO_ROOT, '.gitignore'), 'utf8');
    assert.doesNotMatch(gitignore, /^functions\/_lib\/?$/m, 'the SOURCE must never be ignored');
  });
});
