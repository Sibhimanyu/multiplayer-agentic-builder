// Tests for global seq allocation (order 0005).
//
// Driven through a fake port that enforces a real unique index, so contention is
// exercised rather than described. No project ID and no cloud needed -- this is
// the part of step 4 that could be built while the project ID is outstanding.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { allocateSeqAndInsert, SEQ_MAX_ATTEMPTS } from './seq.ts';
import type { SeqAllocatorPort } from './seq.ts';
import { DuplicateValueError } from './duplicate.ts';
import { StoreBusyError, StoreError, isRetryable } from '../../shared/store/errors.ts';
import { CapturingLogger } from '../../shared/log.ts';

/**
 * Stands in for the `events` table: one global unique index on seq, shared by
 * every allocator pointed at it. Counts reads so "exactly one SELECT" is a
 * measured fact, which is what G4 needs.
 */
class FakeEventsTable {
  readonly taken = new Set<number>();
  selects = 0;
  inserts = 0;
  /** Rows as inserted, to prove nothing was lost under contention. */
  readonly rows: { seq: number; label: string }[] = [];

  constructor(taken: number[] = []) { for (const s of taken) this.taken.add(s); }

  /** Global MAX(seq), no project filter. 0 when empty. */
  maxSeq = async (): Promise<number> => {
    this.selects += 1;
    await Promise.resolve();
    return this.taken.size === 0 ? 0 : Math.max(...this.taken);
  };

  port(label: string, onInsert?: () => Promise<void>): SeqAllocatorPort<{ seq: number }> {
    return {
      maxSeq: this.maxSeq,
      insert: async (seq: number) => {
        this.inserts += 1;
        if (onInsert) await onInsert();
        // The await above is the interleaving window. The check-and-set below is
        // synchronous, exactly as the unique index is.
        if (this.taken.has(seq)) {
          throw new DuplicateValueError('Duplicate value for seq. Please give a different value');
        }
        this.taken.add(seq);
        this.rows.push({ seq, label });
        return { seq };
      },
    };
  }
}

describe('seq allocation (order 0005)', () => {
  test('empty ledger allocates seq 1 with exactly one SELECT', async () => {
    const table = new FakeEventsTable();
    const out = await allocateSeqAndInsert(table.port('a'));
    assert.equal(out.seq, 1);
    assert.equal(out.attempts, 1);
    assert.equal(out.selects, 1);
    assert.equal(table.selects, 1);
  });

  test('non-empty ledger allocates MAX + 1', async () => {
    const table = new FakeEventsTable([1, 2, 41]);
    const out = await allocateSeqAndInsert(table.port('a'));
    assert.equal(out.seq, 42);
    assert.equal(out.attempts, 1);
  });

  test('a collision increments the candidate and NEVER re-reads MAX', async () => {
    // We read MAX = 41, then 42, 43 and 44 land before our first insert. MAX
    // would now report 44, but we must walk up from what we read, not re-read.
    const table2 = new FakeEventsTable([41]);
    const port = table2.port('a');
    let firstInsert = true;
    const racingPort: SeqAllocatorPort<{ seq: number }> = {
      maxSeq: port.maxSeq,
      insert: async (seq) => {
        if (firstInsert) {
          firstInsert = false;
          table2.taken.add(42); table2.taken.add(43); table2.taken.add(44);
        }
        return port.insert(seq);
      },
    };

    const out = await allocateSeqAndInsert(racingPort);
    assert.equal(out.seq, 45, 'should walk 42,43,44 then take 45');
    assert.equal(out.attempts, 4);
    assert.equal(out.selects, 1, 'exactly one SELECT no matter how many collisions');
    assert.equal(table2.selects, 1);
  });

  test('REGRESSION: a project whose own max lags the global max does not spin', async () => {
    // The deadlock the coordinator caught in 0005. Project A holds seq 6.
    // Project B's own rows stop at 5. A per-project MAX(seq WHERE project=B)
    // would compute 5, try 6, collide, recompute 5, and try 6 forever.
    //
    // Allocating globally, B reads 6 and takes 7 on the first attempt.
    const table = new FakeEventsTable([1, 2, 3, 4, 5, 6]);
    const out = await allocateSeqAndInsert(table.port('project_b'));
    assert.equal(out.seq, 7);
    assert.equal(out.attempts, 1, 'global allocation must not race here at all');
  });

  test('20 concurrent allocators get 20 distinct seqs, none lost', async () => {
    const table = new FakeEventsTable([100]);
    // Every allocator reads MAX before any of them inserts: maximum contention.
    const N = 20;
    const gate = { open: false as boolean };
    const results = await Promise.all(
      Array.from({ length: N }, (_u, i) =>
        allocateSeqAndInsert(table.port(`agent_${i}`, async () => {
          if (!gate.open) { gate.open = true; await Promise.resolve(); }
        }))),
    );

    const seqs = results.map((r) => r.seq);
    assert.equal(new Set(seqs).size, N, `expected ${N} distinct seqs, got ${seqs.join(',')}`);
    assert.equal(table.rows.length, N, 'every append must land');
    for (const s of seqs) assert.ok(s > 100, 'every seq is above the pre-existing max');
    // Dense: N racers starting from 100 fill exactly 101..120.
    assert.deepEqual([...seqs].sort((a, b) => a - b), Array.from({ length: N }, (_u, i) => 101 + i));
  });

  test('exhausting the attempt bound throws StoreBusyError, and it is retryable', async () => {
    const alwaysTaken: SeqAllocatorPort<never> = {
      maxSeq: async () => 0,
      insert: async () => {
        throw new DuplicateValueError('Duplicate value for seq. Please give a different value');
      },
    };
    const log = new CapturingLogger();

    await assert.rejects(
      () => allocateSeqAndInsert(alwaysTaken, { log }),
      (err: unknown) => {
        assert.ok(err instanceof StoreBusyError, `expected StoreBusyError, got ${String(err)}`);
        assert.equal(isRetryable(err), true, 'the CLI must be allowed to back off and retry');
        return true;
      },
    );
    assert.ok(log.has('seq.exhausted'), 'exhaustion must be logged, never silent');
    assert.equal(log.withCode('seq.exhausted')[0].fields.max_attempts, SEQ_MAX_ATTEMPTS);
  });

  test('a duplicate on a NON-seq column is rethrown, not retried', async () => {
    // A replayed idempotency_key. Incrementing the seq to "fix" this would
    // append a second copy of an event the caller already has -- breaking A1.
    let attempts = 0;
    const port: SeqAllocatorPort<never> = {
      maxSeq: async () => 10,
      insert: async () => {
        attempts += 1;
        throw new DuplicateValueError(
          'Duplicate value for idempotency_key. Please give a different value',
        );
      },
    };
    const log = new CapturingLogger();

    await assert.rejects(
      () => allocateSeqAndInsert(port, { log }),
      (err: unknown) => {
        assert.ok(err instanceof DuplicateValueError);
        assert.equal((err as DuplicateValueError).column, 'idempotency_key');
        return true;
      },
    );
    assert.equal(attempts, 1, 'must not retry a duplicate on another column');
    assert.ok(log.has('seq.duplicate_on_other_column'));
  });

  test('an unrecognised duplicate message is rethrown rather than assumed to be seq', async () => {
    // If Catalyst changes the message format, column parses to null. Guessing
    // "probably seq" would silently mis-route it; this must surface loudly.
    let attempts = 0;
    const port: SeqAllocatorPort<never> = {
      maxSeq: async () => 0,
      insert: async () => {
        attempts += 1;
        throw new DuplicateValueError('some new phrasing nobody anticipated');
      },
    };
    await assert.rejects(() => allocateSeqAndInsert(port), (err: unknown) => {
      assert.ok(err instanceof DuplicateValueError);
      assert.equal((err as DuplicateValueError).column, null);
      return true;
    });
    assert.equal(attempts, 1);
  });

  test('a non-duplicate error is not swallowed', async () => {
    const port: SeqAllocatorPort<never> = {
      maxSeq: async () => 0,
      insert: async () => { throw new StoreError('connection reset'); },
    };
    await assert.rejects(() => allocateSeqAndInsert(port), /connection reset/);
  });

  test('a non-integer MAX(seq) throws instead of allocating seq NaN', async () => {
    const port: SeqAllocatorPort<never> = {
      maxSeq: async () => Number.NaN,
      insert: async () => { throw new Error('should never be reached'); },
    };
    await assert.rejects(() => allocateSeqAndInsert(port), /non-integer/);
  });
});
