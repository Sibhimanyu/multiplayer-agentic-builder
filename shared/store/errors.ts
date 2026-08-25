// Error taxonomy from docs/reference/store-interface.md § Error mapping.
//
// Callers see these four and nothing else. An adapter that lets a backend error
// escape has leaked the seam. Claim losses, scope conflicts and duplicate
// idempotency keys are NOT errors -- they are return values.

export class StoreError extends Error {
  /** The backend's own message, kept for logs. Never shown as control flow. */
  readonly backend_message?: string;
  readonly cause_code?: string;
  constructor(message: string, opts: { backend_message?: string; cause_code?: string } = {}) {
    super(message);
    this.name = 'StoreError';
    this.backend_message = opts.backend_message;
    this.cause_code = opts.cause_code;
  }
}

/** Agent token revoked or invalid. The caller MUST stop, not retry. */
export class StoreAuthError extends StoreError {
  constructor(message = 'agent token is revoked or invalid', opts?: { backend_message?: string }) {
    super(message, opts);
    this.name = 'StoreAuthError';
  }
}

/**
 * Backend rate limited or at its concurrency ceiling (Catalyst: 10 concurrent
 * executions per function per env, then 429). The caller retries with jittered
 * backoff.
 */
export class StoreBusyError extends StoreError {
  /** Server-advised wait, when the backend supplies one. */
  readonly retry_after_ms?: number;
  constructor(message = 'backend is rate limited', opts: { backend_message?: string; retry_after_ms?: number } = {}) {
    super(message, { backend_message: opts.backend_message });
    this.name = 'StoreBusyError';
    this.retry_after_ms = opts.retry_after_ms;
  }
}

/** Backend unreachable. The caller queues to its outbox and keeps working. */
export class StoreOfflineError extends StoreError {
  constructor(message = 'backend is unreachable', opts?: { backend_message?: string }) {
    super(message, opts);
    this.name = 'StoreOfflineError';
  }
}

/**
 * Retryable: busy and offline. NOT auth -- retrying a revoked token burns quota
 * and never succeeds. NOT a bare StoreError -- an unnamed failure is not known
 * to be safe to repeat.
 */
export function isRetryable(err: unknown): boolean {
  return err instanceof StoreBusyError || err instanceof StoreOfflineError;
}
