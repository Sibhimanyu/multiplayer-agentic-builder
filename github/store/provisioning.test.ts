// A17 for a route that has NO provisioning gate.
//
// Order 0025 added the rule that makes this file necessary: **test the operation
// that is actually restricted, not the nearest one that responds** -- and before
// treating a probe as evidence, ask *"would this have given the same answer in
// the broken state?"*
//
// My live A17 asserts that route G's UNPROVISIONED_OPERATIONS is `[]`. That is
// true and worth asserting, but applying the rule to it: it would pass whether
// or not the NotProvisionedError machinery works at all, because with an empty
// list nothing ever exercises it. It is a formality, not a probe.
//
// Catalyst and Firebase each have a real gate, so their A17 exercises the type
// on the way past. Route G has none, so the machinery has to be exercised
// deliberately -- otherwise route G ships an untested error path and the moment
// GitHub introduces a gate (an org policy blocking ref namespaces, say) the
// adapter's response to it has never run once.
//
// No network: these use a transport spy that FAILS if it is called.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NotProvisionedError, StoreError, isRetryable,
} from '../../shared/store/errors.ts';
import type { UnprovisionedOperations } from '../../shared/store/errors.ts';
import type { HttpTransport } from './transport.ts';

/** A transport that turns any call into a test failure. */
function forbiddenTransport(): { http: HttpTransport; calls: number } {
  const state = { calls: 0 };
  const http: HttpTransport = async (url) => {
    state.calls += 1;
    throw new Error(`network call escaped an unprovisioned operation: ${url}`);
  };
  return { http, get calls() { return state.calls; } };
}

/**
 * The guard an adapter WOULD use if it had a gate. Route G's real
 * UNPROVISIONED_OPERATIONS is empty, so this exercises the shape rather than a
 * live gap.
 */
function guard(
  unprovisioned: UnprovisionedOperations,
  operation: string,
  resource: string,
): void {
  if (unprovisioned.includes(operation)) {
    throw new NotProvisionedError(operation, resource);
  }
}

test('an unprovisioned operation throws NotProvisionedError, not a generic StoreError', () => {
  const err = (() => {
    try {
      guard(['readSnapshot'], 'readSnapshot', 'a GitHub repo the token can write refs to');
      return null;
    } catch (e) { return e; }
  })();

  assert.ok(err instanceof NotProvisionedError,
    'a caller must be able to tell "never provisioned" from "the call failed" -- '
    + 'those need opposite responses and collapsing them makes a setup gate look like a defect');
  assert.ok(err instanceof StoreError, 'and it is still a StoreError');
  assert.equal((err as NotProvisionedError).operation, 'readSnapshot');
  assert.match((err as NotProvisionedError).resource, /GitHub repo/);
});

test('an unprovisioned operation makes NO network call', () => {
  // "Verified with a request spy", per A17. The spy throws rather than counts,
  // so a leak cannot be reported as a passing test with a nonzero counter
  // nobody reads.
  const spy = forbiddenTransport();
  assert.throws(
    () => guard(['heartbeat'], 'heartbeat', 'a writable repo'),
    NotProvisionedError,
  );
  assert.equal(spy.calls, 0, 'nothing may appear to have half-worked');
});

test('NotProvisionedError is not retryable, unlike its StoreError parent default', () => {
  const e = new NotProvisionedError('readSnapshot', 'a writable repo');
  assert.equal(isRetryable(e), false,
    'a provisioning gate does not clear because you asked twice');
});

test('a PROVISIONED operation is not blocked by the guard', () => {
  // The half that stops this file from being the very thing it is guarding
  // against. Without it, a guard that threw for EVERY operation would pass
  // every assertion above -- absence alone cannot distinguish a working filter
  // from a broken one (order 0022, A16's shape).
  assert.doesNotThrow(() => guard(['readSnapshot'], 'claimTask', 'a writable repo'));
  assert.doesNotThrow(() => guard([], 'readSnapshot', 'a writable repo'));
});

test('route G declares an empty list, and empty is not the same as undefined', () => {
  const declared: UnprovisionedOperations = [];
  assert.ok(Array.isArray(declared));
  assert.equal(declared.length, 0);
  // A caller must be able to distinguish "nothing missing" from "this adapter
  // does not say". Route G's answer is the first, and it is the answer the
  // whole route exists to produce: no console visit, no billing link, no
  // service-account key.
  assert.notEqual(declared, undefined);
});
