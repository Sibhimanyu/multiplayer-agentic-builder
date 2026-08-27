// F1-F12: the Inventory Tracker demo, end to end, against the real GitHub.
//
// This is the headline result. It runs the whole system: three agents in three
// separate worktrees, a real ledger, real claims, a real contract published to
// the git blackboard, a real branch, a real pull request, a real CI failure, a
// real merge, and a real reaper releasing a real dead agent's claim.
//
// Nothing here is staged. In particular F9's red check is produced by a CI
// workflow that genuinely fails because `qty` is still a string -- the same
// breaking change F6 publishes -- rather than by a check invented to be red.
//
//   GITHUB_LIVE=1 node --test --test-timeout=3600000 \
//     github/demo/f-series.live.test.ts
//
// F11 waits out the REAL 15-minute claim timeout by default. Set
// F11_TIMEOUT_MS to shorten it, and if you do, the result is a demonstration of
// the mechanism at a different constant -- say so rather than reporting F11.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

import { PROTOCOL_VERSION } from '../../shared/store/types.ts';
import { systemClock } from '../../shared/clock.ts';
import { CapturingLogger } from '../../shared/log.ts';

import { createGithubStore } from '../store/github.ts';
import { createGitRunner, createHttpTransport } from '../store/transport.ts';
import { AgenticDir, PROTOCOL_EXCERPT } from '../cli/agentic.ts';
import { ROLE_PACKS } from '../cli/cli.ts';
import { createBlackboard, contractPath } from '../cli/blackboard.ts';
import { createDaemon } from '../cli/daemon.ts';
import { reapStaleClaims } from '../reaper.ts';
import { mapDelivery, taskFromBranch } from '../webhook/map.ts';

const run = promisify(execFile);
const LIVE = process.env.GITHUB_LIVE === '1';
const REPO = process.env.GITHUB_REPO ?? 'Sibhimanyu/inventory-tracker-github';
const F11_TIMEOUT_MS = Number(process.env.F11_TIMEOUT_MS ?? 15 * 60_000);

function token(): string {
  return process.env.GITHUB_TOKEN
    ?? execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
}

const PROJECT = `proj-demo${process.pid}`;
const TASK_API = 'task_items_api';
const TASK_UI = 'task_items_ui';
const BRANCH = 'agent/backend/items_api';

interface Builder {
  agent_id: string;
  /** The heartbeat loop a real `start` would be running. See F3. */
  pulse?: ReturnType<typeof setInterval>;
  role: keyof typeof ROLE_PACKS;
  dir: string;
  agentic: AgenticDir;
  store: ReturnType<typeof createGithubStore>;
  daemon: ReturnType<typeof createDaemon>;
  blackboard: ReturnType<typeof createBlackboard>;
  log: CapturingLogger;
}

const builders = new Map<string, Builder>();
const dirs: string[] = [];
const timings: { step: string; ms: number }[] = [];
let demoStart = 0;

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  const out = await fn();
  const ms = Date.now() - t0;
  timings.push({ step: name, ms });
  // eslint-disable-next-line no-console
  console.log(`[${name}] ${ms} ms`);
  return out;
}

/** F3: each builder gets its OWN worktree, as if on its own machine. */
async function makeBuilder(role: keyof typeof ROLE_PACKS, agent_id: string): Promise<Builder> {
  const dir = await mkdtemp(join(tmpdir(), `demo-${role}-`));
  dirs.push(dir);
  await run('git', ['clone', '--quiet', `https://github.com/${REPO}.git`, dir]);
  await run('git', ['-C', dir, 'config', 'user.email', 'agent@example.invalid']);
  await run('git', ['-C', dir, 'config', 'user.name', `agent-${role}`]);

  const git = createGitRunner(dir);
  const log = new CapturingLogger();
  const store = createGithubStore({
    repo: REPO, git, http: createHttpTransport(), token: token(),
    clock: systemClock, log,
  });
  const agentic = new AgenticDir(dir);
  await agentic.create({
    project: {
      project_id: PROJECT, name: 'Inventory Tracker',
      repo_url: `https://github.com/${REPO}`, brief: 'Inventory Tracker',
      protocol_version: PROTOCOL_VERSION,
    },
    role: ROLE_PACKS[role]!,
    agent_id,
    protocol_excerpt: PROTOCOL_EXCERPT,
  });
  const blackboard = createBlackboard({ git, repo: REPO, cwd: dir });
  const daemon = createDaemon({
    store, agentic, project_id: PROJECT, agent_id, blackboard, clock: systemClock, log,
    fetchPinned: (sha, path) => blackboard.readPinned(sha, path, token(), async (url, init) => {
      const res = await fetch(url, { headers: init.headers });
      return { status: res.status, body: await res.text() };
    }),
  });
  const b: Builder = { agent_id, role, dir, agentic, store, daemon, blackboard, log };
  builders.set(role, b);
  return b;
}

function owner(): ReturnType<typeof createGithubStore> {
  return builders.get('architect')!.store;
}

if (LIVE) {
  before(() => { demoStart = Date.now(); });

  // ---- F1, F2 -------------------------------------------------------------

  test('F1 the owner creates the project and connects the repo', async () => {
    await step('F1', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'demo-owner-'));
      dirs.push(dir);
      await run('git', ['init', '--quiet', dir]);
      await run('git', ['-C', dir, 'remote', 'add', 'origin', `https://github.com/${REPO}.git`]);
      const store = createGithubStore({
        repo: REPO, git: createGitRunner(dir), http: createHttpTransport(),
        token: token(), clock: systemClock,
      });
      await store.purge(PROJECT);
      await store.registerTask(PROJECT, { task_id: TASK_API, title: 'Items API', kind: 'backend' });
      await store.registerTask(PROJECT, { task_id: TASK_UI, title: 'Items UI', kind: 'frontend' });

      // "Connects the repo" is the whole of provisioning on this route: the repo
      // IS the backend. There is no project to create and nothing to link.
      const snap = await store.readSnapshot(PROJECT);
      assert.ok(snap);
      assert.equal(snap.snapshot.repo_url, `https://github.com/${REPO}`);
      assert.deepEqual(snap.snapshot.tasks.map((t) => t.task_id).sort(), [TASK_API, TASK_UI]);
    });
  });

  test('F2 the owner invites three builders and assigns their roles', async () => {
    await step('F2', async () => {
      await makeBuilder('architect', 'agent_arch01');
      await makeBuilder('backend', 'agent_be01');
      await makeBuilder('frontend', 'agent_fe01');
      for (const [role, b] of builders) {
        await b.store.registerAgent(PROJECT, {
          agent_id: b.agent_id, role_slug: role, member_label: ROLE_PACKS[role]!.title,
        });
      }
      const presence = await owner().listPresence(PROJECT);
      assert.deepEqual(
        presence.map((p) => p.role_slug).sort(),
        ['architect', 'backend', 'frontend'],
      );
    });
  });

  // ---- F3 -----------------------------------------------------------------

  test('F3 each builder has its own .agentic tree and an independent identity', async () => {
    await step('F3', async () => {
      const seen = new Set<string>();
      for (const b of builders.values()) {
        const state = await b.agentic.readState();
        assert.equal(state.agent_id, b.agent_id);
        assert.ok(!seen.has(b.dir), 'each builder must be in its own worktree');
        seen.add(b.dir);
        const agents = await readFile(join(b.dir, 'AGENTS.md'), 'utf8');
        assert.ok(agents.includes(ROLE_PACKS[b.role]!.title));
        // The agent holds no credential. This is the property that makes prompt
        // injection unable to exfiltrate one.
        assert.ok(!agents.includes('gho_') && !agents.includes('ghp_'));
      }
      // Start each builder's heartbeat loop, because a real `start` runs one.
      //
      // The dry run taught me why this matters: without it the BACKEND agent
      // stopped beating during F8-F10's CI waits and the reaper correctly took
      // its claim in F11. The reaper was right and the demo was wrong -- a
      // running agent beats, and an agent that has gone quiet for fifteen
      // minutes IS dead by the only definition the system has.
      for (const b of builders.values()) {
        await b.daemon.beat('working');
        b.pulse = setInterval(() => { void b.daemon.beat('working').catch(() => {}); }, 20_000);
        b.pulse.unref();
      }
    });
  });

  // ---- F4 -----------------------------------------------------------------

  test('F4 the architect publishes the schema and items-api v1, then exits', async () => {
    await step('F4', async () => {
      const a = builders.get('architect')!;
      const v1 = [
        'name: items-api', 'version: 1', 'supersedes: null', 'breaking: false',
        'openapi: 3.1.0', 'paths:', '  /items:', '    post:', '      requestBody:',
        '        name: { type: string }', '        sku:  { type: string, unique: true }',
        '        qty:  { type: string }', '',
      ].join('\n');

      const published = await a.blackboard.publish(
        contractPath('items-api', 1), v1, 'publish items-api v1',
      );
      assert.match(published.commit_sha, /^[0-9a-f]{40}$/);

      await a.store.appendEvent(PROJECT, {
        layer: 'contract', kind: 'contract_published', actor_type: 'agent', actor_id: a.agent_id,
        body: {
          name: 'items-api', version: 1, path: published.path,
          commit_sha: published.commit_sha, supersedes: null,
        },
      }, `f4-contract-v1-${PROJECT}`);

      // C2: the event body carries a POINTER, never the content.
      const { events } = await owner().readEvents(PROJECT, 0);
      const e = events.find((x) => x.kind === 'contract_published');
      assert.ok(e);
      assert.equal(e.body.commit_sha, published.commit_sha);
      assert.ok(!JSON.stringify(e.body).includes('openapi'), 'the contract body must not be inlined');
    });
  });

  // ---- F5 -----------------------------------------------------------------

  test('F5 backend and frontend claim concurrently with no double-claim', async () => {
    await step('F5', async () => {
      const be = builders.get('backend')!;
      const fe = builders.get('frontend')!;

      // Both race for the SAME task first, to prove exactly-one under real
      // concurrency in the demo and not only in A2.
      const [r1, r2] = await Promise.all([
        be.store.claimTask(PROJECT, TASK_API, be.agent_id),
        fe.store.claimTask(PROJECT, TASK_API, fe.agent_id),
      ]);
      const winners = [r1, r2].filter((r) => r.ok);
      assert.equal(winners.length, 1, 'exactly one agent may hold a task');

      const loser = [r1, r2].find((r) => !r.ok) as { ok: false; owner: string };
      assert.ok([be.agent_id, fe.agent_id].includes(loser.owner),
        'the loser must be told a real owner');

      // Then each takes its own task, as the demo intends.
      if (!r1.ok) assert.deepEqual(await be.store.claimTask(PROJECT, TASK_API, be.agent_id), { ok: true });
      assert.deepEqual(await fe.store.claimTask(PROJECT, TASK_UI, fe.agent_id), { ok: true });

      const claims = await owner().listClaims(PROJECT);
      const byTask = new Map(claims.map((c) => [c.task_id, c.agent_id]));
      assert.equal(byTask.get(TASK_API), be.agent_id);
      assert.equal(byTask.get(TASK_UI), fe.agent_id);
    });
  });

  // ---- F6 -----------------------------------------------------------------

  test('F6 the backend publishes items-api v2, a breaking change', async () => {
    await step('F6', async () => {
      const be = builders.get('backend')!;
      const v2 = [
        'name: items-api', 'version: 2', 'supersedes: 1', 'breaking: true',
        'migration_note: >',
        '  qty changed from string to integer. Text sorts lexically, so a string',
        '  qty put "100" before "9" in every ordered query.',
        'openapi: 3.1.0', 'paths:', '  /items:', '    post:', '      requestBody:',
        '        name: { type: string }', '        sku:  { type: string, unique: true }',
        '        qty:  { type: integer }', '',
      ].join('\n');

      // The agent writes the file and names it. The CLI does the rest -- the
      // agent never handles a commit sha (C7).
      const rel = 'contracts/items-api.v2.yaml';
      await writeFile(join(be.dir, rel.replace('contracts/', '')), v2, 'utf8');
      await be.agentic.appendOutbox({
        v: PROTOCOL_VERSION, kind: 'contract_published', ts: systemClock.iso(),
        body: {
          name: 'items-api', version: 2,
          file: join(be.dir, rel.replace('contracts/', '')), supersedes: 1,
        },
      });
      const drained = await be.daemon.drainOutbox();
      assert.equal(drained.published, 1);

      const { events } = await owner().readEvents(PROJECT, 0);
      const v2ev = events.filter((e) => e.kind === 'contract_published')
        .find((e) => e.body.version === 2);
      assert.ok(v2ev, 'v2 must reach the ledger');
      assert.match(String(v2ev.body.commit_sha), /^[0-9a-f]{40}$/);
      assert.equal(v2ev.body.supersedes, 1);

      // C6: v1 is untouched. A version is a NEW FILE, never an edit -- editing
      // v1 in place destroys the diff a blocked consumer needs most.
      const v1ev = events.filter((e) => e.kind === 'contract_published')
        .find((e) => e.body.version === 1);
      assert.ok(v1ev);
      assert.notEqual(v1ev.body.commit_sha, v2ev.body.commit_sha);
    });
  });

  // ---- F7 -----------------------------------------------------------------

  test('F7 the frontend receives the pointer, reads the contract from disk, reports blocked', async () => {
    await step('F7', async () => {
      const fe = builders.get('frontend')!;
      const res = await fe.daemon.deliverInbox();
      assert.ok(res.delivered >= 2, 'v1 and v2 must both arrive');

      const lines = (await readFile(fe.agentic.p('inbox.jsonl'), 'utf8'))
        .split('\n').filter(Boolean).map((l) => JSON.parse(l) as { kind: string; body: { local?: string; version?: number } });
      const v2 = lines.find((l) => l.kind === 'contract_published' && l.body.version === 2);
      assert.ok(v2, 'the v2 pointer must be in the inbox');
      assert.ok(v2.body.local, 'body.local must be populated');

      // The agent opens a FILE. It never makes a network call.
      const onDisk = await readFile(join(fe.dir, v2.body.local!), 'utf8');
      assert.match(onDisk, /qty:\s+\{ type: integer \}/, 'the real contract must be on disk');
      assert.match(onDisk, /breaking: true/);

      // B8 again, live: no human-layer event ever reached this agent.
      assert.ok(!lines.some((l) => l.kind === 'task_progress' || l.kind === 'agent_heartbeat'),
        'a human-layer event reached an agent inbox');

      await fe.agentic.appendOutbox({
        v: PROTOCOL_VERSION, kind: 'task_blocked', ts: systemClock.iso(),
        body: { task_id: TASK_UI, reason: 'needs items-api v2', blocked_by_task_id: TASK_API },
      });
      await fe.daemon.drainOutbox();

      const { events } = await owner().readEvents(PROJECT, 0);
      const blocked = events.find((e) => e.kind === 'task_blocked');
      assert.ok(blocked);
      assert.equal(blocked.body.reason, 'needs items-api v2');
    });
  });

  // ---- F8 -----------------------------------------------------------------

  let prNumber = 0;

  test('F8 the backend pushes a branch, opens a PR, and the board updates', async () => {
    await step('F8', async () => {
      const be = builders.get('backend')!;
      await run('git', ['-C', be.dir, 'fetch', '--quiet', 'origin', 'main']);
      await run('git', ['-C', be.dir, 'checkout', '--quiet', '-B', BRANCH, 'origin/main']);
      // qty is still a string here, so CI genuinely fails. F9's red badge is a
      // real failure, not a check invented to be red.
      await writeFile(join(be.dir, 'qty.txt'), 'string\n', 'utf8');
      await run('git', ['-C', be.dir, 'add', 'qty.txt']);
      await run('git', ['-C', be.dir, 'commit', '--quiet', '-m', 'items API: qty still a string']);
      await run('git', ['-C', be.dir, 'push', '--quiet', '--force', 'origin', `HEAD:${BRANCH}`]);

      const head = (await run('git', ['-C', be.dir, 'rev-parse', 'HEAD'])).stdout.trim();

      // Route G delivers GitHub events by POLLING; the same mapper a webhook
      // would use turns the API payload into a ledger event.
      const mapped = mapDelivery('push', {
        repository: { full_name: REPO },
        ref: `refs/heads/${BRANCH}`,
        after: head,
      }, `demo-push-${head.slice(0, 8)}`, {
        resolveProject: () => PROJECT, resolveTask: taskFromBranch,
      });
      assert.ok(mapped);
      assert.equal(mapped.event.kind, 'branch_pushed');
      await be.store.appendEvent(PROJECT, mapped.event, mapped.idempotency_key);

      const existing = await run('gh', [
        'pr', 'list', '--repo', REPO, '--head', BRANCH, '--json', 'number', '--state', 'open',
      ]).then((r) => JSON.parse(r.stdout) as { number: number }[]);
      if (existing.length > 0) {
        prNumber = existing[0]!.number;
      } else {
        const created = await run('gh', [
          'pr', 'create', '--repo', REPO, '--head', BRANCH, '--base', 'main',
          '--title', 'Items API', '--body', 'F8 of the route G demo.',
        ]);
        prNumber = Number(/\/pull\/(\d+)/.exec(created.stdout)?.[1]);
      }
      assert.ok(prNumber > 0, 'a real PR must exist');

      const prMapped = mapDelivery('pull_request', {
        repository: { full_name: REPO },
        action: 'opened',
        pull_request: {
          number: prNumber, html_url: `https://github.com/${REPO}/pull/${prNumber}`,
          head: { ref: BRANCH },
        },
      }, `demo-pr-${prNumber}`, { resolveProject: () => PROJECT, resolveTask: taskFromBranch });
      assert.ok(prMapped);
      await be.store.appendEvent(PROJECT, prMapped.event, prMapped.idempotency_key);

      const snap = await owner().readSnapshot(PROJECT);
      assert.ok(snap);
      const task = snap.snapshot.tasks.find((t) => t.task_id === TASK_API);
      assert.ok(task);
      assert.equal(task.status, 'pr_open', 'the board must reach pr_open');
      assert.equal(task.pr_number, prNumber);
    });
  });

  // ---- F9 -----------------------------------------------------------------

  test('F9 CI fails and the board shows the badge', async () => {
    await step('F9', async () => {
      const be = builders.get('backend')!;

      // Wait for the REAL check run to conclude.
      let conclusion: string | null = null;
      for (let i = 0; i < 60; i += 1) {
        const r = await run('gh', [
          'api', `repos/${REPO}/commits/${BRANCH}/check-runs`,
          '--jq', '.check_runs[0].conclusion // "pending"',
        ]).catch(() => ({ stdout: 'pending' }));
        conclusion = r.stdout.trim();
        if (conclusion !== 'pending' && conclusion !== 'null' && conclusion !== '') break;
        await new Promise((res) => setTimeout(res, 5_000));
      }
      assert.equal(conclusion, 'failure',
        `CI must genuinely fail while qty is a string, got ${conclusion}`);

      const mapped = mapDelivery('check_suite', {
        repository: { full_name: REPO },
        action: 'completed',
        check_suite: {
          conclusion, head_branch: BRANCH,
          pull_requests: [{ number: prNumber, head: { ref: BRANCH } }],
          app: { name: 'GitHub Actions' },
          url: `https://github.com/${REPO}/actions`,
        },
      }, `demo-ci-${prNumber}-1`, { resolveProject: () => PROJECT, resolveTask: taskFromBranch });
      assert.ok(mapped);
      assert.equal(mapped.event.kind, 'ci_failed');
      await be.store.appendEvent(PROJECT, mapped.event, mapped.idempotency_key);

      const snap = await owner().readSnapshot(PROJECT);
      assert.ok(snap);
      const task = snap.snapshot.tasks.find((t) => t.task_id === TASK_API);
      assert.equal(task?.ci, 'failed', 'the CI badge must be visible on the card');
    });
  });

  // ---- F10 ----------------------------------------------------------------

  test('F10 the owner merges on GitHub and the board reaches merged', async () => {
    await step('F10', async () => {
      const be = builders.get('backend')!;

      // Make CI pass so the merge is a normal one rather than an override --
      // and this is also the v2 change landing for real.
      await writeFile(join(be.dir, 'qty.txt'), 'integer\n', 'utf8');
      await run('git', ['-C', be.dir, 'add', 'qty.txt']);
      await run('git', ['-C', be.dir, 'commit', '--quiet', '-m', 'items API: qty is an integer (v2)']);
      await run('git', ['-C', be.dir, 'push', '--quiet', 'origin', `HEAD:${BRANCH}`]);

      for (let i = 0; i < 60; i += 1) {
        const r = await run('gh', [
          'api', `repos/${REPO}/commits/${BRANCH}/check-runs`,
          '--jq', '.check_runs[0].conclusion // "pending"',
        ]).catch(() => ({ stdout: 'pending' }));
        if (r.stdout.trim() === 'success') break;
        await new Promise((res) => setTimeout(res, 5_000));
      }

      // Agents may push branches and open PRs. They may NOT merge. This merge is
      // the OWNER acting, which is the distinction the protocol draws.
      await run('gh', ['pr', 'merge', String(prNumber), '--repo', REPO, '--squash', '--delete-branch']);

      const pr = JSON.parse((await run('gh', [
        'pr', 'view', String(prNumber), '--repo', REPO, '--json', 'merged,mergeCommit',
      ])).stdout) as { merged: boolean; mergeCommit: { oid: string } | null };
      assert.equal(pr.merged, true);

      const mapped = mapDelivery('pull_request', {
        repository: { full_name: REPO },
        action: 'closed',
        pull_request: {
          number: prNumber, merged: true,
          merge_commit_sha: pr.mergeCommit?.oid ?? null,
          head: { ref: BRANCH },
        },
      }, `demo-merge-${prNumber}`, { resolveProject: () => PROJECT, resolveTask: taskFromBranch });
      assert.ok(mapped);
      assert.equal(mapped.event.kind, 'merged');
      await be.store.appendEvent(PROJECT, mapped.event, mapped.idempotency_key);

      const snap = await owner().readSnapshot(PROJECT);
      const task = snap!.snapshot.tasks.find((t) => t.task_id === TASK_API);
      assert.equal(task?.status, 'merged', 'the board must reach merged');
    });
  });

  // ---- F11, F12 -----------------------------------------------------------

  test('F11 the frontend agent dies and the reaper releases its claim', async () => {
    await step('F11', async () => {
      const fe = builders.get('frontend')!;
      await fe.daemon.beat('working', TASK_UI, null);

      const before = await owner().listClaims(PROJECT);
      assert.ok(before.some((c) => c.task_id === TASK_UI && c.agent_id === fe.agent_id));

      // Nothing may be reaped while every agent is still beating. Asserting
      // this BEFORE the kill is what stops the test passing against a reaper
      // that releases everything unconditionally -- the control half.
      const early = await reapStaleClaims({
        store: owner() as never, project_id: PROJECT,
        clock: systemClock, log: new CapturingLogger(),
        claim_timeout_ms: F11_TIMEOUT_MS,
      });
      assert.equal(early.reaped.length, 0,
        `no live agent's claim may be reaped, got ${JSON.stringify(early.reaped)}`);

      // THE KILL. This is the laptop dying: the frontend's heartbeat loop stops
      // and nothing else changes. Every other agent keeps beating, which is what
      // makes the reaper's later choice discriminating rather than indiscriminate.
      clearInterval(fe.pulse!);
      fe.pulse = undefined;

      // eslint-disable-next-line no-console
      console.log(`[F11] waiting out the ${F11_TIMEOUT_MS / 60_000}-minute claim timeout...`);
      await new Promise((res) => setTimeout(res, F11_TIMEOUT_MS + 30_000));

      const reaped = await reapStaleClaims({
        store: owner() as never, project_id: PROJECT,
        clock: systemClock, log: new CapturingLogger(),
        claim_timeout_ms: F11_TIMEOUT_MS,
      });
      assert.ok(reaped.reaped.some((r) => r.task_id === TASK_UI && r.agent_id === fe.agent_id),
        `the dead agent's claim must be released, got ${JSON.stringify(reaped)}`);

      // Correlation, not count: ONLY the dead agent's claim went. A reaper that
      // took every claim would satisfy the line above and be catastrophic.
      const live = builders.get('backend')!;
      assert.ok(!reaped.reaped.some((r) => r.agent_id === live.agent_id),
        'a still-beating agent lost a claim to the reaper');

      const { events } = await owner().readEvents(PROJECT, 0);
      assert.ok(events.some((e) => e.kind === 'task_unblocked' && e.body.task_id === TASK_UI),
        'and task_unblocked must be announced so a waiting agent learns of it');
    });
  });

  test('F12 another agent claims the released task', async () => {
    await step('F12', async () => {
      const be = builders.get('backend')!;
      const res = await be.store.claimTask(PROJECT, TASK_UI, be.agent_id);
      assert.deepEqual(res, { ok: true }, 'a released task must be claimable again');

      const claims = await owner().listClaims(PROJECT);
      const now = claims.find((c) => c.task_id === TASK_UI);
      assert.equal(now?.agent_id, be.agent_id, 'and the new owner must be the one that claimed it');
    });
  });

  after(async () => {
    const total = Date.now() - demoStart;
    // eslint-disable-next-line no-console
    console.log(`\n[F3 wall clock] ${Math.round(total / 1000)} s total`);
    for (const t of timings) console.log(`  ${t.step.padEnd(4)} ${t.ms} ms`);

    for (const b of builders.values()) if (b.pulse) clearInterval(b.pulse);
    try { await owner()?.purge(PROJECT); } catch { /* best effort */ }
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });
} else {
  test('the F1-F12 demo was NOT RUN', () => {
    assert.fail('GITHUB_LIVE=1 was not set, so the demo did not run against the real backend.');
  });
}
