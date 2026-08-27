// Ref naming invariants. Two of these guard measured defects rather than
// hypothetical ones.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RefLayout, padSeq, padTs, parseSeq, refParent, refTail, scopedKey } from './refs.ts';

test('padding makes LEXICAL and NUMERIC ref order agree', () => {
  // Probe J measured that both git ls-remote and the REST matching-refs
  // endpoint return refs lexically: 10, 100, 2, 9. Unpadded, a reader that
  // sorts the natural way reads the ledger out of order.
  const raw = ['10', '100', '2', '9'];
  assert.deepEqual([...raw].sort(), ['10', '100', '2', '9'], 'the trap, reproduced');

  const padded = raw.map((n) => padSeq(Number(n)));
  const lexical = [...padded].sort();
  const numeric = [...padded].sort((a, b) => parseSeq(a) - parseSeq(b));
  assert.deepEqual(lexical, numeric, 'padded, the natural sort IS the correct sort');
  assert.deepEqual(lexical.map(parseSeq), [2, 9, 10, 100]);
});

test('a seq too wide to pad throws instead of wrapping', () => {
  // Wrapping would reorder the ledger silently. At 10^10 events this route
  // needs a different scheme and should say so rather than corrupt.
  assert.throws(() => padSeq(10_000_000_000), RangeError);
});

test('timestamps get their own width, because epoch ms is 13 digits not 10', () => {
  // This test exists because the shared-width version threw on the first real
  // timestamp. The guard was right and the caller was wrong, so the caller
  // changed: widening SEQ_WIDTH to hide it would have been fixing the guard.
  assert.throws(() => padSeq(Date.now()), RangeError, 'epoch ms does not fit a seq');
  const t = padTs(1787748287000);
  assert.equal(t.length, 13);
  assert.equal(parseSeq(t), 1787748287000);
  // Ordering still has to survive the natural sort.
  const stamps = [1787748287000, 999999999999, 1787748287001].map(padTs);
  assert.deepEqual([...stamps].sort(), [...stamps].sort((a, b) => parseSeq(a) - parseSeq(b)));
});

test('an unreadable seq throws rather than defaulting to 0', () => {
  // Order 0019's MAX(seq) defect and order 0021's `?? 0` defect are the same
  // shape: an unreadable value collapsing to 0 restarts the ledger and reissues
  // every seq ever given out. "Unverifiable is not true."
  for (const bad of ['', 'abc', '00a1', '1.5', '-3', ' 12']) {
    assert.throws(() => parseSeq(bad), RangeError, `parseSeq(${JSON.stringify(bad)}) must throw`);
  }
  assert.equal(parseSeq('0000000042'), 42);
});

test('composite keys cannot collide across a separator boundary', () => {
  // Required by the checklist either way; this build takes rule B, hash each
  // part, so the collision class cannot exist rather than being policed.
  assert.notEqual(scopedKey('a:b', 'c'), scopedKey('a', 'b:c'));
  assert.notEqual(scopedKey('a', 'bc'), scopedKey('ab', 'c'));
  assert.notEqual(scopedKey('', 'abc'), scopedKey('abc', ''));
  assert.equal(scopedKey('proj_1', 'k'), scopedKey('proj_1', 'k'), 'and it is deterministic');
});

test('the idempotency key is scoped per project (MB1a)', () => {
  const a = new RefLayout('proj_alpha');
  const b = new RefLayout('proj_beta');
  // A client-supplied uuid colliding across projects must not make one
  // project's append absorb as the other's duplicate.
  assert.notEqual(a.dedupeRef('same-uuid'), b.dedupeRef('same-uuid'));
});

test('the ref path is the project scope, so identical task names cannot collide', () => {
  const a = new RefLayout('proj_alpha');
  const b = new RefLayout('proj_beta');
  assert.notEqual(a.claimRef('task_items'), b.claimRef('task_items'));
  assert.match(a.claimRef('task_items'), /^refs\/agentic\/proj_alpha\/claims\/task_items$/);
});

test('a path-traversing id is rejected, not sanitised', () => {
  // Quietly rewriting an id would make two different agents share one ref.
  // "../../heads/main" would rewrite a branch.
  assert.throws(() => new RefLayout('../../heads'), RangeError);
  const l = new RefLayout('proj_ok');
  assert.throws(() => l.claimRef('../../../heads/main'), RangeError);
  assert.throws(() => l.claimRef('has space'), RangeError);
  assert.throws(() => l.agentRef('..'), RangeError);
});

test('a heartbeat ref carries its timestamp in the NAME', () => {
  const l = new RefLayout('proj_x');
  const ref = l.heartbeatRef('agent_be01', 1787748287000);
  assert.equal(refParent(ref), 'agent_be01');
  assert.equal(parseSeq(refTail(ref)), 1787748287000);
  // This is the property that makes presence cost zero object reads: everything
  // needed to answer "is this agent alive" is in the listing.
});
