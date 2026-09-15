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
const built = fs.readFileSync(out, 'utf8');
if (!built.startsWith('#!/usr/bin/env node')) {
  console.error('FAIL: built file has no shebang; it would not be executable when installed');
  process.exit(1);
}
console.log('shebang present');

// NO PROJECT ID IN THE SHIPPED BUNDLE.
//
// Checked HERE, on the built file, because the source was clean-looking the whole time this was
// broken: `?? 'multiplayer-agents-eec02'` read as a harmless default and compiled one person's
// Firebase project into a package anyone can install. Grepping the source would have said
// nothing; grepping the artifact is what found it.
//
// Checked against the project ids THIS REPO ACTUALLY KNOWS, gathered from its own config, rather
// than against a guessed pattern for "what a Firebase id looks like". A first attempt used a
// shape regex and flagged `x-agent-token`, `retry-after` and `rev-parse` -- there is no reliable
// shape, and a check that cries wolf gets deleted.
//
// This is narrower but it is the actual failure: the project the bundle was built against
// leaking into the bundle. It would have caught the original bug, which is the bar.
const known = new Set();
for (const f of ['../client/.env.local', '../.firebaserc', '../firebase.json']) {
  try {
    const text = fs.readFileSync(path.join(here, f), 'utf8');
    for (const m of text.matchAll(/([a-z][a-z0-9-]{4,29})/g)) {
      if (/-[a-z0-9]{4,6}$/.test(m[1]) && m[1].includes('-')) known.add(m[1]);
    }
  } catch { /* absent is fine */ }
}
const leaked = [...known].filter((id) => built.includes(id));
if (leaked.length > 0) {
  console.error(`FAIL: the bundle names a project from this repo's own config: ${leaked.join(', ')}`);
  console.error('  A published CLI must not name the project it was built against.');
  process.exit(1);
}

// THE CONTROL. An absence check is vacuous unless it can fire, and this one nearly shipped
// checking an empty set. Prove the same comparison flags a bundle that DOES contain an id.
if (known.size === 0) {
  console.error('FAIL: no project ids found in this repo\'s config, so the check above proved nothing.');
  process.exit(1);
}
const canary = [...known][0];
if (!`${built}\n// ${canary}`.includes(canary)) {
  console.error('FAIL: the leak check cannot detect a project id even when one is present.');
  process.exit(1);
}
console.log(`no project id in the bundle (checked ${known.size} known id(s), e.g. ${canary})`);
