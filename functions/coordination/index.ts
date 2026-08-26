// The deployed Advanced I/O function. Six routes, one handler.
//
// This is the ONLY file that talks to the Catalyst SDK. Everything it delegates
// to -- handleAppend, handleClaim, handleEvents, handleWebhook -- was written and
// tested against a Data Store double first, so this file's job is narrow: turn a
// raw Node request into a port call, and turn SDK errors into the store error
// taxonomy.
//
// WHY A RAW HANDLER MATTERS. Advanced I/O hands you `(req, res)` --
// IncomingMessage and ServerResponse -- with no body parsing. That is exactly
// what the webhook needs: the raw bytes, before anything re-serialises them. A
// framework that parsed JSON for us would break D1 permanently and the failure
// would look like a misconfigured secret.

import type { IncomingMessage, ServerResponse } from 'node:http';

import { StoreError, StoreBusyError, StoreOfflineError } from '../../shared/store/errors.ts';
import { consoleLogger } from '../../shared/log.ts';
import type { Logger } from '../../shared/log.ts';
import { toDuplicateValueError } from '../../catalyst/lib/duplicate.ts';
import { fromCatalystDatetime, toCatalystDatetime } from '../../catalyst/lib/datetime.ts';
import {
  readMaxSeq, selectClaim, selectDedupe, selectEventByDedupeKey, selectLocksForProject,
  selectMaxSeq, unwrapRows,
} from '../../catalyst/lib/zcql.ts';
import { handleAppend } from '../append/index.ts';
import type { AppendPort } from '../append/index.ts';
import { handleClaim } from '../claim/index.ts';
import type { ClaimPort } from '../claim/index.ts';
import { handleEvents } from '../events/index.ts';
import { handleWebhook } from '../github-webhook/index.ts';
import type { WebhookPort } from '../github-webhook/index.ts';
import { handleAcquireScope, handleReleaseScope } from '../scope/index.ts';
import type { LockRecord, ScopePort } from '../scope/index.ts';
import { handleHeartbeat, handleListPresence, PRESENCE_SEGMENT } from '../presence/index.ts';
import { REAPER_STATUS_KEY } from '../reaper/index.ts';
import type { PresenceDeps, PresencePort } from '../presence/index.ts';
import { resolvePrincipal } from '../_lib/auth.ts';
import type { AuthPort } from '../_lib/auth.ts';
import { agentToken, errorResponse, header, json, withCors } from '../_lib/http.ts';
import type { HttpRequest, HttpResponse } from '../_lib/http.ts';
import { HttpError } from '../_lib/http.ts';

/** Table names, resolved by name rather than by the numeric table_id. */
const T = {
  events: 'events',
  request_dedupe: 'request_dedupe',
  task_claims: 'task_claims',
  agents: 'agents',
  roles: 'roles',
  github_links: 'github_links',
} as const;

/** Columns the platform types as `datetime`: they reject RFC3339 on input and
 * return a form RFC3339 parsers do not accept, so both directions are converted. */
const DATETIME_COLUMNS = new Set(['created_at', 'claimed_at', 'acquired_at']);

/**
 * Operation counters. G4 wants the exact number of backend operations a session
 * consumed, and a provider console reports them hours later in coarse buckets.
 * Counting them at the call site is the only way to attribute them to a request.
 */
export const ops = {
  selects: 0, inserts: 0, updates: 0, deletes: 0, cache_puts: 0, cache_gets: 0,
};

export function resetOps(): void {
  ops.selects = 0; ops.inserts = 0; ops.updates = 0;
  ops.deletes = 0; ops.cache_puts = 0; ops.cache_gets = 0;
}

interface Datastore {
  table(name: string): {
    insertRow(row: Record<string, unknown>): Promise<Record<string, unknown>>;
    deleteRow(rowId: string): Promise<unknown>;
  };
}
interface CacheSegment {
  put(key: string, value: string, expiryInHours?: number): Promise<unknown>;
  get(key: string): Promise<unknown>;
}
interface CatalystApp {
  datastore(): Datastore;
  zcql(): { executeZCQLQuery(query: string): Promise<unknown[]> };
  cache(): { segment(name?: string): CacheSegment };
}

/**
 * Turn an SDK rejection into the store taxonomy.
 *
 * DUPLICATE_VALUE is the load-bearing case: it arrives as a generic SDK error
 * carrying the platform payload, and the COLUMN inside it decides whether the
 * caller retries, reports a replay, or reports a lost claim. Losing that
 * distinction here would surface a replayed append as a fabricated claim loss.
 */
function mapSdkError(err: unknown): unknown {
  // The SDK rejects with a PLAIN OBJECT, not an Error subclass:
  //   {statusCode, code, message}
  const anyErr = err as {
    message?: string; code?: string; error_code?: string; data?: unknown; statusCode?: number;
  };

  // Handles both shapes: the REST payload and the SDK's reshaped reject.
  const dup = toDuplicateValueError(anyErr) ?? toDuplicateValueError(anyErr.data);
  if (dup) return dup;

  const status = anyErr.statusCode;
  if (status === 429) return new StoreBusyError('Catalyst returned 429', { backend_message: anyErr.message });
  if (status === 503 || status === 504) {
    return new StoreOfflineError('Catalyst is unavailable', { backend_message: anyErr.message });
  }
  // Named, not swallowed. An unrecognised backend failure keeps its message.
  return new StoreError('Catalyst Data Store call failed', { backend_message: anyErr.message });
}

/**
 * Encode every datetime column on the way in.
 *
 * A Data Store `datetime` column rejects RFC3339 -- the format the protocol
 * mandates -- with a 400. Doing the conversion here rather than at each call site
 * means a new write path cannot forget it.
 */
function encodeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = DATETIME_COLUMNS.has(k) && typeof v === 'string' ? toCatalystDatetime(v) : v;
  }
  return out;
}

async function insertRow(app: CatalystApp, table: string, row: Record<string, unknown>): Promise<void> {
  ops.inserts += 1;
  try {
    await app.datastore().table(table).insertRow(encodeRow(row));
  } catch (err) {
    throw mapSdkError(err);
  }
}

/**
 * Decode datetime columns on the way out, so callers above this file only ever
 * see RFC3339 as the protocol specifies. Applied to every read in one place:
 * doing it per call site is how a `claimed_at` escapes as "2026-08-26 12:32:20".
 */
function decodeRows(rows: unknown[]): unknown[] {
  return rows.map((wrapper) => {
    if (wrapper === null || typeof wrapper !== 'object') return wrapper;
    const out: Record<string, unknown> = {};
    for (const [table, row] of Object.entries(wrapper as Record<string, unknown>)) {
      if (row === null || typeof row !== 'object') { out[table] = row; continue; }
      const decoded: Record<string, unknown> = {};
      for (const [col, value] of Object.entries(row as Record<string, unknown>)) {
        decoded[col] = DATETIME_COLUMNS.has(col) && typeof value === 'string' && value.length > 0
          ? fromCatalystDatetime(value)
          : value;
      }
      out[table] = decoded;
    }
    return out;
  });
}

async function query(app: CatalystApp, zcql: string): Promise<unknown[]> {
  ops.selects += 1;
  try {
    return decodeRows(await app.zcql().executeZCQLQuery(zcql));
  } catch (err) {
    throw mapSdkError(err);
  }
}

// ---- ports ---------------------------------------------------------------

export function makeAppendPort(app: CatalystApp): AppendPort {
  return {
    maxSeq: async () => readMaxSeq(await query(app, selectMaxSeq())),
    insertDedupe: (row) => insertRow(app, T.request_dedupe, { ...row }),
    insertEvent: (row) => insertRow(app, T.events, row),
    findDedupe: async (dedupe_key) => {
      const rows = unwrapRows<Record<string, unknown>>(
        await query(app, selectDedupe(dedupe_key)), T.request_dedupe);
      if (rows.length === 0) return null;
      const r = rows[0];
      return {
        dedupe_key: String(r.dedupe_key), idempotency_key: String(r.idempotency_key),
        project_id: String(r.project_id), seq: Number(r.seq), event_id: String(r.event_id),
      };
    },
    findEventByDedupeKey: async (dedupe_key) => {
      const rows = unwrapRows<Record<string, unknown>>(
        await query(app, selectEventByDedupeKey(dedupe_key)), T.events);
      if (rows.length === 0) return null;
      return { seq: Number(rows[0].seq), event_id: String(rows[0].event_id) };
    },
  };
}

export function makeClaimPort(app: CatalystApp): ClaimPort {
  return {
    insertClaim: (row) => insertRow(app, T.task_claims, { ...row }),
    findClaim: async (claim_key) => {
      const rows = unwrapRows<Record<string, unknown>>(
        await query(app, selectClaim(claim_key)), T.task_claims);
      if (rows.length === 0) return null;
      return { agent_id: String(rows[0].agent_id), claimed_at: String(rows[0].claimed_at) };
    },
  };
}

export function makeAuthPort(app: CatalystApp): AuthPort {
  return {
    findAgentByTokenHash: async (token_hash) => {
      const rows = unwrapRows<Record<string, unknown>>(await query(app,
        `SELECT agent_id, project_id, member_id, role_slug, member_label, harness, token_hash, revoked` +
        ` FROM agents WHERE token_hash = '${token_hash.replace(/'/g, "''")}' LIMIT 0, 1`), T.agents);
      if (rows.length === 0) return null;
      const r = rows[0];
      return {
        agent_id: String(r.agent_id), project_id: String(r.project_id),
        member_id: String(r.member_id), role_slug: String(r.role_slug),
        member_label: String(r.member_label), harness: String(r.harness),
        token_hash: String(r.token_hash),
        revoked: r.revoked, // deliberately raw: readBool decides, not a cast
      };
    },
    findRole: async (project_id, role_slug) => {
      const key = `${project_id}:${role_slug}`.replace(/'/g, "''");
      const rows = unwrapRows<Record<string, unknown>>(await query(app,
        `SELECT role_key, project_id, role_slug, label, can_merge, prompt_path` +
        ` FROM roles WHERE role_key = '${key}' LIMIT 0, 1`), T.roles);
      if (rows.length === 0) return null;
      const r = rows[0];
      return {
        role_key: String(r.role_key), project_id: String(r.project_id),
        role_slug: String(r.role_slug), label: String(r.label),
        can_merge: r.can_merge, // raw, same reason
        prompt_path: r.prompt_path === null ? null : String(r.prompt_path),
      };
    },
  };
}

export function makeWebhookPort(app: CatalystApp, log: Logger): WebhookPort {
  const appendPort = makeAppendPort(app);
  return {
    findProjectForRepo: async (repo_full_name) => {
      const rows = unwrapRows<Record<string, unknown>>(await query(app,
        `SELECT repo_full_name, project_id FROM github_links` +
        ` WHERE repo_full_name = '${repo_full_name.replace(/'/g, "''")}' LIMIT 0, 1`), T.github_links);
      return rows.length === 0 ? null : { project_id: String(rows[0].project_id) };
    },
    // The secret lives in a Catalyst environment variable, never a column. Only
    // its hash is stored, so a Data Store dump yields nothing usable.
    secretFor: async () => process.env.GITHUB_WEBHOOK_SECRET ?? null,
    appendEvent: async (project_id, event, idempotency_key) => {
      const e = event as { kind: string; body: Record<string, unknown> };
      await handleAppend(appendPort,
        { agent_id: 'github', project_id, role_slug: 'github', member_id: 'github',
          member_label: 'GitHub', can_merge: false },
        { project_id, kind: e.kind, body: e.body }, idempotency_key,
        () => new Date().toISOString(), log);
    },
  };
}

export function makeScopePort(app: CatalystApp): ScopePort {
  return {
    listLocks: async (project_id) => {
      const rows = unwrapRows<Record<string, unknown>>(
        await query(app, selectLocksForProject(project_id)), 'scope_locks');
      return rows.map((r): LockRecord => ({
        lock_key: String(r.lock_key), agent_id: String(r.agent_id), task_id: String(r.task_id),
        globs: parseGlobs(r.globs), acquired_at: String(r.acquired_at),
      }));
    },
    insertLock: (row) => insertRow(app, 'scope_locks', { ...row }),
    deleteLock: async (lock_key) => {
      // No DELETE in ZCQL via this path, so rows go through the Data Store API.
      await deleteRowsWhere(app, 'scope_locks', 'lock_key', lock_key);
    },
    deleteLocksForAgent: async (project_id, agent_id) => {
      const rows = unwrapRows<Record<string, unknown>>(await query(app,
        `SELECT ROWID, lock_key FROM scope_locks WHERE project_id = '${project_id.replace(/'/g, "''")}'` +
        ` AND agent_id = '${agent_id.replace(/'/g, "''")}' ORDER BY acquired_at LIMIT 0, 200`), 'scope_locks');
      for (const r of rows) await deleteRowById(app, 'scope_locks', String(r.ROWID));
      return rows.length;
    },
  };
}

function parseGlobs(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== 'string' || raw === '') return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    // An unparseable glob list must NOT read as "locks nothing" -- that would
    // silently disable the very check this table exists for. Treat it as a lock
    // on everything, so it conflicts loudly instead of failing open.
    return ['**'];
  }
}

async function deleteRowById(app: CatalystApp, table: string, rowid: string): Promise<void> {
  ops.deletes += 1;
  try {
    await app.datastore().table(table).deleteRow(rowid);
  } catch (err) {
    throw mapSdkError(err);
  }
}

async function deleteRowsWhere(
  app: CatalystApp, table: string, column: string, value: string,
): Promise<void> {
  const rows = unwrapRows<Record<string, unknown>>(await query(app,
    `SELECT ROWID FROM ${table} WHERE ${column} = '${value.replace(/'/g, "''")}' LIMIT 0, 1`), table);
  for (const r of rows) await deleteRowById(app, table, String(r.ROWID));
}

export function makePresenceDeps(app: CatalystApp, log: Logger): PresenceDeps {
  const segment = app.cache().segment(PRESENCE_SEGMENT);
  const port: PresencePort = {
    // ALWAYS an explicit expiry. The SDK takes hours; a put without one resets
    // the TTL to 48 hours, which would keep a dead agent looking connected.
    put: async (key, value, ttl_ms) => {
      ops.cache_puts += 1;
      await segment.put(key, value, Math.max(1, Math.round(ttl_ms / 3_600_000)));
    },
    get: async (key) => {
      ops.cache_gets += 1;
      const v = await segment.get(key);
      return normaliseCacheValue(v);
    },
    getMany: async (keys) => {
      const out = new Map<string, string | null>();
      for (const k of keys) {
        ops.cache_gets += 1;
        out.set(k, normaliseCacheValue(await segment.get(k)));
      }
      return out;
    },
  };
  return {
    port, log,
    now_ms: () => Date.now(),
    listAgentIds: async (project_id) => {
      const rows = unwrapRows<Record<string, unknown>>(await query(app,
        `SELECT agent_id FROM agents WHERE project_id = '${project_id.replace(/'/g, "''")}'` +
        ` LIMIT 0, 100`), 'agents');
      return rows.map((r) => String(r.agent_id));
    },
  };
}

/** Cache returns assorted shapes, and delete() leaves a null value behind. */
function normaliseCacheValue(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v === '' ? null : v;
  if (typeof v === 'object') {
    const holder = v as { cache_value?: unknown; value?: unknown };
    const inner = holder.cache_value ?? holder.value;
    if (inner === null || inner === undefined) return null;
    return typeof inner === 'string' ? inner : JSON.stringify(inner);
  }
  return String(v);
}

// ---- routing -------------------------------------------------------------

async function route(app: CatalystApp, req: HttpRequest, log: Logger): Promise<HttpResponse> {
  // req.path is the raw request target, query string included. Matching against
  // it whole made /events?since_seq=0 a 404 while /events worked.
  const [rawPath = '/'] = req.path.split('?');
  const path = rawPath.replace(/\/+$/, '') || '/';

  // The webhook is deliberately first and deliberately outside auth: it carries a
  // GitHub HMAC, not a bearer token, and it must see the RAW body.
  if (path === '/github/webhook') {
    if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });
    return handleWebhook(makeWebhookPort(app, log), req, log);
  }

  if (path === '/health') {
    // Also surfaces the reaper's last pass, because a job function's console
    // output is not retrievable and its failures report no message.
    let reaper: unknown = null;
    try {
      const raw = await app.cache().segment(PRESENCE_SEGMENT).get(REAPER_STATUS_KEY);
      const text = normaliseCacheValue(raw);
      reaper = text === null ? null : JSON.parse(text);
    } catch {
      reaper = { error: 'could not read the reaper status key' };
    }
    return json(200, { ok: true, ops: { ...ops }, reaper });
  }

  // Everything below resolves token -> agent -> project -> role, every request.
  const principal = await resolvePrincipal(makeAuthPort(app), agentToken(req));

  if (path === '/claim' && req.method === 'POST') {
    return handleClaim(makeClaimPort(app), principal, req.body, () => new Date().toISOString());
  }

  if (path === '/append' && req.method === 'POST') {
    const key = header(req, 'x-idempotency-key');
    if (!key) throw new HttpError(400, 'MISSING_IDEMPOTENCY_KEY', 'X-Idempotency-Key is required');
    return handleAppend(makeAppendPort(app), principal, req.body, key,
      () => new Date().toISOString(), log);
  }

  if (path === '/scope' && req.method === 'POST') {
    return handleAcquireScope(makeScopePort(app), principal, req.body,
      () => new Date().toISOString(), log);
  }

  if (path === '/scope/release' && req.method === 'POST') {
    return handleReleaseScope(makeScopePort(app), principal, req.body, log);
  }

  if (path === '/heartbeat' && req.method === 'POST') {
    return handleHeartbeat(makePresenceDeps(app, log), principal, req.body);
  }

  if (path === '/presence' && req.method === 'GET') {
    const url = new URL(req.path, 'http://local');
    return handleListPresence(makePresenceDeps(app, log), principal,
      url.searchParams.get('project_id') ?? principal.project_id);
  }

  if (path === '/events' && req.method === 'GET') {
    const url = new URL(req.path, 'http://local');
    const since = Number(url.searchParams.get('since_seq') ?? '0');
    const limitRaw = url.searchParams.get('limit');
    return handleEvents({ query: (q) => query(app, q) }, principal,
      {
        project_id: url.searchParams.get('project_id') ?? principal.project_id,
        since_seq: Number.isFinite(since) ? since : 0,
        ...(limitRaw === null ? {} : { limit: Number(limitRaw) }),
      },
      url.searchParams.get('audience') === 'dashboard' ? 'dashboard' : 'agent', log);
  }

  return json(404, { error: 'not_found', path });
}

/** Read the raw request bytes. Never parsed before the webhook has verified them. */
function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function serve(
  app: CatalystApp, req: IncomingMessage, res: ServerResponse, log: Logger = consoleLogger,
): Promise<void> {
  const started = Date.now();
  const rawUrl = req.url ?? '/';
  let response: HttpResponse;

  try {
    const raw = await readRawBody(req);
    const request: HttpRequest = {
      method: req.method ?? 'GET',
      path: rawUrl,
      headers: req.headers as Record<string, string | string[] | undefined>,
      raw,
      // Parsed here for the JSON routes. The webhook ignores this and uses `raw`.
      body: raw.length > 0 ? safeJson(raw) : undefined,
    };
    response = await route(app, request, log);
  } catch (err) {
    if (err instanceof HttpError) {
      response = json(err.status, { error: err.code, message: err.message });
    } else {
      response = errorResponse(err);
    }
    // Every failure is logged with its name AND the backend's own message. The
    // client deliberately never sees backend_message -- it leaks schema detail --
    // but withholding it from the log too made a real 400 undiagnosable.
    log.warn('function.request_failed', 'request failed', {
      path: rawUrl, status: response.status,
      error: err instanceof Error ? err.name : typeof err,
      message: err instanceof Error ? err.message : String(err),
      backend_message: (err as { backend_message?: string })?.backend_message,
      column: (err as { column?: string })?.column,
    });
  }

  const headers = withCors(response.headers, '*', {});
  res.writeHead(response.status, headers);
  if (response.body !== null && response.body !== undefined) res.write(JSON.stringify(response.body));
  res.end();

  log.info('function.request', 'request served', {
    path: rawUrl, status: response.status, ms: Date.now() - started,
    selects: ops.selects, inserts: ops.inserts,
  });
}

function safeJson(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    // Not an error yet -- the webhook route does not need it, and a JSON route
    // will reject a missing field with a named 400.
    return undefined;
  }
}
