// Presence on REAL RTDB. Observed, not arithmetic. Order 0046.
//
// ============================ REGION, STATED FIRST ============================
// RTDB instance: us-central1.  Client: Asia/Kolkata.  CROSS-REGION.
//
// Every other latency figure in this project is same-region by construction -- Firestore in
// asia-south1 with the client in Asia/Kolkata, deliberately best-case. These are not. NO FIGURE
// FROM THIS FILE MAY APPEAR IN A ROW WITH A FIRESTORE NUMBER: the two are not comparable and a
// shared table would read as though they were. Decision 0003 accepted the mismatch knowingly
// because RTDB bills BANDWIDTH, not distance, so the cost conclusion is unaffected.
// ==============================================================================
//
// What entry 56 had: 171 B per presence record, computed with JSON.stringify, and a monthly
// total derived from it. The caveat was explicit -- Firebase bills RTDB bandwidth inclusive of
// protocol and encryption overhead, which was not in the number. This replaces the payload input
// with an OBSERVED one and re-derives.
//
//   node firebase/presence-live.mjs [N]
import { initializeApp, deleteApp, applicationDefault } from 'firebase-admin/app';
import { getDatabase } from 'firebase-admin/database';
import { RtdbPresence } from './presence-rtdb.ts';
import { toPresence } from './presence.ts';
import { HEARTBEAT_INTERVAL_MS } from '../shared/store/types.ts';
import { CapturingLogger } from '../shared/log.ts';
import { systemClock } from '../shared/clock.ts';

const PROJECT = process.env.FB_PROJECT_ID ?? 'multiplayer-agents-eec02';
const DB_URL = process.env.FB_DATABASE_URL ?? 'https://multiplayer-agents-eec02-default-rtdb.firebaseio.com';
const REGION = 'us-central1';
const N = Number(process.argv[2] ?? 60);
const PID = `proj_pl_${Date.now().toString(36)}`;
const AGENT = 'agent_pl01';

let failed = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed += 1;
};
const pct = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
};

const log = new CapturingLogger();
const app = initializeApp({ projectId: PROJECT, databaseURL: DB_URL, credential: applicationDefault() }, `plive-${Date.now()}`);
const db = getDatabase(app);
const presence = new RtdbPresence({ db, clock: systemClock, log, on_disconnect: true });

console.log('PRESENCE ON REAL RTDB');
console.log(`  instance  ${DB_URL}`);
console.log(`  REGION    ${REGION}   (client Asia/Kolkata -- CROSS-REGION, see the header)`);
console.log(`  project   ${PROJECT}, namespace ${PID}\n`);

try {
  // ---- write latency, observed ----
  const writes = [];
  for (let i = 0; i < N; i++) {
    const t0 = Date.now();
    await presence.write(PID, AGENT, 'working', 'task_items_crud', 'feat/items-crud-handlers');
    writes.push(Date.now() - t0);
  }
  console.log(`heartbeat write, n=${N}   p50 ${pct(writes, 0.5)} ms   p95 ${pct(writes, 0.95)} ms   max ${Math.max(...writes)} ms`);
  console.log(`  ^ ${REGION}. Not comparable with any Firestore figure in this project.\n`);

  // ---- the stored record, OBSERVED on the wire ----
  // REST rather than the SDK: the SDK hands back a parsed object, and the thing being measured
  // is bytes, so it has to be read where bytes exist. Content-Length is the server's own count.
  const token = await app.options.credential.getAccessToken();
  const res = await fetch(`${DB_URL}/presence/${PID}/${AGENT}.json?access_token=${token.access_token}`);
  const body = await res.text();
  const observed = new TextEncoder().encode(body).length;
  const contentLength = Number(res.headers.get('content-length') ?? 0);

  console.log(`presence record, OBSERVED over the wire`);
  console.log(`  body bytes        ${observed}`);
  console.log(`  content-length    ${contentLength || 'not sent (chunked)'}`);
  console.log(`  entry 56 assumed  171 B (JSON.stringify, arithmetic)`);
  console.log(`  record: ${body.slice(0, 180)}\n`);
  check(observed > 0, 'the record came back with a measurable size');

  // ---- re-derive the monthly figure from the OBSERVED payload ----
  const beatsDay = Math.round(86_400_000 / HEARTBEAT_INTERVAL_MS);
  const rows = [];
  for (const agents of [2, 10]) {
    for (const dashboards of [1, 5]) {
      const perMonth = beatsDay * agents * observed * dashboards * 30;
      rows.push({ agents, dashboards, perMonth });
    }
  }
  const GB = 10 * 1024 ** 3;
  const fmt = (n) => (n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1048576).toFixed(1)} MiB`);
  console.log('monthly download, from the OBSERVED payload (arithmetic over a measured input):');
  console.log('  agents  dashboards  download/month   % of 10 GB/mo');
  for (const r of rows) {
    console.log(`  ${String(r.agents).padStart(6)}  ${String(r.dashboards).padStart(10)}  ${fmt(r.perMonth).padStart(14)}   ${((r.perMonth / GB) * 100).toFixed(1)}%`);
  }
  const ten = rows.find((r) => r.agents === 10 && r.dashboards === 1);
  console.log(`\n  headline: 10 agents, 1 dashboard, ${HEARTBEAT_INTERVAL_MS / 1000}s beat -> ${fmt(ten.perMonth)}/month, ${((ten.perMonth / GB) * 100).toFixed(1)}% of the free allowance.`);
  console.log('  Still arithmetic for the MULTIPLIER (beats x listeners), but the payload is now');
  console.log('  observed rather than computed. Protocol framing on the websocket is still not in');
  console.log('  it -- a REST body is not a websocket frame -- so treat this as a floor.');

  // ---- the two signals, and that they are different ----
  const rows2 = await presence.list(PID);
  const p = toPresence(rows2.find((r) => r.agent_id === AGENT), systemClock);
  check(p.stale === false, 'a fresh heartbeat is not stale (derived from last_heartbeat_at, not RTDB)');
  check(p.status === 'working', 'and carries the status the agent reported');

  // onDisconnect is the SECOND signal. Fire it for real by dropping the socket: goOffline()
  // makes the server run the registered handler, which is the thing a closed laptop does.
  const t0 = Date.now();
  await db.goOffline();
  await new Promise((r) => setTimeout(r, 4_000));
  await db.goOnline();
  await new Promise((r) => setTimeout(r, 2_000));

  const after = await presence.list(PID);
  const dropped = after.find((r) => r.agent_id === AGENT);
  check(dropped?.connected === false, `onDisconnect fired server-side and set connected:false (${Date.now() - t0} ms incl. waits)`);
  const derived = toPresence(dropped, systemClock);
  check(derived.status === 'offline', 'which the reader renders as offline -- the faster signal');
  check(derived.stale === false, 'while `stale` is still false: two signals, different meanings');
  console.log('\n  ^ onDisconnect has NO Firestore equivalent. It is the reason presence is here.');
} finally {
  await presence.close().catch(() => {});
  await deleteApp(app);
}

console.log(`\n${failed === 0 ? 'PRESENCE LIVE: PASSED' : `FAILED (${failed})`}`);
console.log(`All figures above: RTDB ${REGION}, client Asia/Kolkata. Never tabulate with Firestore.`);
process.exit(failed === 0 ? 0 : 1);
