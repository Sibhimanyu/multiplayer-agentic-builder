// `flotilla whoami`, against the real binary. Order 0057.
//
// Three outcomes, three exit codes, because this is a command people put in scripts and an exit
// code that lies is worse than no command. Driven as a CHILD PROCESS under a fresh HOME with a
// scrubbed environment -- the identity it reports must come from the credential file and nothing
// else. An ambient GOOGLE_APPLICATION_CREDENTIALS answering for it is the exact failure mode that
// made `ls` and `members` print "Could not load the default credentials" to strangers.
//
//   node firebase/whoami-cases.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const cli = path.join(here, 'flotilla-main.ts');
const SANDBOX = path.join(repo, '.agentic', `whoami-${Date.now().toString(36)}`);

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

const HOME = path.join(SANDBOX, 'home');
await fs.mkdir(HOME, { recursive: true });

// Scrubbed by DELETION, and a fresh HOME rather than a redirected one.
const env = { ...process.env, HOME };
for (const k of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_TOKEN', 'GCLOUD_PROJECT',
  'GOOGLE_CLOUD_PROJECT', 'FLOTILLA_PROJECT', 'FLOTILLA_API_KEY']) delete env[k];

const run = (args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [cli, ...args], { cwd: repo, env });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const t = setTimeout(() => child.kill('SIGKILL'), 60_000);
  child.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
});

console.log('flotilla whoami\n');

// ============================================================ 1. in --help
//
// The order's reason, and it is the right one: a command missing from the help does not exist for
// the person who needs it.
console.log('1. it is discoverable');
{
  const help = await run(['--help']);
  check(help.code === 0, `--help exits 0 (${help.code})`);
  check(/flotilla whoami/.test(help.out), 'and lists `flotilla whoami`');
  check(/identity this machine is signed in as/.test(help.out), 'with what it does');
  // The control: --help would also "contain whoami" if it printed everything under the sun. Check
  // it still lists the commands it listed before, so this is an addition and not a replacement.
  check(/flotilla login/.test(help.out) && /flotilla ls/.test(help.out),
    'and the existing commands are still there (the control)');
}

// ============================================================ 2. not configured
console.log('\n2. not configured -> the existing message, exit 1');
{
  const r = await run(['whoami']);
  check(r.code === 1, `exits 1 (${r.code})`);
  check(/not configured/i.test(r.out), 'says it is not configured');
  check(/flotilla init --project/.test(r.out), 'and names `flotilla init --project`');
  // The same message the other commands give -- not a second dialect for the same condition.
  check(/There is no default project/.test(r.out), 'using the existing NotConfigured text');
  check(!/default credentials/i.test(r.out), 'and never mentions Application Default Credentials');
}

// ============================================================ 3. configured, not signed in
console.log('\n3. configured but not signed in -> names `flotilla login`, exit 1');
{
  const init = await run(['init', '--project', PROJECT]);
  check(init.code === 0, `flotilla init exits 0 (${init.code})`);

  const r = await run(['whoami']);
  check(r.code === 1, `exits 1 (${r.code})`);
  check(/Not signed in/i.test(r.out), 'says it is not signed in');
  check(/flotilla login/.test(r.out), 'and names `flotilla login`');
  check(r.out.includes(PROJECT), 'while still reporting which project is configured');
  check(!/not configured/i.test(r.out), 'and does NOT confuse this with being unconfigured');
}

// ============================================================ 4. signed in
console.log('\n4. signed in -> uid, email, project, credential path, exit 0');
{
  // A REAL identity from the live project, written through the CLI's own saveCredential so the
  // file is the one `flotilla login` produces -- not a fixture shaped like it.
  const su = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${env0.VITE_FIREBASE_API_KEY}`,
    { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ returnSecureToken: true }) },
  );
  const session = await su.json();
  check(su.ok && !!session.refreshToken, 'a real Firebase identity was issued');

  const { saveCredential, credentialsPath } = await import('../cli/auth.ts');
  const file = await saveCredential({
    refresh_token: session.refreshToken, uid: session.localId, project_id: PROJECT,
    obtained_at: new Date().toISOString(),
  }, HOME);
  check(file === credentialsPath(HOME), 'stored where the CLI stores it');

  const r = await run(['whoami']);
  check(r.code === 0, `exits 0 (${r.code})`);
  check(r.out.includes(session.localId), `reports the uid (${session.localId})`);
  check(r.out.includes(PROJECT), 'the project');
  check(r.out.includes(credentialsPath(HOME)), 'and the credential path');
  check(/anonymous — no email|anonymous -- no email/.test(r.out),
    'an anonymous identity is described as having no email rather than showing a blank');

  // It must read the FILE, not the network. Proven by breaking the network name resolution for
  // this run: a whoami that still answers is one that never called out.
  const offline = await new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, 'whoami'], {
      cwd: repo,
      // An unroutable proxy for anything that tries to leave the machine.
      env: { ...env, HTTPS_PROXY: 'http://127.0.0.1:1', HTTP_PROXY: 'http://127.0.0.1:1' },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const t = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
  });
  check(offline.code === 0 && offline.out.includes(session.localId),
    'and answers with the network proxied into a black hole -- it reads the file, not Firebase');
}

// ============================================================ 5. a credential for another project
console.log('\n5. a credential from a DIFFERENT project is called out');
{
  const { saveCredential } = await import('../cli/auth.ts');
  await saveCredential({
    refresh_token: 'r', uid: 'uid_elsewhere', project_id: 'some-other-project',
    obtained_at: new Date().toISOString(),
  }, HOME);
  const r = await run(['whoami']);
  check(r.code === 0, `still exits 0 -- it IS signed in (${r.code})`);
  check(/NOTE: this config points at/.test(r.out), 'but says the config and the credential disagree');
  check(r.out.includes('some-other-project') && r.out.includes(PROJECT), 'naming both projects');
}

await fs.rm(SANDBOX, { recursive: true, force: true });
console.log(`\n${failed === 0 ? 'WHOAMI VERIFIED' : `FAILED (${failed})`}`);
process.exit(failed === 0 ? 0 : 1);
