// Shared HTTP plumbing for the Advanced I/O functions.
//
// Every handler is thin: parse, authorise, delegate to a tested module in
// catalyst/lib, map the result to a status. The interesting decisions live here
// because getting them wrong the same way six times is the usual outcome of
// copying a handler.
//
// THREE TRAPS THIS FILE EXISTS TO AVOID
//
// 1. Duplicate CORS headers. Catalyst injects its own Access-Control-Allow-Origin
//    on some paths. Setting it again produces two values in one header, which
//    every browser rejects with a message that names neither cause. So we SET
//    (never append) and only when it is absent.
// 2. agent_id from the client. Non-negotiable H4: agent_id is never accepted
//    from a request. It is resolved from the bearer token, server-side, on every
//    call. `requireAgent` is the only way a handler may learn who is calling.
// 3. A thrown error becoming a 500. StoreBusyError must be a 429 with a
//    Retry-After so the CLI backs off; StoreAuthError must be a 401 so the CLI
//    STOPS. A 500 for either makes the client do exactly the wrong thing.

import {
  StoreAuthError, StoreBusyError, StoreError, StoreOfflineError,
} from '../../shared/store/errors.ts';

export interface HttpRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  /** Parsed body. Never used by the webhook handler, which needs raw bytes. */
  body?: unknown;
  /** Exact request bytes. Populated for the webhook route only. */
  raw?: Buffer;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export function header(req: HttpRequest, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v;
}

/** Bearer token, or null. Never falls back to a query parameter -- tokens do not belong in URLs. */
export function bearerToken(req: HttpRequest): string | null {
  const auth = header(req, 'authorization');
  if (!auth) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(auth.trim());
  return m ? m[1] : null;
}

/**
 * Set CORS headers without ever duplicating one.
 *
 * Catalyst may already have set Access-Control-Allow-Origin. Two values in that
 * header is a hard browser failure, so an existing value is left alone.
 */
export function withCors(
  headers: Record<string, string>, origin: string, existing: Record<string, string> = {},
): Record<string, string> {
  const out = { ...headers };
  const already = Object.keys(existing).some((k) => k.toLowerCase() === 'access-control-allow-origin');
  if (!already) out['Access-Control-Allow-Origin'] = origin;
  out['Access-Control-Allow-Headers'] = 'Authorization, Content-Type, X-Idempotency-Key';
  out['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
  return out;
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse {
  return { status, headers: { 'Content-Type': 'application/json', ...headers }, body };
}

/**
 * Map a thrown error to a response.
 *
 * Named, never catch-all: each error type gets the status that makes the client
 * do the right thing. An unrecognised error is a 500 with a stable code, and it
 * is the ONLY thing that produces a 500 here.
 */
export function errorResponse(err: unknown): HttpResponse {
  if (err instanceof StoreAuthError) {
    // 401, so the CLI stops rather than retrying a token that will never work.
    return json(401, { error: 'unauthorized', code: 'STORE_AUTH', message: err.message });
  }
  if (err instanceof StoreBusyError) {
    const retry_after_ms = err.retry_after_ms ?? 1_000;
    return json(429,
      { error: 'busy', code: 'STORE_BUSY', message: err.message, retry_after_ms },
      { 'Retry-After': String(Math.ceil(retry_after_ms / 1000)) });
  }
  if (err instanceof StoreOfflineError) {
    // 503: the CLI queues to its outbox and keeps working.
    return json(503, { error: 'unavailable', code: 'STORE_OFFLINE', message: err.message });
  }
  if (err instanceof StoreError) {
    return json(400, { error: 'bad_request', code: 'STORE_ERROR', message: err.message });
  }
  return json(500, {
    error: 'internal',
    code: 'UNEXPECTED',
    message: err instanceof Error ? err.message : String(err),
  });
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

/** Read a required string field from a JSON body, rejecting anything else. */
export function requireString(body: unknown, field: string, max = 255): string {
  if (body === null || typeof body !== 'object') {
    throw new HttpError(400, 'BAD_BODY', 'request body must be a JSON object');
  }
  const value = (body as Record<string, unknown>)[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError(400, 'BAD_FIELD', `${field} is required and must be a non-empty string`);
  }
  if (value.length > max) {
    throw new HttpError(400, 'BAD_FIELD', `${field} exceeds ${max} characters`);
  }
  return value;
}

export function optionalString(body: unknown, field: string, max = 255): string | null {
  if (body === null || typeof body !== 'object') return null;
  const value = (body as Record<string, unknown>)[field];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new HttpError(400, 'BAD_FIELD', `${field} must be a string when present`);
  }
  if (value.length > max) throw new HttpError(400, 'BAD_FIELD', `${field} exceeds ${max} characters`);
  return value;
}

/**
 * Fields a client may never set, because the server owns them. Sending one is a
 * forgery attempt, not a mistake to normalise away: H4 is verified by forging
 * an agent_id, so the forgery has to be REJECTED, not ignored.
 */
export const SERVER_OWNED_FIELDS = ['agent_id', 'actor_id', 'seq', 'event_id', 'created_at'] as const;

export function rejectServerOwnedFields(body: unknown): void {
  if (body === null || typeof body !== 'object') return;
  const present = SERVER_OWNED_FIELDS.filter((f) => f in (body as Record<string, unknown>));
  if (present.length > 0) {
    throw new HttpError(400, 'SERVER_OWNED_FIELD',
      `these fields are resolved server-side and must not be sent: ${present.join(', ')}`);
  }
}
