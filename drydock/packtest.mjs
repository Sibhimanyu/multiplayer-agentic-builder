// Prove the PACKAGE, not the build step. Order 0048.
//
// `npm pack` exiting 0 says a tarball was produced. It does not say the tarball contains the
// bundle, that the bin path resolves, that the shebang survived, or that the binary runs from
// somewhere that is not this repo. PACKAGING THAT WORKS IN THE SOURCE TREE AND FAILS FROM A
// TARBALL IS THE NORMAL FAILURE -- node resolves ../shared happily from here and not at all from
// a global install -- and only installing the tarball somewhere clean can tell them apart.
//
// So: pack, install into a directory that has no relationship to this repo, and run the REAL
// binary from there.
//
//   node drydock/packtest.mjs
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
// Inside the worktree because the sandbox confines writes here, but OUTSIDE the package and with
// its own node_modules -- which is what makes it a clean install rather than a source-tree run.
const SANDBOX = path.join(repo, '.agentic', 'packtest');

let failed = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed += 1;
};
const run = async (cmd, args, opts = {}) => {
  try {
    const { stdout, stderr } = await exec(cmd, args, { maxBuffer: 1 << 24, ...opts });
    return { code: 0, out: stdout + stderr };
  } catch (e) {
    return { code: e.code ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

await fs.rm(SANDBOX, { recursive: true, force: true });
await fs.mkdir(SANDBOX, { recursive: true });

console.log('1. npm pack\n');
const packed = await run('npm', ['pack', '--json'], { cwd: here });
check(packed.code === 0, 'npm pack exits 0');
// `prepack` prints the build output on the same stream as `--json`, so slice from the first '['
// to the LAST ']' rather than to the end. Parsing from the first bracket to end-of-output picks
// up the trailing build lines and throws.
const meta = JSON.parse(
  packed.out.slice(packed.out.indexOf('['), packed.out.lastIndexOf(']') + 1),
)[0];
const tarball = path.join(here, meta.filename);
console.log(`  tarball   ${meta.filename}  ${(meta.size / 1024).toFixed(1)} KiB, ${meta.entryCount} entries`);

// The CONTENTS, before trusting the install. A tarball with no dist/ installs fine and fails on
// first run, which is a much worse place to find out.
const names = meta.files.map((f) => f.path);
check(names.includes('dist/drydock.js'), 'the tarball CONTAINS dist/drydock.js');
check(names.includes('package.json'), 'and package.json');
check(!names.some((n) => n.startsWith('..')), 'and nothing reaching above the package root');

console.log('\n2. install into a clean directory\n');
await fs.writeFile(path.join(SANDBOX, 'package.json'), JSON.stringify({ name: 'packtest', private: true }, null, 2));
const install = await run('npm', ['install', '--no-audit', '--no-fund', tarball], { cwd: SANDBOX });
check(install.code === 0, `npm install <tarball> exits 0${install.code ? `: ${install.out.slice(0, 300)}` : ''}`);

const bin = path.join(SANDBOX, 'node_modules', '.bin', 'drydock');
check(await fs.stat(bin).then(() => true, () => false), 'the `drydock` binary is on .bin');

console.log('\n3. run the REAL binary from the clean directory\n');
const help = await run(bin, ['--help'], { cwd: SANDBOX });
console.log(help.out.trimEnd().split('\n').map((l) => `  | ${l}`).join('\n'));
check(help.code === 0, 'drydock --help exits 0');
check(/drydock new <name>/.test(help.out), 'help ADVERTISES `drydock new` -- the string the UI shows');
check(!/\bbuilder\b/.test(help.out), 'and the word "builder" appears nowhere in it');

// A CONTROL for the help assertion: a command that does not exist must be refused, or "--help
// exits 0" would also pass for a binary that ignores its arguments entirely.
const bogus = await run(bin, ['definitely-not-a-command'], { cwd: SANDBOX });
check(bogus.code !== 0, `an unknown subcommand is REFUSED (exit ${bogus.code}) -- so the dispatcher is reading argv`);

console.log('\n4. an UNCONFIGURED install must refuse, not guess\n');
const demo = path.join(SANDBOX, 'demo-repo');
await fs.mkdir(demo, { recursive: true });
await run('git', ['init', '-q'], { cwd: demo });
await run('git', ['remote', 'add', 'origin', 'https://github.com/Sibhimanyu/inventory-tracker.git'], { cwd: demo });

// HOME is redirected into the sandbox so this exercises a genuinely fresh install and cannot
// read -- or clobber -- the real ~/.drydock on this machine.
const FAKE_HOME = path.join(SANDBOX, 'home');
await fs.mkdir(FAKE_HOME, { recursive: true });
const cleanEnv = { ...process.env, HOME: FAKE_HOME, DRYDOCK_UID: 'uid_packtest', BUILDER_ROOT: demo };
delete cleanEnv.DRYDOCK_PROJECT;
delete cleanEnv.FB_PROJECT_ID;

const name = `Packtest ${Date.now().toString(36)}`;
const unconfigured = await run(bin, ['new', name], { cwd: demo, env: cleanEnv });
check(unconfigured.code !== 0, `unconfigured \`drydock new\` FAILS (exit ${unconfigured.code}) rather than defaulting`);
check(/drydock init --project/.test(unconfigured.out), 'and the error names the command to run');
// THE ARTIFACT AGAIN: the project id must not be recoverable from the shipped bundle even by
// reading it. Source being clean proved nothing; this is the file a stranger receives.
const bundle = await fs.readFile(path.join(SANDBOX, 'node_modules', 'drydock-cli', 'dist', 'drydock.js'), 'utf8');
check(!bundle.includes('multiplayer-agents-eec02'),
  'and the INSTALLED bundle does not contain the project it was built against');

console.log('\n5. drydock init, then new, from the installed binary\n');
const apiKey = (await fs.readFile(path.join(repo, 'client', '.env.local'), 'utf8'))
  .split('\n').find((l) => l.startsWith('VITE_FIREBASE_API_KEY='))?.split('=')[1]?.trim();
const init = await run(bin, ['init', '--project', 'multiplayer-agents-eec02', '--api-key', apiKey ?? ''], {
  cwd: demo, env: cleanEnv,
});
console.log(init.out.trimEnd().split('\n').filter((l) => !l.startsWith('{')).map((l) => `  | ${l}`).join('\n'));
check(init.code === 0, `drydock init exits 0 (${init.code})`);
check(/cloudfunctions\.net\/write/.test(init.out), 'and the write URL is DERIVED from the project id, not stored separately');

// `new` NOW REQUIRES AN IDENTITY, and this file deliberately never logs in.
//
// Order 0051 moved project creation off the Admin SDK and onto the user's token, and these
// assertions -- written when `new` used admin credentials -- were not re-run afterwards. They
// have been failing silently since. A test only covers what it is re-run against.
//
// The division now: PACKTEST proves the PACKAGE (it installs, the bin resolves, the binary runs,
// it refuses correctly). STRANGER proves the FLOW, including a login. Making packtest log in too
// would duplicate that and give two places to keep in step.
const notSignedIn = await run(bin, ['new', name], { cwd: demo, env: cleanEnv });
console.log(notSignedIn.out.trimEnd().split('\n').filter((l) => !l.startsWith('{')).map((l) => `  | ${l}`).join('\n'));
check(notSignedIn.code === 1, `installed + configured but NOT logged in: \`new\` refuses (exit ${notSignedIn.code})`);
check(/not signed in/i.test(notSignedIn.out), 'and says "not signed in"');
check(/drydock login/.test(notSignedIn.out), 'naming the command to run');
check(!/default credentials/i.test(notSignedIn.out), 'and not a credentials-library error');

// AND IT WROTE NOTHING. A refusal that had already scaffolded half a project would leave the
// repo looking set up when it is not -- worse than the error it printed.
const scaffold = await fs.readFile(path.join(demo, '.agentic', 'project.json'), 'utf8').catch(() => null);
check(scaffold === null, 'and scaffolded NOTHING -- a refused create leaves no .agentic/project.json');

// Creating a project end to end, with a login, is drydock/stranger.mjs. Stated here so the gap
// is a decision rather than something nobody noticed.
console.log('\n   (project creation end to end, including login, is drydock/stranger.mjs)');

await fs.rm(tarball, { force: true });
console.log(`\n${failed === 0 ? 'PACKAGE VERIFIED FROM A TARBALL INSTALL' : `PACK TEST FAILED (${failed})`}`);
process.exit(failed === 0 ? 0 : 1);
