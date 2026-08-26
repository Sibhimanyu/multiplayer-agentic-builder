// Tests for parsing Catalyst's DUPLICATE_VALUE payload.
//
// The strings here are verbatim from the live probe recorded in
// docs/handoff/impl-catalyst-notes.md, not invented for the test.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  DUPLICATE_VALUE, DuplicateValueError, isDuplicateValue, parseDuplicateColumn,
  toDuplicateValueError,
} from './duplicate.ts';

const VERBATIM_PAYLOAD = {
  status: 'failure',
  data: {
    message: 'Duplicate value for task_id. Please give a different value',
    error_code: 'DUPLICATE_VALUE',
  },
};

describe('DUPLICATE_VALUE parsing', () => {
  test('parses the column out of the verbatim probe message', () => {
    assert.equal(
      parseDuplicateColumn('Duplicate value for task_id. Please give a different value'),
      'task_id',
    );
    assert.equal(
      parseDuplicateColumn('Duplicate value for seq. Please give a different value'),
      'seq',
    );
    assert.equal(
      parseDuplicateColumn('Duplicate value for idempotency_key. Please give a different value'),
      'idempotency_key',
    );
  });

  test('returns null rather than guessing on an unrecognised message', () => {
    assert.equal(parseDuplicateColumn('Constraint violation on column seq'), null);
    assert.equal(parseDuplicateColumn(''), null);
  });

  test('recognises the failure payload shape', () => {
    assert.equal(isDuplicateValue(VERBATIM_PAYLOAD), true);
    assert.equal(isDuplicateValue({ status: 'failure', data: { error_code: 'INVALID_QUERY' } }), false);
    assert.equal(isDuplicateValue({ error_code: DUPLICATE_VALUE }), true, 'unwrapped shape too');
    assert.equal(isDuplicateValue(null), false);
    assert.equal(isDuplicateValue('nope'), false);
  });

  test('builds a typed error carrying the column and the backend message', () => {
    const err = toDuplicateValueError(VERBATIM_PAYLOAD);
    assert.ok(err instanceof DuplicateValueError);
    assert.equal(err.column, 'task_id');
    assert.equal(err.backend_message, VERBATIM_PAYLOAD.data.message);
    assert.match(err.message, /DUPLICATE_VALUE/);
  });

  test('returns null for a failure that is not a duplicate, so callers do not mis-handle it', () => {
    assert.equal(toDuplicateValueError({ status: 'failure', data: { error_code: 'RATE_LIMIT' } }), null);
  });
});
