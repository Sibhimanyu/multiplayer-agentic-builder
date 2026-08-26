// Catalyst datetime codec.
//
// THE FINDING. A Data Store `datetime` column REJECTS RFC3339, which is the exact
// format the protocol mandates for `Event.created_at`:
//
//   "2026-08-26T12:30:00.000Z"  -> {"error_code":"INVALID_INPUT",
//                                   "message":"Invalid input value for claimed_at.
//                                              datetime value expected"}
//   "2026-08-26 12:30:00:000"   -> same rejection
//   "2026-08-26 12:30:00"       -> accepted
//
// So the platform accepts `YYYY-MM-DD HH:MM:SS` and nothing finer. Reads come
// back with milliseconds appended in a fourth colon-separated field
// ("2026-08-26 17:59:05:359"), which is not a format it will accept back.
//
// PRECISION LOSS, RECORDED RATHER THAN HIDDEN. Encoding drops milliseconds. That
// is cosmetic for ordering -- `seq` is the ordering authority, not the clock, and
// mandatory behaviour 4 is explicit that reordering is what matters. But it means
// a Catalyst ledger stores second-resolution `created_at` where a Firestore
// ledger stores milliseconds, and that is a visible difference between the two
// builds rather than an internal detail. Flagged to the coordinator.
//
// The failure is at least LOUD: a 400 at write time, naming the field. Unlike
// varchar clamping, nothing is silently mangled.

import { StoreError } from '../../shared/store/errors.ts';

/** `YYYY-MM-DD HH:MM:SS`, the only input form the platform accepts. */
const CATALYST_DATETIME = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/;

/** What reads return: the same, plus `:mmm`. Not accepted as input. */
const CATALYST_DATETIME_READ = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?::(\d{1,3}))?$/;

/**
 * RFC3339 -> Catalyst datetime, in UTC.
 *
 * UTC deliberately: the project carries a timezone (`Asia/Kolkata` here) and a
 * naive local-time string would shift every timestamp by the offset the moment
 * anything compared it against a server clock.
 */
export function toCatalystDatetime(rfc3339: string): string {
  const ms = Date.parse(rfc3339);
  if (Number.isNaN(ms)) throw new StoreError(`not a parseable timestamp: ${JSON.stringify(rfc3339)}`);
  const d = new Date(ms);
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/**
 * Catalyst datetime -> RFC3339, in UTC.
 *
 * Accepts the read form with milliseconds as well as the write form without, so
 * a value round-trips whichever way it arrived. An unparseable value throws
 * rather than becoming `Invalid Date` and silently sorting to the epoch.
 */
export function fromCatalystDatetime(value: string): string {
  const m = CATALYST_DATETIME_READ.exec(value.trim());
  if (!m) throw new StoreError(`not a Catalyst datetime: ${JSON.stringify(value)}`);
  const [, y, mo, d, h, mi, s, msRaw] = m;
  const ms = msRaw === undefined ? 0 : Number(msRaw.padEnd(3, '0'));
  const at = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms);
  return new Date(at).toISOString();
}

/** True when a string is in the form the platform will accept as input. */
export function isCatalystDatetime(value: string): boolean {
  return CATALYST_DATETIME.test(value);
}

/** Now, in the platform's input format. */
export function catalystNow(clockMs: number = Date.now()): string {
  return toCatalystDatetime(new Date(clockMs).toISOString());
}
