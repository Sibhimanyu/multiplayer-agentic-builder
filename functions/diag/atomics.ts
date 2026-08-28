// Order 0035 section 2: does Catalyst have ANY atomic primitive?
//
// `is_unique` on a Data Store column does not exclude under concurrent insert
// (entry 37: 169/200 tasks admitted more than one winner, 554 durable rows for
// 205 keys). That is one mechanism. This module tests the others the platform
// offers, so that "Catalyst cannot do atomic claim" is a measured statement
// rather than an inference from a single failure.
//
// THE RULE THIS OBEYS, from 0035:
//
//   A concurrency test that passes against a double proves nothing about the
//   platform. Atomicity is measured against the LIVE service, contended, with
//   durable state counted afterwards.
//
// So every function here talks to the real service. There are no fakes in this
// file and there must never be one: a double would enforce correctly and the
// test could not fail.
//
// SHAPE. Each `attempt*` function performs exactly ONE racer's attempt and
// reports whether the platform told that racer it won. The five-way race is
// driven from OUTSIDE, by catalyst/measure/atomics-contended.ts, as five
// concurrent HTTP requests -- deliberately identical in shape to the run that
// found the original bug, and deliberately NOT a Promise.all inside one function
// instance, where an SDK connection pool could serialise the attempts and make a
// non-atomic primitive look atomic.
//
// WHAT "won" MEANS, and why it is the whole measurement. The interesting failure
// is not "two rows exist" -- it is "the platform told two racers they won".
// A claim primitive is a promise made to a caller. So `won` is derived strictly
// from what the API returned to THIS attempt, never from a subsequent read.

import { describeError } from './index.ts';
import type { Logger } from '../../shared/log.ts';

/** The table the compare-and-set probe owns. Provisioned and dropped per run. */
export const CAS_TABLE = 'cas_probe';
/** The cache segment the presence design already uses. */
export const CAS_CACHE_SEGMENT = 'presence';
/** The bucket order 0030/0031 established as writable. */
export const CAS_BUCKET = 'coordinationsnapshots';
/** The sentinel a seeded, unclaimed cas_probe row carries. */
export const FREE = 'FREE';

interface CacheSegment {
  put(key: string, value: string, expiryInHours?: number): Promise<unknown>;
  getValue(key: string): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}
interface StratusBucketApi {
  putObject(key: string, body: string, opts?: Record<string, unknown>): Promise<unknown>;
  getObject(key: string, opts?: Record<string, unknown>): Promise<unknown>;
  deleteObjects(objects: unknown[], ttl?: unknown): Promise<unknown>;
}
export interface AtomicsApp {
  zcql(): { executeZCQLQuery(query: string): Promise<unknown[]> };
  cache(): { segment(name?: string): CacheSegment };
  stratus(): { bucket(name: string): StratusBucketApi };
  // Present on the SDK; absent or throwing if the service is not enabled for
  // this project or data centre. Typed loosely on purpose -- the point of the
  // inventory is to find out what is actually there.
  nosql?: () => { getAllTable(): Promise<unknown[]> };
  circuit?: () => unknown;
}

/** One racer's attempt at one key. */
export interface Attempt {
  /** Did the platform tell THIS caller it won? Never inferred from a later read. */
  won: boolean;
  /** Milliseconds for the primitive call alone -- no HTTP, no auth. */
  ms: number;
  /** Whatever the service returned, unshaped. */
  raw?: unknown;
  error?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Candidate 1: Data Store compare-and-set via a conditional ZCQL UPDATE.
//
// The cheapest possible adoption path -- same service, same table, no new
// dependency. A row is seeded holder='FREE'; each racer runs
//
//   UPDATE cas_probe SET holder = '<agent>' WHERE cas_key = '<k>' AND holder = 'FREE'
//
// and wins if the platform reports it changed a row. This is the classic
// conditional update, and it is the primitive that route C would adopt if it
// works.
//
// IT DEPENDS ENTIRELY ON ZCQL REPORTING AN AFFECTED-ROW COUNT. If UPDATE returns
// nothing a caller can distinguish, then no caller can be told whether it won,
// and the mechanism is unusable as a claim primitive regardless of whether the
// underlying write is atomic. That is a finding in its own right, so the raw
// response is always reported.
// ---------------------------------------------------------------------------

/**
 * Decide, from a raw ZCQL UPDATE response, whether this caller changed a row.
 *
 * Kept separate and exported so its behaviour is inspectable, and so the
 * interpretation is written down rather than buried in a truthiness check.
 * Returns null when the response carries no usable signal -- which is NOT the
 * same as losing, and must never be collapsed into `false`.
 */
export function updateAffectedRows(raw: unknown): number | null {
  if (Array.isArray(raw)) return raw.length;
  if (raw !== null && typeof raw === 'object') {
    const o = raw as Record<string, unknown>;
    for (const k of ['affected_rows', 'affectedRows', 'rows_affected', 'count']) {
      const v = o[k];
      if (typeof v === 'number') return v;
      if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
    }
  }
  return null;
}

export async function attemptDatastoreCas(
  app: AtomicsApp, key: string, holder: string,
): Promise<Attempt & { affected: number | null }> {
  // Values are probe-generated and matched against a strict pattern by the
  // route before reaching here, so there is no user-controlled text in the SQL.
  const sql = `UPDATE ${CAS_TABLE} SET holder = '${holder}' `
    + `WHERE cas_key = '${key}' AND holder = '${FREE}'`;
  const t0 = Date.now();
  try {
    const raw = await app.zcql().executeZCQLQuery(sql);
    const affected = updateAffectedRows(raw);
    return { won: affected === 1, affected, ms: Date.now() - t0, raw };
  } catch (err) {
    return { won: false, affected: null, ms: Date.now() - t0, error: describeError(err) };
  }
}

/** Seed n unclaimed rows. One statement per row: ZCQL has no multi-row INSERT. */
export async function seedCasRows(
  app: AtomicsApp, keys: string[],
): Promise<{ seeded: number; errors: Record<string, unknown>[] }> {
  const errors: Record<string, unknown>[] = [];
  let seeded = 0;
  for (const key of keys) {
    try {
      await app.zcql().executeZCQLQuery(
        `INSERT INTO ${CAS_TABLE} (cas_key, holder) VALUES ('${key}', '${FREE}')`,
      );
      seeded += 1;
    } catch (err) {
      errors.push(describeError(err));
    }
  }
  return { seeded, errors };
}

// ---------------------------------------------------------------------------
// Candidate 2: Cache put-if-absent.
//
// A SETNX equivalent would be a claim primitive outright. The SDK segment
// surface is put / update / getValue / get / delete -- there is no named
// put-if-absent, but `put` and `update` being separate calls raises the question
// of whether `put` REFUSES an existing key. That is what the inventory checks.
// ---------------------------------------------------------------------------

export async function attemptCachePut(
  app: AtomicsApp, key: string, holder: string,
): Promise<Attempt> {
  const t0 = Date.now();
  try {
    const raw = await app.cache().segment(CAS_CACHE_SEGMENT).put(key, holder, 1);
    // A `put` that returns instead of throwing is the platform saying it stored
    // the value. Whether that means "created" or "overwrote" is exactly what the
    // sequential inventory settles before this is ever run contended.
    return { won: true, ms: Date.now() - t0, raw };
  } catch (err) {
    return { won: false, ms: Date.now() - t0, error: describeError(err) };
  }
}

// ---------------------------------------------------------------------------
// Candidate 3: Stratus conditional put.
//
// `putObject(key, body, { overwrite: false })` -- the SDK documents `overwrite`
// as "Whether to overwrite an existing object", and order 0030 established that
// a put over an existing key fails WITHOUT it while versioning is off. That is a
// put-if-absent in all but name, and the bucket is already provisioned and
// writable (order 0031), so it needs no new service.
// ---------------------------------------------------------------------------

export async function attemptStratusPutIfAbsent(
  app: AtomicsApp, key: string, holder: string,
): Promise<Attempt> {
  const t0 = Date.now();
  try {
    const raw = await app.stratus().bucket(CAS_BUCKET)
      .putObject(key, holder, { overwrite: false });
    return { won: true, ms: Date.now() - t0, raw };
  } catch (err) {
    return { won: false, ms: Date.now() - t0, error: describeError(err) };
  }
}

/**
 * Read back what Stratus actually stores for a key.
 *
 * "Exactly one winner" is necessary but not sufficient: a service could hand out
 * exactly one success and still let a rejected racer's bytes land. 0035 requires
 * durable state to be counted, so the winner's claim gets checked against the
 * object.
 */
export async function readbackStratus(
  app: AtomicsApp, key: string,
): Promise<{ stored: string | null; error?: Record<string, unknown> }> {
  try {
    const got = await app.stratus().bucket(CAS_BUCKET).getObject(key);
    if (got === null || got === undefined) return { stored: null };
    // getObject does NOT hand back a Buffer. It returns a wrapper, and String()
    // on it yields the literal text "[object Object]" -- which is exactly what
    // the first reconciliation run reported for all 48 keys, making it look like
    // the platform had stored the wrong value when in fact this line was wrong.
    // That run is void; the reconciliation was redone against Stratus's own
    // content MD5 instead. Unwrap explicitly rather than trusting String().
    if (Buffer.isBuffer(got)) return { stored: got.toString('utf8').slice(0, 64) };
    if (typeof got === 'string') return { stored: got.slice(0, 64) };
    const o = got as Record<string, unknown>;
    for (const k of ['content', 'body', 'data', 'object', 'value']) {
      const v = o[k];
      if (Buffer.isBuffer(v)) return { stored: v.toString('utf8').slice(0, 64) };
      if (typeof v === 'string') return { stored: v.slice(0, 64) };
    }
    // Report the shape rather than a stringified placeholder, so a future
    // failure here is legible instead of looking like a data mismatch.
    return { stored: null, error: { unwrap_failed: true, own_keys: Object.keys(o) } };
  } catch (err) {
    return { stored: null, error: describeError(err) };
  }
}

// ---------------------------------------------------------------------------
// INVENTORY. Sequential capability discovery, run once before any contended
// spend.
//
// The asymmetry that makes this sound, stated explicitly because getting it
// backwards is what produced entry 37:
//
//   Sequential REJECTION proves nothing about concurrency -- that was the
//   original mistake, and it cost the route its foundation.
//
//   Sequential ACCEPTANCE, however, is decisive in the negative direction: a
//   mechanism that happily overwrites an existing key when there is no
//   contention at all cannot possibly exclude a racer under contention. There
//   is nothing left for concurrency to break.
//
// So this eliminates candidates cheaply, and promotes survivors to a contended
// run. It never promotes a candidate to "works" on its own evidence.
// ---------------------------------------------------------------------------

export interface InventoryResult {
  at: string;
  cache_put_if_absent: {
    second_put_threw: boolean;
    value_after: unknown;
    verdict: string;
    first?: unknown; second?: unknown; error?: Record<string, unknown>;
  };
  stratus_put_if_absent: {
    second_put_threw: boolean;
    body_after: unknown;
    verdict: string;
    first?: unknown; second?: unknown; error?: Record<string, unknown>;
  };
  zcql_update_signal: {
    matching_raw?: unknown; matching_affected: number | null;
    non_matching_raw?: unknown; non_matching_affected: number | null;
    verdict: string;
    error?: Record<string, unknown>;
  };
  nosql: { available: boolean; tables?: unknown; error?: Record<string, unknown> };
  circuit: { present_on_sdk: boolean; note: string };
}

export async function runInventory(app: AtomicsApp, log: Logger): Promise<InventoryResult> {
  const stamp = Date.now().toString(36);
  const out: Partial<InventoryResult> = { at: new Date().toISOString() };

  // --- Cache: does put() refuse a key that already exists? ---
  {
    const key = `_inv_cache_${stamp}`;
    const seg = app.cache().segment(CAS_CACHE_SEGMENT);
    try {
      const first = await seg.put(key, 'FIRST', 1);
      let second: unknown;
      let threw = false;
      try {
        second = await seg.put(key, 'SECOND', 1);
      } catch (err) {
        threw = true;
        second = describeError(err);
      }
      const value_after = await seg.getValue(key);
      await seg.delete(key).catch(() => undefined);
      out.cache_put_if_absent = {
        second_put_threw: threw, value_after, first, second,
        verdict: threw
          ? 'put REFUSED an existing key -- promote to a contended run'
          : 'put OVERWROTE an existing key with no contention at all; '
            + 'it cannot exclude a racer under contention. ELIMINATED, no contended run needed.',
      };
    } catch (err) {
      out.cache_put_if_absent = {
        second_put_threw: false, value_after: null, verdict: 'inconclusive: the FIRST put failed',
        error: describeError(err),
      };
    }
  }

  // --- Stratus: does putObject({overwrite:false}) refuse an existing key? ---
  {
    const key = `_diag/inv-${stamp}.txt`;
    const bucket = app.stratus().bucket(CAS_BUCKET);
    try {
      const first = await bucket.putObject(key, 'FIRST', { overwrite: false });
      let second: unknown;
      let threw = false;
      try {
        second = await bucket.putObject(key, 'SECOND', { overwrite: false });
      } catch (err) {
        threw = true;
        second = describeError(err);
      }
      let body_after: unknown = null;
      try {
        const got = await bucket.getObject(key);
        body_after = got === null || got === undefined ? null : String(got).slice(0, 64);
      } catch (err) {
        body_after = describeError(err);
      }
      await bucket.deleteObjects([{ key }]).catch(() => undefined);
      out.stratus_put_if_absent = {
        second_put_threw: threw, body_after, first, second,
        verdict: threw
          ? 'putObject REFUSED an existing key -- promote to a contended run'
          : 'putObject OVERWROTE an existing key with overwrite:false and no contention; '
            + 'ELIMINATED, no contended run needed.',
      };
    } catch (err) {
      out.stratus_put_if_absent = {
        second_put_threw: false, body_after: null, verdict: 'inconclusive: the FIRST put failed',
        error: describeError(err),
      };
    }
  }

  // --- ZCQL: does UPDATE report an affected-row count at all? ---
  //
  // Two statements on the seeded probe table: one whose WHERE matches a row, one
  // whose WHERE matches nothing. If the two responses are indistinguishable then
  // no caller can be told whether it won, and compare-and-set is unusable here
  // however the write itself behaves.
  {
    const key = `_inv_cas_${stamp}`;
    try {
      await app.zcql().executeZCQLQuery(
        `INSERT INTO ${CAS_TABLE} (cas_key, holder) VALUES ('${key}', '${FREE}')`,
      );
      const matching_raw = await app.zcql().executeZCQLQuery(
        `UPDATE ${CAS_TABLE} SET holder = 'WINNER' WHERE cas_key = '${key}' AND holder = '${FREE}'`,
      );
      const non_matching_raw = await app.zcql().executeZCQLQuery(
        `UPDATE ${CAS_TABLE} SET holder = 'LOSER' WHERE cas_key = '${key}' AND holder = '${FREE}'`,
      );
      await app.zcql().executeZCQLQuery(
        `DELETE FROM ${CAS_TABLE} WHERE cas_key = '${key}'`,
      ).catch(() => undefined);

      const m = updateAffectedRows(matching_raw);
      const n = updateAffectedRows(non_matching_raw);
      out.zcql_update_signal = {
        matching_raw, matching_affected: m, non_matching_raw, non_matching_affected: n,
        verdict: m === null || n === null
          ? 'no affected-row signal could be extracted from at least one response'
          : m === n
            ? `matching and non-matching UPDATEs are INDISTINGUISHABLE (both ${m}); `
              + 'no caller can be told whether it won. Compare-and-set unusable.'
            : `distinguishable: matching=${m}, non-matching=${n} -- promote to a contended run`,
      };
    } catch (err) {
      out.zcql_update_signal = {
        matching_affected: null, non_matching_affected: null,
        verdict: 'inconclusive: the probe statements failed',
        error: describeError(err),
      };
    }
  }

  // --- NoSQL: is the service reachable, and does a table exist to test on? ---
  //
  // NoSQL is the strongest candidate on paper: INoSQLInsertItem carries an
  // optional `condition`, and a negated `attribute_exists` is a conditional put.
  // But nothing in the SDK creates a table, and none of the 186 MCP tools
  // mentions NoSQL, so a table can only come from the console.
  {
    if (typeof app.nosql !== 'function') {
      out.nosql = { available: false, error: { reason: 'app.nosql is not a function on this SDK build' } };
    } else {
      try {
        const tables = await app.nosql().getAllTable();
        out.nosql = { available: true, tables };
      } catch (err) {
        out.nosql = { available: false, error: describeError(err) };
      }
    }
  }

  out.circuit = {
    present_on_sdk: typeof app.circuit === 'function',
    note: 'Circuits is documented as unavailable in the EU, AU, IN, JP, SA and CA '
      + 'data centres. This project is in the IN data centre.',
  };

  log.info('diag.inventory', 'atomic primitive inventory complete', {});
  return out as InventoryResult;
}
