// G1-G6 measurement harness, run against the deployed function.
//
// MEASUREMENT DISCIPLINE, applied to my own numbers:
//
//  - No single-run figure is reported as a threshold. Every latency is a
//    distribution: p50, p95, min, max, n.
//  - The FIRST call is reported separately, never folded into the percentiles. A
//    cold start is a real cost but it is one sample, and averaging it in makes a
//    warm p50 look worse and a cold cost invisible at the same time.
//  - Failures are counted and shown, not silently dropped. A run that quietly
//    discarded its errors would report a flattering p95 for a broken system.
//  - Operation counts come from the function's own counters, not from the
//    provider console, because the console aggregates hours later in buckets that
//    cannot be attributed to a request.
//
// Usage: node catalyst/measure/g-metrics.ts <g1|g2|ops> [n]

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const BASE = process.env.COORDINATION_URL
  ?? 'https://multiplayer-agents-60083782173.development.catalystserverless.in/server/coordination';

function token(): string {
  if (process.env.CATALYST_AGENT_TOKEN) return process.env.CATALYST_AGENT_TOKEN;
  const env = readFileSync(new URL('../../.context/measure.env', import.meta.url), 'utf8');
  const m = /^CATALYST_AGENT_TOKEN=(.+)$/m.exec(env);
  if (!m) throw new Error('no agent token available');
  return m[1].trim();
}

const TOKEN = token();
const PROJECT = 'proj_inventory';

export interface Sample { ms: number; ok: boolean; status: number; note?: string }

export interface Stats {
  n: number; ok: number; failed: number;
  p50: number; p95: number; p99: number; min: number; max: number; mean: number;
  /** The first sample, reported on its own. Never inside the percentiles. */
  first_call_ms: number;
}

export function summarise(samples: Sample[]): Stats {
  if (samples.length === 0) throw new Error('nothing to summarise');
  const first = samples[0];
  // Percentiles over the WARM samples only. The cold start is reported beside
  // them, not blended into them.
  const warm = samples.length > 1 ? samples.slice(1) : samples;
  const okWarm = warm.filter((s) => s.ok).map((s) => s.ms).sort((a, b) => a - b);
  const at = (q: number): number =>
    okWarm.length === 0 ? Number.NaN : okWarm[Math.min(okWarm.length - 1, Math.floor(q * okWarm.length))];

  return {
    n: samples.length,
    ok: samples.filter((s) => s.ok).length,
    failed: samples.filter((s) => !s.ok).length,
    p50: at(0.5), p95: at(0.95), p99: at(0.99),
    min: okWarm[0] ?? Number.NaN,
    max: okWarm[okWarm.length - 1] ?? Number.NaN,
    mean: okWarm.length === 0 ? Number.NaN
      : Math.round(okWarm.reduce((a, b) => a + b, 0) / okWarm.length),
    first_call_ms: first.ms,
  };
}

async function timed(fn: () => Promise<Response>): Promise<Sample & { body: unknown }> {
  const t0 = performance.now();
  try {
    const res = await fn();
    const ms = Math.round(performance.now() - t0);
    let body: unknown;
    try { body = await res.json(); } catch { body = null; }
    return { ms, ok: res.ok, status: res.status, body };
  } catch (err) {
    return {
      ms: Math.round(performance.now() - t0), ok: false, status: 0,
      note: err instanceof Error ? err.message : String(err), body: null,
    };
  }
}

function post(path: string, body: unknown, extra: Record<string, string> = {}): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'X-Agent-Token': TOKEN, 'Content-Type': 'application/json', ...extra },
    body: JSON.stringify(body),
  });
}

function get(path: string): Promise<Response> {
  return fetch(`${BASE}${path}`, { headers: { 'X-Agent-Token': TOKEN } });
}

/** G2: claim round-trip. Each claim is a fresh task, so each one really inserts. */
export async function g2(n: number): Promise<{ stats: Stats; samples: Sample[] }> {
  const stamp = Date.now().toString(36);
  const samples: Sample[] = [];
  for (let i = 0; i < n; i += 1) {
    const s = await timed(() => post('/claim', { project_id: PROJECT, task_id: `task_g2_${stamp}_${i}` }));
    const won = (s.body as { ok?: boolean } | null)?.ok === true;
    samples.push({ ms: s.ms, ok: s.ok && won, status: s.status, note: s.note });
    if (i % 25 === 0) process.stderr.write(`  g2 ${i}/${n}\n`);
  }
  return { stats: summarise(samples), samples };
}

/**
 * LEDGER PROPAGATION, TIGHT-LOOP FLOOR, NO SUBSCRIBER.
 *
 * RENAMED from "publish -> visible" per order 0034. The old name put this figure
 * in the same scoreboard row as Firebase's live-listener push, and the two
 * measure different mechanisms:
 *
 *   - There is NO PUSH PATH on this route. `subscribe` throws
 *     NotProvisionedError, so nothing here was ever notified of anything.
 *   - The loop below polls with ZERO BACKOFF. A real subscriber polls at
 *     `poll_ms` (5,000 ms) and would therefore wait up to a full interval on top
 *     of whatever propagation costs. This number is the FLOOR that polling can
 *     never beat, not the latency any subscriber experiences.
 *   - It is the ledger read path, which is route C2's path. The folded-snapshot
 *     path has never been measured.
 *
 * Quote it only with that label attached. Compared against a push figure it
 * flatters this route by omitting the poll interval entirely, which is the
 * borrowed-number error in a new costume: right number, wrong mechanism.
 */
export async function g1(n: number): Promise<{ stats: Stats; samples: Sample[]; visible: Stats }> {
  const stamp = Date.now().toString(36);
  const appendSamples: Sample[] = [];
  const visibleSamples: Sample[] = [];

  for (let i = 0; i < n; i += 1) {
    const key = randomUUID();
    const t0 = performance.now();
    const a = await timed(() => post('/append', {
      project_id: PROJECT, kind: 'contract_published',
      body: {
        name: `items-api-g1-${stamp}`, version: i + 1,
        path: `contracts/items-api.v${i + 1}.yaml`, commit_sha: 'a'.repeat(40), supersedes: i === 0 ? null : i,
      },
    }, { 'X-Idempotency-Key': key }));

    const seq = (a.body as { seq?: number } | null)?.seq;
    appendSamples.push({ ms: a.ms, ok: a.ok && typeof seq === 'number', status: a.status, note: a.note });
    if (typeof seq !== 'number') continue;

    // Read until the event is visible to a reader that did not write it.
    let visible = false;
    for (let attempt = 0; attempt < 20 && !visible; attempt += 1) {
      const r = await timed(() => get(`/events?project_id=${PROJECT}&since_seq=${seq - 1}&limit=1`));
      const events = (r.body as { events?: { seq: number }[] } | null)?.events ?? [];
      visible = events.some((e) => e.seq === seq);
    }
    visibleSamples.push({
      ms: Math.round(performance.now() - t0), ok: visible, status: 200,
      ...(visible ? {} : { note: 'never became visible within 20 reads' }),
    });
    if (i % 10 === 0) process.stderr.write(`  g1 ${i}/${n}\n`);
  }

  return { stats: summarise(appendSamples), samples: appendSamples, visible: summarise(visibleSamples) };
}

/** Ask the function what it has counted. */
export async function readOps(): Promise<unknown> {
  const r = await timed(() => get('/health'));
  return r.body;
}

async function main(): Promise<void> {
  const [what, nRaw] = process.argv.slice(2);
  const n = Number(nRaw ?? '0') || 0;

  if (what === 'g2') {
    const { stats } = await g2(n || 200);
    console.log(JSON.stringify({ metric: 'G2 claim round-trip', base: BASE, ...stats }, null, 2));
    return;
  }
  if (what === 'g1') {
    const out = await g1(n || 100);
    console.log(JSON.stringify({
      metric: 'ledger propagation, tight-loop floor, no subscriber', base: BASE,
      mechanism: 'poll with zero backoff; subscribe throws NotProvisionedError; '
        + 'a real subscriber adds up to poll_ms on top of this',
      append: out.stats, ledger_propagation_tight_loop_floor: out.visible,
    }, null, 2));
    return;
  }
  if (what === 'ops') {
    console.log(JSON.stringify(await readOps(), null, 2));
    return;
  }
  throw new Error('usage: g-metrics.ts <g1|g2|ops> [n]');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
