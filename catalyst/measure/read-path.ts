// Order 0031 section 4 runner. Calls the deployed /diag/readpath route and prints
// the cold / warm / headers result verbatim.
//
// The interpretation is PRE-REGISTERED in order 0031 and applied here in code, so
// the number cannot be reinterpreted after it is seen:
//
//   warm << cold AND a cache header present -> cacheable read is real
//   warm ~= cold AND no cache header        -> plain origin object GET; C1's
//                                              advantage over C2 was never
//                                              established
//
// Usage: node catalyst/measure/read-path.ts

import { readFileSync } from 'node:fs';

const BASE = process.env.COORDINATION_URL
  ?? 'https://multiplayer-agents-60083782173.development.catalystserverless.in/server/coordination';

function token(): string {
  if (process.env.CATALYST_AGENT_TOKEN) return process.env.CATALYST_AGENT_TOKEN;
  const env = readFileSync(new URL('../../.context/measure.env', import.meta.url), 'utf8');
  const m = /^CATALYST_AGENT_TOKEN=(.+)$/m.exec(env);
  if (!m) throw new Error('no agent token available');
  return m[1].trim();
}

/** Headers that would mean a cache layer served the object. */
const CACHE_SIGNALS = ['age', 'x-cache', 'cf-cache-status', 'x-cache-hit', 'x-served-by', 'via', 'x-amz-cf-pop'];

async function main(): Promise<void> {
  console.log(`PROBE_AT=${new Date().toISOString()}`);
  const res = await fetch(`${BASE}/diag/readpath`, {
    method: 'POST',
    headers: { 'X-Agent-Token': token(), 'Content-Type': 'application/json' },
    body: '{}',
  });
  const out = await res.json() as {
    ok?: boolean; signed_url_host?: string;
    cold_ms?: number; warm_ms?: number; cold_status?: number; warm_status?: number;
    cold_headers?: Record<string, string>; warm_headers?: Record<string, string>;
    error?: unknown;
  };

  console.log(`HTTP ${res.status}`);
  console.log('--- verbatim ---');
  console.log(JSON.stringify(out, null, 1));

  if (out.ok !== true || out.cold_ms === undefined || out.warm_ms === undefined) {
    console.log('\nMEASUREMENT DID NOT COMPLETE. No figure may be reported.');
    return;
  }

  const signals = CACHE_SIGNALS.filter((h) => out.warm_headers?.[h] !== undefined);
  const warmMuchFaster = out.warm_ms < out.cold_ms * 0.5;

  console.log('');
  console.log(`HOST                ${out.signed_url_host}`);
  console.log(`cold                ${out.cold_ms} ms  (HTTP ${out.cold_status})`);
  console.log(`warm                ${out.warm_ms} ms  (HTTP ${out.warm_status})`);
  console.log(`cache signals       ${signals.length === 0 ? 'NONE' : signals.join(', ')}`);
  console.log(`cache-control       ${out.warm_headers?.['cache-control'] ?? 'absent'}`);
  console.log(`etag                ${out.warm_headers?.etag ?? 'absent'}`);
  console.log('');

  // Pre-registered, per order 0031 section 4. Not decided after the fact.
  if (warmMuchFaster && signals.length > 0) {
    console.log(`VERDICT: cacheable read is REAL. Report as "Stratus, ${out.warm_ms} ms warm`
      + `, ${out.cold_ms} ms cold, host ${out.signed_url_host}". Never as 34 ms.`);
  } else {
    console.log('VERDICT: warm is not materially faster than cold and no cache header is present.');
    console.log('C1\'s read is a PLAIN ORIGIN OBJECT GET.');
    console.log("C1's advantage over route C2 was NEVER ESTABLISHED. C2 is live again.");
  }
}

await main();
