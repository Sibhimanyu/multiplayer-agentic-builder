// CoordinationStore over the deployed Catalyst function. Build order step 7.
//
// Ten operations, eight of them working against the real backend. `readSnapshot`
// and `subscribe` are STUBBED and throw a named error -- see NotProvisionedError
// below. They are not faked, not approximated, and not quietly served from the
// ledger, because the snapshot read path is the one thing route C1 exists to
// measure and a substitute would produce a number that looks like evidence.
//
// WIRE DETAILS THAT ARE NOT OBVIOUS, each learned by deploying:
//
//  - The token goes in X-AGENT-TOKEN. `Authorization` is reserved by the API
//    Gateway, which validates any value it finds there as a Zoho OAuth token
//    BEFORE the function is invoked. Ruled canonical for all routes in 0017.
//  - A claim loss, a scope conflict and a duplicate append are all HTTP 200.
//    They are normal outcomes, and returning 4xx would make the CLI treat them
//    as failures and retry them.
//  - 401 must NOT be retried, 429 must be, 503 means queue to the outbox. The
//    status code is the whole contract with the retry policy.

import type {
  AgentId, AgentPresence, AgentStatus, AppendResult, ClaimResult, CoordinationStore,
  Event, EventInput, Freshness, ProjectId, ScopeLock, ScopeResult, Seq, Snapshot,
  SnapshotRead, TaskId,
} from '../../shared/store/types.ts';
import { LIMITS } from '../../shared/store/types.ts';
import {
  StoreAuthError, StoreBusyError, StoreError, StoreOfflineError,
} from '../../shared/store/errors.ts';
import type { Logger } from '../../shared/log.ts';
import { nullLogger } from '../../shared/log.ts';

/**
 * Thrown by the operations that need a Stratus bucket.
 *
 * A distinct type rather than a generic StoreError so a caller -- and the
 * conformance suite -- can tell "this platform capability has not been
 * provisioned" apart from "this call failed". Silently returning an empty
 * snapshot would let A10, A11 and A13 pass against nothing.
 */
export class NotProvisionedError extends StoreError {
  readonly capability: string;
  constructor(capability: string, detail: string) {
    super(`${capability} is not provisioned: ${detail}`);
    this.name = 'NotProvisionedError';
    this.capability = capability;
  }
}

const STRATUS_GATE =
  'Stratus requires an interactive console session before its first API use. ' +
  'Create_Bucket returns OPERATION_NOT_ALLOWED ("User needs to be in session when ' +
  'accessing Stratus for the first time") while Get_All_Buckets succeeds, so reads ' +
  'are permitted and only first-time creation is gated. No CLI path exists.';

export interface CatalystStoreOptions {
  /** Base function URL, no trailing slash. */
  base_url: string;
  /** Agent token. Sent as X-Agent-Token; Authorization is reserved. */
  token: string;
  log?: Logger;
  /** Injected for tests. Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Poll interval for subscribe, once a snapshot exists. */
  poll_ms?: number;
}

interface RequestOptions {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
}

export class CatalystStore implements CoordinationStore {
  /**
   * poll, not live. Read from `store.freshness` by the dashboard so it renders
   * "updated Ns ago" rather than a live dot -- the one place the two builds are
   * required to differ visibly and honestly.
   */
  readonly freshness: Freshness;

  #base: string;
  #token: string;
  #log: Logger;
  #fetch: typeof globalThis.fetch;

  constructor(opts: CatalystStoreOptions) {
    this.#base = opts.base_url.replace(/\/+$/, '');
    this.#token = opts.token;
    this.#log = opts.log ?? nullLogger;
    this.#fetch = opts.fetch ?? globalThis.fetch;
    this.freshness = { mode: 'poll', stale_ms: opts.poll_ms ?? 5_000 };
  }

  // ---- transport ---------------------------------------------------------

  async #call<T>(opts: RequestOptions): Promise<T> {
    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}${opts.path}`, {
        method: opts.method,
        headers: {
          // NOT Authorization. See the header note at the top of this file.
          'X-Agent-Token': this.#token,
          ...(opts.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...opts.headers,
        },
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      });
    } catch (err) {
      // A transport failure is offline, not a bad request: the caller should
      // queue to its outbox and keep working rather than discard the write.
      throw new StoreOfflineError('could not reach the coordination function', {
        backend_message: err instanceof Error ? err.message : String(err),
      });
    }

    const text = await res.text();
    const payload = parseJson(text);

    if (res.ok) return payload as T;

    const message = messageOf(payload) ?? `HTTP ${res.status}`;

    // The status code IS the contract with the retry policy. Each of these makes
    // the caller do something different, and getting one wrong is worse than
    // failing: a retried 401 burns quota forever, an un-retried 429 drops a write.
    if (res.status === 401 || res.status === 403) {
      throw new StoreAuthError(message, { backend_message: text });
    }
    if (res.status === 429) {
      const retry_after_ms = retryAfterMs(res, payload);
      throw new StoreBusyError(message, { backend_message: text, ...(retry_after_ms === undefined ? {} : { retry_after_ms }) });
    }
    if (res.status === 503 || res.status === 504 || res.status >= 500) {
      throw new StoreOfflineError(message, { backend_message: text });
    }
    throw new StoreError(message, { backend_message: text });
  }

  // ---- ledger -----------------------------------------------------------

  async appendEvent(
    project_id: ProjectId, event: EventInput, idempotency_key: string,
  ): Promise<AppendResult> {
    if (!idempotency_key) throw new StoreError('idempotency_key is required');
    const out = await this.#call<{ event_id: string; seq: number; duplicate: boolean }>({
      method: 'POST',
      path: '/append',
      headers: { 'X-Idempotency-Key': idempotency_key },
      body: { project_id, kind: event.kind, body: event.body },
    });
    return { event_id: out.event_id, seq: out.seq, duplicate: out.duplicate === true };
  }

  async readEvents(
    project_id: ProjectId, since_seq: Seq, limit: number = LIMITS.events,
  ): Promise<{ events: Event[]; next_cursor: Seq; has_more: boolean }> {
    const q = new URLSearchParams({
      project_id, since_seq: String(since_seq), limit: String(limit),
    });
    const out = await this.#call<{ events: Event[]; next_cursor: number; has_more: boolean }>({
      method: 'GET', path: `/events?${q.toString()}`,
    });
    if (limit > LIMITS.events) {
      this.#log.warn('store.events.capped', 'requested more than the platform allows', {
        project_id, requested: limit, cap: LIMITS.events, returned: out.events.length,
      });
    }
    return { events: out.events, next_cursor: out.next_cursor, has_more: out.has_more === true };
  }

  // ---- claims -----------------------------------------------------------

  async claimTask(project_id: ProjectId, task_id: TaskId, _agent_id: AgentId): Promise<ClaimResult> {
    // agent_id is deliberately IGNORED. The server resolves it from the token on
    // every request, and sending it would be rejected as a forged field. It stays
    // in the signature because the interface is shared with a backend where the
    // caller does supply it.
    const out = await this.#call<{ ok: boolean; owner?: string; claimed_at?: string }>({
      method: 'POST', path: '/claim', body: { project_id, task_id },
    });
    if (out.ok) return { ok: true };
    if (typeof out.owner !== 'string' || typeof out.claimed_at !== 'string') {
      throw new StoreError('claim was refused without naming an owner');
    }
    return { ok: false, owner: out.owner, claimed_at: out.claimed_at };
  }

  async releaseTask(project_id: ProjectId, task_id: TaskId, _agent_id: AgentId): Promise<void> {
    await this.#call<{ ok: boolean }>({
      method: 'POST', path: '/claim/release', body: { project_id, task_id },
    });
  }

  // ---- scope ------------------------------------------------------------

  async acquireScope(
    project_id: ProjectId, _agent_id: AgentId, task_id: TaskId, globs: string[],
  ): Promise<ScopeResult> {
    const out = await this.#call<{ ok: boolean; conflicts?: ScopeLock[] }>({
      method: 'POST', path: '/scope', body: { project_id, task_id, globs },
    });
    if (out.ok) return { ok: true };
    return { ok: false, conflicts: out.conflicts ?? [] };
  }

  async releaseScope(project_id: ProjectId, _agent_id: AgentId): Promise<void> {
    await this.#call<{ ok: boolean }>({
      method: 'POST', path: '/scope/release', body: { project_id },
    });
  }

  // ---- presence ---------------------------------------------------------

  async heartbeat(
    project_id: ProjectId, _agent_id: AgentId, status: AgentStatus,
    current_task: TaskId | null = null, branch: string | null = null,
  ): Promise<void> {
    // Cache PUT server-side. Zero Data Store UPDATEs, which is the only reason a
    // 20 s heartbeat is affordable at all on this platform.
    await this.#call<null>({
      method: 'POST', path: '/heartbeat',
      body: { project_id, status, current_task, branch },
    });
  }

  async listPresence(project_id: ProjectId): Promise<AgentPresence[]> {
    const out = await this.#call<{ presence: AgentPresence[] }>({
      method: 'GET', path: `/presence?project_id=${encodeURIComponent(project_id)}`,
    });
    return out.presence ?? [];
  }

  // ---- read + notify: NOT PROVISIONED ------------------------------------

  /**
   * NOT IMPLEMENTED -- blocked on the Stratus gate.
   *
   * The design is a signed Stratus GET of snapshot.json with cache-control and an
   * ETag, written by an Event function. The bucket cannot be created without an
   * interactive console session, so there is nothing to read.
   *
   * This throws rather than falling back to folding the ledger client-side. The
   * fallback would work, and that is exactly the problem: it would report a
   * latency for a read path that is not the one under test, and route C1's whole
   * claim is about that path.
   */
  async readSnapshot(_project_id: ProjectId, _etag?: string): Promise<SnapshotRead | null> {
    throw new NotProvisionedError('readSnapshot (Stratus snapshot.json)', STRATUS_GATE);
  }

  /**
   * NOT IMPLEMENTED -- blocked on the same gate.
   *
   * The design polls `readSnapshot` every 5 s with adaptive backoff to 30 s when
   * idle. With no snapshot to poll there is nothing to notify from, and a
   * subscribe that fired once with an empty Snapshot would let A10 pass against
   * fabricated state.
   */
  subscribe(_project_id: ProjectId, _from_seq: Seq, _onChange: (s: Snapshot) => void): () => void {
    throw new NotProvisionedError('subscribe (poll over Stratus snapshot.json)', STRATUS_GATE);
  }
}

/** Which operations are unavailable, so a harness can report rather than guess. */
export const UNPROVISIONED_OPERATIONS = ['readSnapshot', 'subscribe'] as const;

export function createCatalystStore(opts: CatalystStoreOptions): CatalystStore {
  return new CatalystStore(opts);
}

function parseJson(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

function messageOf(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== 'object') return undefined;
  const p = payload as { message?: unknown; error?: unknown };
  if (typeof p.message === 'string' && p.message !== '') return p.message;
  if (typeof p.error === 'string' && p.error !== '') return p.error;
  return undefined;
}

function retryAfterMs(res: Response, payload: unknown): number | undefined {
  const header = res.headers.get('retry-after');
  if (header !== null) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  }
  if (payload !== null && typeof payload === 'object') {
    const ms = (payload as { retry_after_ms?: unknown }).retry_after_ms;
    if (typeof ms === 'number' && Number.isFinite(ms)) return ms;
  }
  return undefined;
}
