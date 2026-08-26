// Backend operations consumed per logical action, derived from the code paths
// rather than from a provider console.
//
// The console aggregates hours later in buckets that cannot be attributed to a
// request, so it can confirm a total but never explain it. These numbers are
// counted at the call sites in functions/coordination/index.ts and cross-checked
// against the durable row counts the session actually left behind.

export interface OpCost { selects: number; inserts: number; note: string }

/**
 * EVERY authenticated request pays 2 SELECTs before its own work begins:
 * token -> agent, then project+role -> permissions. The protocol requires that
 * resolution on every request, so it is not cacheable without weakening it.
 */
export const AUTH_SELECTS = 2;

export const COSTS: Record<string, OpCost> = {
  'claim (won)': { selects: AUTH_SELECTS, inserts: 1, note: 'auth, then one INSERT that wins the unique constraint' },
  'claim (lost)': { selects: AUTH_SELECTS + 1, inserts: 1, note: 'the failed INSERT still costs an operation, plus one SELECT to name the owner' },
  'append (new)': { selects: AUTH_SELECTS + 3, inserts: 2, note: 'auth, findDedupe, findEventByDedupeKey, MAX(seq); then event + dedupe rows' },
  'append (replay)': { selects: AUTH_SELECTS + 1, inserts: 0, note: 'auth then findDedupe short-circuits' },
  'readEvents (partial page)': { selects: AUTH_SELECTS + 1, inserts: 0, note: 'auth then one paged SELECT' },
  'readEvents (full page)': { selects: AUTH_SELECTS + 2, inserts: 0, note: 'plus the has_more probe, because ZCQL rejects LIMIT 301' },
  'webhook delivery (new)': { selects: 1 + 3, inserts: 2, note: 'repo lookup instead of auth, then the append path' },
  'webhook delivery (replay)': { selects: 1 + 1, inserts: 0, note: 'repo lookup then dedupe short-circuits' },
};

/** Free-tier monthly allowances, from the pricing reference. */
export const FREE_TIER = { selects: 10_000, inserts: 5_000, updates: 1_000 };

export function budget(action: keyof typeof COSTS): { selects_per_month: number; inserts_per_month: number } {
  const c = COSTS[action];
  return {
    selects_per_month: c.selects === 0 ? Infinity : Math.floor(FREE_TIER.selects / c.selects),
    inserts_per_month: c.inserts === 0 ? Infinity : Math.floor(FREE_TIER.inserts / c.inserts),
  };
}

/**
 * What this session actually spent.
 *
 * INSERTs are the MEASURED row counts, read back with COUNT(ROWID) rather than
 * estimated: 201 task_claims, 101 events, 101 request_dedupe = 403 rows. SELECTs
 * are computed from the per-action costs, because there is no durable artefact a
 * SELECT leaves behind to count.
 */
export const SESSION = {
  g2_claims: 200,
  g1_appends: 100,
  g1_visibility_reads: 100,
  /** Curl probes and failed attempts during bring-up. */
  manual_requests: 15,
  /** Verified with COUNT(ROWID) on each table. */
  measured_rows: { task_claims: 201, events: 101, request_dedupe: 101 },
};

export function sessionTotals(): { selects: number; inserts: number; inserts_measured: number } {
  const claim = COSTS['claim (won)'];
  const append = COSTS['append (new)'];
  const read = COSTS['readEvents (partial page)'];
  const r = SESSION.measured_rows;
  return {
    selects: SESSION.g2_claims * claim.selects
      + SESSION.g1_appends * append.selects
      + SESSION.g1_visibility_reads * read.selects
      + SESSION.manual_requests * 4,
    inserts: r.task_claims + r.events + r.request_dedupe,
    inserts_measured: r.task_claims + r.events + r.request_dedupe,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rows: string[] = [];
  rows.push('action                        SELECT  INSERT  ops/month at free tier');
  for (const action of Object.keys(COSTS)) {
    const c = COSTS[action];
    const b = budget(action);
    const limit = Math.min(b.selects_per_month, b.inserts_per_month);
    rows.push(`${action.padEnd(28)}  ${String(c.selects).padStart(6)}  ${String(c.inserts).padStart(6)}  ${Number.isFinite(limit) ? limit.toLocaleString() : 'unbounded'}`);
  }
  const t = sessionTotals();
  rows.push('');
  rows.push(`this session: ${t.selects} SELECT (${(t.selects / FREE_TIER.selects * 100).toFixed(1)}% of monthly free tier), ${t.inserts} INSERT (${(t.inserts / FREE_TIER.inserts * 100).toFixed(1)}%)`);
  rows.push(`remaining: ${FREE_TIER.selects - t.selects} SELECT, ${FREE_TIER.inserts - t.inserts} INSERT, ${FREE_TIER.updates} UPDATE (zero used, by design)`);
  console.log(rows.join('\n'));
}
