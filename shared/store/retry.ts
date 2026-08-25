// Retry policy for store calls. One place, so "the CLI backs off with jitter"
// is a testable object rather than a sentence in a design doc.
//
// Two rules that matter more than the numbers:
//   - StoreAuthError is NEVER retried. A revoked token does not become valid;
//     retrying burns quota and hides the real problem from the operator.
//   - Jitter is mandatory. Ten agents hitting a Catalyst function's 10-execution
//     concurrency ceiling and backing off in lockstep re-collide forever.

import type { Clock } from '../clock.ts';
import { systemClock } from '../clock.ts';
import type { Logger } from '../log.ts';
import { nullLogger } from '../log.ts';
import { isRetryable, StoreBusyError } from './errors.ts';

export interface RetryPolicy {
  /** Total attempts including the first. Default 5. */
  attempts?: number;
  /** First backoff, doubling per attempt. Default 250ms. */
  base_ms?: number;
  /** Ceiling on a single backoff. Default 8s. */
  cap_ms?: number;
  clock?: Clock;
  log?: Logger;
  /** Injectable for deterministic tests. Default Math.random. */
  random?: () => number;
  /** Injectable for tests that assert delays without waiting for them. */
  sleep?: (ms: number) => Promise<void>;
  /** Label for the log lines. */
  op?: string;
}

/**
 * Equal jitter: half the window is fixed, half is random. Always > 0, so a
 * retry is never a tight loop, and never identical across callers.
 */
export function backoffMs(attempt: number, policy: RetryPolicy = {}): number {
  const base = policy.base_ms ?? 250;
  const cap = policy.cap_ms ?? 8_000;
  const random = policy.random ?? Math.random;
  const window = Math.min(cap, base * 2 ** attempt);
  const half = window / 2;
  return Math.round(half + random() * half);
}

export interface RetryOutcome {
  /** Every backoff actually taken, in order. Empty when the first try worked. */
  delays: number[];
  attempts: number;
}

/**
 * Run `fn`, retrying only what is safe to repeat. Returns the value plus what
 * the backoff did, because "no tight loop" is only provable if the delays are
 * observable.
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy = {},
): Promise<{ value: T; outcome: RetryOutcome }> {
  const attempts = policy.attempts ?? 5;
  const clock = policy.clock ?? systemClock;
  const log = policy.log ?? nullLogger;
  const sleep = policy.sleep ?? ((ms: number) => clock.sleep(ms));
  const op = policy.op ?? 'store.call';

  const delays: number[] = [];
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const value = await fn(attempt);
      return { value, outcome: { delays, attempts: attempt + 1 } };
    } catch (err) {
      lastError = err;
      if (!isRetryable(err)) {
        // StoreAuthError and unnamed StoreError land here. Stop, do not retry.
        log.warn('retry.abandoned', 'error is not retryable, giving up immediately', {
          op, attempt: attempt + 1, error: (err as Error).name,
        });
        throw err;
      }
      if (attempt === attempts - 1) break;

      const advised = err instanceof StoreBusyError ? err.retry_after_ms : undefined;
      const wait = advised ?? backoffMs(attempt, policy);
      delays.push(wait);
      log.info('retry.backoff', 'retryable error, backing off with jitter', {
        op, attempt: attempt + 1, wait_ms: wait, error: (err as Error).name,
      });
      await sleep(wait);
    }
  }

  log.error('retry.exhausted', 'retries exhausted', {
    op, attempts, delays, error: (lastError as Error)?.name,
  });
  throw lastError;
}
