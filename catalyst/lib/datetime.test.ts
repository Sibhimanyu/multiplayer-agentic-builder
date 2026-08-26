// The datetime codec. The rejected/accepted strings here are verbatim from live
// Data Store calls, not invented.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  catalystNow, fromCatalystDatetime, isCatalystDatetime, toCatalystDatetime,
} from './datetime.ts';
import { StoreError } from '../../shared/store/errors.ts';

describe('Catalyst datetime codec', () => {
  test('encodes RFC3339 to the only form the platform accepts', () => {
    assert.equal(toCatalystDatetime('2026-08-26T12:30:00.000Z'), '2026-08-26 12:30:00');
    assert.equal(toCatalystDatetime('2026-08-26T12:30:00Z'), '2026-08-26 12:30:00');
  });

  test('encodes in UTC, never local time', () => {
    // The project timezone is Asia/Kolkata. A naive local-time string would shift
    // every timestamp by the offset the moment anything compared it to a server
    // clock, and the bug would look like clock skew.
    assert.equal(toCatalystDatetime('2026-08-26T23:45:00.000Z'), '2026-08-26 23:45:00');
    assert.equal(toCatalystDatetime('2026-08-26T18:15:00+05:30'), '2026-08-26 12:45:00');
  });

  test('the encoded form is the accepted form', () => {
    assert.equal(isCatalystDatetime(toCatalystDatetime('2026-08-26T12:30:00.000Z')), true);
    // Both of these were REJECTED by the live platform.
    assert.equal(isCatalystDatetime('2026-08-26T12:30:00.000Z'), false);
    assert.equal(isCatalystDatetime('2026-08-26 12:30:00:000'), false);
  });

  test('decodes the read form, which carries milliseconds the write form cannot', () => {
    // Verbatim shape returned by a real insert response.
    assert.equal(fromCatalystDatetime('2026-08-26 17:59:05:359'), '2026-08-26T17:59:05.359Z');
    assert.equal(fromCatalystDatetime('2026-08-26 12:30:00'), '2026-08-26T12:30:00.000Z');
  });

  test('PRECISION LOSS is real and asserted, not hoped away', () => {
    // Encoding drops milliseconds. Recorded because it means a Catalyst ledger
    // stores second-resolution created_at where a Firestore ledger stores
    // milliseconds -- a visible difference between the two builds.
    const original = '2026-08-26T12:30:00.789Z';
    const round = fromCatalystDatetime(toCatalystDatetime(original));
    assert.equal(round, '2026-08-26T12:30:00.000Z');
    assert.notEqual(round, original);
  });

  test('a value that survived a real write round-trips exactly', () => {
    const stored = '2026-08-26 12:30:00';
    assert.equal(toCatalystDatetime(fromCatalystDatetime(stored)), stored);
  });

  test('an unparseable value throws rather than becoming Invalid Date', () => {
    // Coercing here would sort the row to the epoch and look like a data bug
    // somewhere else entirely.
    assert.throws(() => toCatalystDatetime('not a date'), StoreError);
    assert.throws(() => fromCatalystDatetime('26/08/2026'), StoreError);
    assert.throws(() => fromCatalystDatetime(''), StoreError);
  });

  test('catalystNow emits an acceptable value', () => {
    assert.equal(isCatalystDatetime(catalystNow(Date.UTC(2026, 7, 26, 12, 30, 0))), true);
    assert.equal(catalystNow(Date.UTC(2026, 7, 26, 12, 30, 0)), '2026-08-26 12:30:00');
  });
});
