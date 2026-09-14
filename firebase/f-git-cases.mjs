// F4, F6, F7 -- the git half. Evidence: git log, inbox.jsonl, and the ledger.
//
// MECHANISM, NAMED (entry 30), because two parts of this are real and one is local:
//
//   REAL git. A bare repository is created on disk and used as `origin`. Every git operation the
//   bridge performs -- worktree, fetch, reset, add of ONE path, commit, push, and pull --rebase
//   on rejection -- is actual git against an actual remote. Nothing is stubbed.
//
//   LOCAL CDN. materialise() normally fetches
//   raw.githubusercontent.com/{repo}/{sha}/{path}. Here a fetchImpl serves the same sha-pinned
//   bytes out of the bare repo via `git show <sha>:<path>`. Same immutability, same
//   sha-pinning, same write-to-disk-before-announce ordering -- but it is NOT a measurement of
//   GitHub's CDN and no latency from this file is a result.
//
//   The remote is local so this does not push test contracts to a live repository.
//
//   REAL Firestore for the ledger, because the ledger is the evidence F7 is graded on.
//
// The ledger is real Firestore; git is a real repo; the CDN hop is local. Stated up front rather
// than discovered later.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createFirestoreStore } from './store.ts';
import { drainOnce, startInboxFeed } from '../cli/bridge.ts';
import { LAYOUT } from '../cli/agentic.ts';
import { CapturingLogger } from '../shared/log.ts';
import { systemClock } from '../shared/clock.ts';

if (process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FIRESTORE_EMULATOR_HOST set; refusing. The ledger evidence is real Firestore.');
  process.exit(1);
}

const PROJECT = process.env.FB_PROJECT_ID ?? 'multiplayer-agents-eec02';
const PID = `proj_git_${Date.now().toString(36)}`;
const REPO = 'Sibhimanyu/inventory-tracker';
const ROOT = path.resolve('.agentic', 'f-git');

let failed = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Every git child gets a DEADLINE. A wedged send-pack with no timeout hangs forever looking healthy. */
const run = (args, cwd, timeout_ms = 60_000) =>
  new Promise((resolve) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: 124, stdout, stderr: 'timeout' }); }, timeout_ms);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); });
  });

const BARE = path.join(ROOT, 'remote.git');

/** The local CDN: sha-pinned bytes straight out of the bare repo. */
const fetchImpl = async (url) => {
  const m = /raw\.githubusercontent\.com\/.+?\/.+?\/([0-9a-f]{40})\/(.+)$/.exec(url);
  if (!m) return { ok: false, status: 400, text: async () => '' };
  const show = await run(['show', `${m[1]}:${m[2]}`], BARE);
  return show.code === 0
    ? { ok: true, status: 200, text: async () => show.stdout }
    : { ok: false, status: 404, text: async () => show.stderr };
};

const V1 = `name: items-api
version: 1
breaking: false
openapi: 3.1.0
paths:
  /items:
    post:
      requestBody:
        name: { type: string }
        sku:  { type: string, unique: true }
        qty:  { type: string }
`;

const V2 = `name: items-api
version: 2
supersedes: 1
breaking: true
migration_note: >
  qty changed from string to integer. Text sorts lexically, so a string qty
  put "100" before "9" in every ordered query.
openapi: 3.1.0
paths:
  /items:
    post:
      requestBody:
        name: { type: string }
        sku:  { type: string, unique: true }
        qty:  { type: integer }
`;

const SCHEMA = `CREATE TABLE items (
  item_id TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  sku     TEXT NOT NULL UNIQUE,
  qty     INTEGER NOT NULL DEFAULT 0
);
`;

const log = new CapturingLogger();
const app = initializeApp({ projectId: PROJECT }, `fgit-${Date.now()}`);
const store = createFirestoreStore({ db: getFirestore(app), log, clock: systemClock, debounce_ms: 0 });

/** One agent's workspace: its own working tree, its own .agentic/. */
async function makeAgent(name) {
  const root = path.join(ROOT, name);
  await fs.mkdir(path.join(root, '.agentic'), { recursive: true });
  await run(['init', '-q'], root);
  await run(['config', 'user.email', 'agent@drydock.local'], root);
  await run(['config', 'user.name', `drydock ${name}`], root);
  await run(['remote', 'add', 'origin', BARE], root);
  // A root commit so the worktree has somewhere to start from.
  await fs.writeFile(path.join(root, 'README.md'), `# ${name}\n`, 'utf8');
  await run(['add', 'README.md'], root);
  await run(['commit', '-qm', 'init'], root);
  return { name, root, blackboard: { root, repo: REPO, runner: undefined, token: undefined, fetchImpl } };
}

/** The agent's ONLY write path: append one JSON line. It never calls git and never sees a sha. */
async function agentAppends(agent, kind, body) {
  const line = JSON.stringify({ kind, body }) + '\n';
  await fs.appendFile(path.join(agent.root, LAYOUT.outbox), line, 'utf8');
  return line;
}

const readLedger = async (kind) => {
  const { events } = await store.readEvents(PID, 0);
  return events.filter((e) => !kind || e.kind === kind);
};

console.log(`F4 / F6 / F7 -- the git half`);
console.log(`ledger: real Firestore ${PROJECT} asia-south1`);
console.log(`git:    real, against a local bare remote (${path.relative(process.cwd(), BARE)})`);
console.log(`CDN:    local, sha-pinned blobs via \`git show\` -- no latency here is a result\n`);

try {
  await fs.rm(ROOT, { recursive: true, force: true });
  await fs.mkdir(BARE, { recursive: true });
  await run(['init', '--bare', '-q', '-b', 'agentic/blackboard'], BARE);

  await store.ensureProject(PID, { project_name: 'Inventory Tracker', repo_url: REPO });
  for (const [id, role, initials] of [
    ['agent_architect', 'architect', 'AR'],
    ['agent_backend', 'backend-builder', 'BE'],
    ['agent_frontend', 'frontend-builder', 'FE'],
  ]) {
    await store.registerAgent(PID, { agent_id: id, role_slug: role, member_label: 'sibhi', initials, harness: 'claude-code' });
  }

  const architect = await makeAgent('architect');
  const backend = await makeAgent('backend');
  const frontend = await makeAgent('frontend');

  // ================================================================ F4
  console.log('F4  architect publishes a schema and items-api v1, then exits   [evidence: git log]');

  await fs.mkdir(path.join(architect.root, 'contracts'), { recursive: true });
  await fs.mkdir(path.join(architect.root, 'schema'), { recursive: true });
  await fs.writeFile(path.join(architect.root, 'contracts', 'items-api.v1.yaml'), V1, 'utf8');
  await fs.writeFile(path.join(architect.root, 'schema', 'items.sql'), SCHEMA, 'utf8');

  const archLines = [
    await agentAppends(architect, 'schema_published', { table: 'items', file: 'schema/items.sql', agent_id: 'agent_architect' }),
    await agentAppends(architect, 'contract_published', { name: 'items-api', version: 1, file: 'contracts/items-api.v1.yaml', agent_id: 'agent_architect' }),
  ];

  const archBridge = { root: architect.root, project_id: PID, store, log, blackboard: architect.blackboard };
  const d1 = await drainOnce(archBridge);
  check(d1.published === 2 && d1.failed === 0, `both facts published (${d1.published} published, ${d1.failed} failed)`);

  // EVIDENCE: git log on the blackboard branch.
  const gitlog = await run(['log', '--oneline', 'agentic/blackboard'], BARE);
  check(/publish items-api v1/.test(gitlog.stdout), 'git log shows "publish items-api v1"');
  check(/items/.test(gitlog.stdout), 'git log shows the schema commit');
  const tree1 = await run(['ls-tree', '-r', '--name-only', 'agentic/blackboard'], BARE);
  check(tree1.stdout.includes('contracts/items-api.v1.yaml'), 'contracts/items-api.v1.yaml is on the branch');
  check(tree1.stdout.includes('schema/items.sql'), 'schema/items.sql is on the branch');

  // The architect "then exits": its bridge stops here. Nothing below uses it.
  const pub1 = (await readLedger('contract_published')).find((e) => e.body.version === 1);
  check(typeof pub1?.body.commit_sha === 'string' && /^[0-9a-f]{40}$/.test(pub1.body.commit_sha), 'ledger event carries a 40-hex commit_sha pointer');
  check(pub1?.body.path === 'contracts/items-api.v1.yaml', 'ledger event carries the blackboard path');
  check(pub1?.body.file === undefined, 'ledger event does NOT carry the agent\'s local scratch path');

  // ================================================================ F6
  console.log('\nF6  backend publishes items-api v2, breaking, qty string -> integer   [evidence: git log]');

  await fs.mkdir(path.join(backend.root, 'contracts'), { recursive: true });
  await fs.writeFile(path.join(backend.root, 'contracts', 'items-api.v2.yaml'), V2, 'utf8');
  await agentAppends(backend, 'contract_published', {
    name: 'items-api', version: 2, supersedes: 1, breaking: true,
    file: 'contracts/items-api.v2.yaml', agent_id: 'agent_backend',
  });

  const beBridge = { root: backend.root, project_id: PID, store, log, blackboard: backend.blackboard };
  const d2 = await drainOnce(beBridge);
  check(d2.published === 1 && d2.failed === 0, 'v2 published');

  const tree2 = await run(['ls-tree', '-r', '--name-only', 'agentic/blackboard'], BARE);
  check(tree2.stdout.includes('contracts/items-api.v2.yaml'), 'contracts/items-api.v2.yaml is on the branch');
  check(tree2.stdout.includes('contracts/items-api.v1.yaml'), 'v1 is STILL on the branch beside it');

  // VERSIONS ARE NEW FILES, NEVER EDITS -- the rule F7 depends on. Assert v1's bytes are
  // byte-identical to what was published, not merely that the path still exists.
  const v1Now = await run(['show', 'agentic/blackboard:contracts/items-api.v1.yaml'], BARE);
  check(v1Now.stdout === V1, 'v1 is byte-identical to what was published (never edited in place)');
  check(/qty:  { type: string }/.test(v1Now.stdout) , 'v1 still says qty is a string');

  // The diff between versions is the thing a blocked consumer needs most. Prove it exists.
  const diff = await run(['diff', 'agentic/blackboard:contracts/items-api.v1.yaml', 'agentic/blackboard:contracts/items-api.v2.yaml'], BARE);
  check(/-.*qty.*string/.test(diff.stdout) && /\+.*qty.*integer/.test(diff.stdout), 'git diff v1..v2 shows qty string -> integer');

  // ================================================================ F7
  console.log('\nF7  frontend receives the pointer, reads the contract FROM DISK, reports blocked');
  console.log('    [evidence: inbox.jsonl + ledger]');

  const feBridge = { root: frontend.root, project_id: PID, store, log, blackboard: frontend.blackboard };
  const stopInbox = startInboxFeed(feBridge);
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const raw = await fs.readFile(path.join(frontend.root, LAYOUT.inbox), 'utf8').catch(() => '');
    if (raw.includes('items-api') && raw.includes('"version":2')) break;
  }
  stopInbox();

  const inboxRaw = await fs.readFile(path.join(frontend.root, LAYOUT.inbox), 'utf8').catch(() => '');
  const inbox = inboxRaw.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const v2Line = inbox.find((l) => l.kind === 'contract_published' && l.body.version === 2);
  check(!!v2Line, 'inbox.jsonl carries the contract_published pointer for v2');
  check(typeof v2Line?.body.local === 'string', `body.local names a local file (${v2Line?.body.local})`);
  check(v2Line?.body.commit_sha === undefined, 'and the inbox line carries NO commit_sha (C7)');

  // THE ACTUAL F7 ASSERTION: the file is on disk, and the agent opens it. No network call.
  const localAbs = path.join(frontend.root, v2Line?.body.local ?? 'missing');
  const fromDisk = await fs.readFile(localAbs, 'utf8').catch(() => null);
  check(fromDisk !== null, 'the contract exists on the frontend\'s disk before it was announced');
  check(fromDisk === V2, 'and its bytes are exactly what the backend published');
  check(/qty:  { type: integer }/.test(fromDisk ?? ''), 'reading it from disk shows qty is now an integer');

  // The frontend, having READ THE FILE, reports blocked. This is the agent acting on disk
  // contents, which is the behaviour F7 exists to prove.
  const breaking = /breaking:\s*true/.test(fromDisk ?? '');
  check(breaking, 'the frontend can see from the file alone that the change is breaking');
  await agentAppends(frontend, 'task_blocked', {
    task_id: 'task_items_ui', agent_id: 'agent_frontend',
    reason: 'items-api v2 changes qty from string to integer; the list view parses it as a string',
    contract: 'items-api', version: 2,
  });
  const d3 = await drainOnce(feBridge);
  check(d3.published === 1 && d3.failed === 0, 'the blocked report is published');

  const blocked = (await readLedger('task_blocked')).find((e) => e.body.task_id === 'task_items_ui');
  check(!!blocked, 'ledger carries task_blocked for the frontend task');
  check(/string to integer/.test(String(blocked?.body.reason ?? '')), 'and the reason names what broke');

  // ================================================================ rule 5, made to fire
  //
  // Nothing above ever had a push rejected, so the pull --rebase path -- the rule that makes
  // one-file-per-fact pay off -- was never executed. A control that never fires has not been
  // run (entry 60). Two agents publish DIFFERENT facts at the same instant: one wins the push,
  // the other is rejected, rebases, and both land. If it were a shared append-only file this is
  // exactly where it would conflict.
  console.log('\nrule 5: concurrent publishes force a push rejection and rebase');

  await fs.writeFile(path.join(backend.root, 'contracts', 'orders-api.v1.yaml'), 'name: orders-api\nversion: 1\n', 'utf8');
  await fs.mkdir(path.join(frontend.root, 'decisions'), { recursive: true });
  await fs.writeFile(path.join(frontend.root, 'decisions', '0007-qty-is-integer.md'), '# 0007 - qty is an integer\n\nStatus: accepted\n', 'utf8');

  await agentAppends(backend, 'contract_published', { name: 'orders-api', version: 1, file: 'contracts/orders-api.v1.yaml', agent_id: 'agent_backend' });
  await agentAppends(frontend, 'decision_recorded', { slug: 'qty-is-integer', number: 7, file: 'decisions/0007-qty-is-integer.md', agent_id: 'agent_frontend' });

  const [r1, r2] = await Promise.all([drainOnce(beBridge), drainOnce(feBridge)]);
  check(r1.published === 1 && r2.published === 1 && r1.failed + r2.failed === 0, 'both concurrent publishes succeeded');

  const rebased = log.withCode('cli.blackboard_push_rejected_rebasing');
  const restarted = log.withCode('cli.blackboard_branch_was_created');
  check(
    rebased.length + restarted.length > 0,
    `the rejection path actually FIRED (${rebased.length} rebase, ${restarted.length} branch-restart) -- not a vacuous pass`,
  );

  const tree3 = await run(['ls-tree', '-r', '--name-only', 'agentic/blackboard'], BARE);
  check(
    tree3.stdout.includes('contracts/orders-api.v1.yaml') && tree3.stdout.includes('decisions/0007-qty-is-integer.md'),
    'both facts are on the branch after the rebase -- additive, no conflict',
  );
  check(tree3.stdout.includes('contracts/items-api.v1.yaml') && tree3.stdout.includes('contracts/items-api.v2.yaml'), 'and nothing earlier was lost by the rebase');

  // ================================================================ the sha claim
  console.log('\nthe agent never touched a commit sha');
  const SHA = /[0-9a-f]{40}/;
  for (const [who, agent] of [['architect', architect], ['backend', backend], ['frontend', frontend]]) {
    const out = await fs.readFile(path.join(agent.root, LAYOUT.outbox), 'utf8').catch(() => '');
    check(!SHA.test(out), `${who}: nothing it WROTE to outbox.jsonl contains a sha`);
  }
  check(!SHA.test(inboxRaw), 'frontend: nothing it READ from inbox.jsonl contains a sha');
  check(archLines.every((l) => !SHA.test(l)), 'the architect\'s own outbox lines were sha-free at the source');
  // And the control: the sha DOES exist, on the ledger, where the CLI put it.
  check(SHA.test(String(pub1?.body.commit_sha)), 'control: the sha exists on the LEDGER, so the checks above are not vacuous');
} finally {
  await store.close();
  await deleteApp(app);
}

console.log(`\n${failed === 0 ? 'F4 / F6 / F7 PASSED' : `FAILED (${failed})`}`);
process.exit(failed === 0 ? 0 : 1);
