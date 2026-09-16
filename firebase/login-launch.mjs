// WHICH URL does `flotilla login` hand to the browser? Order 0060.
//
// THE BUG IS NOT "no browser opened". It is "the user ended up on a different page than the one we
// serve". The user switched to their browser, found an old multiplayer-agents-eec02.web.app tab,
// and signed in THERE -- on the hosted page, which uses redirect, which is the flow Safari's ITP
// breaks. Three orders of work went into the local page and they were never on it.
//
// So a test that asserts "spawn was called" is worthless here: it passes while the CLI hands the
// launcher the hosted URL. The assertion has to be the URL STRING ITSELF.
//
// HOW: no product seam, no test-only flag. A directory is put at the FRONT OF PATH containing an
// executable with the launcher's own name, which records its argv to a file. The real binary
// spawns what it always spawns; what it passed is then on disk. That is the artifact rule --
// assert what the user's machine actually receives, not what the code appears to intend.
//
//   node firebase/login-launch.mjs
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { browserCommand, openBrowser } from '../cli/browser.ts';
import { localLoginUrl, loginUrl } from '../cli/auth.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const cli = path.join(here, 'flotilla-main.ts');

let failed = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed += 1;
};

const env0 = Object.fromEntries(
  (await fs.readFile(path.join(repo, 'client/.env.local'), 'utf8')).split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const PROJECT = env0.VITE_FIREBASE_PROJECT_ID;

console.log('WHICH URL REACHES THE BROWSER\n');

// ============================================================ 1. the command per platform
console.log('1. every platform gets a launcher that exists there');
{
  const url = 'http://localhost:12345/';
  const mac = browserCommand('darwin', url);
  const lin = browserCommand('linux', url);
  const win = browserCommand('win32', url);
  check(mac.command === 'open' && mac.args.includes(url), `darwin -> open ${url}`);
  check(lin.command === 'xdg-open' && lin.args.includes(url), `linux  -> xdg-open ${url}`);
  // win32 was previously given xdg-open, which does not exist on Windows.
  check(win.command === 'cmd' && win.args[1] === 'start' && win.args.includes(url),
    `win32  -> ${win.command} ${win.args.join(' ')}`);
  check(win.args[2] === '""',
    'and win32 passes an empty title placeholder, or `start` eats the URL as a window title');
  check(lin.command !== 'xdg-open' === false && win.command !== 'xdg-open',
    'win32 is NOT handed xdg-open (the old code gave it exactly that)');
}

// ============================================================ 2. a launcher that is not there
console.log('\n2. a launcher that cannot start is reported, not swallowed');
{
  const out = await openBrowser('http://localhost:1/', {
    platform: 'linux',
    spawnImpl: () => {
      const e = new EventEmitter();
      setTimeout(() => e.emit('error', new Error('spawn xdg-open ENOENT')), 5);
      return e;
    },
  });
  check(out.ok === false, 'a failed launch reports ok=false');
  check(/ENOENT/.test(out.error ?? ''), `and carries the reason (${out.error})`);
  check(out.url === 'http://localhost:1/', 'and still knows the URL it tried, for the message');
}

// ============================================================ the real binary
//
// A sandbox with a fake launcher first on PATH.
const SANDBOX = path.join(repo, '.agentic', `launch-${Date.now().toString(36)}`);
const HOME = path.join(SANDBOX, 'home');
const BIN = path.join(SANDBOX, 'bin');
const RECORD = path.join(SANDBOX, 'argv.txt');
await fs.mkdir(HOME, { recursive: true });
await fs.mkdir(BIN, { recursive: true });

const launcherName = browserCommand(process.platform, 'x').command;
await fs.writeFile(
  path.join(BIN, launcherName),
  `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(RECORD)}\nexit 0\n`,
  { mode: 0o755 },
);

const baseEnv = { ...process.env, HOME, PATH: `${BIN}:${process.env.PATH}` };
for (const k of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_TOKEN', 'GCLOUD_PROJECT',
  'GOOGLE_CLOUD_PROJECT', 'FLOTILLA_PROJECT', 'FLOTILLA_API_KEY']) delete baseEnv[k];

/** Run `flotilla login ...`, let it print and launch, then stop it. It waits 5 minutes otherwise. */
const runLogin = (args, env = baseEnv) => new Promise((resolve) => {
  const child = spawn(process.execPath, [cli, 'login', ...args], { cwd: repo, env });
  let out = '';
  const onData = (d) => { out += d; };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  // Long enough for the URL to print and the launcher to be spawned and recorded.
  const stop = setTimeout(() => child.kill('SIGKILL'), 6_000);
  child.on('close', () => { clearTimeout(stop); resolve({ out }); });
});

const recorded = async () => {
  const text = await fs.readFile(RECORD, 'utf8').catch(() => '');
  return text.split('\n').map((l) => l.trim()).filter(Boolean);
};
const clearRecord = () => fs.rm(RECORD, { force: true });

const init = await new Promise((resolve) => {
  const c = spawn(process.execPath, [cli, 'init', '--project', PROJECT], { cwd: repo, env: baseEnv });
  let out = '';
  c.stdout.on('data', (d) => { out += d; });
  c.stderr.on('data', (d) => { out += d; });
  c.on('close', (code) => resolve({ code, out }));
});
console.log(`\n(init exited ${init.code})`);

// ============================================================ 3. the default
console.log('\n3. DEFAULT: the launcher receives the localhost URL this server is bound to');
let localFromDefault = null;
{
  await clearRecord();
  const { out } = await runLogin([]);
  const printed = /http:\/\/localhost:\d+\//.exec(out)?.[0] ?? null;
  const args = await recorded();

  check(!!printed, `the URL is printed (${printed ?? 'NOT PRINTED'})`);
  check(args.length > 0, `the launcher ran (${launcherName} received ${args.length} argument(s))`);
  // THE ASSERTION THIS ORDER EXISTS FOR: string for string, the page we serve.
  check(args.includes(printed), `and it received EXACTLY the printed URL: ${args.join(' ')}`);
  check(args.some((a) => a.startsWith('http://localhost:')),
    'which is a localhost URL -- the page the CLI serves itself');
  check(!args.some((a) => a.includes('web.app')),
    'and NOT the hosted board, which is where the user actually ended up');
  localFromDefault = printed;
}

// ============================================================ 4. --no-browser
console.log('\n4. --no-browser: no launch, and the URL is STILL printed');
{
  await clearRecord();
  const { out } = await runLogin(['--no-browser']);
  const printed = /http:\/\/localhost:\d+\//.exec(out)?.[0] ?? null;
  const args = await recorded();
  // Both halves. A flag that suppressed the launch AND the print would be useless on the headless
  // box it exists for.
  check(args.length === 0, `the launcher was NOT invoked (${args.length} argument(s) recorded)`);
  check(!!printed, `and the URL is still printed (${printed ?? 'NOT PRINTED'})`);
}

// ============================================================ 5. --hosted
console.log('\n5. --hosted: the launcher receives the HOSTED url');
let hostedFromFlag = null;
{
  await clearRecord();
  const { out } = await runLogin(['--hosted']);
  const printed = /https:\/\/\S+/.exec(out)?.[0] ?? null;
  const args = await recorded();
  check(args.length > 0, 'the launcher ran');
  check(args.includes(printed), `and received exactly the printed URL: ${printed}`);
  check(args.some((a) => a.includes('/login?') && a.startsWith('https://')),
    'which is the hosted board page, as that flag promises');
  hostedFromFlag = printed;
}

// ============================================================ 6. THE CONTROL
//
// Everything above is vacuous if the two URLs were the same string -- the default check would
// pass while handing over the hosted page. Prove they differ, and that each check would reject
// the other's URL.
console.log('\n6. THE CONTROL: the two URLs are genuinely different');
{
  check(!!localFromDefault && !!hostedFromFlag && localFromDefault !== hostedFromFlag,
    `local (${localFromDefault}) !== hosted (${hostedFromFlag})`);
  check(!localFromDefault?.includes('web.app') && hostedFromFlag?.includes('web.app'),
    'and only one of them is the hosted board, so section 3 could have failed');
  // And the builders themselves disagree, independently of the running binary.
  check(localLoginUrl(1234) !== loginUrl('https://x.web.app', 1234, 'n'.repeat(43)),
    'localLoginUrl and loginUrl produce different URLs by construction');
}

// ============================================================ 7. a launcher that fails
console.log('\n7. a launcher that fails: the login still proceeds and the URL is still printed');
{
  await clearRecord();
  // Same fake launcher, made to fail. The login must not depend on it.
  await fs.writeFile(path.join(BIN, launcherName), '#!/bin/sh\nexit 127\n', { mode: 0o755 });
  const { out } = await runLogin([]);
  const printed = /http:\/\/localhost:\d+\//.exec(out)?.[0] ?? null;
  check(!!printed, `the URL is printed anyway (${printed ?? 'NOT PRINTED'})`);
  check(/Open this in your browser/.test(out), 'with the instruction that makes it usable');
  check(!/Traceback|Error:/.test(out), 'and the command does not fall over behind it');
}

await fs.rm(SANDBOX, { recursive: true, force: true });
console.log(`\n${failed === 0 ? 'LAUNCH VERIFIED' : `FAILED (${failed})`}`);
process.exit(failed === 0 ? 0 : 1);
