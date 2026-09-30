import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatAge, kindLabel } from '../client/src/format.ts';

const MIN = 60_000;

test('formatAge picks the largest natural unit', () => {
  assert.equal(formatAge(0), '0m');
  assert.equal(formatAge(59 * MIN), '59m');
  assert.equal(formatAge(60 * MIN), '1h');
  assert.equal(formatAge(47 * 60 * MIN), '47h');
  assert.equal(formatAge(48 * 60 * MIN), '2d');
  // The regression: 18,690 minutes printed as "18690m" on the board.
  assert.equal(formatAge(18_690 * MIN), '13d');
});

test('formatAge never goes negative on clock skew', () => {
  assert.equal(formatAge(-5 * MIN), '0m');
});

test('kindLabel spells acronyms and capitalises the rest', () => {
  assert.equal(kindLabel('qa'), 'QA');
  assert.equal(kindLabel('devops'), 'DevOps');
  assert.equal(kindLabel('backend'), 'Backend');
});
