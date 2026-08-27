// G1-G8: the measurements. This is what building the route was for.
//
// Measurement discipline, applied throughout and stated once here:
//
//   - No single-run figure is reported as a threshold. Every latency below is a
//     distribution with n, min, p50, p95 and max.
//   - Every retry loop's ATTEMPT COUNT is reported alongside its result, per
//     order 0019, or a G4 figure is a lower bound presented as a measurement.
//   - Caveats go ABOVE the numbers, not in a footnote.
//   - Nothing is converted to money without a verified rate card.
//
//   GITHUB_LIVE=1 node --test --test-timeout=7200000 \
//     github/demo/g-series.live.test.ts

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { systemClock } from '../../shared/clock.ts';
import { CapturingLogger } from '../../shared/log.ts';
import { PROTOCOL_VERSION } from '../../shared/store/types.ts';
import { createGithubStore } from '../store/github.ts';
import { createGitRunner, createHttpTransport } from '../store/transport.ts';

const LIVE = process.env.GITHUB_LIVE === '1';
const REPO = process.env.GITHUB_REPO ?? 'Sibhimanyu/inventory-tracker-github';
const G1_N = Number(process.env.G1_N ?? 100);
const G2_N = Number(process.env.G2_N ?? 200);

function token(): string {
  return process.env.GITHUB_TOKEN
    ?? execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
}

interface Stats { n: number; min: number; p50: number; p95: number; max: number; mean: number }

function stats(values: number[]): Stats {
  const v = [...values].sort((a, b) => a - b);
  const q = (p: number) => {
    const i = (v.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.min(lo + 1, v.length - 1);
    return v[lo]! + (v[hi]! - v[lo]!) * (i - lo);
  };
  return {
    n: v.length, min: v[0]!, p50: q(0.5), p95: q(0.95), max: v[v.length - 1]!,
    mean: v.reduce((a, b) => a + b, 0) / v.length,
  };
}

function show(label: string, s: Stats): void {
  // eslint-disable-next-line no-console
  console.log(
    `${label.padEnd(38)} n=${String(s.n).padStart(3)}  min=${s.min.toFixed(0).padStart(6)}`
    + `  p50=${s.p50.toFixed(0).padStart(6)}  p95=${s.p95.toFixed(0).padStart(6)}`
    + `  max=${s.max.toFixed(0).padStart(7)}  mean=${s.mean.toFixed(0).padStart(6)}  ms`,
  );
}

const dirs: string[] = [];

async function makeStore(project_id: string) {
  const dir = await mkdtemp(join(tmpdir(), 'g-'));
  dirs.push(dir);
  const git = createGitRunner(dir);
  await git.run(['init', '--quiet']);
  await git.run(['config', 'user.email', 'g@example.invalid']);
  await git.run(['config', 'user.name', 'g']);
  await git.run(['remote', 'add', 'origin', `https://github.com/${REPO}.git`]);
  const store = createGithubStore({
    repo: REPO, git, http: createHttpTransport(), token: token(),
    clock: systemClock, log: new CapturingLogger(),
  });
  void project_id;
  return store;
}

if (LIVE) {
  const PROJECT = `proj-g${process.pid}`;

  // ---- G1 ----------------------------------------------------------------

  test(`G1 publish -> visible latency, ${G1_N} appends`, async () => {
    const writer = await makeStore(PROJECT);
    const reader = await makeStore(PROJECT);
    await writer.purge(PROJECT);
    await writer.registerTask(PROJECT, { task_id: 'task_g1', title: 'G1', kind: 'backend' });
    await writer.registerAgent(PROJECT, {
      agent_id: 'agent_g1', role_slug: 'backend', member_label: 'G One',
    });

    const appendMs: number[] = [];
    const visibleMs: number[] = [];

    for (let i = 0; i < G1_N; i += 1) {
      const t0 = Date.now();
      const res = await writer.appendEvent(PROJECT, {
        layer: 'coordination', kind: 'task_completed', actor_type: 'agent', actor_id: 'agent_g1',
        body: { task_id: 'task_g1', n: i, v: PROTOCOL_VERSION },
      }, `g1-${PROJECT}-${i}`);
      const t1 = Date.now();
      appendMs.push(t1 - t0);

      // Visible = a DIFFERENT client can read it back. Same-process caching
      // would measure the cache, not the platform.
      for (;;) {
        const { events } = await reader.readEvents(PROJECT, res.seq - 1, 1);
        if (events.length > 0 && events[0]!.seq === res.seq) break;
      }
      visibleMs.push(Date.now() - t0);
    }

    // eslint-disable-next-line no-console
    console.log('\n=== G1 ===');
    show('append (write acknowledged)', stats(appendMs));
    show('publish -> visible to another client', stats(visibleMs));
    // eslint-disable-next-line no-console
    console.log(
      `writer ops: pushes=${writer.stats.pushes} rest=${writer.stats.rest_calls} `
      + `transport_retries=${writer.stats.transport_retries}`,
    );
    // eslint-disable-next-line no-console
    console.log(
      `append push ATTEMPTS: ${writer.stats.push_attempts_by_op.appendEvent} for ${G1_N} appends `
      + `(${(writer.stats.push_attempts_by_op.appendEvent! / G1_N).toFixed(2)} per append)`,
    );

    assert.equal(appendMs.length, G1_N);
    await writer.purge(PROJECT);
  });

  // ---- G2 ----------------------------------------------------------------

  test(`G2 claim round-trip, ${G2_N} claims`, async () => {
    const store = await makeStore(PROJECT);
    await store.purge(PROJECT);
    await store.registerAgent(PROJECT, {
      agent_id: 'agent_g2a', role_slug: 'backend', member_label: 'G Two A',
    });
    await store.registerAgent(PROJECT, {
      agent_id: 'agent_g2b', role_slug: 'backend', member_label: 'G Two B',
    });

    const winMs: number[] = [];
    const loseMs: number[] = [];
    const releaseMs: number[] = [];

    for (let i = 0; i < G2_N; i += 1) {
      const task = `task_g2_${i}`;
      const t0 = Date.now();
      const w = await store.claimTask(PROJECT, task, 'agent_g2a');
      const t1 = Date.now();
      assert.equal(w.ok, true, `claim ${i} should win on a fresh task`);
      winMs.push(t1 - t0);

      const l = await store.claimTask(PROJECT, task, 'agent_g2b');
      const t2 = Date.now();
      assert.equal(l.ok, false, `claim ${i} should lose on a held task`);
      loseMs.push(t2 - t1);

      await store.releaseTask(PROJECT, task, 'agent_g2a');
      releaseMs.push(Date.now() - t2);
    }

    // eslint-disable-next-line no-console
    console.log('\n=== G2 ===');
    show('claimTask WIN', stats(winMs));
    show('claimTask LOSE (incl. owner lookup)', stats(loseMs));
    show('releaseTask', stats(releaseMs));
    // eslint-disable-next-line no-console
    console.log(
      `ops: pushes=${store.stats.pushes} rest=${store.stats.rest_calls} `
      + `transport_retries=${store.stats.transport_retries}`,
    );
    // eslint-disable-next-line no-console
    console.log(`claim push attempts: ${store.stats.push_attempts_by_op.claimTask}`);

    await store.purge(PROJECT);
  });

  // ---- G4 ----------------------------------------------------------------

  test('G4 backend operations per store call, measured not estimated', async () => {
    const store = await makeStore(PROJECT);
    await store.purge(PROJECT);

    const snap = () => ({ ...store.stats, by: { ...store.stats.push_attempts_by_op } });
    const delta = (a: ReturnType<typeof snap>, b: ReturnType<typeof snap>) => ({
      pushes: b.pushes - a.pushes,
      rest: b.rest_calls - a.rest_calls,
      retries: b.transport_retries - a.transport_retries,
    });

    await store.registerAgent(PROJECT, {
      agent_id: 'agent_g4', role_slug: 'backend', member_label: 'G Four',
    });
    await store.registerTask(PROJECT, { task_id: 'task_g4', title: 'G4', kind: 'backend' });

    const rows: { op: string; pushes: number; rest: number; retries: number }[] = [];

    let a = snap();
    await store.appendEvent(PROJECT, {
      layer: 'coordination', kind: 'task_completed', actor_type: 'agent', actor_id: 'agent_g4',
      body: { task_id: 'task_g4' },
    }, `g4-append-${PROJECT}`);
    rows.push({ op: 'appendEvent', ...delta(a, snap()) });

    a = snap();
    await store.claimTask(PROJECT, 'task_g4', 'agent_g4');
    rows.push({ op: 'claimTask (win)', ...delta(a, snap()) });

    a = snap();
    await store.claimTask(PROJECT, 'task_g4', 'agent_other');
    rows.push({ op: 'claimTask (lose)', ...delta(a, snap()) });

    a = snap();
    await store.releaseTask(PROJECT, 'task_g4', 'agent_g4');
    rows.push({ op: 'releaseTask', ...delta(a, snap()) });

    a = snap();
    await store.heartbeat(PROJECT, 'agent_g4', 'working', 'task_g4', null);
    rows.push({ op: 'heartbeat', ...delta(a, snap()) });

    a = snap();
    await store.heartbeat(PROJECT, 'agent_g4', 'working', 'task_g4', null);
    rows.push({ op: 'heartbeat (2nd)', ...delta(a, snap()) });

    a = snap();
    await store.listPresence(PROJECT);
    rows.push({ op: 'listPresence', ...delta(a, snap()) });

    a = snap();
    await store.readEvents(PROJECT, 0);
    rows.push({ op: 'readEvents', ...delta(a, snap()) });

    a = snap();
    await store.readEvents(PROJECT, 0);
    rows.push({ op: 'readEvents (cached)', ...delta(a, snap()) });

    a = snap();
    await store.readSnapshot(PROJECT);
    rows.push({ op: 'readSnapshot', ...delta(a, snap()) });

    a = snap();
    await store.acquireScope(PROJECT, 'agent_g4', 'task_g4', ['src/**']);
    rows.push({ op: 'acquireScope', ...delta(a, snap()) });

    // eslint-disable-next-line no-console
    console.log('\n=== G4: operations per store call ===');
    // eslint-disable-next-line no-console
    console.log('operation                     git pushes   REST calls   retries');
    for (const r of rows) {
      // eslint-disable-next-line no-console
      console.log(
        `${r.op.padEnd(28)}  ${String(r.pushes).padStart(10)}   ${String(r.rest).padStart(10)}`
        + `   ${String(r.retries).padStart(7)}`,
      );
    }

    // git pushes are UNMETERED. Only REST calls count against 5,000/hour, and a
    // conditional 304 costs zero of those. That split is the whole G5/G6 story.
    // eslint-disable-next-line no-console
    console.log(
      `\nconditional GETs this run: 304s=${store.stats.conditional_304} `
      + `200s=${store.stats.conditional_200} (304 costs 0 quota, 200 costs 1)`,
    );

    assert.ok(rows.every((r) => r.pushes >= 0 && r.rest >= 0));
    await store.purge(PROJECT);
  });

  after(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });
} else {
  test('the G-series measurements were NOT RUN', () => {
    assert.fail('GITHUB_LIVE=1 was not set, so no measurement was taken.');
  });
}
