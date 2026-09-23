// Build the published CLI artifacts: dist/flotilla.js, the npm tarball, and install.sh.
//
// ORDER 0058 ASKED FOR THIS AND IT WAS NEVER BUILT. The tarball and the installer existed only
// inside client/dist -- a gitignored directory that `vite build` empties -- so a routine rebuild
// deleted both, and hosting's catch-all rewrite kept answering `/install.sh` with 200 and
// index.html. The published install path was dead for a day and every status check said fine.
//
// Everything this emits is derived from tracked source (packaging/ + firebase/ + cli/ + shared/).
// Nothing here is hand-copied, so nothing here can go stale without the source going stale first.

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(root, 'client', 'dist');
const pkg = JSON.parse(readFileSync(join(root, 'packaging', 'package.json'), 'utf8'));

// esbuild lives in client/. Importing it from there rather than adding a second copy at the root:
// one version of the bundler, one place to upgrade it.
const esbuild = await import(join(root, 'client', 'node_modules', 'esbuild', 'lib', 'main.js'));

const stage = mkdtempSync(join(tmpdir(), 'flotilla-pack-'));
try {
  mkdirSync(join(stage, 'dist'), { recursive: true });

  // One bundle, node platform, ESM, with the shebang npm needs to link it as a binary.
  // `packages: 'external'` keeps firebase-admin a real dependency rather than inlining a
  // megabyte of it -- the package.json declares it and npm installs it.
  await esbuild.build({
    entryPoints: [join(root, 'firebase', 'flotilla-main.ts')],
    outfile: join(stage, 'dist', 'flotilla.js'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    packages: 'external',
    banner: { js: '#!/usr/bin/env node\n' },
    // So `flotilla --version` cannot disagree with the tarball it shipped in. Running from
    // source has no define and reports 0.1.0-dev instead of claiming a release number.
    define: { __FLOTILLA_VERSION__: JSON.stringify(pkg.version) },
    logLevel: 'error',
  });

  // THE FONTS SHIP WITH THE CLI. `flotilla chat` serves a page that must render in Plex with no
  // network (DESIGN.md: "any visual divergence between the two builds is a bug"), and before
  // order 0083 it had no font files to serve, so it fell back to system-ui -- the one typographic
  // signal DESIGN.md forbids by name. Five woff2 plus the licence is 148 KB in a CLI tarball.
  //
  // COPIED FROM client/public, not duplicated into packaging/: one copy of each font in the
  // repository, so the board and the CLI cannot drift onto different cuts of the same typeface.
  const fontSrc = join(root, 'client', 'public', 'brand', 'fonts');
  const fontDst = join(stage, 'dist', 'brand', 'fonts');
  mkdirSync(fontDst, { recursive: true });
  const fonts = readdirSync(fontSrc).filter((f) => f.endsWith('.woff2'));
  // Asserted, not assumed: an empty glob would silently ship a fontless CLI, which is exactly
  // the failure this block fixes and is invisible until someone opens the page.
  if (fonts.length < 5) {
    throw new Error(`expected 5 woff2 in ${fontSrc}, found ${fonts.length}`);
  }
  for (const f of [...fonts, 'OFL.txt']) copyFileSync(join(fontSrc, f), join(fontDst, f));

  writeFileSync(join(stage, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
  copyFileSync(join(root, 'README.md'), join(stage, 'README.md'));

  // npm pack names the file for us: flotilla-cli-<version>.tgz. Read it back rather than
  // reconstructing the name, so a version bump cannot make the build and the installer disagree.
  execFileSync('npm', ['pack', '--quiet'], { cwd: stage, stdio: 'inherit' });
  const tgz = readdirSync(stage).find((f) => f.endsWith('.tgz'));
  if (!tgz) throw new Error('npm pack produced no tarball');

  mkdirSync(outDir, { recursive: true });
  copyFileSync(join(stage, tgz), join(outDir, tgz));
  copyFileSync(join(root, 'packaging', 'install.sh'), join(outDir, 'install.sh'));

  // The installer hardcodes the version it fetches. If that ever disagrees with the tarball
  // this build just produced, the published one-liner 404s -- which, behind the rewrite, looks
  // like a 200. Caught here instead.
  const installer = readFileSync(join(root, 'packaging', 'install.sh'), 'utf8');
  const wants = /VERSION="([^"]+)"/.exec(installer)?.[1];
  if (wants !== pkg.version) {
    throw new Error(
      `install.sh fetches version ${wants} but packaging/package.json is ${pkg.version}`,
    );
  }

  const bytes = (f) => readFileSync(join(outDir, f)).length;
  console.log(`build-cli: ${tgz} (${bytes(tgz)} bytes) + install.sh (${bytes('install.sh')} bytes) -> client/dist`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}
