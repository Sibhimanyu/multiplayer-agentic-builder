// BOUNDED DIAGNOSTIC. Authorised by order 0031 section 3b, and by nothing else.
//
// Purpose: prove whether Stratus `putObject` works AT ALL from inside a deployed
// function. Nothing outside a function can reach that path — the MCP exposes no
// putObject, and both of its signature-based surfaces failed (order 0030 notes).
//
// SCOPE, deliberately narrow and enforced by the code rather than by intent:
//
//   - ONE key: `_diag/putobject-probe.json`. No parameter variation. If the write
//     fails, this reports the error verbatim and stops — it does not retry with
//     different options, because order 0031 says a fifth variation is where a
//     probe becomes a fishing trip.
//   - overwrite: true, per order 0030 (versioning is OFF, so a put over an
//     existing key fails without it).
//   - Writes, reads back, then DELETES. Leaves the bucket as it was found.
//   - Reports the full error OBJECT, never a matched message string (0017).
//
// This is NOT the snapshot Event function and must not become it. It exists to
// answer one question and should be deleted once G1 is settled.

import type { Logger } from '../../shared/log.ts';

/** The single key this probe is allowed to touch. */
export const DIAG_KEY = '_diag/putobject-probe.json';
export const DIAG_BUCKET = 'coordinationsnapshots';

interface StratusBucket {
  putObject(key: string, body: string, opts?: Record<string, unknown>): Promise<unknown>;
  getObject(key: string, opts?: Record<string, unknown>): Promise<unknown>;
  deleteObjects(objects: unknown[], ttl?: unknown): Promise<unknown>;
  headObject(key: string, opts?: Record<string, unknown>): Promise<unknown>;
  generatePreSignedUrl(
    key: string, urlAction: string, opts?: Record<string, unknown>,
  ): Promise<unknown>;
}
interface StratusApp {
  stratus(): { bucket(name: string): StratusBucket };
}

/**
 * Serialise an unknown throw for reporting.
 *
 * Every enumerable own property plus the standard Error fields, because the SDK
 * rejects with plain objects AND with CatalystError instances whose useful data
 * lives in getters. A `message` alone has repeatedly been empty or misleading.
 */
export function describeError(err: unknown): Record<string, unknown> {
  if (err === null || err === undefined) return { thrown: String(err) };
  if (typeof err !== 'object') return { thrown: String(err), type: typeof err };

  const e = err as Record<string, unknown> & { message?: unknown; stack?: unknown };
  const out: Record<string, unknown> = {
    constructor_name: err.constructor?.name ?? null,
    own_keys: Object.keys(e),
  };
  for (const k of Object.keys(e)) out[k] = e[k];
  // Getters do not appear in Object.keys, so read the known ones explicitly.
  for (const k of ['message', 'code', 'statusCode', 'value', 'errorInfo', 'name']) {
    const v = (e as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = v;
  }
  if (typeof e.stack === 'string') out.stack_first_line = e.stack.split('\n')[0];
  return out;
}

export interface DiagResult {
  step: 'put' | 'head' | 'get' | 'delete' | 'complete';
  ok: boolean;
  put?: unknown;
  head?: unknown;
  get_body?: string | null;
  delete?: unknown;
  timings_ms?: Record<string, number>;
  error?: Record<string, unknown>;
}

/**
 * Run the probe. Never throws: the caller is an HTTP route and the point is to
 * report what happened, including failure, rather than produce a 500.
 *
 * Stops at the first failing step. Deliberately: order 0031 forbids varying
 * parameters after a failure, and continuing past a failed write would report
 * downstream errors that are merely consequences of it.
 */
export async function runPutObjectProbe(app: StratusApp, log: Logger): Promise<DiagResult> {
  const bucket = app.stratus().bucket(DIAG_BUCKET);
  const timings_ms: Record<string, number> = {};
  const body = JSON.stringify({ probe: 'putobject', at: new Date().toISOString() });

  let put: unknown;
  try {
    const t0 = Date.now();
    put = await bucket.putObject(DIAG_KEY, body, { overwrite: true });
    timings_ms.put = Date.now() - t0;
    log.info('diag.put_ok', 'putObject succeeded', { key: DIAG_KEY, ms: timings_ms.put });
  } catch (err) {
    const error = describeError(err);
    log.error('diag.put_failed', 'putObject failed', { key: DIAG_KEY, error });
    return { step: 'put', ok: false, error, timings_ms };
  }

  let head: unknown;
  try {
    const t0 = Date.now();
    head = await bucket.headObject(DIAG_KEY);
    timings_ms.head = Date.now() - t0;
  } catch (err) {
    const error = describeError(err);
    log.error('diag.head_failed', 'headObject failed after a successful put', { error });
    return { step: 'head', ok: false, put, error, timings_ms };
  }

  let get_body: string | null = null;
  try {
    const t0 = Date.now();
    const got = await bucket.getObject(DIAG_KEY);
    timings_ms.get = Date.now() - t0;
    get_body = got === null || got === undefined ? null : String(got).slice(0, 200);
  } catch (err) {
    const error = describeError(err);
    log.error('diag.get_failed', 'getObject failed after a successful put', { error });
    return { step: 'get', ok: false, put, head, error, timings_ms };
  }

  // Always attempt the delete, even if something above was odd. Leaving litter
  // in a bucket the snapshot builder will use is worse than a noisy report.
  let deleted: unknown;
  try {
    const t0 = Date.now();
    deleted = await bucket.deleteObjects([{ key: DIAG_KEY }]);
    timings_ms.delete = Date.now() - t0;
  } catch (err) {
    const error = describeError(err);
    log.error('diag.delete_failed', 'could not delete the probe key; bucket has litter', { error });
    return { step: 'delete', ok: false, put, head, get_body, error, timings_ms };
  }

  return { step: 'complete', ok: true, put, head, get_body, delete: deleted, timings_ms };
}

// ---------------------------------------------------------------------------
// Order 0031 section 4: cold / warm / headers on the SNAPSHOT READ PATH.
//
// The interpretation is PRE-REGISTERED in 0031 and must be honoured as written:
//   warm << cold WITH a cache header -> the cacheable read is real; name the host.
//   warm ~= cold with NO cache header -> C1's read is a plain origin object GET,
//                                        and C1's advantage over C2 was never
//                                        established.
//
// Measured through a PRE-SIGNED URL fetched over plain HTTP, because that is the
// actual client read path: the bucket is Authenticated, not Public, so a browser
// or CLI reads snapshot.json via a signed URL. Measuring the SDK's getObject
// instead would time a function-to-Stratus hop inside one DC and label it as the
// client read -- the same class of error as inheriting GitHub's 34 ms.
// ---------------------------------------------------------------------------

export interface ReadMeasurement {
  ok: boolean;
  signed_url_host?: string;
  cold_ms?: number;
  warm_ms?: number;
  cold_status?: number;
  warm_status?: number;
  cold_headers?: Record<string, string>;
  warm_headers?: Record<string, string>;
  error?: Record<string, unknown>;
}

const CACHE_HEADER_NAMES = [
  'age', 'x-cache', 'cf-cache-status', 'x-cache-hit', 'x-served-by',
  'cache-control', 'etag', 'last-modified', 'via', 'x-amz-cf-pop',
];

function headersOf(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => { out[k] = v; });
  return out;
}

/** Cache-indicating headers only, for the pre-registered decision. */
export function cacheSignals(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of CACHE_HEADER_NAMES) {
    if (h[name] !== undefined) out[name] = h[name];
  }
  return out;
}

/**
 * Write a key, measure a cold and an immediately-repeated warm read of it
 * through a pre-signed URL, then delete it.
 *
 * Two GETs only. No retries, no warm-up laps, no best-of-N: order 0031 forbids
 * retrying into a better number, and a "best" figure would be exactly that.
 */
export async function measureSnapshotRead(app: StratusApp, log: Logger): Promise<ReadMeasurement> {
  const bucket = app.stratus().bucket(DIAG_BUCKET);
  const body = JSON.stringify({ probe: 'read-path', at: new Date().toISOString() });

  try {
    await bucket.putObject(DIAG_KEY, body, { overwrite: true });
  } catch (err) {
    return { ok: false, error: describeError(err) };
  }

  let url: string;
  try {
    const signed = await bucket.generatePreSignedUrl(DIAG_KEY, 'GET', { expiryIn: 600 });
    const candidate = typeof signed === 'string'
      ? signed
      : (signed as { signature?: unknown; url?: unknown })?.signature
        ?? (signed as { url?: unknown })?.url;
    if (typeof candidate !== 'string' || candidate === '') {
      return {
        ok: false,
        error: { reason: 'generatePreSignedUrl returned no usable url', returned: signed },
      };
    }
    url = candidate;
  } catch (err) {
    await bucket.deleteObjects([{ key: DIAG_KEY }]).catch(() => undefined);
    return { ok: false, error: describeError(err) };
  }

  const out: ReadMeasurement = { ok: true };
  try {
    out.signed_url_host = new URL(url).host;
  } catch {
    out.signed_url_host = 'unparseable';
  }

  try {
    const t0 = Date.now();
    const cold = await fetch(url);
    await cold.arrayBuffer();
    out.cold_ms = Date.now() - t0;
    out.cold_status = cold.status;
    out.cold_headers = headersOf(cold.headers);

    const t1 = Date.now();
    const warm = await fetch(url);
    await warm.arrayBuffer();
    out.warm_ms = Date.now() - t1;
    out.warm_status = warm.status;
    out.warm_headers = headersOf(warm.headers);
  } catch (err) {
    out.ok = false;
    out.error = describeError(err);
  }

  try {
    await bucket.deleteObjects([{ key: DIAG_KEY }]);
  } catch (err) {
    log.error('diag.read_probe_delete_failed', 'probe key may remain in the bucket', {
      error: describeError(err),
    });
  }

  return out;
}
