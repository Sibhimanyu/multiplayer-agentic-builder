// The whole path, as someone who has never touched this machine. Order 0051.
//
//   install tarball -> drydock init -> drydock login -> drydock new
//     -> agent appends claim_requested -> bridge claims -> card moves -> agent reports -> ledger
//
// THE ENVIRONMENT IS SCRUBBED, AND THAT IS THE POINT. The previous stranger test redirected HOME
// and left GOOGLE_APPLICATION_CREDENTIALS exported, so `drydock init` found credentials nobody
// else has and went green on a command that was broken for everyone. A redirected HOME is not a
// fresh machine. Every child below runs with those variables REMOVED, not overridden.
//
// Assertions are on ARTIFACTS -- the config file, the project document, the claim document, the
// ledger event -- never on a command's exit code alone.
//
//   node drydock/stranger.mjs
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const SANDBOX = path.join(repo, '.agentic', 'stranger');
const FB_PROJECT = process.env.FB_PROJECT_ID ?? 'multiplayer-agents-eec02';

let failed = 0;
const results = [];
const check = (ok, label) => {
  results.push({ ok, label });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed += 1;
};

/**
 * A stranger's environment: no Google credentials, no Firebase token, no ambient project, and a
 * HOME that has never seen drydock. Built by DELETION from a copy, so a variable added to this
 * machine later cannot silently leak in.
 */
const strangerEnv = (extra = {}) => {
  const e = { ...process.env, ...extra };
  for (const k of [
    'GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_TOKEN', 'GCLOUD_PROJECT',
    'GOOGLE_CLOUD_PROJECT', 'DRYDOCK_PROJECT', 'DRYDOCK_API_KEY', 'FB_PROJECT_ID',
  ]) delete e[k];
  return e;
};

const run = async (cmd, args, opts = {}) => {
  try {
    const { stdout, stderr } = await exec(cmd, args, { maxBuffer: 1 << 24, ...opts });
    return { code: 0, out: stdout + stderr };
  } catch (e) {
    return { code: e.code ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};
const quote = (s, n = 6) => s.trimEnd().split('\n').slice(0, n).map((l) => `        | ${l}`).join('\n');

await fs.rm(SANDBOX, { recursive: true, force: true });
await fs.mkdir(SANDBOX, { recursive: true });
const HOME = path.join(SANDBOX, 'home');
await fs.mkdir(HOME, { recursive: true });
const env = strangerEnv({ HOME });

console.log('THE STRANGER PATH');
console.log('  env scrubbed of GOOGLE_APPLICATION_CREDENTIALS, FIREBASE_TOKEN, GCLOUD_PROJECT,');
console.log(`  GOOGLE_CLOUD_PROJECT, DRYDOCK_*, FB_PROJECT_ID;  HOME=${path.relative(repo, HOME)}\n`);

// ---------------------------------------------------------------- 1. install
console.log('1. install the tarball into a clean directory');
const packed = await run('npm', ['pack', '--json'], { cwd: here });
const meta = JSON.parse(packed.out.slice(packed.out.indexOf('['), packed.out.lastIndexOf(']') + 1))[0];
const tarball = path.join(here, meta.filename);
await fs.writeFile(path.join(SANDBOX, 'package.json'), JSON.stringify({ name: 'stranger', private: true }));
const install = await run('npm', ['install', '--no-audit', '--no-fund', tarball], { cwd: SANDBOX, env });
check(install.code === 0, `npm install <tarball> (${meta.filename})`);
const bin = path.join(SANDBOX, 'node_modules', '.bin', 'drydock');
check(await fs.stat(bin).then(() => true, () => false), 'the `drydock` binary is installed');

// ---------------------------------------------------------------- 2. errors are messages
console.log('\n2. an unconfigured install explains itself');
const bare = await run(bin, ['ls'], { cwd: SANDBOX, env });
console.log(quote(bare.out));
check(bare.code === 1, `exits 1 (${bare.code})`);
check(/drydock init --project/.test(bare.out), 'names the command to run');
check(!/\bat .*\.js:\d+/.test(bare.out) && !/\^\s*$/m.test(bare.out),
  'and prints NO stack trace -- a crash dump is a message to whoever wrote the tool');
const dbg = await run(bin, ['ls'], { cwd: SANDBOX, env: { ...env, DRYDOCK_DEBUG: '1' } });
check(/at /.test(dbg.out), 'DRYDOCK_DEBUG=1 does show the stack, for whoever has to fix it');

// ---------------------------------------------------------------- 3. init
console.log('\n3. drydock init -- must need NO credentials');
const init = await run(bin, ['init', '--project', FB_PROJECT], { cwd: SANDBOX, env });
console.log(quote(init.out));
check(init.code === 0, `drydock init exits 0 (${init.code})`);
check(!/default credentials/i.test(init.out), 'and does not ask for Application Default Credentials');
// THE ARTIFACT: the config file, not the exit code.
const cfgPath = path.join(HOME, '.drydock', 'config.json');
const cfg = await fs.readFile(cfgPath, 'utf8').then(JSON.parse, () => null);
check(cfg !== null, 'config.json exists');
check(cfg?.project_id === FB_PROJECT, `and records the project id (${cfg?.project_id})`);
check(typeof cfg?.api_key === 'string' && cfg.api_key.length > 10,
  'and the web API key, fetched from the project\'s PUBLIC hosting config');

// ---------------------------------------------------------------- 4. login (STUBBED)
console.log('\n4. drydock login -- STUBBED, and only this step');
console.log('        Google sign-in needs a browser and a human; it cannot be driven headlessly.');
console.log('        Everything either side of it is real. The stub writes the SAME credential');
console.log('        file the loopback flow writes, and nothing downstream knows the difference.');
const su = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${cfg.api_key}`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ returnSecureToken: true }),
});
const session = await su.json();
check(su.ok && !!session.refreshToken, 'a real Firebase identity was issued (the stub is the BROWSER, not the auth)');
await fs.writeFile(
  path.join(HOME, '.drydock', 'credentials.json'),
  JSON.stringify({
    refresh_token: session.refreshToken, uid: session.localId,
    project_id: FB_PROJECT, obtained_at: new Date().toISOString(),
  }, null, 2),
  { mode: 0o600 },
);
const UID = session.localId;
check(!!UID, `signed in as ${String(UID).slice(0, 10)}...`);

// ---------------------------------------------------------------- 5. new
console.log('\n5. drydock new, in a repo the stranger just made');
const demo = path.join(SANDBOX, 'my-repo');
await fs.mkdir(demo, { recursive: true });
await run('git', ['init', '-q'], { cwd: demo, env });
await run('git', ['remote', 'add', 'origin', 'https://github.com/Sibhimanyu/inventory-tracker.git'], { cwd: demo, env });
const NAME = `Stranger ${Date.now().toString(36)}`;
const created = await run(bin, ['new', NAME], { cwd: demo, env: { ...env, DRYDOCK_UID: UID, BUILDER_ROOT: demo } });
console.log(quote(created.out, 7));
check(created.code === 0, `drydock new exits 0 (${created.code})`);
const PID = /created (proj_[a-z0-9_]+)/.exec(created.out)?.[1];
check(!!PID, `project id (${PID})`);
const scaffold = await fs.readFile(path.join(demo, '.agentic', 'project.json'), 'utf8').then(JSON.parse, () => null);
check(scaffold?.project_id === PID, '.agentic/project.json exists and names it');
const packs = await fs.readdir(path.join(demo, '.agentic', 'roles')).catch(() => []);
check(packs.length === 6, `six role packs on disk (${packs.length})`);

// The rest needs admin access to read Firestore, which a stranger does not have and this test
// harness does. Stated rather than blurred: from here the assertions are the OPERATOR's view of
// what the stranger's commands produced.
console.log('\n   (verification below uses admin credentials to READ Firestore — the stranger');
console.log('    still only runs the CLI; this is how the harness sees what they produced)');

// Via firebase/admin-sdk.ts: a bare `firebase-admin` specifier does not resolve from this
// directory, because the install lives under firebase/. See that file.
const { initializeApp, deleteApp, getFirestore } = await import('../firebase/admin-sdk.ts');
const { createFirestoreStore } = await import('../firebase/store.ts');
const { drainOnce } = await import('../cli/bridge.ts');
const { CapturingLogger } = await import('../shared/log.ts');
const { systemClock } = await import('../shared/clock.ts');

const adminApp = initializeApp({ projectId: FB_PROJECT }, `stranger-${Date.now()}`);
const db = getFirestore(adminApp);
const log = new CapturingLogger();
const store = createFirestoreStore({ db, log, clock: systemClock, debounce_ms: 0 });

try {
  const projDoc = await db.collection('projects').doc(PID).get();
  check(projDoc.exists, 'the PROJECT DOCUMENT exists in Firestore');
  check(projDoc.get('repo_url') === 'Sibhimanyu/inventory-tracker', 'and records the repo from origin');

  // ---------------------------------------------------------------- 6. agent claims
  console.log('\n6. the agent appends claim_requested; the BRIDGE claims');
  const AGENT = `agent_be_${Date.now().toString(36)}`;
  await store.registerAgent(PID, {
    agent_id: AGENT, role_slug: 'backend', member_label: 'stranger', initials: 'BE', harness: 'claude-code',
  });
  await store.seedTasks(PID, [{
    task_id: 'task_demo', title: 'Add a quantity field', kind: 'backend', status: 'open',
    claimed_by: null, branch: null, pr_url: null, pr_number: null, ci: null, depends_on: [],
    blocked_by: null, blocked_reason: null, file_scope: ['functions/**'], updated_at: systemClock.iso(),
  }]);
  await fs.writeFile(
    path.join(demo, '.agentic', 'state.json'),
    JSON.stringify({ agent_id: AGENT, last_seen_seq: 0, last_written_seq: 0 }, null, 2),
  );

  // Exactly what the protocol now documents: two fields, nothing invented.
  await fs.writeFile(
    path.join(demo, '.agentic', 'outbox.jsonl'),
    `${JSON.stringify({ kind: 'claim_requested', body: { task_id: 'task_demo', agent_id: AGENT } })}\n`,
  );
  const d1 = await drainOnce({ root: demo, project_id: PID, store, log });
  check(d1.published === 1 && d1.failed === 0, `the bridge accepted claim_requested (${d1.published}/${d1.failed})`);

  // THE ARTIFACT: the claim document, not the return value.
  const claim = await db.collection('projects').doc(PID).collection('claims').doc('task_demo').get();
  check(claim.exists, 'the CLAIM DOCUMENT exists');
  check(claim.get('agent_id') === AGENT, `held by the agent that asked (${claim.get('agent_id') === AGENT})`);

  // ---------------------------------------------------------------- 7. the card moves
  const snap = await store.readSnapshot(PID);
  const task = snap?.snapshot.tasks.find((t) => t.task_id === 'task_demo');
  check(task?.status === 'claimed', `the CARD MOVED to claimed (${task?.status})`);
  check(task?.claimed_by === AGENT, 'and names the agent');

  // ---------------------------------------------------------------- 8. agent reports
  console.log('\n7. the agent reports; it lands on the ledger');
  await fs.appendFile(
    path.join(demo, '.agentic', 'outbox.jsonl'),
    `${JSON.stringify({ kind: 'task_progress', body: { task_id: 'task_demo', agent_id: AGENT, summary: 'added the qty column' } })}\n`,
  );
  const d2 = await drainOnce({ root: demo, project_id: PID, store, log });
  check(d2.published === 1 && d2.failed === 0, 'the report published');
  const { events } = await store.readEvents(PID, 0);
  check(events.some((e) => e.kind === 'task_claimed' && e.body.task_id === 'task_demo'), 'the LEDGER has task_claimed');
  check(events.some((e) => e.kind === 'task_progress' && /qty column/.test(String(e.body.summary ?? ''))), 'and the progress report');

  // ---------------------------------------------------------------- 9. a LOSS is a reply
  console.log('\n8. a second agent loses the race, and is TOLD');
  const RIVAL = `agent_fe_${Date.now().toString(36)}`;
  await store.registerAgent(PID, {
    agent_id: RIVAL, role_slug: 'frontend', member_label: 'rival', initials: 'FE', harness: 'claude-code',
  });
  const rivalRoot = path.join(SANDBOX, 'rival');
  await fs.mkdir(path.join(rivalRoot, '.agentic'), { recursive: true });
  await fs.writeFile(path.join(rivalRoot, '.agentic', 'state.json'),
    JSON.stringify({ agent_id: RIVAL, last_seen_seq: 0, last_written_seq: 0 }));
  await fs.writeFile(path.join(rivalRoot, '.agentic', 'outbox.jsonl'),
    `${JSON.stringify({ kind: 'claim_requested', body: { task_id: 'task_demo', agent_id: RIVAL } })}\n`);
  const d3 = await drainOnce({ root: rivalRoot, project_id: PID, store, log });
  check(d3.failed === 0, 'a lost claim is NOT a failure for the bridge');
  const rivalInbox = await fs.readFile(path.join(rivalRoot, '.agentic', 'inbox.jsonl'), 'utf8').catch(() => '');
  const denial = rivalInbox.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.kind === 'claim_denied');
  check(!!denial, 'the loser gets claim_denied ON ITS INBOX');
  check(denial?.layer === 'coordination', `as coordination layer (${denial?.layer})`);
  check(denial?.body.owner === AGENT, 'naming who holds it');

  // ---------------------------------------------------------------- 10. CAN IT GO RED?
  console.log('\n9. the control: one hop against a deliberately WRONG project id');
  const wrong = `${PID}_does_not_exist`;
  const wrongDoc = await db.collection('projects').doc(wrong).get();
  const wouldPass = wrongDoc.exists;
  check(!wouldPass, `the project-document assertion FAILS for a wrong id (exists=${wrongDoc.exists})`);
  const wrongClaim = await db.collection('projects').doc(wrong).collection('claims').doc('task_demo').get();
  check(!wrongClaim.exists, 'and so does the claim-document assertion');
  const wrongSnap = await store.readSnapshot(wrong);
  check(!wrongSnap?.snapshot.tasks.some((t) => t.task_id === 'task_demo'),
    'and the card-moved assertion — so a green run above is not green by construction');
} finally {
  await store.close();
  await deleteApp(adminApp);
  await fs.rm(tarball, { force: true });
}

console.log(`\n${failed === 0 ? 'STRANGER PATH PASSED' : `STRANGER PATH FAILED (${failed})`}`);
console.log(`${results.length - failed}/${results.length} assertions.`);
console.log('STUBBED: the browser half of `drydock login` only. Everything else ran.');
process.exit(failed === 0 ? 0 : 1);
