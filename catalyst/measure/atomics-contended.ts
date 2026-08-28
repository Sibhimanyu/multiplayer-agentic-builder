// Order 0035 section 2: is there ANY atomic primitive on this platform?
//
// Same shape as catalyst/measure/g2-contended.ts, which is the point. That
// harness found that `is_unique` admits 2.7 winners per task on average. This
// one asks the identical question of every other mechanism Catalyst offers, so
// the answers are comparable line for line.
//
// RULES CARRIED OVER FROM 0034 AND 0035:
//   - LIVE service only. A double would enforce correctly and could never fail.
//   - n >= 200 tasks, 5 racers, fired together.
//   - EXACTLY ONE WINNER asserted, not assumed.
//   - Durable state counted AFTERWARDS and reconciled against the harness count.
//     Two independent sources or it does not count.
//   - p50/p95/p99/max. No mean.
//
// Usage:
//   node catalyst/measure/atomics-contended.ts inventory
//   node catalyst/measure/atomics-contended.ts cas     [n]
//   node catalyst/measure/atomics-contended.ts stratus [n]
//   node catalyst/measure/atomics-contended.ts cache   [n]
//   node catalyst/measure/atomics-contended.ts count   <table>

import { readFileSync } from 'node:fs';

const BASE = process.env.COORDINATION_URL
  ?? 'https://multiplayer-agents-60083782173.development.catalystserverless.in/server/coordination';
const RACERS = 5;

function env(name: string): string {
  const raw = readFileSync(new URL('../../.context/measure.env', import.meta.url), 'utf8');
  const m = new RegExp(`^${name}=(.+)$`, 'm').exec(raw);
  if (!m) throw new Error(`missing ${name}`);
  return m[1].trim();
}

const ADMIN = (): string => env('CATALYST_AGENT_TOKEN');
const RACE_TOKENS = (): string[] =>
  Array.from({ length: RACERS }, (_, i) => env(`RACE_TOKEN_${i + 1}`));

async function post(path: string, body: unknown, token: string): Promise<{
  status: number; ms: number; body: unknown;
}> {
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'X-Agent-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let parsed: unknown = null;
    try { parsed = await res.json(); } catch { parsed = null; }
    return { status: res.status, ms: Math.round(performance.now() - t0), body: parsed };
  } catch (err) {
    return {
      status: 0, ms: Math.round(performance.now() - t0),
      body: { transport_error: err instanceof Error ? err.message : String(err) },
    };
  }
}

function pct(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function summarise(label: string, values: number[]): string {
  const s = [...values].sort((a, b) => a - b);
  return `${label.padEnd(24)} n=${String(s.length).padStart(4)}  `
    + `p50 ${String(pct(s, 0.5)).padStart(5)}  p95 ${String(pct(s, 0.95)).padStart(5)}  `
    + `p99 ${String(pct(s, 0.99)).padStart(5)}  max ${String(s[s.length - 1]).padStart(5)}`;
}

interface AttemptBody { won?: boolean; ms?: number; affected?: number | null; error?: unknown }

/**
 * The shared contended driver.
 *
 * `route` performs ONE racer's attempt. Five are fired with Promise.all so they
 * start in the same tick, from five distinct agent tokens, over five separate
 * HTTP connections -- so nothing inside a single function instance can serialise
 * them and make a non-atomic primitive look atomic.
 */
async function race(
  route: string, keyFor: (i: number) => string, n: number, label: string,
  /**
   * Optional durable read-back. Given a key and the holder the platform told
   * "you won", it must return what the service actually stores.
   *
   * This exists because "exactly one winner" is necessary but NOT sufficient.
   * A service could hand out exactly one success and still let a rejected
   * racer's write land -- the caller would be told the truth about exclusion and
   * lied to about ownership. 0035's rule is that durable state gets counted, so
   * the winner's claim is checked against the bytes.
   */
  readback?: (key: string) => Promise<string | null>,
): Promise<void> {
  const toks = RACE_TOKENS();
  console.log(`PROBE_AT=${new Date().toISOString()}`);
  console.log(`HOST=${new URL(BASE).host}`);
  console.log(`mechanism: ${label}`);
  console.log(`shape: ${RACERS} agents racing for ONE key, n=${n} keys `
    + `= ${RACERS * n} attempts`);
  console.log('');

  const winnerMs: number[] = [];
  const loserMs: number[] = [];
  const innerWinnerMs: number[] = [];
  let exactlyOne = 0;
  let zeroWinners = 0;
  let multipleWinners = 0;
  let transport = 0;
  let durableAgrees = 0;
  let durableDisagrees = 0;
  const sampleDisagreements: string[] = [];
  const sampleViolations: string[] = [];
  const t0 = Date.now();

  for (let i = 0; i < n; i += 1) {
    const key = keyFor(i);
    const results = await Promise.all(
      toks.map((t, r) => post(route, { key, holder: `agent_race0${r + 1}` }, t)),
    );

    let wins = 0;
    let declaredWinner: string | null = null;
    for (const [r, res] of results.entries()) {
      if (res.status === 0) { transport += 1; continue; }
      const b = (res.body ?? {}) as AttemptBody;
      if (b.won === true) {
        wins += 1;
        declaredWinner = `agent_race0${r + 1}`;
        winnerMs.push(res.ms);
        if (typeof b.ms === 'number') innerWinnerMs.push(b.ms);
      } else {
        loserMs.push(res.ms);
      }
    }

    if (readback !== undefined && wins === 1 && declaredWinner !== null) {
      const stored = await readback(key);
      if (stored === declaredWinner) durableAgrees += 1;
      else {
        durableDisagrees += 1;
        if (sampleDisagreements.length < 5) {
          sampleDisagreements.push(`${key}: told '${declaredWinner}' it won, stored '${stored}'`);
        }
      }
    }

    if (wins === 1) exactlyOne += 1;
    else if (wins === 0) zeroWinners += 1;
    else multipleWinners += 1;

    if (wins !== 1 && sampleViolations.length < 5) {
      sampleViolations.push(`${key}: ${wins} winners -> ${JSON.stringify(results.map((r) => r.body)).slice(0, 420)}`);
    }
    if (i % 25 === 0) process.stderr.write(`  ${i}/${n}\n`);
  }

  const wall = Math.round((Date.now() - t0) / 1000);
  console.log('=== MUTUAL EXCLUSION ===');
  console.log(`keys with EXACTLY ONE winner    ${exactlyOne}/${n}`);
  console.log(`keys with ZERO winners          ${zeroWinners}`);
  console.log(`keys with MORE THAN ONE winner  ${multipleWinners}   <-- the failure that matters`);
  console.log(`transport failures              ${transport}`);
  if (readback !== undefined) {
    console.log('');
    console.log('=== DURABLE STATE, read back per key ===');
    console.log(`stored value MATCHES the declared winner   ${durableAgrees}/${exactlyOne}`);
    console.log(`stored value CONTRADICTS it                ${durableDisagrees}`);
    for (const d of sampleDisagreements) console.log(`  ${d}`);
  }
  console.log('');
  if (sampleViolations.length > 0) {
    console.log('--- first violations, verbatim ---');
    for (const v of sampleViolations) console.log(v);
    console.log('');
  }
  console.log('=== LATENCY, ms. No mean: a mean over a contended distribution');
  console.log('=== hides the tail that contention creates.');
  console.log(summarise('winners (end to end)', winnerMs));
  console.log(summarise('losers  (end to end)', loserMs));
  if (innerWinnerMs.length > 0) {
    console.log(summarise('winners (primitive only)', innerWinnerMs));
    console.log('  "primitive only" excludes HTTP and the 2-SELECT auth path, which');
    console.log('  are not what is being measured.');
  }
  console.log('');
  console.log(`wall clock ${wall}s`);
  console.log('');
  console.log(`VERDICT: ${exactlyOne === n
    ? 'exactly one winner on EVERY key. Mutual exclusion HELD under contention.'
    : `mutual exclusion BROKE on ${n - exactlyOne}/${n} keys.`}`);
}

async function main(): Promise<void> {
  const [what, arg] = process.argv.slice(2);
  const n = Number(arg ?? '200') || 200;
  const stamp = Date.now().toString(36);

  if (what === 'inventory') {
    const r = await post('/diag/atomic/inventory', {}, ADMIN());
    console.log(`PROBE_AT=${new Date().toISOString()}  HTTP ${r.status}`);
    console.log(JSON.stringify(r.body, null, 1));
    return;
  }

  if (what === 'cas') {
    // Seed n unclaimed rows first. The compare-and-set has nothing to contend
    // over until the rows exist.
    const prefix = `cas_${stamp}`;
    process.stderr.write(`seeding ${n} rows...\n`);
    const seed = await post('/diag/atomic/seed', { prefix, n }, ADMIN());
    console.log(`SEED: HTTP ${seed.status} ${JSON.stringify(seed.body).slice(0, 300)}`);
    console.log('');
    await race('/diag/atomic/cas', (i) => `${prefix}_${i}`, n,
      "Data Store compare-and-set: UPDATE cas_probe SET holder=? WHERE cas_key=? AND holder='FREE'");
    console.log(`\nCount durable state with: SELECT cas_key, holder FROM cas_probe`);
    console.log(`prefix for this run: ${prefix}`);
    return;
  }

  if (what === 'stratus') {
    const admin = ADMIN();
    await race('/diag/atomic/stratus', (i) => `_race/${stamp}/${i}.txt`, n,
      'Stratus putObject(key, holder, { overwrite: false })',
      async (key) => {
        const r = await post('/diag/atomic/readback', { key }, admin);
        const stored = (r.body as { stored?: unknown } | null)?.stored;
        return typeof stored === 'string' ? stored : null;
      });
    console.log(`\nprefix for this run: _race/${stamp}/`);
    return;
  }

  if (what === 'cache') {
    await race('/diag/atomic/cache', (i) => `race_${stamp}_${i}`, n,
      'Cache segment.put(key, holder, 1)');
    return;
  }

  throw new Error('usage: atomics-contended.ts <inventory|cas|stratus|cache> [n]');
}

await main();
