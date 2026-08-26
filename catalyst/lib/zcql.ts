// ZCQL statement building and result unwrapping.
//
// Two things here are load-bearing and easy to get wrong.
//
// INJECTION. The Data Store API takes a query STRING. There is no parameter
// binding, so every value is interpolated, and project_id / task_id / cursor
// values arrive from HTTP requests. `zqStr` is therefore not a convenience --
// it is the only thing between a request body and the ledger. Identifiers are
// validated against an allowlist rather than escaped, because an identifier can
// never legitimately need escaping.
//
// THE 300-ROW CAP. ZCQL returns at most 300 rows and 20 columns. `readEvents`
// makes 300 the explicit default, and anything dropped is reported to the
// caller as has_more rather than silently lost (mandatory behaviour 9).
//
// Result shape: rows come back wrapped in the table name --
//   [{ "events": { "seq": 1, ... } }, ...]
// -- verified in the probe. Unwrapping is centralised so no call site forgets.

import { LIMITS } from '../../shared/store/types.ts';
import { StoreError } from '../../shared/store/errors.ts';

/** ZCQL hard caps. Not ours -- the platform's. */
export const ZCQL_ROW_CAP = 300;
export const ZCQL_COLUMN_CAP = 20;

/** Identifiers we will ever emit. Anything else is a bug, not a value to escape. */
const SAFE_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Control characters and DEL. Rejected in literals rather than escaped. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/**
 * Quote a string literal for ZCQL.
 *
 * Escapes the single-quote terminator by doubling, and rejects control
 * characters and backslashes outright rather than trying to be clever about
 * them. A value that needs a backslash in this system is a value that has
 * already gone wrong.
 */
export function zqStr(value: string): string {
  if (typeof value !== 'string') throw new StoreError(`expected a string literal, got ${typeof value}`);
  if (CONTROL_CHARS.test(value)) {
    throw new StoreError('string literal contains a control character');
  }
  if (value.includes('\\')) {
    throw new StoreError('string literal contains a backslash, which is not accepted here');
  }
  return `'${value.replace(/'/g, "''")}'`;
}

/** Emit an integer literal, refusing anything that is not one. */
export function zqInt(value: number): string {
  if (!Number.isInteger(value)) throw new StoreError(`expected an integer, got ${String(value)}`);
  return String(value);
}

/** Validate an identifier. Never escaped -- an identifier is ours or it is a bug. */
export function zqIdent(name: string): string {
  if (!SAFE_IDENTIFIER.test(name)) throw new StoreError(`unsafe ZCQL identifier: ${JSON.stringify(name)}`);
  return name;
}

export interface CappedLimit {
  /** What will actually be requested. Never above 300. */
  applied: number;
  /** What the caller asked for. */
  requested: number;
  /** True when the caller asked for more than the platform allows. */
  capped: boolean;
}

/** Clamp a caller's limit to the platform cap. The caller is told, never surprised. */
export function capLimit(requested: number = LIMITS.events): CappedLimit {
  const applied = Math.max(1, Math.min(Math.floor(requested), ZCQL_ROW_CAP));
  return { applied, requested, capped: requested > ZCQL_ROW_CAP };
}

/**
 * Build the readEvents query.
 *
 * ORDER BY seq, NOT ROWID: ROWID is allocated from per-shard blocks and runs
 * backwards across inserts, so ordering by it silently skips events for any
 * reader holding a cursor. See store-interface.md mandatory behaviour 4.
 *
 * One row over the limit is requested so has_more is a fact rather than a guess.
 */
export function selectEvents(
  project_id: string, since_seq: number, limit: number = LIMITS.events,
): { query: string; cap: CappedLimit } {
  const cap = capLimit(limit);
  const probe = Math.min(cap.applied + 1, ZCQL_ROW_CAP + 1);
  const columns = ['seq', 'event_id', 'project_id', 'layer', 'kind', 'actor_type', 'actor_id', 'created_at', 'body'];
  const query =
    `SELECT ${columns.map(zqIdent).join(', ')} FROM events` +
    ` WHERE project_id = ${zqStr(project_id)} AND seq > ${zqInt(since_seq)}` +
    ` ORDER BY seq LIMIT 0, ${zqInt(probe)}`;
  return { query, cap };
}

/** `SELECT MAX(seq) FROM events` -- globally, no project filter. See order 0005. */
export function selectMaxSeq(): string {
  return 'SELECT MAX(seq) AS max_seq FROM events';
}

export function selectClaim(claim_key: string): string {
  return `SELECT claim_key, project_id, task_id, agent_id, claimed_at FROM task_claims` +
    ` WHERE claim_key = ${zqStr(claim_key)} LIMIT 0, 1`;
}

export function selectLocksForProject(project_id: string, limit: number = LIMITS.locks): string {
  const cap = capLimit(limit);
  return `SELECT lock_key, project_id, agent_id, task_id, globs, acquired_at FROM scope_locks` +
    ` WHERE project_id = ${zqStr(project_id)} ORDER BY acquired_at LIMIT 0, ${zqInt(cap.applied)}`;
}

/** Crash recovery: did the event for this request already land? */
export function selectEventByDedupeKey(dedupe_key: string): string {
  return `SELECT seq, event_id, dedupe_key FROM events` +
    ` WHERE dedupe_key = ${zqStr(dedupe_key)} LIMIT 0, 1`;
}

export function selectDedupe(dedupe_key: string): string {
  return `SELECT dedupe_key, idempotency_key, project_id, seq, event_id FROM request_dedupe` +
    ` WHERE dedupe_key = ${zqStr(dedupe_key)} LIMIT 0, 1`;
}

/**
 * Unwrap ZCQL's table-keyed rows.
 *
 * A row arrives as { "events": {...} }. A row that is missing the expected
 * table key is an error, not something to skip: silently dropping it would be
 * exactly the invisible data loss the ROWID bug would have caused.
 */
export function unwrapRows<T = Record<string, unknown>>(rows: unknown, table: string): T[] {
  if (!Array.isArray(rows)) throw new StoreError(`expected a ZCQL row array, got ${typeof rows}`);
  return rows.map((row, i) => {
    if (row === null || typeof row !== 'object') {
      throw new StoreError(`ZCQL row ${i} is not an object`);
    }
    const wrapped = (row as Record<string, unknown>)[table];
    if (wrapped === undefined) {
      const keys = Object.keys(row as Record<string, unknown>).join(', ');
      throw new StoreError(`ZCQL row ${i} is not keyed by '${table}' (found: ${keys || 'nothing'})`);
    }
    return wrapped as T;
  });
}

/** Read MAX(seq) out of its result set. An empty ledger is 0, not an error. */
export function readMaxSeq(rows: unknown): number {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const first = rows[0] as Record<string, unknown>;
  // Aggregate results are not always table-keyed, so accept either shape.
  const holder = (first.events && typeof first.events === 'object'
    ? first.events
    : first) as Record<string, unknown>;
  const raw = holder.max_seq ?? holder.MAX_SEQ ?? holder['MAX(seq)'];
  if (raw === null || raw === undefined) return 0;
  const n = typeof raw === 'number' ? raw : Number(String(raw));
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
    throw new StoreError(`MAX(seq) returned a non-integer: ${JSON.stringify(raw)}`);
  }
  return n;
}
