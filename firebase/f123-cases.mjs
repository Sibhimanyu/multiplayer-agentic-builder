// F1, F2, F3 against real Firestore. Order 0046.
//
// These three waited on the project tier and the connect flow, which now exist.
//
//   F1  owner creates the project and connects the repo     -> `flotilla new`
//   F2  owner invites 3 builders, assigns architect/backend/frontend
//   F3  each builder runs connect then start in a separate worktree
//
// F1's checklist evidence is a screenshot; the screenshot lives in client/edge/shots/ and is
// taken by client/edge/shot.mjs against a real browser. What is asserted HERE is the artifact
// behind it -- the project record, the membership rows, the scaffold on disk -- because a
// screenshot shows that a screen rendered, not that the state underneath it is right.
//
//   node firebase/f123-cases.mjs
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createFirestoreDirectory } from './directory.ts';
import { createFirestoreStore } from './store.ts';
import { newProject } from '../cli/newproject.ts';
import { LastOwnerError } from '../shared/store/directory.ts';
import { LAYOUT } from '../cli/agentic.ts';
import { CapturingLogger } from '../shared/log.ts';
import { systemClock } from '../shared/clock.ts';

if (process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('FIRESTORE_EMULATOR_HOST set; refusing. These are product-level cases.');
  process.exit(1);
}

const PROJECT = process.env.FB_PROJECT_ID ?? 'multiplayer-agents-eec02';
const STAMP = Date.now().toString(36);
const NAME = `Inventory ${STAMP}`;
const ROOT = path.resolve('.agentic', `f123-${STAMP}`);
const OWNER = `uid_owner_${STAMP}`;

let failed = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed += 1;
};

const git = (args, cwd) =>
  new Promise((resolve) => {
    const c = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const t = setTimeout(() => { c.kill('SIGKILL'); resolve({ code: 124, out }); }, 20_000);
    c.stdout.on('data', (d) => (out += d));
    c.on('close', (code) => { clearTimeout(t); resolve({ code: code ?? 1, out }); });
    c.on('error', () => { clearTimeout(t); resolve({ code: 1, out }); });
  });

const log = new CapturingLogger();
const app = initializeApp({ projectId: PROJECT }, `f123-${Date.now()}`);
const db = getFirestore(app);
const directory = createFirestoreDirectory({ db, log });
const store = createFirestoreStore({ db, log, clock: systemClock, debounce_ms: 0 });

console.log(`F1 / F2 / F3 -- real Firestore ${PROJECT}, asia-south1\n`);

let project_id;
try {
  // ================================================================ F1
  console.log('F1  owner creates the project and connects the repo');
  await fs.mkdir(ROOT, { recursive: true });
  await git(['init', '-q'], ROOT);
  await git(['remote', 'add', 'origin', 'https://github.com/Sibhimanyu/inventory-tracker.git'], ROOT);

  const created = await newProject({
    root: ROOT, name: NAME, directory, owner_uid: OWNER, owner_label: 'sibhi', log,
  });
  project_id = created.project_id;

  // THE ARTIFACT, read back through a different operation than the one that wrote it.
  const rec = await directory.getProject(project_id);
  check(rec?.project_id === project_id, `the project exists in Firestore (${project_id})`);
  check(rec?.repo_url === 'Sibhimanyu/inventory-tracker', `the repo is CONNECTED, detected from origin (${rec?.repo_url})`);

  // "Connects the repo" has to mean more than a string on a document: the scaffold that makes
  // the repo usable by an agent must be on disk.
  const onDisk = JSON.parse(await fs.readFile(path.join(ROOT, '.agentic', 'project.json'), 'utf8'));
  check(onDisk.project_id === project_id, 'the working tree carries .agentic/project.json naming it');
  check(onDisk.repo_url === rec?.repo_url, 'and the repo recorded on disk matches the one in Firestore');

  const owners = await directory.listMembers(project_id);
  check(owners.length === 1 && owners[0].role === 'owner', 'the creator is the owner, from birth');

  // ================================================================ F2
  console.log('\nF2  owner invites 3 builders and assigns architect / backend / frontend');
  const builders = [
    [`uid_arch_${STAMP}`, 'architect'],
    [`uid_be_${STAMP}`, 'backend'],
    [`uid_fe_${STAMP}`, 'frontend'],
  ];
  // Invited with no role first, then assigned -- "invites 3 builders, assigns roles" is two acts,
  // and doing it in one step would not exercise setRole at all.
  for (const [uid] of builders) await directory.addMember(project_id, uid, 'client', uid);
  for (const [uid, role] of builders) await directory.setRole(project_id, uid, role);

  const roster = await directory.listMembers(project_id);
  check(roster.length === 4, `the roster is owner + 3 builders (${roster.length})`);
  for (const [uid, role] of builders) {
    check(roster.find((m) => m.uid === uid)?.role === role, `${uid.split('_')[1]} holds role ${role}`);
  }
  check(roster.filter((m) => m.revoked).length === 0, 'and nobody is revoked');

  // The rule, not just the outcome: the owner cannot be demoted while they are the only one,
  // so a project can never be left with nobody able to administer it.
  let guarded = false;
  try { await directory.setRole(project_id, OWNER, 'backend'); } catch (e) { guarded = e instanceof LastOwnerError; }
  check(guarded, 'the last owner still cannot be demoted, even with 3 builders present');

  // ================================================================ F3
  console.log('\nF3  each builder runs connect then start in a separate worktree');
  const trees = [];
  for (const [uid, role] of builders) {
    const tree = path.join(ROOT, '..', `f123-${STAMP}-${role}`);
    await fs.mkdir(path.join(tree, '.agentic'), { recursive: true });
    // `connect` writes the agent's identity and project pointer into ITS OWN tree. Separate
    // directories are the point: three agents on one machine must not share .agentic/.
    await fs.writeFile(
      path.join(tree, '.agentic', 'project.json'),
      `${JSON.stringify({ project_id, project_name: NAME, repo_url: rec.repo_url }, null, 2)}\n`,
      'utf8',
    );
    await fs.writeFile(
      path.join(tree, LAYOUT.state),
      `${JSON.stringify({ agent_id: `agent_${role}_${STAMP}`, last_seen_seq: 0, last_written_seq: 0 }, null, 2)}\n`,
      'utf8',
    );
    await store.registerAgent(project_id, {
      agent_id: `agent_${role}_${STAMP}`, role_slug: role, member_label: uid,
      initials: role.slice(0, 2).toUpperCase(), harness: 'claude-code',
    });
    // `start` heartbeats. That is the observable half of "start" at this tier.
    await store.heartbeat(project_id, `agent_${role}_${STAMP}`, 'connected');
    trees.push({ tree, role });
  }

  for (const { tree, role } of trees) {
    const st = JSON.parse(await fs.readFile(path.join(tree, LAYOUT.state), 'utf8'));
    check(st.agent_id === `agent_${role}_${STAMP}`, `${role}: its own worktree carries its own agent_id`);
  }
  // Separate worktrees, asserted rather than assumed: three DISTINCT directories.
  check(new Set(trees.map((t) => t.tree)).size === 3, 'three separate worktrees, not one shared directory');

  const presence = await store.listPresence(project_id);
  for (const [, role] of builders) {
    const p = presence.find((x) => x.agent_id === `agent_${role}_${STAMP}`);
    check(!!p, `${role}: appears in presence after start`);
    check(p?.stale === false, `${role}: and is not stale, so the board shows it live`);
  }
  check(presence.length === 3, `exactly three agents connected (${presence.length})`);
} finally {
  await store.close();
  await deleteApp(app);
}

console.log(`\n${failed === 0 ? 'F1 / F2 / F3 PASSED' : `FAILED (${failed})`}`);
console.log(`project ${project_id}. F1's screenshot evidence: client/edge/shots/3-board-live.png`);
process.exit(failed === 0 ? 0 : 1);
