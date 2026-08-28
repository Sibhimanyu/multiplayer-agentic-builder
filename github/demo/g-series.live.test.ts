// G1-G5 for route G. Every figure carries its HOST and its MECHANISM.
//
// Order 0036 makes both retroactive, and both were learned expensively:
//
//   Entry 25 -- a 34 ms figure measured on raw.githubusercontent.com was quoted
//   for two runs as a Stratus number and was the stated reason one route beat
//   another. THAT HOST WAS MINE. A number must never travel without it.
//
//   Entry 30/33 -- before two numbers go in one row, name the mechanism: push
//   or poll, contended or not, direct or through a hop, depleting or resetting.
//   Four of six scoreboard rows failed on mechanism while every one of them
//   named its host correctly.
//
// ROUTE G TOUCHES THREE HOSTS AND THEY ARE NOT INTERCHANGEABLE:
//
//   github.com                 git push / git fetch -- the write path.
//                              Unmetered. This is where claims are decided.
//   api.github.com             REST. The read path. 5,000/hour, and a
//                              conditional 304 costs zero of those.
//   raw.githubusercontent.com  the sha-pinned CDN for blackboard blobs. NOT
//                              used by any figure below; named here so nobody
//                              can attribute its latency to the other two.
//
// Order 0034 dinged Catalyst for reporting a tight-loop read floor in a row
// headed the same as Firebase's listener push. G1 below therefore reports BOTH
// the floor and what a real subscriber experiences, each labelled, so the two
// can never be confused for one another.
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
const G2_ROUNDS = Number(process.env.G2_ROUNDS ?? 50);
const G2_RACERS = Number(process.env.G2_RACERS ?? 20);
const POLL_MS = 5_000;

/** The three hosts, named once so every label can reference them. */
const HOST_GIT = 'github.com (git push/fetch over HTTPS)';
const HOST_API = 'api.github.com (REST)';

function token(): string {
  return process.env.GITHUB_TOKEN
    ?? execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
}

interface Stats { n: number; min: number; p50: number; p95: number; p99: number; max: number }

/**
 * No mean. Order 0036 asks for p50/p95/p99/max explicitly, and order 0012's
 * reason still applies: a mean hides exactly the tail that is user-visible.
 */
function stats(values: number[]): Stats {
  const v = [...values].sort((a, b) => a - b);
  const q = (p: number) => {
    const i = (v.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.min(lo + 1, v.length - 1);
    return v[lo]! + (v[hi]! - v[lo]!) * (i - lo);
  };
  return { n: v.length, min: v[0]!, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: v[v.length - 1]! };
}

function show(label: string, s: Stats): void {
  // eslint-disable-next-line no-console
  console.log(
    `  ${label}\n`
    + `      n=${s.n}  min=${s.min.toFixed(0)}  p50=${s.p50.toFixed(0)}`
    + `  p95=${s.p95.toFixed(0)}  p99=${s.p99.toFixed(0)}  max=${s.max.toFixed(0)}  ms`,
  );
}

const dirs: string[] = [];

async function makeStore() {
  const dir = await mkdtemp(join(tmpdir(), 'g-'));
  dirs.push(dir);
  const git = createGitRunner(dir);
  await git.run(['init', '--quiet']);
  await git.run(['config', 'user.email', 'g@example.invalid']);
  await git.run(['config', 'user.name', 'g']);
  await git.run(['remote', 'add', 'origin', `https://github.com/${REPO}.git`]);
  return createGithubStore({
    repo: REPO, git, http: createHttpTransport(), token: token(),
    clock: systemClock, log: new CapturingLogger(), stale_ms: POLL_MS,
  });
}

if (LIVE) {
  const PROJECT = `proj-g${process.pid}`;

  // ---- G1 ----------------------------------------------------------------

  test(`G1 appendEvent and publish->visible, n=${G1_N}`, async () => {
    const writer = await makeStore();
    const reader = await makeStore();
    await writer.purge(PROJECT);
    await writer.registerTask(PROJECT, { task_id: 'task_g1', title: 'G1', kind: 'backend' });
    await writer.registerAgent(PROJECT, {
      agent_id: 'agent_g1', role_slug: 'backend', member_label: 'G One',
    });

    const appendMs: number[] = [];
    const floorMs: number[] = [];

    for (let i = 0; i < G1_N; i += 1) {
      const t0 = Date.now();
      const res = await writer.appendEvent(PROJECT, {
        layer: 'coordination', kind: 'task_completed', actor_type: 'agent', actor_id: 'agent_g1',
        body: { task_id: 'task_g1', n: i, v: PROTOCOL_VERSION },
      }, `g1-${PROJECT}-${i}`);
      appendMs.push(Date.now() - t0);

      // A DIFFERENT client reads it back, in a tight loop with NO backoff. This
      // is the propagation FLOOR, not what a subscriber sees.
      for (;;) {
        const { events } = await reader.readEvents(PROJECT, res.seq - 1, 1);
        // Assert on a named field, never a stringified return.
        if (events.length > 0 && events[0]!.seq === res.seq) break;
      }
      floorMs.push(Date.now() - t0);
    }

    // The figure a real subscriber experiences: subscribe() polls, and a poll
    // adds up to a full interval on top of propagation. Measured separately
    // rather than inferred, and it is the one comparable to a listener push.
    const subMs: number[] = [];
    const SUB_N = 10;
    for (let i = 0; i < SUB_N; i += 1) {
      let resolve: (ms: number) => void;
      const seen = new Promise<number>((r) => { resolve = r; });
      let baseline: number | null = null;
      let t0 = 0;
      const unsub = reader.subscribe(PROJECT, 0, (s) => {
        if (baseline === null) { baseline = s.seq; return; }   // the immediate fire
        if (t0 !== 0 && s.seq > baseline) resolve(Date.now() - t0);
      });
      // Let the immediate fire land before starting the clock.
      await new Promise((r) => setTimeout(r, 1_500));
      t0 = Date.now();
      await writer.appendEvent(PROJECT, {
        layer: 'coordination', kind: 'task_completed', actor_type: 'agent', actor_id: 'agent_g1',
        body: { task_id: 'task_g1', sub: i },
      }, `g1sub-${PROJECT}-${i}`);
      subMs.push(await seen);
      unsub();
    }

    // eslint-disable-next-line no-console
    console.log('\n================ G1 ================');
    show(`appendEvent -- host ${HOST_GIT} + ${HOST_API}; mechanism: 1 git push + 2 REST, uncontended`,
      stats(appendMs));
    show(`publish->visible FLOOR -- host ${HOST_API}; mechanism: tight read loop, ZERO backoff, NO subscriber`,
      stats(floorMs));
    show(`publish->visible SUBSCRIBER -- host ${HOST_API}; mechanism: POLL at ${POLL_MS} ms interval`,
      stats(subMs));
    // eslint-disable-next-line no-console
    console.log(
      `  writer ops: pushes=${writer.stats.pushes} rest=${writer.stats.rest_calls} `
      + `transport_retries=${writer.stats.transport_retries}\n`
      + `  append push ATTEMPTS: ${writer.stats.push_attempts_by_op.appendEvent} for ${G1_N + SUB_N} appends`,
    );

    assert.equal(appendMs.length, G1_N);
    assert.equal(subMs.length, SUB_N);
    await writer.purge(PROJECT);
  });

  // ---- G2, CONTENDED -------------------------------------------------------

  test(`G2 claim round-trip CONTENDED, ${G2_RACERS} racers x ${G2_ROUNDS} rounds`, async () => {
    // My previous G2 was UNCONTENDED and order 0036 is right that it is the
    // wrong row. This is the same shape as A2 -- which the coordinator
    // re-checked and confirmed genuinely contends -- but recording LATENCY
    // rather than only correctness.
    const stores = await Promise.all(
      Array.from({ length: G2_RACERS }, () => makeStore()),
    );
    const owner = stores[0]!;
    await owner.purge(PROJECT);
    const racers = Array.from({ length: G2_RACERS }, (_u, i) => `agent_r${String(i).padStart(2, '0')}`);
    for (let i = 0; i < G2_RACERS; i += 1) {
      await owner.registerAgent(PROJECT, {
        agent_id: racers[i]!, role_slug: 'backend', member_label: `Racer ${i}`,
      });
    }

    const winMs: number[] = [];
    const loseMs: number[] = [];
    const allMs: number[] = [];
    let replyWinners = 0;
    let durableAgreements = 0;
    let disagreements = 0;

    for (let round = 0; round < G2_ROUNDS; round += 1) {
      const task = `task_g2c_${round}`;

      const results = await Promise.all(racers.map(async (agent_id, i) => {
        const t0 = Date.now();
        const r = await stores[i]!.claimTask(PROJECT, task, agent_id);
        return { agent_id, ms: Date.now() - t0, ok: r.ok };
      }));

      // ---- the REPLY ----
      const winners = results.filter((r) => r.ok);
      assert.equal(winners.length, 1,
        `round ${round}: exactly one reply may say ok:true, got ${winners.length}`);
      replyWinners += winners.length;

      // ---- the DURABLE STATE, read back independently ----
      //
      // Measured SEPARATELY on purpose. Catalyst's Data Store CAS returned
      // affected:1 to five racers while the table held exactly one correct row
      // -- either check alone passes and only the pair catches it. Here the
      // reply is rc/porcelain and the durable state is the ref's commit.
      const claims = await owner.listClaims(PROJECT);
      const held = claims.find((c) => c.task_id === task);
      assert.ok(held, `round ${round}: no durable claim exists at all`);
      if (held.agent_id === winners[0]!.agent_id) durableAgreements += 1;
      else {
        disagreements += 1;
        assert.fail(
          `round ${round}: the reply said ${winners[0]!.agent_id} won but the ref holds `
          + `${held.agent_id} -- reply and durable state disagree`,
        );
      }

      for (const r of results) {
        allMs.push(r.ms);
        (r.ok ? winMs : loseMs).push(r.ms);
      }

      await owner.forceReleaseClaim(PROJECT, task, held.sha);
    }

    // eslint-disable-next-line no-console
    console.log('\n================ G2 (CONTENDED) ================');
    // eslint-disable-next-line no-console
    console.log(
      `  ${G2_RACERS} racers x ${G2_ROUNDS} rounds = ${G2_RACERS * G2_ROUNDS} claims, all for ONE task per round\n`
      + `  host: ${HOST_GIT} decides the claim; loser owner-lookup adds ${HOST_API}\n`
      + `  mechanism: push --force-with-lease with an EMPTY expected value (create-if-absent)\n`,
    );
    show('claim, ALL racers -- contended', stats(allMs));
    show('claim, the WINNER -- contended', stats(winMs));
    show('claim, a LOSER (incl. owner lookup) -- contended', stats(loseMs));
    // eslint-disable-next-line no-console
    console.log(
      `\n  reply vs durable state, measured separately:\n`
      + `    replies saying ok:true          ${replyWinners} (expected ${G2_ROUNDS})\n`
      + `    rounds where the ref agreed     ${durableAgreements}\n`
      + `    disagreements                   ${disagreements}\n`
      + `  claim push attempts: ${stores.reduce((a, s) => a + (s.stats.push_attempts_by_op.claimTask ?? 0), 0)}`,
    );

    assert.equal(replyWinners, G2_ROUNDS);
    assert.equal(durableAgreements, G2_ROUNDS);
    assert.equal(disagreements, 0);
    await owner.purge(PROJECT);
  });

  // ---- G3 / G4 -------------------------------------------------------------

  test('G3/G4 operation cost, and which rate limit actually binds', async () => {
    const store = await makeStore();
    await store.purge(PROJECT);

    // THE COUNTER IS READ FROM THE RESPONSE HEADERS, NOT FROM /rate_limit.
    //
    // The first version of this test read `GET /rate_limit` either side of each
    // operation and reported CHARGED = 0 for all nine -- including a
    // readSnapshot that our own counter said sent seven calls. Two claims about
    // one counter, disagreeing, so neither was publishable.
    //
    // Measured 2026-08-28, same token, same second:
    //   GET /rate_limit         -> remaining 5000, limit 5000, every resource
    //   live response header    -> remaining 2856, used 2144, -1 per call
    //
    // `/rate_limit` was reporting a full bucket while the bucket was 43% gone.
    // The per-response `X-RateLimit-Remaining` is the one that tracks reality,
    // and the adapter now records it on every call. Had I published the first
    // version, G4 would have said route G's reads are free and G5 would have
    // been built on it.
    const quota = () => ({
      remaining: store.stats.rate_limit_remaining,
      limit: store.stats.rate_limit_limit,
    });

    // One priming read so the counter is populated before the first delta.
    await store.listPresence(PROJECT);

    await store.registerAgent(PROJECT, {
      agent_id: 'agent_g4', role_slug: 'backend', member_label: 'G Four',
    });
    await store.registerTask(PROJECT, { task_id: 'task_g4', title: 'G4', kind: 'backend' });

    const rows: { op: string; pushes: number; sent: number; charged: number }[] = [];
    let contaminated = 0;

    const measure = async (op: string, fn: () => Promise<unknown>) => {
      const before = quota().remaining;
      const p0 = store.stats.pushes;
      const r0 = store.stats.rest_calls;
      const c0 = store.stats.conditional_304;
      await fn();
      const after = quota().remaining;
      const sent = store.stats.rest_calls - r0;
      const free = store.stats.conditional_304 - c0;
      const charged = before - after;

      // CONTAMINATION GUARD. This token is shared by anything else running on
      // this machine, and a concurrent run spends the same bucket -- so a
      // charged delta larger than what THIS operation sent is not a property of
      // the operation, it is someone else's traffic landing inside my window.
      //
      // The first run of this test reported charged > sent on four of nine rows
      // (readSnapshot: sent 7, charged 9) because a backgrounded G1 was still
      // hammering the API. Those numbers were wrong and would have been
      // published. Same failure as Firebase's readiness probe asking "is
      // anything listening on 8080" rather than "is MY backend listening".
      //
      // Expected: charged === sent - (conditional 304s, which cost nothing).
      if (charged !== sent - free) contaminated += 1;

      rows.push({ op, pushes: store.stats.pushes - p0, sent, charged });
    };

    await measure('appendEvent', () => store.appendEvent(PROJECT, {
      layer: 'coordination', kind: 'task_completed', actor_type: 'agent', actor_id: 'agent_g4',
      body: { task_id: 'task_g4' },
    }, 'g4-append-' + PROJECT));
    await measure('claimTask (win)', () => store.claimTask(PROJECT, 'task_g4', 'agent_g4'));
    await measure('claimTask (lose)', () => store.claimTask(PROJECT, 'task_g4', 'agent_zz'));
    await measure('releaseTask', () => store.releaseTask(PROJECT, 'task_g4', 'agent_g4'));
    await measure('heartbeat', () => store.heartbeat(PROJECT, 'agent_g4', 'working', null, null));
    await measure('listPresence', () => store.listPresence(PROJECT));
    await measure('readEvents', () => store.readEvents(PROJECT, 0));
    await measure('readSnapshot', () => store.readSnapshot(PROJECT));
    await measure('acquireScope', () => store.acquireScope(PROJECT, 'agent_g4', 'task_g4', ['src/**']));

    const q = quota();
    // eslint-disable-next-line no-console
    console.log('\n================ G3 / G4 ================');
    // eslint-disable-next-line no-console
    console.log('  write path host: ' + HOST_GIT);
    // eslint-disable-next-line no-console
    console.log('  read  path host: ' + HOST_API + '\n');
    // eslint-disable-next-line no-console
    console.log('  operation             git pushes   REST sent   REST CHARGED');
    for (const r of rows) {
      // eslint-disable-next-line no-console
      console.log(
        '  ' + r.op.padEnd(20)
        + '  ' + String(r.pushes).padStart(10)
        + '  ' + String(r.sent).padStart(10)
        + '  ' + String(r.charged).padStart(12),
      );
    }

    const snap = rows.find((r) => r.op === 'readSnapshot')!;
    const pollsPerHour = Math.round(3600000 / POLL_MS);
    const perHour = snap.charged * pollsPerHour;
    const verdict = perHour > q.limit
      ? 'OVER THE LIMIT'
      : Math.round((perHour / q.limit) * 100) + '% of it';
    // eslint-disable-next-line no-console
    console.log(
      '\n  BINDING LIMIT: core = ' + q.limit + '/hour, ROLLING window.\n'
      + '  git push/fetch appears in NO rate-limit resource -- the write path is unmetered.\n\n'
      + '  A dashboard polling readSnapshot every ' + POLL_MS + ' ms:\n'
      + '    ' + pollsPerHour + ' polls/hour x ' + snap.charged + ' charged = '
      + perHour + '/hour against ' + q.limit + ' -- ' + verdict,
    );

    assert.equal(rows.length, 9);
    // Fail rather than publish an inflated number. "Could not measure cleanly"
    // and "this is the cost" are different claims and only one of them is
    // useful.
    assert.equal(contaminated, 0,
      `${contaminated} of 9 operations saw a charged delta that does not match what they sent. `
      + 'Another client is spending this token concurrently -- rerun with nothing else running. '
      + 'These figures are NOT publishable.');
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
