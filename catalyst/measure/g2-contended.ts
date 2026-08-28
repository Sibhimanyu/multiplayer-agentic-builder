// G2 CONTENDED. Order 0034 debt 1.
//
// WHY THIS EXISTS. The earlier G2 reported 200/200 claims won, which means every
// claim was for a task nobody else wanted -- nothing ever contended. That 127 ms
// is the UNCONTENDED figure, and it had been sitting in the scoreboard opposite
// Firebase's contended number as though the two were counterparts. They were not.
//
// Here: 5 distinct agents, each with its own token, all firing at the SAME task
// at the same time. n=200 tasks, so 1,000 claim requests.
//
// REPORTING RULES, from 0034 and 0028:
//   - p50 / p95 / p99 / max. NO MEAN. A mean over a contended distribution hides
//     exactly the tail that contention creates.
//   - EXACTLY ONE WINNER PER TASK is asserted, not assumed. A latency figure from
//     a run that also broke mutual exclusion would be worthless.
//   - Winners and losers are reported SEPARATELY. A loser returns as soon as the
//     unique constraint rejects it; a winner waits for its INSERT to commit. They
//     are different operations and averaging them together would be a third
//     measurement-shape artifact.
//
// Usage: node catalyst/measure/g2-contended.ts [n]

import { readFileSync } from 'node:fs';

const BASE = process.env.COORDINATION_URL
  ?? 'https://multiplayer-agents-60083782173.development.catalystserverless.in/server/coordination';
export const HOST = new URL(BASE).host;
const PROJECT = 'proj_inventory';
const RACERS = 5;

function tokens(): string[] {
  const env = readFileSync(new URL('../../.context/measure.env', import.meta.url), 'utf8');
  const out: string[] = [];
  for (let i = 1; i <= RACERS; i += 1) {
    const m = new RegExp(`^RACE_TOKEN_${i}=(.+)$`, 'm').exec(env);
    if (!m) throw new Error(`missing RACE_TOKEN_${i}`);
    out.push(m[1].trim());
  }
  return out;
}

interface Attempt { ms: number; won: boolean; ok: boolean; status: number; owner?: string }

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

function summarise(label: string, values: number[]): string {
  const s = [...values].sort((a, b) => a - b);
  return `${label.padEnd(22)} n=${String(s.length).padStart(4)}  `
    + `p50 ${String(percentile(s, 0.5)).padStart(5)}  `
    + `p95 ${String(percentile(s, 0.95)).padStart(5)}  `
    + `p99 ${String(percentile(s, 0.99)).padStart(5)}  `
    + `max ${String(s[s.length - 1]).padStart(5)}`;
}

async function claim(token: string, task_id: string): Promise<Attempt> {
  const t0 = performance.now();
  try {
    const res = await fetch(`${BASE}/claim`, {
      method: 'POST',
      headers: { 'X-Agent-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: PROJECT, task_id }),
    });
    const ms = Math.round(performance.now() - t0);
    const body = await res.json() as { ok?: boolean; owner?: string };
    return {
      ms, ok: res.ok, status: res.status, won: body.ok === true,
      ...(body.owner === undefined ? {} : { owner: body.owner }),
    };
  } catch (err) {
    return { ms: Math.round(performance.now() - t0), ok: false, status: 0, won: false };
  }
}

async function main(): Promise<void> {
  const n = Number(process.argv[2] ?? '200') || 200;
  const toks = tokens();
  const stamp = Date.now().toString(36);

  console.log(`PROBE_AT=${new Date().toISOString()}`);
  console.log(`HOST=${HOST}`);
  console.log(`shape: ${RACERS} agents racing for ONE task, n=${n} tasks `
    + `= ${RACERS * n} claim requests`);
  console.log('');

  const winnerMs: number[] = [];
  const loserMs: number[] = [];
  const allMs: number[] = [];
  let tasksWithExactlyOneWinner = 0;
  let violations = 0;
  let transportFailures = 0;
  const t0 = Date.now();

  for (let i = 0; i < n; i += 1) {
    const task_id = `task_race_${stamp}_${i}`;
    // All five fire together. Promise.all starts them in the same tick, so the
    // contention is real rather than staggered by the loop.
    const attempts = await Promise.all(toks.map((t) => claim(t, task_id)));

    const winners = attempts.filter((a) => a.won);
    if (winners.length === 1) tasksWithExactlyOneWinner += 1;
    else violations += 1;

    for (const a of attempts) {
      if (!a.ok && a.status === 0) { transportFailures += 1; continue; }
      allMs.push(a.ms);
      if (a.won) winnerMs.push(a.ms); else loserMs.push(a.ms);
    }
    if (i % 25 === 0) process.stderr.write(`  ${i}/${n}\n`);
  }

  const wall = Math.round((Date.now() - t0) / 1000);
  console.log('=== MUTUAL EXCLUSION ===');
  console.log(`tasks with exactly one winner   ${tasksWithExactlyOneWinner}/${n}`);
  console.log(`violations (0 or >1 winners)    ${violations}`);
  console.log(`transport failures              ${transportFailures}`);
  console.log('');
  console.log('=== LATENCY, ms. No mean: a mean over a contended distribution');
  console.log('=== hides the tail that contention creates.');
  console.log(summarise('winners', winnerMs));
  console.log(summarise('losers', loserMs));
  console.log(summarise('all attempts', allMs));
  console.log('');
  console.log(`wall clock ${wall}s`);
  console.log('');
  console.log('Quota consumed by this run (from the measured per-action costs):');
  console.log(`  SELECT  ${RACERS * n * 2} (2 auth per request)`);
  console.log(`  INSERT  ${RACERS * n} attempted, ${n} committed, ${RACERS * n - n} rejected by the unique constraint`);
}

await main();
