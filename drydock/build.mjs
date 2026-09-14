// Build the `drydock` binary to plain JS.
//
// WHY A BUNDLE AND NOT tsc. Two reasons, both about the installed user rather than this repo:
//
//   1. An installed user has NO TYPESCRIPT LOADER. Everything in this repo runs .ts directly
//      through node's type stripping; that is a property of running from source and does not
//      survive `npm install`.
//   2. The CLI imports from ../shared and ../cli, which are OUTSIDE this package directory. npm
//      pack cannot include files above the package root, so a tsc build emitting a tree of .js
//      would ship imports pointing at files that are not in the tarball. Bundling compiles them
//      in, which is why the package can be rooted here without reaching upward at runtime.
//
// WHY THIS PACKAGE IS NOT THE REPO ROOT. Root package.json is frozen: `npm test` there must mean
// exactly "the shared conformance suite" on both branches, and renaming it or adding a bin would
// make that claim branch-specific. territory.md records the precedent -- prefer "stop needing
// the frozen file" over "ask who owns it" -- so the package lives in its own tree.
//
// firebase-admin stays EXTERNAL: it has native and dynamically-required pieces that do not
// survive bundling, so it is a real dependency the installer resolves.
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const out = path.join(here, 'dist', 'drydock.js');

const esbuild = await import(path.join(repo, 'client', 'node_modules', 'esbuild', 'lib', 'main.js'));

await esbuild.build({
  entryPoints: [path.join(repo, 'firebase', 'drydock-main.ts')],
  outfile: out,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // Not 'external: packages' -- that would externalise ../shared too if it were a bare import.
  // Only the SDK is external; everything relative is compiled in.
  external: ['firebase-admin', 'firebase-admin/*'],
  banner: { js: '#!/usr/bin/env node' },
  logLevel: 'warning',
  // The repo's imports are written as ./x.ts because node strips types in place. esbuild
  // resolves those paths directly, so no rewriting is needed -- but say so, because the next
  // person will wonder whether allowImportingTsExtensions matters here. It does not: that is a
  // typechecker setting, and this is a bundler.
});

fs.chmodSync(out, 0o755);
const bytes = fs.statSync(out).size;
console.log(`built ${path.relative(repo, out)}  ${(bytes / 1024).toFixed(1)} KiB`);

// Assert the ARTIFACT, not that the build returned. A bundle missing its shebang installs as a
// binary the shell cannot execute, and that failure only appears after `npm install -g`.
const head = fs.readFileSync(out, 'utf8').slice(0, 20);
if (!head.startsWith('#!/usr/bin/env node')) {
  console.error('FAIL: built file has no shebang; it would not be executable when installed');
  process.exit(1);
}
console.log('shebang present');
