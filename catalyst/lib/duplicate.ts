// Catalyst DUPLICATE_VALUE, parsed.
//
// The probe (see docs/handoff/impl-catalyst-notes.md) established that a unique
// violation comes back as:
//
//   {"status":"failure","data":{
//      "message":"Duplicate value for task_id. Please give a different value",
//      "error_code":"DUPLICATE_VALUE"}}
//
// The column name is only in the prose. That matters more than it looks: three
// different unique columns collide for three different reasons, and treating
// them alike is a correctness bug, not a logging nicety.
//
//   seq             -> another append raced us. Retry with a higher candidate.
//   idempotency_key -> the caller replayed. Return the ORIGINAL seq, append nothing.
//   task_id         -> another agent won the claim. Return {ok:false, owner}.
//
// So the column is parsed once, here, and every caller branches on it explicitly.
// A catch-all that treated any DUPLICATE_VALUE as "someone else won" would answer
// a replayed append with a fabricated claim loss.

export const DUPLICATE_VALUE = 'DUPLICATE_VALUE';

/** Matches the verbatim message observed in the probe. */
const DUPLICATE_MESSAGE = /^Duplicate value for (\S+?)\.?\s/i;

export class DuplicateValueError extends Error {
  /** The unique column that collided, or null if the message did not name one. */
  readonly column: string | null;
  readonly backend_message: string;

  constructor(backend_message: string, column?: string | null) {
    super(`Catalyst DUPLICATE_VALUE: ${backend_message}`);
    this.name = 'DuplicateValueError';
    this.backend_message = backend_message;
    this.column = column === undefined ? parseDuplicateColumn(backend_message) : column;
  }
}

/**
 * Pull the column name out of a DUPLICATE_VALUE message.
 *
 * Returns null rather than guessing when the message does not match. A null
 * column must never be treated as "probably seq" -- callers rethrow instead, so
 * a Catalyst message format change surfaces as a loud unknown error rather than
 * a silently mis-routed retry.
 */
export function parseDuplicateColumn(message: string): string | null {
  const m = DUPLICATE_MESSAGE.exec(message.trim());
  return m ? m[1] : null;
}

/**
 * True when a Data Store error is a unique-constraint violation.
 *
 * TWO SHAPES, because the SDK reshapes the REST payload. The REST API returns
 *
 *   {"status":"failure","data":{"message":"Duplicate value for ...",
 *                               "error_code":"DUPLICATE_VALUE"}}
 *
 * but zcatalyst-sdk-node rejects with a PLAIN OBJECT that renames the field and
 * drops the wrapper (see its utils/api-request.js `rejectWithContext`):
 *
 *   {statusCode: 400, code: "DUPLICATE_VALUE", message: "Duplicate value for ..."}
 *
 * Code written against the documented REST shape therefore does not match what
 * the SDK throws. Found by deploying: the claim path returned a generic 400
 * instead of {ok:false, owner} because `error_code` was absent. Note the message
 * does NOT contain the literal string "DUPLICATE_VALUE" either, so matching on
 * the message is not a fallback.
 */
export function isDuplicateValue(payload: unknown): boolean {
  if (payload === null || typeof payload !== 'object') return false;
  const data = (payload as { data?: unknown }).data;
  const holder = (data !== null && typeof data === 'object' ? data : payload) as {
    error_code?: unknown; code?: unknown;
  };
  return holder.error_code === DUPLICATE_VALUE || holder.code === DUPLICATE_VALUE;
}

/**
 * Build a DuplicateValueError from a raw Data Store failure payload, or return
 * null when the payload is some other failure. Never throws -- the caller
 * decides what an unrecognised failure means.
 */
export function toDuplicateValueError(payload: unknown): DuplicateValueError | null {
  if (!isDuplicateValue(payload)) return null;
  const data = (payload as { data?: { message?: unknown } }).data;
  const message = typeof data?.message === 'string'
    ? data.message
    : String((payload as { message?: unknown }).message ?? 'duplicate value');
  return new DuplicateValueError(message);
}
