// Vendor functions/_lib into each function directory.
//
// Catalyst deploys each function directory independently, so shared code has to
// be either vendored per directory or published to a registry. Order 0006 chose
// vendoring: a private registry would add auth, versioning and publish steps to
// every contributor's setup, on a tool whose main advantage is low friction.
//
// The rules that make vendoring safe rather than a slow-motion fork:
//
//   - functions/_lib is the ONLY source of truth.
//   - The copies are generated artifacts. Gitignored, never edited, always
//     overwritten wholesale.
//   - `check` fails the build when a copy has drifted, so an edit to a copy is
//     caught at once rather than silently surviving until it contradicts source.
//
// Usage:
//   node catalyst/tools/sync-lib.ts          write the copies (predeploy)
//   node catalyst/tools/sync-lib.ts --check  verify, write nothing, exit 1 on drift

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');
export const FUNCTIONS_DIR = join(REPO_ROOT, 'functions');
export const LIB_DIR = join(FUNCTIONS_DIR, '_lib');
/** Where the copy lands inside each function directory. */
export const VENDOR_DIRNAME = '_vendor';

const GENERATED_BANNER =
  '// GENERATED FILE -- DO NOT EDIT. Source: functions/_lib/%s\n' +
  '// Regenerate with: node catalyst/tools/sync-lib.ts\n' +
  '// Edits here are overwritten and will fail the drift check.\n';

export interface SyncResult {
  /** Function directories that received a copy. */
  targets: string[];
  /** Files copied per target. */
  files: string[];
  /** Paths whose copy did not match source. Empty means in sync. */
  drifted: string[];
  /** Copies present with no corresponding source file. */
  orphans: string[];
}

/** Source files to vendor. Tests are not deployed, so they are not copied. */
export function libFiles(): string[] {
  return readdirSync(LIB_DIR)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .sort();
}

/** Function directories: everything under functions/ except _lib itself. */
export function functionDirs(): string[] {
  return readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== '_lib')
    .map((e) => e.name)
    .sort();
}

/**
 * The content a vendored copy must have.
 *
 * Two transforms, both necessary:
 *  - a banner, so nobody edits a copy by accident;
 *  - `../../shared/` becomes `../../../shared/`, because the copy sits one level
 *    deeper than the source. Without this the copies typecheck as broken imports
 *    and the failure only shows up at deploy time.
 */
export function renderCopy(filename: string, source: string): string {
  const banner = GENERATED_BANNER.replace('%s', filename);
  const rewritten = source.replace(/(['"])\.\.\/\.\.\/shared\//g, '$1../../../shared/');
  return banner + rewritten;
}

function sha(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * Sync (or check) every copy.
 *
 * `check: true` writes nothing and reports what would change -- that is the mode
 * the build runs, so a hand-edited copy fails loudly instead of shipping.
 */
export function syncLib(opts: { check?: boolean } = {}): SyncResult {
  const check = opts.check === true;
  const files = libFiles();
  const targets = functionDirs();
  const drifted: string[] = [];
  const orphans: string[] = [];

  for (const target of targets) {
    const vendorDir = join(FUNCTIONS_DIR, target, VENDOR_DIRNAME);

    // A copy with no source is drift too: _lib deleted a file and the stale copy
    // would keep compiling against something that no longer exists.
    let existing: string[] = [];
    try {
      existing = readdirSync(vendorDir).filter((f) => f.endsWith('.ts'));
    } catch {
      existing = [];
    }
    for (const found of existing) {
      if (!files.includes(found)) {
        orphans.push(relative(REPO_ROOT, join(vendorDir, found)));
        if (!check) rmSync(join(vendorDir, found));
      }
    }

    for (const file of files) {
      const source = readFileSync(join(LIB_DIR, file), 'utf8');
      const expected = renderCopy(file, source);
      const dest = join(vendorDir, file);

      let current: string | null = null;
      try {
        if (statSync(dest).isFile()) current = readFileSync(dest, 'utf8');
      } catch {
        current = null;
      }

      if (current !== null && sha(current) === sha(expected)) continue;

      drifted.push(relative(REPO_ROOT, dest));
      if (!check) {
        mkdirSync(vendorDir, { recursive: true });
        writeFileSync(dest, expected, 'utf8');
      }
    }
  }

  return { targets, files, drifted, orphans };
}

/** CLI. Kept at the bottom so importing this module runs nothing. */
function main(argv: string[]): number {
  const check = argv.includes('--check');
  const result = syncLib({ check });

  if (check) {
    if (result.drifted.length === 0 && result.orphans.length === 0) {
      console.log(`_lib copies in sync: ${result.files.length} files x ${result.targets.length} functions`);
      return 0;
    }
    console.error('_lib copies have DRIFTED from functions/_lib.');
    for (const p of result.drifted) console.error(`  stale or missing: ${p}`);
    for (const p of result.orphans) console.error(`  orphaned (no source): ${p}`);
    console.error('\nThe copies are generated artifacts. Edit functions/_lib instead, then run:');
    console.error('  node catalyst/tools/sync-lib.ts');
    return 1;
  }

  console.log(`synced ${result.files.length} files into ${result.targets.length} function directories`);
  for (const p of result.drifted) console.log(`  wrote ${p}`);
  for (const p of result.orphans) console.log(`  removed orphan ${p}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv.slice(2)));
}
