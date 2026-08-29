// Instrument A5's own loop, under A5's exact conditions.
//
// THE CONTRADICTION THIS RESOLVES. `appendEvent` measured in a tight loop is
// flat at 3.3 s (n=60). A5 IS a tight loop of `appendEvent` and ran ~60 min
// against a 17-min baseline. One of those two observations is not measuring
// what it appears to, and after three proxy mis-diagnoses in one session I am
// not guessing a fourth.
//
// So: replicate A5's conditions EXACTLY -- the same harness construction, the
// same FakeClock, the same human-layer `task_progress` event, seeded the same
// way -- and time every git and REST call at the transport seam, which is
// already an injection point and needs no adapter change.
//
// The difference between my earlier phase probe and A5, enumerated so the
// instrument covers all of them:
//   1. FakeClock            (harness) vs systemClock (phase probe)
//   2. human-layer event    vs coordination-layer
//   3. seeded through the harness, which calls warm() -> a full readSnapshot
//   4. 301 iterations       vs 60
//
//   GITHUB_LIVE=1 npm run --prefix github a5i

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { FakeClock } from '../../shared/clock.ts';
import { CapturingLogger } from '../../shared/log.ts';
import { LIMITS } from '../../shared/store/types.ts';
import { createGithubStore } from '../store/github.ts';
import { createGitRunner, createHttpTransport } from '../store/transport.ts';
import type { GitRunner, HttpTransport } from '../store/transport.ts';

const LIVE = process.env.GITHUB_LIVE === '1';
const REPO = process.env.GITHUB_REPO ?? 'Sibhimanyu/inventory-tracker-github';
const N = Number(process.env.A5I_N ?? LIMITS.events + 1);

function token(): string {
  return process.env.GITHUB_TOKEN
    ?? execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
}

interface Bucket { calls: number; ms: number }
const zero = (): Bucket => ({ calls: 0, ms: 0 });

/** Per-call-site timing, so "where did the wall clock go" is answerable. */
interface Meter {
  gitRun: Map<string, Bucket>;
  gitPush: Bucket;
  catFile: Bucket;
  http: Map<string, Bucket>;
  reset(): void;
  gitTotal(): Bucket;
  httpTotal(): Bucket;
}

function newMeter(): Meter {
  const m: Meter = {
    gitRun: new Map(), gitPush: zero(), catFile: zero(), http: new Map(),
    reset() {
      m.gitRun.clear(); m.http.clear();
      m.gitPush = zero(); m.catFile = zero();
    },
    gitTotal() {
      let b = zero();
      for (const v of m.gitRun.values()) { b.calls += v.calls; b.ms += v.ms; }
      b.calls += m.gitPush.calls + m.catFile.calls;
      b.ms += m.gitPush.ms + m.catFile.ms;
      return b;
    },
    httpTotal() {
      const b = zero();
      for (const v of m.http.values()) { b.calls += v.calls; b.ms += v.ms; }
      return b;
    },
  };
  return m;
}

function bump(map: Map<string, Bucket>, key: string, ms: number): void {
  const b = map.get(key) ?? zero();
  b.calls += 1; b.ms += ms;
  map.set(key, b);
}

/** Wrap the real transports so nothing about the adapter changes. */
function meteredGit(inner: GitRunner, m: Meter): GitRunner {
  return {
    async run(args) {
      const t0 = Date.now();
      const r = await inner.run(args);
      bump(m.gitRun, args[0] ?? '?', Date.now() - t0);
      return r;
    },
    async push(args) {
      const t0 = Date.now();
      const r = await inner.push(args);
      m.gitPush.calls += 1; m.gitPush.ms += Date.now() - t0;
      return r;
    },
    async catFileBatch(shas) {
      const t0 = Date.now();
      const r = await inner.catFileBatch(shas);
      m.catFile.calls += 1; m.catFile.ms += Date.now() - t0;
      return r;
    },
  };
}

function meteredHttp(inner: HttpTransport, m: Meter): HttpTransport {
  return async (url, init) => {
    const t0 = Date.now();
    const res = await inner(url, init);
    // Bucket by endpoint SHAPE, not the full url, or every project id is its
    // own row and the table says nothing.
    const shape = url
      .replace(/^https:\/\/api\.github\.com\/repos\/[^/]+\/[^/]+/, '')
      .replace(/\/agentic\/[^/]+\//, '/agentic/<proj>/')
      .replace(/\/[0-9a-f]{40}$/, '/<sha>')
      .replace(/\/[0-9a-f]{32,}$/, '/<hash>')
      .replace(/\/\d{10,}$/, '/<n>');
    bump(m.http, shape || '/', Date.now() - t0);
    return res;
  };
}

const dirs: string[] = [];

if (LIVE) {
  test(`A5 instrumented: ${N} appends, per-phase`, async () => {
    const dir = await mkdtemp(join(tmpdir(), 'a5i-'));
    dirs.push(dir);
    const meter = newMeter();

    const realGit = createGitRunner(dir);
    await realGit.run(['init', '--quiet']);
    await realGit.run(['config', 'user.email', 'a5i@example.invalid']);
    await realGit.run(['config', 'user.name', 'a5i']);
    await realGit.run(['remote', 'add', 'origin', `https://github.com/${REPO}.git`]);

    // EXACTLY the harness's construction: FakeClock, CapturingLogger.
    const clock = new FakeClock();
    const log = new CapturingLogger();
    const store = createGithubStore({
      repo: REPO,
      git: meteredGit(realGit, meter),
      http: meteredHttp(createHttpTransport(), meter),
      token: token(),
      clock, log, stale_ms: 5_000,
    });

    const PROJECT = `proj-a5i${process.pid}`;
    await store.purge(PROJECT);
    // Seeded the way the harness seeds: register THEN warm, which is what
    // populates lastSnapshot and the event cache.
    await store.registerTask(PROJECT, { task_id: 'task_items_api', title: 'Items API', kind: 'backend' });
    await store.warm(PROJECT);
    await store.registerAgent(PROJECT, { agent_id: 'agent_be01', role_slug: 'backend', member_label: 'Bea Backend' });
    await store.warm(PROJECT);
    await store.registerAgent(PROJECT, { agent_id: 'agent_fe01', role_slug: 'frontend', member_label: 'Fern Frontend' });
    await store.warm(PROJECT);

    // eslint-disable-next-line no-console
    console.log('\n================ A5 INSTRUMENTED ================');
    // eslint-disable-next-line no-console
    console.log('  clock: FakeClock (as the harness uses)   event: human-layer task_progress');
    // eslint-disable-next-line no-console
    console.log('\n   i    append ms    git ms (calls)   REST ms (calls)   unaccounted ms');

    const perAppend: number[] = [];
    let keyN = 0;

    for (let i = 0; i < N; i += 1) {
      meter.reset();
      const t0 = Date.now();
      keyN += 1;
      await store.appendEvent(PROJECT, {
        layer: 'human', kind: 'task_progress', actor_type: 'agent', actor_id: 'agent_be01',
        body: { task_id: 'task_items_api', n: i },
      }, `a5i-${keyN.toString(36)}`);
      const total = Date.now() - t0;
      perAppend.push(total);

      if (i % 25 === 0 || i === N - 1) {
        const g = meter.gitTotal();
        const h = meter.httpTotal();
        // eslint-disable-next-line no-console
        console.log(
          '  ' + String(i).padStart(3)
          + '  ' + String(total).padStart(9)
          + '  ' + (String(g.ms) + ' (' + g.calls + ')').padStart(16)
          + '  ' + (String(h.ms) + ' (' + h.calls + ')').padStart(17)
          + '  ' + String(total - g.ms - h.ms).padStart(15),
        );
      }
    }

    const sorted = [...perAppend].sort((a, b) => a - b);
    const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]!;
    // eslint-disable-next-line no-console
    console.log(
      '\n  per-append across all ' + N + ': min=' + sorted[0]
      + ' p50=' + q(0.5) + ' p95=' + q(0.95) + ' max=' + sorted[sorted.length - 1] + ' ms',
    );
    const first = perAppend.slice(0, 25).reduce((a, b) => a + b, 0) / 25;
    const last = perAppend.slice(-25).reduce((a, b) => a + b, 0) / 25;
    // eslint-disable-next-line no-console
    console.log(
      '  first 25 mean=' + Math.round(first) + ' ms, last 25 mean=' + Math.round(last)
      + ' ms  -> ' + (last / first).toFixed(2) + 'x'
      + (last > first * 1.5 ? '   DEGRADES WITH LEDGER SIZE' : '   FLAT'),
    );
    // eslint-disable-next-line no-console
    console.log('  total wall clock: ' + Math.round(perAppend.reduce((a, b) => a + b, 0) / 1000) + ' s');

    // Then the read A5 actually asserts on, timed separately.
    meter.reset();
    const t0 = Date.now();
    const page = await store.readEvents(PROJECT, 0, 1000);
    const readMs = Date.now() - t0;
    // eslint-disable-next-line no-console
    console.log(
      '\n  readEvents(0, 1000) after ' + N + ' appends: ' + readMs + ' ms'
      + '  git ' + meter.gitTotal().ms + ' ms (' + meter.gitTotal().calls + ')'
      + '  REST ' + meter.httpTotal().ms + ' ms (' + meter.httpTotal().calls + ')',
    );
    // eslint-disable-next-line no-console
    console.log('  returned ' + page.events.length + ' events, has_more=' + page.has_more);

    // eslint-disable-next-line no-console
    console.log('\n  where the time went, LAST append, by call site:');
    for (const [k, v] of [...meter.gitRun.entries()].sort((a, b) => b[1].ms - a[1].ms)) {
      // eslint-disable-next-line no-console
      console.log('    git ' + k.padEnd(16) + String(v.ms).padStart(7) + ' ms  x' + v.calls);
    }
    for (const [k, v] of [...meter.http.entries()].sort((a, b) => b[1].ms - a[1].ms)) {
      // eslint-disable-next-line no-console
      console.log('    REST ' + k.padEnd(45) + String(v.ms).padStart(7) + ' ms  x' + v.calls);
    }

    // A5's own assertions, but only when N actually exceeds the cap. At a
    // smaller N this file is a profiler, not a conformance test, and asserting
    // the cap there would fail for a reason that says nothing.
    if (N > LIMITS.events) {
      assert.equal(page.events.length, LIMITS.events);
      assert.equal(page.has_more, true);
      assert.equal(page.next_cursor, page.events[page.events.length - 1]!.seq);
    } else {
      assert.equal(page.events.length, N);
      assert.equal(page.has_more, false);
    }
    await store.purge(PROJECT);
  });

  after(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });
} else {
  test('A5 instrumentation was NOT RUN', () => {
    assert.fail('GITHUB_LIVE=1 was not set.');
  });
}
