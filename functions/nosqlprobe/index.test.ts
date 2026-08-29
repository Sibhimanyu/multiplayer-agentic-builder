// The sort-key gate is the load-bearing check in order 0037.
//
// With a primary key of (partition, sort), five racers insert under five sort
// values and ALL succeed -- so a broken gate turns this probe into a green
// result that excluded nothing. These tests exist because the first version of
// the gate checked seven hand-written spellings of "sort key" and the real
// definition turned out to use an eighth, `additional_sort_keys`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { allOverlap, extractHolder, hasNoSortKey, verdictOf } from './index.ts';

/** The definition the live table actually returned, 2026-08-29. */
const REAL_DEFINITION = {
  type: 'TABLE',
  project_details: { project_name: 'multiplayer-agents', id: '53069000000062004' },
  partition_key: { column_name: 'claim_key', data_type: 'S' },
  status: 'ONLINE',
  id: '53069000000101123',
  name: 'claim_probe',
  ttl_enabled: false,
  api_access: false,
  additional_sort_keys: [],
  global_index: [],
};

test('the real claim_probe definition is cleared: partition key present, no sort key', () => {
  const r = hasNoSortKey(REAL_DEFINITION);
  assert.equal(r.safe, true);
});

test('a POPULATED additional_sort_keys blocks the race -- the spelling the first gate missed', () => {
  const r = hasNoSortKey({ ...REAL_DEFINITION, additional_sort_keys: [{ column_name: 'created_at' }] });
  assert.equal(r.safe, false);
  assert.match(r.reason, /additional_sort_keys/);
});

test('any field whose name mentions sort or range blocks it, including names not anticipated', () => {
  for (const field of ['sort_key', 'rangeKey', 'secondary_sort_column', 'RANGE_KEY']) {
    const r = hasNoSortKey({ ...REAL_DEFINITION, [field]: { column_name: 'x' } });
    assert.equal(r.safe, false, `${field} should have blocked the race`);
  }
});

test('a column list declaring a sort role blocks it', () => {
  const r = hasNoSortKey({
    ...REAL_DEFINITION,
    columns: [{ column_name: 'claim_key', key_type: 'HASH' }, { column_name: 'ts', key_type: 'SORT' }],
  });
  assert.equal(r.safe, false);
});

test('an unrecognised shape BLOCKS rather than passes: no partition key means the gate does not understand it', () => {
  assert.equal(hasNoSortKey({ name: 'claim_probe' }).safe, false);
  assert.equal(hasNoSortKey(null).safe, false);
  assert.equal(hasNoSortKey('claim_probe').safe, false);
});

test('overlap detection: five attempts in flight together overlap; serialised ones do not', () => {
  const concurrent = [
    { racer: 'a', won: true, t0: 100, t1: 140 },
    { racer: 'b', won: false, t0: 101, t1: 139 },
    { racer: 'c', won: false, t0: 102, t1: 145 },
  ];
  assert.equal(allOverlap(concurrent), true);

  // A connection pool serialising the calls produces disjoint intervals. If this
  // returned true, a non-atomic primitive that was never actually raced would be
  // reported as holding.
  const serialised = [
    { racer: 'a', won: true, t0: 100, t1: 140 },
    { racer: 'b', won: false, t0: 141, t1: 180 },
    { racer: 'c', won: false, t0: 181, t1: 220 },
  ];
  assert.equal(allOverlap(serialised), false);
});

// A REFUSAL DOES NOT THROW. insertItems resolves with CriteriaMismatch when the
// condition is not met, so "did not throw" is not a win. The first race counted
// it as one and reported 392 winners over 200 keys while the table held nothing.
test('a refused conditional insert is NOT a win: CriteriaMismatch resolves, it does not throw', () => {
  assert.equal(verdictOf({ size: 0, operation: 'create', create: [{ status: 'CriteriaMismatch' }] }), 'CriteriaMismatch');
  assert.equal(verdictOf({ size: 41, operation: 'create', create: [{ status: 'Success' }] }), 'Success');
});

test('an unrecognised response can never manufacture a win', () => {
  for (const res of [null, undefined, {}, { create: [] }, { create: [{}] }, 'ok', { create: 'Success' }]) {
    assert.notEqual(verdictOf(res), 'Success', `${JSON.stringify(res)} must not read as Success`);
  }
});

test('verdictOf reads through the SDK wrapper via toJSON, not off the instance', () => {
  const wrapper = { size: 0, toJSON: () => ({ create: [{ status: 'Success' }] }) };
  assert.equal(verdictOf(wrapper), 'Success');
});

test('extractHolder unwraps the marshalled attribute, and returns null rather than a placeholder', () => {
  assert.equal(extractHolder({ get: [{ item: { holder: { S: 'agent_race03' } } }] }), 'agent_race03');
  assert.equal(extractHolder({ holder: 'agent_race01' }), 'agent_race01');
  // The bug that produced "[object Object]" for 48 keys in order 0035 and looked
  // exactly like a platform failure. A null is legible; a placeholder is not.
  assert.equal(extractHolder({ get: [] }), null);
  assert.equal(extractHolder(null), null);
});

// The bug that made a correct 200/200 race look like 200 lost writes. The
// response is a class instance whose nested items are ALSO class instances, so
// Object.values() over them finds nothing -- including for rows that provably
// existed. Normalising through JSON invokes every nested toJSON on the way down.
test('extractHolder reads a wrapper whose nested items only serialise via toJSON', () => {
  class Item {
    h: string;
    constructor(h: string) { this.h = h; }
    toJSON(): unknown { return { claim_key: { S: 'k' }, holder: { S: this.h } }; }
  }
  class Response {
    readonly size = 39;
    readonly operation = 'read';
    readonly get = [{ item: new Item('agent_race02') }];
  }
  assert.equal(extractHolder(new Response()), 'agent_race02');
});
