// Firebase-specific supplement to the shared section-A suite.
//
// Everything the shared contract covers is covered by shared/store/conformance.ts, run against
// this adapter by firebase.test.ts. This file tests only the one thing that suite structurally
// cannot: the mapping from real gRPC status codes onto the shared error taxonomy.
//
// It matters because that mapping decides the CALLER's behaviour, and getting it wrong is
// expensive in a specific way. PERMISSION_DENIED mapped to a retryable error puts the CLI in a
// tight loop against an auth endpoint, billed per attempt, on a plan with no spending cap.
//
//   node --test shared/store/firebase-errors.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mapFirestoreError } from './store.ts';
import {
  StoreAuthError,
  StoreBusyError,
  StoreError,
  StoreOfflineError,
  isRetryable,
} from '../shared/store/errors.ts';

/** gRPC status codes the admin SDK throws, and the string spellings the web SDK uses. */
const CASES: { code: number | string; expect: new (...a: never[]) => Error; why: string }[] = [
  { code: 7, expect: StoreAuthError, why: 'PERMISSION_DENIED: rules said no' },
  { code: 'permission-denied', expect: StoreAuthError, why: 'web SDK spelling' },
  { code: 16, expect: StoreAuthError, why: 'UNAUTHENTICATED: no or bad credential' },
  { code: 'unauthenticated', expect: StoreAuthError, why: 'web SDK spelling' },

  { code: 8, expect: StoreBusyError, why: 'RESOURCE_EXHAUSTED: quota' },
  { code: 'resource-exhausted', expect: StoreBusyError, why: 'web SDK spelling' },
  { code: 10, expect: StoreBusyError, why: 'ABORTED: transaction contention' },
  { code: 'aborted', expect: StoreBusyError, why: 'web SDK spelling' },

  { code: 4, expect: StoreOfflineError, why: 'DEADLINE_EXCEEDED' },
  { code: 14, expect: StoreOfflineError, why: 'UNAVAILABLE' },
  { code: 'unavailable', expect: StoreOfflineError, why: 'web SDK spelling' },

  // Everything else is a bug, not a condition. A bare StoreError is not retryable, which is
  // the point: repeating a malformed request just sends it again.
  { code: 3, expect: StoreError, why: 'INVALID_ARGUMENT is a caller bug' },
  { code: 5, expect: StoreError, why: 'NOT_FOUND' },
  { code: 9, expect: StoreError, why: 'FAILED_PRECONDITION, e.g. a missing index' },
  { code: 13, expect: StoreError, why: 'INTERNAL' },
];

test('every gRPC status code maps onto the shared error taxonomy', () => {
  for (const { code, expect: Expected, why } of CASES) {
    const mapped = mapFirestoreError({ code, message: 'boom', details: 'backend detail' }, 'testOp');
    assert.ok(
      mapped instanceof Expected,
      `code ${String(code)} (${why}) should map to ${Expected.name}, got ${mapped.name}`,
    );
    assert.match(mapped.message, /testOp/, 'the operation name must survive into the message');
    assert.equal(
      mapped.backend_message,
      'backend detail',
      "the backend's own words must be kept for logs",
    );
  }
});

test('an unrecognised or absent code is a StoreError, never silently retryable', () => {
  for (const err of [{}, { code: 999 }, { code: 'who-knows' }, null, undefined, 'a string']) {
    const mapped = mapFirestoreError(err, 'testOp');
    assert.ok(mapped instanceof StoreError);
    assert.equal(isRetryable(mapped), false, 'an unnamed failure is not known to be safe to repeat');
  }
});

test('PERMISSION_DENIED is never retryable — the expensive mistake', () => {
  // Called out explicitly because this is the one that costs money rather than correctness:
  // a revoked agent retrying in a loop is a billable request per attempt, forever, and Blaze
  // has no spending cap by default.
  for (const code of [7, 'permission-denied', 16, 'unauthenticated']) {
    assert.equal(isRetryable(mapFirestoreError({ code }, 'op')), false, `${code} must be terminal`);
  }
});

test('transaction contention is retryable and carries a wait hint', () => {
  // ABORTED means the SDK already exhausted its internal retries on a contended document.
  // Backing off is right; hammering the same document is not.
  const mapped = mapFirestoreError({ code: 10, message: 'too much contention' }, 'claimTask');
  assert.ok(mapped instanceof StoreBusyError);
  assert.equal(isRetryable(mapped), true);
  if (mapped instanceof StoreBusyError) {
    assert.ok((mapped.retry_after_ms ?? 0) > 0, 'contention must advise a wait');
  }
});

test('quota exhaustion is retryable but advises no fixed wait', () => {
  const mapped = mapFirestoreError({ code: 8, message: 'quota exceeded' }, 'appendEvent');
  assert.ok(mapped instanceof StoreBusyError);
  if (mapped instanceof StoreBusyError) {
    // Firestore does not return Retry-After for quota, so guessing one would be a fiction.
    // The caller's jittered backoff owns the schedule.
    assert.equal(mapped.retry_after_ms, undefined);
  }
});
