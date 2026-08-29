// Order 0037: the last atomic primitive that keeps atomicity in a database.
//
// WHY THIS IS A JOB FUNCTION AND NOT AN HTTP ROUTE.
//
// Data Store is at FREE_USAGE_LIMIT_REACHED. Every authenticated HTTP route on
// this build spends 2 SELECTs resolving token -> agent -> project, so every one
// of them returns STORE_ERROR and cannot be reached at all. 0037 forbids
// working around that by weakening auth, and rightly: a measurement of a path
// nobody ships is worth nothing.
//
// A job function is not a weakening. It is invoked through the Job Scheduling
// API under Catalyst's own platform credentials -- stronger auth than an agent
// token, not weaker -- and this route already ships one, the reaper. So this is
// an existing production-shaped entry point that happens not to touch Data
// Store, which is exactly what 0037 asked me to establish.
//
// The honest cost of that choice, stated up front and repeated in the report:
// the five racers here run inside ONE function invocation rather than as five
// separate HTTP clients. That is a different shape from every other primitive
// measured on this route, so:
//
//   - END-TO-END latency from this probe is NOT comparable to the other rows
//     and must not be put in the same column. It is not reported as such.
//   - The concurrency itself is therefore not assumed. Every attempt records
//     its own start and end, and the report states whether all five intervals
//     actually OVERLAP. If a connection pool serialised them, the overlap check
//     says so and the mutual-exclusion result means nothing -- a non-atomic
//     primitive looks perfect if the client never actually raced.
//
// OUTPUT. A job function's console.log is write-only here: Get_Logs returns []
// for every function in this project at every level. So results go to Cache
// keys, which is the pattern the reaper already established, and Cache is
// readable through the MCP without spending a Data Store read.

import type { Logger } from '../../shared/log.ts';
import { PRESENCE_SEGMENT } from '../presence/index.ts';

/** The table the console gate produced. Fixed here so no caller can point this at another. */
export const CLAIM_PROBE_TABLE_ID = '53069000000101123';

export const SCHEMA_KEY = 'nosql:schema';
export const CONTROL_KEY = 'nosql:control';
export const RESULT_KEY = 'nosql:result';
export const PROGRESS_KEY = 'nosql:progress';

/** Racers, matching every other contended probe on this route. */
const RACERS = ['agent_race01', 'agent_race02', 'agent_race03', 'agent_race04', 'agent_race05'];

// --- Structural SDK types. Declared locally, as everywhere else in this build,
// --- because zcatalyst-sdk-node lives only in the deploy tree.

interface NoSQLAttr { S?: string }
type NoSQLRawItem = Record<string, NoSQLAttr>;

interface NoSQLCondition {
  function?: { function_name: string; args: Array<{ attribute_path: string[] }> };
  negate?: boolean;
}
interface NoSQLTableApi {
  insertItems(...values: Array<{ item: NoSQLRawItem; condition?: NoSQLCondition }>): Promise<unknown>;
  fetchItem(value: { keys: NoSQLRawItem | NoSQLRawItem[]; consistent_read?: boolean }): Promise<unknown>;
  toJSON(): unknown;
}
export interface ProbeApp {
  nosql(): {
    getTable(id: string): Promise<NoSQLTableApi>;
    table(id: string): NoSQLTableApi;
  };
  cache(): {
    segment(name?: string): {
      get(key: string): Promise<unknown>;
      getValue(key: string): Promise<unknown>;
      put(key: string, value: string, expiryInHours?: number): Promise<unknown>;
    };
  };
}

/** Serialise an unknown throw. Same contract as diag/index.ts describeError. */
export function describe(err: unknown): Record<string, unknown> {
  if (err === null || err === undefined) return { thrown: String(err) };
  if (typeof err !== 'object') return { thrown: String(err), type: typeof err };
  const e = err as Record<string, unknown>;
  const out: Record<string, unknown> = { constructor_name: err.constructor?.name ?? null };
  for (const k of Object.keys(e)) out[k] = e[k];
  for (const k of ['message', 'code', 'statusCode', 'value', 'errorInfo', 'name']) {
    if (e[k] !== undefined) out[k] = e[k];
  }
  return out;
}

/**
 * Decide, from the table's OWN definition, whether it has a sort key.
 *
 * 0037 is emphatic about this and it is the single most important function in
 * this file: with a primary key of (partition, sort), five racers inserting
 * under five different sort values would ALL succeed, and the probe would
 * report perfect mutual exclusion having excluded nothing. That is the same
 * false-pass shape as the original "20 concurrent claims" test against a double.
 *
 * Returns `true` for "definitely no sort key". Anything it cannot read
 * confidently returns `false`, so an unrecognised schema shape BLOCKS the race
 * rather than being waved through -- the failure mode of guessing here is a
 * green result that means nothing.
 */
export function hasNoSortKey(def: unknown): { safe: boolean; reason: string; seen: unknown } {
  if (def === null || typeof def !== 'object') {
    return { safe: false, reason: 'table definition was not an object', seen: def };
  }
  const d = def as Record<string, unknown>;

  // GENERIC, not a fixed list of guessed names.
  //
  // The first version of this checked seven hand-written spellings of "sort
  // key". The real definition turned out to carry `additional_sort_keys`, which
  // was not one of them -- so the gate would have passed a table WITH a sort key
  // while appearing to check for one. It was empty, so the answer was right and
  // the reasoning was wrong, which is the exact failure this whole probe exists
  // to avoid. Scan every field instead of guessing names.
  for (const [k, v] of Object.entries(d)) {
    if (!/sort|range/i.test(k)) continue;
    const populated = Array.isArray(v)
      ? v.length > 0
      : v !== undefined && v !== null && v !== '' && v !== false;
    if (populated) {
      return { safe: false, reason: `field ${k} is populated: ${JSON.stringify(v)}`, seen: v };
    }
  }

  // Some shapes describe keys as a list of columns carrying a role instead.
  for (const v of Object.values(d)) {
    if (!Array.isArray(v)) continue;
    for (const col of v) {
      if (col === null || typeof col !== 'object') continue;
      const c = col as Record<string, unknown>;
      const role = String(c.key_type ?? c.keyType ?? c.role ?? c.type ?? '').toLowerCase();
      if (role.includes('sort') || role.includes('range')) {
        return { safe: false, reason: `column entry declares a sort/range role`, seen: col };
      }
    }
  }

  // Positive confirmation required: the partition key must be visible. If the
  // definition does not even show that, this code does not understand the shape
  // and must not clear the race.
  const partition = d.partition_key ?? d.partitionKey ?? d.hash_key ?? d.partition_key_column;
  if (partition === undefined || partition === null || partition === '') {
    return {
      safe: false,
      reason: 'no partition key field recognised; schema shape not understood, refusing to race',
      seen: Object.keys(d),
    };
  }

  return { safe: true, reason: `partition key ${JSON.stringify(partition)}, no sort key field populated`, seen: partition };
}

export interface Attempt {
  racer: string;
  won: boolean;
  /** The platform's own word for what happened. Never inferred. */
  status: string;
  /** Wall-clock start/end of the primitive call, used to prove the five overlapped. */
  t0: number;
  t1: number;
  error?: Record<string, unknown>;
}

/**
 * Read the platform's verdict out of an insertItems response.
 *
 * THE BUG THIS FIXES, recorded because it nearly became a finding. The first
 * version treated "did not throw" as a win. `insertItems` does NOT throw when a
 * condition is not met -- it resolves with `create: [{ status: "CriteriaMismatch" }]`
 * and `size: 0`. So every attempt the platform correctly REFUSED was counted as
 * a winner, and the run reported 392 winners over 200 keys while the table held
 * nothing at all.
 *
 * A win is now positive confirmation of the literal string "Success". Anything
 * unrecognised is reported as its own category and is never a win: an unknown
 * status must not be able to manufacture a claim.
 */
export function verdictOf(res: unknown): string {
  const plain = (() => {
    const maybe = res as { toJSON?: unknown };
    if (res !== null && typeof res === 'object' && typeof maybe.toJSON === 'function') {
      try { return (maybe as { toJSON(): unknown }).toJSON(); } catch { return res; }
    }
    return res;
  })();
  if (plain === null || typeof plain !== 'object') return 'unparseable';
  const create = (plain as { create?: unknown }).create;
  if (!Array.isArray(create) || create.length === 0) return 'no_create_entry';
  const st = (create[0] as { status?: unknown })?.status;
  return typeof st === 'string' ? st : 'no_status_field';
}

/** Do the five attempt intervals all overlap in time? If not, nothing raced. */
export function allOverlap(attempts: Attempt[]): boolean {
  if (attempts.length < 2) return false;
  const latestStart = Math.max(...attempts.map((a) => a.t0));
  const earliestEnd = Math.min(...attempts.map((a) => a.t1));
  return latestStart < earliestEnd;
}

function pct(sorted: number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}
export function stats(values: number[]): Record<string, number> {
  const s = [...values].sort((a, b) => a - b);
  return {
    n: s.length, p50: pct(s, 0.5), p95: pct(s, 0.95), p99: pct(s, 0.99),
    max: s[s.length - 1] ?? Number.NaN,
  };
}

/** One racer's conditional insert: attribute_not_exists(claim_key). */
async function attempt(
  table: NoSQLTableApi, key: string, racer: string,
): Promise<Attempt> {
  const t0 = Date.now();
  try {
    const res = await table.insertItems({
      item: { claim_key: { S: key }, holder: { S: racer } },
      condition: {
        function: { function_name: 'attribute_exists', args: [{ attribute_path: ['claim_key'] }] },
        negate: true,
      },
    });
    const status = verdictOf(res);
    return { racer, won: status === 'Success', status, t0, t1: Date.now() };
  } catch (err) {
    return { racer, won: false, status: 'threw', t0, t1: Date.now(), error: describe(err) };
  }
}

export interface ProbeResult {
  at: string;
  phase: string;
  schema?: unknown;
  sort_key_check?: { safe: boolean; reason: string; seen: unknown };
  raced?: boolean;
  reason?: string;
  rounds_requested?: number;
  rounds_completed?: number;
  exactly_one?: number;
  zero_winners?: number;
  multiple_winners?: number;
  rounds_where_all_five_overlapped?: number;
  winners?: Record<string, number>;
  losers?: Record<string, number>;
  loser_error_codes?: Record<string, number>;
  error_samples?: Record<string, unknown>[];
  /** key -> the racer the platform told "you won". Reconciled against durable state later. */
  declared?: Record<string, string>;
  audit?: {
    keys_checked: number;
    stored_matches_declared: number;
    stored_contradicts_declared: number;
    missing: number;
    samples: string[];
  };
  error?: Record<string, unknown>;
}

/**
 * Read the table's own definition. This is 0037's mandated FIRST operation and
 * it is separated from the race deliberately: the schema is inspected by a human
 * before any racing happens, and the race is additionally gated in code below.
 */
export async function readSchema(app: ProbeApp): Promise<ProbeResult> {
  const out: ProbeResult = { at: new Date().toISOString(), phase: 'schema' };
  try {
    const table = await app.nosql().getTable(CLAIM_PROBE_TABLE_ID);
    const def = table.toJSON();
    out.schema = def;
    out.sort_key_check = hasNoSortKey(def);
  } catch (err) {
    out.error = describe(err);
  }
  return out;
}

/**
 * The contended run, plus an independent audit of what the table actually holds.
 *
 * The audit is a SEPARATE pass over the durable rows, and it is what caught Data
 * Store CAS returning affected:1 to five racers while the table held exactly one
 * correct row. Either check alone passed there; only the pair failed.
 */
export async function race(
  app: ProbeApp, rounds: number, budgetMs: number, log: Logger,
): Promise<ProbeResult> {
  const started = Date.now();
  const out: ProbeResult = { at: new Date().toISOString(), phase: 'race', rounds_requested: rounds };

  // Gate in code, not only in intent: re-read the schema and refuse to race a
  // table whose definition this build cannot confirm is sort-key-free.
  const schema = await readSchema(app);
  out.schema = schema.schema;
  out.sort_key_check = schema.sort_key_check;
  if (schema.error !== undefined) {
    out.raced = false;
    out.reason = 'could not read the table definition';
    out.error = schema.error;
    return out;
  }
  if (schema.sort_key_check?.safe !== true) {
    out.raced = false;
    out.reason = `REFUSED TO RACE: ${schema.sort_key_check?.reason ?? 'sort key check failed'}`;
    return out;
  }

  const table = app.nosql().table(CLAIM_PROBE_TABLE_ID);
  const stamp = Date.now().toString(36);
  const winnerMs: number[] = [];
  const loserMs: number[] = [];
  const loserCodes: Record<string, number> = {};
  const errorSamples: Record<string, unknown>[] = [];
  const declared: Record<string, string> = {};
  let exactlyOne = 0; let zero = 0; let multi = 0; let overlapped = 0;
  let completed = 0;

  for (let i = 0; i < rounds; i += 1) {
    if (Date.now() - started > budgetMs) break;
    const key = `t_${stamp}_${i}`;
    // All five start in the same tick. Whether they were genuinely concurrent is
    // then CHECKED via allOverlap rather than assumed.
    const attempts = await Promise.all(RACERS.map((r) => attempt(table, key, r)));
    completed += 1;

    if (allOverlap(attempts)) overlapped += 1;
    const wins = attempts.filter((a) => a.won);
    if (wins.length === 1) { exactlyOne += 1; declared[key] = wins[0].racer; }
    else if (wins.length === 0) zero += 1;
    else { multi += 1; declared[key] = wins.map((w) => w.racer).join('+'); }

    for (const a of attempts) {
      if (a.won) winnerMs.push(a.t1 - a.t0);
      else {
        loserMs.push(a.t1 - a.t0);
        // Keyed by the platform's own status, so a refusal ("CriteriaMismatch")
        // is never conflated with a server error ("threw"). The first run could
        // not tell those apart and that is what hid the bug.
        const code = a.status === 'threw'
          ? `threw:${String(a.error?.code ?? a.error?.statusCode ?? 'unknown')}`
          : a.status;
        loserCodes[code] = (loserCodes[code] ?? 0) + 1;
        if (a.error !== undefined && errorSamples.length < 3) errorSamples.push(a.error);
      }
    }
  }

  out.rounds_completed = completed;
  out.exactly_one = exactlyOne;
  out.zero_winners = zero;
  out.multiple_winners = multi;
  out.rounds_where_all_five_overlapped = overlapped;
  out.winners = stats(winnerMs);
  out.losers = stats(loserMs);
  out.loser_error_codes = loserCodes;
  out.error_samples = errorSamples;
  out.declared = declared;
  out.raced = true;

  // --- Independent audit. A fresh consistent read of every key, compared with
  // --- what the platform told each caller. Never derived from the tally above.
  const samples: string[] = [];
  let matches = 0; let contradicts = 0; let missing = 0;
  const keys = Object.keys(declared);
  for (const key of keys) {
    if (Date.now() - started > budgetMs + 30_000) break;
    try {
      const res = await table.fetchItem({
        keys: { claim_key: { S: key } }, consistent_read: true,
      });
      const stored = extractHolder(res);
      if (stored === null) { missing += 1; if (samples.length < 5) samples.push(`${key}: NO ROW, declared ${declared[key]}`); }
      else if (stored === declared[key]) matches += 1;
      else {
        contradicts += 1;
        if (samples.length < 5) samples.push(`${key}: declared '${declared[key]}', stored '${stored}'`);
      }
    } catch (err) {
      missing += 1;
      if (samples.length < 5) samples.push(`${key}: audit read failed ${JSON.stringify(describe(err)).slice(0, 160)}`);
    }
  }
  out.audit = {
    keys_checked: keys.length,
    stored_matches_declared: matches,
    stored_contradicts_declared: contradicts,
    missing, samples,
  };

  log.info('nosql.race', 'contended conditional insert complete', {});
  return out;
}

/**
 * Pull the `holder` string out of a NoSQL fetch response.
 *
 * Written defensively and returning null rather than a placeholder, because the
 * last time a read-back was written casually it produced "[object Object]" for
 * 48 keys and looked exactly like a platform failure. A null here is legible as
 * "could not read"; a stringified wrapper is not.
 */
export function extractHolder(res: unknown): string | null {
  // NORMALISE THROUGH JSON FIRST. This is the fix for the third read-back bug of
  // the same family on this route, and the rule it establishes is: never
  // hand-walk an SDK response object.
  //
  // The response is a NoSQLResponse whose nested items are themselves class
  // instances. Object.values() over them finds nothing useful, so a manual walk
  // returned null for EVERY key -- including a positive control row that was
  // provably present and that JSON.stringify rendered perfectly. The previous
  // two instances were String() on a Stratus wrapper ("[object Object]") and
  // treating a non-throwing insert as a win. All three had the same shape: a
  // helper of mine failing quietly and looking exactly like a platform failure.
  //
  // JSON.parse(JSON.stringify(x)) invokes every nested toJSON on the way down,
  // which is what makes the result walkable.
  let plain: unknown;
  try { plain = JSON.parse(JSON.stringify(res)); } catch { return null; }

  const walk = (o: unknown, depth: number): string | null => {
    if (depth > 8 || o === null || typeof o !== 'object') return null;
    const rec = o as Record<string, unknown>;
    const h = rec.holder;
    if (typeof h === 'string') return h;
    if (h !== null && typeof h === 'object') {
      const s = (h as Record<string, unknown>).S;
      if (typeof s === 'string') return s;
    }
    for (const v of Object.values(rec)) {
      const found = walk(v, depth + 1);
      if (found !== null) return found;
    }
    return null;
  };
  return walk(plain, 0);
}

/**
 * Snapshot any SDK value for verbatim reporting.
 *
 * The SDK returns wrapper objects whose useful content is behind toJSON(), and
 * JSON.stringify on the wrapper has already produced misleading output twice on
 * this route. Capture both forms and the key list, so a report can never again
 * be built on a stringified placeholder.
 */
function snap(x: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = { type: typeof x, ctor: (x as object)?.constructor?.name ?? null };
  if (x === null || typeof x !== 'object') { out.value = String(x); return out; }
  out.own_keys = Object.keys(x as object);
  const maybe = x as { toJSON?: unknown };
  if (typeof maybe.toJSON === 'function') {
    try { out.to_json = (maybe as { toJSON(): unknown }).toJSON(); } catch (e) { out.to_json_threw = describe(e); }
  }
  try { out.plain = JSON.parse(JSON.stringify(x)); } catch { out.plain = 'unserialisable'; }
  return out;
}

/**
 * BOUNDED DIAGNOSTIC. Distinguishes "my request shape is wrong" from "NoSQL
 * cannot do conditional inserts".
 *
 * The first contended run reported 392 winners and then found ZERO rows in the
 * table, with all 608 failures carrying INTERNAL_SERVER_ERROR rather than any
 * condition-failed code. Two independent signals that nothing was written at
 * all. Reporting that as a primitive failure would have been the same mistake as
 * the "[object Object]" read-back in order 0035 -- my bug wearing a platform's
 * clothes. So: five ordered steps, each reported verbatim, no interpretation.
 */
export async function diagnose(app: ProbeApp): Promise<Record<string, unknown>> {
  const table = app.nosql().table(CLAIM_PROBE_TABLE_ID);
  const stamp = Date.now().toString(36);
  const kA = `d_${stamp}_plain`;
  const kB = `d_${stamp}_cond`;
  const out: Record<string, unknown> = { at: new Date().toISOString(), phase: 'diagnose' };

  const item = (key: string, holder: string): NoSQLRawItem =>
    ({ claim_key: { S: key }, holder: { S: holder } });
  const notExists: NoSQLCondition = {
    function: { function_name: 'attribute_exists', args: [{ attribute_path: ['claim_key'] }] },
    negate: true,
  };

  // 1. Plain insert, no condition. If THIS fails, the item shape is wrong and
  //    nothing about conditions has been tested.
  try { out.step1_plain_insert = snap(await table.insertItems({ item: item(kA, 'holder_one') })); }
  catch (err) { out.step1_plain_insert_error = describe(err); }

  // 2. Read it straight back, raw.
  try { out.step2_fetch_after_plain = snap(await table.fetchItem({ keys: item(kA, ''), consistent_read: true })); }
  catch (err) { out.step2_fetch_error = describe(err); }

  // 3. Conditional insert onto a key that now EXISTS. Should be refused.
  try { out.step3_cond_insert_existing = snap(await table.insertItems({ item: item(kA, 'holder_two'), condition: notExists })); }
  catch (err) { out.step3_cond_insert_existing_error = describe(err); }

  // 4. Conditional insert onto a FRESH key. Should succeed.
  try { out.step4_cond_insert_fresh = snap(await table.insertItems({ item: item(kB, 'holder_three'), condition: notExists })); }
  catch (err) { out.step4_cond_insert_fresh_error = describe(err); }

  // 5. Read that one back too.
  try { out.step5_fetch_after_cond = snap(await table.fetchItem({ keys: item(kB, ''), consistent_read: true })); }
  catch (err) { out.step5_fetch_error = describe(err); }

  return out;
}

/**
 * INDEPENDENT AUDIT with a POSITIVE CONTROL.
 *
 * The corrected race reported 200/200 exactly-one-winner and then found zero
 * rows. That is either an enormous finding -- NoSQL returning `status: Success`
 * for a write it did not keep -- or my audit is broken for the third time on
 * this route. Those must be told apart before either is written down.
 *
 * So this reads, in one pass and reporting RAW responses with no unwrapping
 * helper in the way:
 *
 *   1. `control_keys` -- rows written by the bounded diagnostic minutes earlier
 *      and confirmed readable at the time. If THESE come back empty, the read
 *      path is broken and nothing can be concluded about the race.
 *   2. `sample_keys` -- rows the race said it created.
 *
 * A positive control is the whole point: without it, "no rows found" cannot be
 * distinguished from "cannot find rows".
 */
export async function auditRaw(
  app: ProbeApp, controlKeys: string[], sampleKeys: string[],
): Promise<Record<string, unknown>> {
  const table = app.nosql().table(CLAIM_PROBE_TABLE_ID);
  const read = async (key: string): Promise<Record<string, unknown>> => {
    try {
      const res = await table.fetchItem({
        keys: { claim_key: { S: key } }, consistent_read: true,
      });
      return { key, raw: snap(res), holder_via_helper: extractHolder(res) };
    } catch (err) { return { key, error: describe(err) }; }
  };
  return {
    at: new Date().toISOString(),
    phase: 'audit',
    positive_control: await Promise.all(controlKeys.map(read)),
    race_samples: await Promise.all(sampleKeys.map(read)),
  };
}

/** Cache writes are chunked: a Cache value caps at 5 MB and 200 keys is small, but a truncated write would be silent. */
async function writeCache(app: ProbeApp, key: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value);
  await app.cache().segment(PRESENCE_SEGMENT).put(key, text.slice(0, 400_000), 24);
}

/**
 * Entry point.
 *
 * Always writes the schema. Races ONLY when the control key says GO -- so the
 * schema can be inspected by a human between the two runs, which is what 0037's
 * "first operation" instruction is for.
 */
export async function probe(app: ProbeApp, log: Logger): Promise<ProbeResult> {
  await writeCache(app, PROGRESS_KEY, { started: new Date().toISOString() });

  const schema = await readSchema(app);
  await writeCache(app, SCHEMA_KEY, schema);
  if (schema.error !== undefined || schema.sort_key_check?.safe !== true) {
    await writeCache(app, PROGRESS_KEY, { finished: new Date().toISOString(), raced: false });
    return schema;
  }

  let control = '';
  try {
    const raw = await app.cache().segment(PRESENCE_SEGMENT).getValue(CONTROL_KEY);
    control = typeof raw === 'string' ? raw.trim() : '';
  } catch { control = ''; }

  // "AUDIT:<control_key>,<control_key>|<race_prefix>" -- keys are passed in
  // rather than recomputed, so the audit cannot accidentally look at a
  // different run than the one being questioned.
  if (control.startsWith('AUDIT:')) {
    const [controls = '', prefix = ''] = control.slice('AUDIT:'.length).split('|');
    const controlKeys = controls.split(',').filter((s) => s !== '');
    const sampleKeys = [0, 1, 2, 3, 4].map((i) => `${prefix}_${i}`);
    const a = await auditRaw(app, controlKeys, sampleKeys);
    await writeCache(app, RESULT_KEY, a);
    await writeCache(app, PROGRESS_KEY, { finished: new Date().toISOString(), phase: 'audit' });
    return { ...schema, phase: 'audit', reason: 'audit written to the result key' };
  }

  if (control === 'DIAG') {
    const d = await diagnose(app);
    await writeCache(app, RESULT_KEY, d);
    await writeCache(app, PROGRESS_KEY, { finished: new Date().toISOString(), phase: 'diagnose' });
    return { ...schema, phase: 'diagnose', reason: 'diagnostic written to the result key' };
  }

  if (control !== 'GO') {
    const held: ProbeResult = {
      ...schema, raced: false,
      reason: `control key is ${JSON.stringify(control)}; set it to "GO" to race`,
    };
    await writeCache(app, PROGRESS_KEY, { finished: new Date().toISOString(), raced: false });
    return held;
  }

  const result = await race(app, 200, 60_000, log);
  await writeCache(app, RESULT_KEY, result);
  await writeCache(app, PROGRESS_KEY, {
    finished: new Date().toISOString(),
    raced: result.raced, rounds_completed: result.rounds_completed,
  });
  return result;
}
