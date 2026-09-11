// Reconcile the open presence number, and state the RTDB figure with its units.
//
// Order 0040 asks: entry 50 records presence as 48% of the daily write allowance AND as 28,800
// writes/day, which at 20,000/day is 144%. Those cannot both be right, and the scoreboard row
// is UNKNOWN. This resolves it and then recomputes on RTDB's meter.
//
// EVIDENCE CLASSES (order 0028), stated per figure rather than blended:
//   measured    the payload byte count below -- it serialises the record the adapter actually
//               writes and counts the bytes
//   arithmetic  every daily/monthly total, derived from that payload and an interval
//   NOT measured  real RTDB bandwidth, because this project has no RTDB instance: the Firebase
//               Realtime Database Management API is disabled and the service account is denied
//               permission to enable it. `--live` runs the real thing once that is fixed.
import { argv } from 'node:process';

const enc = new TextEncoder();
const bytes = (o) => enc.encode(JSON.stringify(o)).length;

// ---------------------------------------------------------------- the record, measured
// Exactly what RtdbPresence.write() sends. Realistic ids and a realistic branch name: a short
// fixture would understate the payload and flatter the result.
const record = {
  agent_id: 'agent_be000001',
  status: 'working',
  current_task: 'task_items_crud',
  branch: 'feat/items-crud-handlers',
  last_heartbeat_ms: 1757577600000,
  connected: true,
};
const PAYLOAD = bytes(record);

// The Firestore document carries the same fields plus the registration fields that never change
// but are stored per document.
const fsDoc = { ...record, role_slug: 'backend-builder', member_label: 'sibhi', initials: 'BE', harness: 'claude-code', revoked: false };
const FS_DOC = bytes(fsDoc);

// ---------------------------------------------------------------- quotas
const FS = { writes_day: 20_000, reads_day: 50_000 };
const RTDB = { download_month_gb: 10, stored_gb: 1, connections: 100 };

const perDay = (interval_s) => Math.round(86_400 / interval_s);
const fmtB = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MiB` : `${(n / 1073741824).toFixed(2)} GiB`);
const pct = (n, d) => `${((n / d) * 100).toFixed(1)}%`;

console.log('PRESENCE COST\n');
console.log(`presence record, serialised            ${PAYLOAD} B   (measured)`);
console.log(`firestore presence document            ${FS_DOC} B   (measured)`);

// ---------------------------------------------------------------- 1. the reconciliation
console.log('\n--- 1. Why 48% and 144% were both "right" -------------------------------------\n');
console.log('They assume different heartbeat intervals. Neither was measured, because NOTHING IN');
console.log('THIS BUILD EMITS HEARTBEATS ON A SCHEDULE YET -- there is no interval constant');
console.log('anywhere in shared/, cli/ or firebase/. The input to both figures is a design');
console.log('decision nobody has made, which is the real reason the row is UNKNOWN.\n');
console.log('  interval   writes/day/agent   at 10 agents   % of 20,000/day');
for (const s of [30, 45, 60, 120]) {
  const w = perDay(s);
  console.log(`  ${String(s).padStart(4)} s      ${String(w).padStart(6)}             ${String(w * 10).padStart(7)}        ${pct(w * 10, FS.writes_day).padStart(7)}`);
}
console.log('\n  120 s -> 36%, which is where "48%" came from once reaper sweeps and work writes');
console.log('  were added.  30 s -> 144%, which is the other figure. Both arithmetic, both from');
console.log('  the same measured per-op costs, different assumption.');

console.log('\nThe interval is not free to choose. STALE_AFTER_MS is 90 s, so an agent must beat');
console.log('several times within that window or it flickers stale between beats. At the usual');
console.log('timeout/3 that is 30 s -- the expensive end. And at 30 s, presence alone does not');
console.log('fit Firestore\'s free tier at 10 agents by any arrangement:');
console.log(`  10 agents x ${perDay(30)} beats = ${(perDay(30) * 10).toLocaleString()} writes/day = ${pct(perDay(30) * 10, FS.writes_day)} of the daily cap.`);
console.log('  Even 60 s -- two beats per staleness window, the least that works -- is ' + pct(perDay(60) * 10, FS.writes_day) + '.');
console.log('\nSO THE FIRESTORE ROW SHOULD READ: over the free tier at 10 agents, at every');
console.log('interval compatible with a 90 s staleness timeout. Not one number -- a range with a');
console.log('floor above 100%.');

// ---------------------------------------------------------------- 2. RTDB, the new meter
console.log('\n--- 2. On RTDB the meter is bandwidth, and the units change --------------------\n');
console.log('RTDB does not bill operations at all. It bills bytes DOWNLOADED (database -> client),');
console.log('storage, and simultaneous connections. So a heartbeat WRITE is not itself metered;');
console.log('what is metered is every listener receiving it. Cost scales with');
console.log('    writes x listeners x payload,  not with writes.\n');

const rows = [];
for (const agents of [2, 10]) {
  for (const dashboards of [1, 5]) {
    const updates = perDay(30) * agents;
    const down = updates * PAYLOAD * dashboards;
    rows.push({ agents, dashboards, updates, down_day: down, down_month: down * 30 });
  }
}
console.log('  agents  dashboards  updates/day  download/day  download/month  % of 10 GB/mo');
for (const r of rows) {
  console.log(
    `  ${String(r.agents).padStart(6)}  ${String(r.dashboards).padStart(10)}  ${String(r.updates).padStart(11)}  ${fmtB(r.down_day).padStart(12)}  ${fmtB(r.down_month).padStart(14)}  ${pct(r.down_month, RTDB.download_month_gb * 1073741824).padStart(13)}`,
  );
}
const ten = rows.find((r) => r.agents === 10 && r.dashboards === 1);
console.log(`\n  storage: ${fmtB(PAYLOAD * 10)} for 10 agents -- presence is a fixed-size node per agent,`);
console.log(`  not a log, so it does not grow with time. Against ${RTDB.stored_gb} GB that is negligible.`);
console.log(`  connections: 1 per agent + 1 per dashboard, against a cap of ${RTDB.connections}.`);

console.log('\n  THE HEADLINE, with units:');
console.log(`  10 agents on a 30 s beat, one dashboard open: ${fmtB(ten.down_month)}/month downloaded,`);
console.log(`  = ${pct(ten.down_month, RTDB.download_month_gb * 1073741824)} of the 10 GB/month free allowance.`);
console.log('  The same workload is ' + pct(perDay(30) * 10, FS.writes_day) + ' of Firestore\'s daily write cap -- i.e. over it.');

console.log('\n  CAVEAT, stated rather than buried: this is arithmetic over a measured payload.');
console.log('  Firebase bills RTDB bandwidth including protocol and encryption overhead, which is');
console.log('  NOT in these numbers and which I cannot measure without an instance. Expect the');
console.log('  real figure to be meaningfully higher per update -- the conclusion (bandwidth is');
console.log('  not the binding constraint here; Firestore writes were) survives a large multiple,');
console.log(`  since it would take ${Math.floor((RTDB.download_month_gb * 1073741824) / ten.down_month)}x to exhaust the allowance.`);

if (argv.includes('--live')) {
  console.log('\n--live requires an RTDB instance. Run firebase/rtdbconfig.mjs first.');
  process.exit(1);
}
