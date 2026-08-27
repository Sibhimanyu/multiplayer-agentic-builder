// Order 0031: the bounded putObject probe (3b) and the cold/warm/headers read
// measurement (section 4).
//
// The interpretation is PRE-REGISTERED in order 0031 section 4 and reproduced
// here so the number cannot pick its own meaning after the fact:
//
//   warm << cold, WITH a cache header  -> the design's cacheable read is real.
//                                         Report it and NAME THE HOST:
//                                         "Stratus CDN, N ms". Never inherit
//                                         GitHub's 34 ms as the label.
//   warm ~= cold, NO cache header      -> C1's read is a plain origin object GET.
//                                         C1's advantage over C2 was NEVER
//                                         ESTABLISHED. Do not soften it, do not
//                                         retry into a better number.
//
// Every figure printed here carries its host, per 0031's rule: a latency is not a
// fact about CDNs, it is a fact about a named endpoint.
//
// Usage: node catalyst/measure/stratus-probe.ts

import { readFileSync } from 'node:fs';

const BASE = process.env.COORDINATION_URL
  ?? 'https://multiplayer-agents-60083782173.development.catalystserverless.in/server/coordination';

/** The host every read figure in this file is measured against. */
export const READ_HOST = 'coordinationsnapshots-development.zohostratus.in';

function token(): string {
  if (process.env.CATALYST_AGENT_TOKEN) return process.env.CATALYST_AGENT_TOKEN;
  const env = readFileSync(new URL('../../.context/measure.env', import.meta.url), 'utf8');
  const m = /^CATALYST_AGENT_TOKEN=(.+)$/m.exec(env);
  if (!m) throw new Error('no agent token available');
  return m[1].trim();
}

/** Headers that would indicate a cache layer is serving the object. */
const CACHE_HEADER_NAMES = [
  'age', 'x-cache', 'cf-cache-status', 'x-cache-hit', 'x-served-by',
  'cache-control', 'etag', 'last-modified', 'x-amz-cf-pop', 'via',
];

function cacheHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of CACHE_HEADER_NAMES) {
    const v = h.get(name);
    if (v !== null) out[name] = v;
  }
  return out;
}

function allHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => { out[k] = v; });
  return out;
}

async function main(): Promise<void> {
  const TOKEN = token();
  const at = new Date().toISOString();
  console.log(`PROBE_AT=${at}`);
  console.log(`READ_HOST=${READ_HOST}`);
  console.log('');

  // ---- section 3b: does putObject work AT ALL --------------------------------
  console.log('=== POST /diag/putobject (bounded, one key, no parameter variation) ===');
  const res = await fetch(`${BASE}/diag/putobject`, {
    method: 'POST',
    headers: { 'X-Agent-Token': TOKEN, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const text = await res.text();
  console.log(`HTTP ${res.status}`);
  console.log('--- response headers (verbatim) ---');
  console.log(JSON.stringify(allHeaders(res.headers), null, 1));
  console.log('--- body (verbatim) ---');
  console.log(text);
}

await main();
