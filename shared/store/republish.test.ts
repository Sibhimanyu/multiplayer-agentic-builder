// A13, at the layer where it actually lives, plus the shared error mapping.
//
// A13 asks that a snapshot reporting seq < last_written_seq does not trigger a re-append. On
// Catalyst that is a live hazard: the snapshot writer is an Event function debounced 2s, so
// the window is real and measurable. On Firestore the window does not exist — readSnapshot
// reads the same listener cache the fold wrote — so the emulator run skips the box rather than
// claiming a pass it did not earn.
//
// The rule is still worth testing, because it is the CALLER's rule and the CLI shares it
// across both builds. That is what this file does.
//
//   node --test shared/store/republish.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decideRepublish } from './conformance.ts';
import { mapFirestoreError } from './firestore.ts';
import {
  StoreAuthError,
  StoreBusyError,
  StoreError,
  StoreOfflineError,
  backoffMs,
  isRetryable,
} from './errors.ts';
import { withRetry } from './retry.ts';

// ---- A13, caller side ------------------------------------------------------------------

test('A13 a lagging snapshot means wait, never republish', () => {
  // Behind: the write is folded but not yet visible. Stale, not lost.
  assert.equal(decideRepublish(4210, 4211), 'wait');
  assert.equal(decideRepublish(0, 1), 'wait');
  assert.equal(decideRepublish(4000, 4211), 'wait');

  // Caught up, or ahead because other agents wrote after us.
  assert.equal(decideRepublish(4211, 4211), 'done');
  assert.equal(decideRepublish(4300, 4211), 'done');

  // Nothing written yet: there is nothing to wait for.
  assert.equal(decideRepublish(0, 0), 'done');
});

test('A13b there is no input for which the caller republishes', () => {
  // The function has two outcomes by construction. This test exists so that adding a third
  // ("republish") requires deleting an assertion someone has to justify — retrying here is
  // the most likely source of duplicate events in the whole system.
  const outcomes = new Set<string>();
  for (let snap = 0; snap <= 50; snap++) {
    for (let written = 0; written <= 50; written++) outcomes.add(decideRepublish(snap, written));
  }
  assert.deepEqual([...outcomes].sort(), ['done', 'wait']);
});

// ---- error mapping ---------------------------------------------------------------------

test('gRPC status codes map onto the shared error vocabulary', () => {
  const cases: [number | string, new (...a: never[]) => Error][] = [
    [7, StoreAuthError], // PERMISSION_DENIED
    ['permission-denied', StoreAuthError],
    [16, StoreAuthError], // UNAUTHENTICATED
    ['unauthenticated', StoreAuthError],
    [8, StoreBusyError], // RESOURCE_EXHAUSTED
    ['resource-exhausted', StoreBusyError],
    [10, StoreBusyError], // ABORTED: transaction contention
    ['aborted', StoreBusyError],
    [4, StoreOfflineError], // DEADLINE_EXCEEDED
    [14, StoreOfflineError], // UNAVAILABLE
    ['unavailable', StoreOfflineError],
    [3, StoreError], // INVALID_ARGUMENT: a bug, not a condition to retry
    [5, StoreError], // NOT_FOUND
    [13, StoreError], // INTERNAL
    [undefined as unknown as number, StoreError],
  ];
  for (const [code, Expected] of cases) {
    const mapped = mapFirestoreError({ code, message: 'boom' }, 'testOp');
    assert.ok(
      mapped instanceof Expected,
      `code ${String(code)} should map to ${Expected.name}, got ${mapped.name}`,
    );
    assert.equal(mapped.backend, 'firestore');
    assert.match(mapped.message, /testOp/, 'the operation name must survive into the message');
    assert.match(mapped.message, /boom/, "the backend's own message must be attached");
  }
});

test('only busy and offline are retryable; auth never is', () => {
  assert.equal(isRetryable(new StoreBusyError('x', 'firestore')), true);
  assert.equal(isRetryable(new StoreOfflineError('x', 'firestore')), true);
  assert.equal(isRetryable(new StoreAuthError('x', 'firestore')), false);
  assert.equal(isRetryable(new StoreError('x', 'firestore')), false);
  assert.equal(isRetryable(new TypeError('a real bug')), false);
});

// ---- A15, backoff shape ----------------------------------------------------------------

test('backoff is full-jitter and honours the cap', () => {
  // rand=0 is the floor, rand~1 the ceiling. Full jitter means the floor is 0, which is what
  // spreads a fleet out instead of moving it in lockstep.
  assert.equal(backoffMs(0, { base_ms: 250, rand: () => 0 }), 0);
  assert.equal(backoffMs(0, { base_ms: 250, rand: () => 1 }), 250);
  assert.equal(backoffMs(1, { base_ms: 250, rand: () => 1 }), 500);
  assert.equal(backoffMs(2, { base_ms: 250, rand: () => 1 }), 1000);
  assert.equal(backoffMs(10, { base_ms: 250, cap_ms: 30_000, rand: () => 1 }), 30_000);
  assert.equal(backoffMs(99, { base_ms: 250, cap_ms: 30_000, rand: () => 1 }), 30_000);

  // Monotonically non-decreasing ceiling, and never negative.
  let prev = -1;
  for (let a = 0; a < 12; a++) {
    const ceiling = backoffMs(a, { rand: () => 1 });
    assert.ok(ceiling >= prev, 'the ceiling must not shrink as attempts grow');
    assert.ok(backoffMs(a, { rand: () => 0 }) >= 0);
    prev = ceiling;
  }
});

test('withRetry stops immediately on auth and never sleeps', async () => {
  let calls = 0;
  const waits: number[] = [];
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          throw new StoreAuthError('revoked', 'firestore');
        },
        { attempts: 5, sleep: async () => {}, onWait: (w) => waits.push(w.delay_ms) },
      ),
    (e: unknown) => e instanceof StoreAuthError,
  );
  assert.equal(calls, 1);
  assert.equal(waits.length, 0);
});

test('withRetry rethrows a non-store error untouched rather than swallowing it', async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withRetry(
        async () => {
          calls++;
          throw new TypeError('cannot read properties of undefined');
        },
        { attempts: 5, sleep: async () => {} },
      ),
    (e: unknown) => e instanceof TypeError,
    'a programming error must not be retried or converted into a StoreError',
  );
  assert.equal(calls, 1, 'a bug is not a transient condition');
});

test('withRetry honours a server Retry-After hint, jittered', async () => {
  const waits: number[] = [];
  let calls = 0;
  await withRetry(
    async () => {
      calls++;
      if (calls < 3) throw new StoreBusyError('slow down', 'firestore', 1_000);
      return 'ok';
    },
    { attempts: 5, sleep: async () => {}, rand: () => 1, onWait: (w) => waits.push(w.delay_ms) },
  );
  assert.equal(calls, 3);
  // rand=1 -> full hint; the 0.5 floor means a fleet told "1s" still spreads over 500-1000ms.
  assert.deepEqual(waits, [1_000, 1_000]);

  const floor: number[] = [];
  let c2 = 0;
  await withRetry(
    async () => {
      c2++;
      if (c2 < 2) throw new StoreBusyError('slow down', 'firestore', 1_000);
      return 'ok';
    },
    { attempts: 3, sleep: async () => {}, rand: () => 0, onWait: (w) => floor.push(w.delay_ms) },
  );
  assert.deepEqual(floor, [500], 'the hint is jittered down to 50%, never ignored, never zero');
});
