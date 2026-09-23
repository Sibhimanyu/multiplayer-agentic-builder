// HTTP client for the coordination API.
//
// The CLI holds the token; the agent never does. That is the whole security story of the file
// contract: a prompt injection cannot exfiltrate a credential the agent never had.
//
// This maps HTTP status codes back onto the shared error vocabulary, so the CLI's retry policy
// is written once against StoreBusyError / StoreOfflineError / StoreAuthError and does not care
// that the transport is HTTP or that the backend is Firestore.

import {
  StoreAuthError,
  StoreBusyError,
  StoreError,
  StoreOfflineError,
} from '../shared/store/errors.ts';
import { withRetry } from '../shared/store/retry.ts';
import type { Logger } from '../shared/log.ts';
import type {
  AgentStatus,
  Event,
  EventKind,
  Freshness,
  ScopeLock,
  Seq,
  Snapshot,
  TaskId,
} from '../shared/store/types.ts';

export interface ClientOptions {
  base_url: string;
  token: string;
  log: Logger;
  fetchImpl?: typeof fetch;
  /** Per-request deadline. Without one, an offline backend hangs the CLI indefinitely. */
  timeout_ms?: number;
}

export interface WhoAmI {
  agent_id: string;
  project_id: string;
  role_slug: string;
  permissions: { push_branches: boolean; open_prs: boolean; merge: boolean; publish_contracts: boolean };
  freshness: Freshness;
  /** The project's own fence for this role. Absent from older backends: fall back to the template. */
  file_scope?: string[];
}

export class ApiClient {
  private readonly opts: ClientOptions;
  private readonly doFetch: typeof fetch;

  constructor(opts: ClientOptions) {
    this.opts = opts;
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  /**
   * One request. Maps transport and status failures onto the shared error vocabulary.
   *
   * A network-level throw (DNS, refused, aborted) becomes StoreOfflineError rather than
   * propagating a TypeError, because "offline is normal" is a protocol rule and the caller's
   * outbox logic is written against that type.
   */
  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; data: T }> {
    const url = `${this.opts.base_url.replace(/\/+$/, '')}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeout_ms ?? 15_000);

    let res: Response;
    try {
      res = await this.doFetch(url, {
        method,
        headers: {
          // X-Agent-Token, raw, not Authorization: Bearer. Ruled in order 0017 -- the Catalyst
          // API Gateway reserves Authorization and validates it as a Zoho OAuth token before
          // the function runs, so a shared CLI cannot use it. One header everywhere beats a
          // per-platform branch in shared code.
          'x-agent-token': this.opts.token,
          'content-type': 'application/json',
          ...extraHeaders,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      // Named: an abort is a timeout, anything else is a transport failure. Both are "offline",
      // which is a normal condition the CLI queues through, not a crash.
      const reason = (err as Error)?.name === 'AbortError' ? 'request timed out' : String(err);
      throw new StoreOfflineError(`${method} ${path}: ${reason}`, { backend_message: String(err) });
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 304) return { status: 304, data: undefined as T };

    const text = await res.text();
    let data: unknown = undefined;
    if (text !== '') {
      try {
        data = JSON.parse(text);
      } catch {
        // A non-JSON body from a 5xx is an infrastructure page, not an API response.
        if (res.ok) throw new StoreError(`${method} ${path}: response was not JSON`, { backend_message: text.slice(0, 200) });
      }
    }

    if (res.ok) return { status: res.status, data: data as T };

    const detail = (data as { detail?: string; error?: string })?.detail ?? text.slice(0, 200);
    switch (res.status) {
      case 401:
      case 403:
        // Terminal. The caller must STOP, not retry: a revoked token retried in a loop is a
        // billable request per attempt against a project with no spending cap.
        throw new StoreAuthError(`${method} ${path}: ${detail}`, { backend_message: detail });
      case 429: {
        const hint = Number((data as { retry_after_ms?: number })?.retry_after_ms ?? NaN);
        const header = Number(res.headers.get('retry-after')) * 1000;
        const retry = Number.isFinite(hint) ? hint : Number.isFinite(header) ? header : null;
        throw new StoreBusyError(`${method} ${path}: ${detail}`, {
          backend_message: detail,
          ...(retry === null ? {} : { retry_after_ms: retry }),
        });
      }
      case 502:
      case 503:
      case 504:
        throw new StoreOfflineError(`${method} ${path}: ${detail}`, { backend_message: detail });
      default:
        // 400 and 404 are caller bugs. Named and thrown, never retried — retrying a malformed
        // request just sends it again.
        throw new StoreError(`${method} ${path}: ${res.status} ${detail}`, {
          backend_message: detail,
          cause_code: String(res.status),
        });
    }
  }

  /**
   * Retryable wrapper. Only busy and offline are retried; auth is terminal.
   *
   * The shared withRetry returns { value, outcome } and emits its own `retry.backoff` /
   * `retry.abandoned` lines, so there is no logging to add here — and adding any would mean
   * two builds reporting the same backoff differently.
   */
  private async retry<T>(fn: () => Promise<T>, op: string): Promise<T> {
    const { value } = await withRetry(fn, { attempts: 4, log: this.opts.log, op });
    return value;
  }

  whoami(): Promise<WhoAmI> {
    return this.retry(async () => (await this.request<WhoAmI>('GET', '/whoami')).data, 'whoami');
  }

  appendEvent(
    kind: EventKind,
    body: Record<string, unknown>,
    idempotency_key: string,
  ): Promise<{ event_id: string; seq: Seq; duplicate: boolean }> {
    return this.retry(async () => {
      const r = await this.request<{ event_id: string; seq: Seq; duplicate: boolean }>(
        'POST',
        '/events',
        { kind, body, idempotency_key },
      );
      return r.data;
    }, 'appendEvent');
  }

  claimTask(
    task_id: TaskId,
  ): Promise<{ ok: true } | { ok: false; owner: string; claimed_at: string }> {
    return this.retry(async () => {
      const r = await this.request<{ ok: boolean; owner?: string; claimed_at?: string }>(
        'POST',
        '/claim',
        { task_id },
      );
      // A lost claim arrives as 200 + ok:false. It is a normal outcome and must not be an
      // error here either, or `flotilla claim` would exit non-zero on a routine race (B3).
      return r.data.ok
        ? { ok: true }
        : { ok: false, owner: r.data.owner ?? 'unknown', claimed_at: r.data.claimed_at ?? '' };
    }, 'claimTask');
  }

  releaseTask(task_id: TaskId): Promise<void> {
    return this.retry(async () => {
      await this.request('POST', '/release', { task_id });
    }, 'releaseTask');
  }

  acquireScope(
    task_id: TaskId,
    globs: string[],
  ): Promise<{ ok: true } | { ok: false; conflicts: ScopeLock[] }> {
    return this.retry(async () => {
      const r = await this.request<{ ok: boolean; conflicts?: ScopeLock[] }>('POST', '/scope', {
        task_id,
        globs,
      });
      return r.data.ok ? { ok: true } : { ok: false, conflicts: r.data.conflicts ?? [] };
    }, 'acquireScope');
  }

  releaseScope(): Promise<void> {
    return this.retry(async () => {
      await this.request('DELETE', '/scope');
    }, 'releaseScope');
  }

  heartbeat(status: AgentStatus, current_task: TaskId | null, branch: string | null): Promise<void> {
    return this.retry(async () => {
      await this.request('POST', '/heartbeat', { status, current_task, branch });
    }, 'heartbeat');
  }

  readEvents(since_seq: Seq): Promise<{ events: Event[]; next_cursor: Seq; has_more: boolean }> {
    return this.retry(async () => {
      const r = await this.request<{ events: Event[]; next_cursor: Seq; has_more: boolean }>(
        'GET',
        `/events?since_seq=${encodeURIComponent(String(since_seq))}`,
      );
      return r.data;
    }, 'readEvents');
  }

  readSnapshot(etag?: string): Promise<{ snapshot: Snapshot; etag: string } | null> {
    return this.retry(async () => {
      const r = await this.request<{ snapshot: Snapshot; etag: string }>(
        'GET',
        '/snapshot',
        undefined,
        etag ? { 'if-none-match': etag } : {},
      );
      if (r.status === 304) return null;
      return r.data;
    }, 'readSnapshot');
  }
}

/** Exchange an invite for a token. Unauthenticated, so it does not go through ApiClient. */
export async function connectWithInvite(
  base_url: string,
  invite: string,
  harness: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ agent_id: string; project_id: string; role_slug: string; member_label: string; token: string }> {
  const res = await fetchImpl(`${base_url.replace(/\/+$/, '')}/connect`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ invite, harness }),
  }).catch((err) => {
    throw new StoreOfflineError(`connect: ${String(err)}`, { backend_message: String(err) });
  });

  const text = await res.text();
  const data = text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
  if (!res.ok) {
    const detail = String(data.detail ?? data.error ?? res.status);
    if (res.status === 401) throw new StoreAuthError(`connect refused: ${detail}`, { backend_message: detail });
    throw new StoreError(`connect failed: ${detail}`, { backend_message: detail });
  }
  return data as never;
}
