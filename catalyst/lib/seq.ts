// Global `seq` allocation for the Catalyst ledger.
//
// Authorised by order 0005 and mandatory behaviour 4 in store-interface.md.
//
// Why this file exists at all: Catalyst has no sequence primitive, and ROWID --
// which the spec originally named -- is allocated from per-shard blocks and runs
// BACKWARDS across separate INSERTs. A live probe measured insert #1 at ...052001
// and insert #2 at ...044002. A reader sitting at cursor 052001 would never be
// delivered the event that landed at 044002, so this was silent event loss
// wearing an ordering bug's clothes.
//
// The mechanism is the same unique-constraint compare-and-set that claimTask
// uses, which the probe verified works on this platform:
//
//   candidate = SELECT MAX(seq) FROM events        -- ONE read, NO project filter
//   loop, bounded at 20:
//     INSERT ... seq = candidate + 1
//     on DUPLICATE_VALUE(seq) -> candidate += 1, retry   -- increment, never re-read
//   exhausted -> StoreBusyError
//
// TWO RULES THAT LOOK LIKE STYLE AND ARE NOT:
//
// 1. ALLOCATE GLOBALLY. `MAX(seq) WHERE project_id = ?` deadlocks against a
//    globally-unique column: project A holds seq 6; project B computes its own
//    max of 5, tries 6, collides, recomputes 5, tries 6 forever. Filter by
//    project on READ, never on allocation. (Caught by the coordinator in 0005 --
//    the first draft of this had exactly that bug.)
//
// 2. INCREMENT ON CONFLICT, DO NOT RE-READ. Re-reading MAX after a collision
//    reintroduces the same spin under contention: every racer re-reads the same
//    value and re-collides. Incrementing walks each racer up its own ladder, so
//    N concurrent appends settle in N attempts worst case rather than never.
//
// Per-project gaps get large. Gaps are legal under mandatory behaviour 4;
// reordering is not.

import type { Seq } from '../../shared/store/types.ts';
import { StoreBusyError, StoreError } from '../../shared/store/errors.ts';
import type { Logger } from '../../shared/log.ts';
import { nullLogger } from '../../shared/log.ts';
import { DuplicateValueError } from './duplicate.ts';

/** The unique column that carries the sequence. */
export const SEQ_COLUMN = 'seq';

/**
 * Attempts before giving up. 20 tolerates far more contention than the platform
 * allows anyway -- a Catalyst function caps at 10 concurrent executions per
 * environment, so 20 racers cannot exist in one env in the first place.
 */
export const SEQ_MAX_ATTEMPTS = 20;

export interface SeqAllocatorPort<T> {
  /**
   * `SELECT MAX(seq) FROM events` -- globally, with NO project filter.
   * Returns 0 for an empty table. See rule 1 above before adding a parameter.
   */
  maxSeq(): Promise<number>;

  /**
   * Insert the row carrying this seq. MUST throw DuplicateValueError when a
   * unique column collides, with `column` naming which one.
   */
  insert(seq: Seq): Promise<T>;
}

export interface AllocateOptions {
  max_attempts?: number;
  log?: Logger;
  /** Included in log lines so a contended append is traceable. */
  op?: string;
}

export interface AllocateResult<T> {
  seq: Seq;
  result: T;
  /** INSERTs issued, including the successful one. 1 means uncontended. */
  attempts: number;
  /** SELECTs issued. Always exactly 1 -- the thing G4 needs to know. */
  selects: number;
}

/**
 * Allocate the next global seq and insert with it, retrying only a genuine seq
 * collision.
 *
 * A DUPLICATE_VALUE on any OTHER column is rethrown untouched. That is the whole
 * reason the column is parsed: a replayed `idempotency_key` must surface as a
 * replay, and incrementing the seq to "fix" it would append a second copy of an
 * event the caller already has.
 */
export async function allocateSeqAndInsert<T>(
  port: SeqAllocatorPort<T>,
  opts: AllocateOptions = {},
): Promise<AllocateResult<T>> {
  const max_attempts = opts.max_attempts ?? SEQ_MAX_ATTEMPTS;
  const log = opts.log ?? nullLogger;
  const op = opts.op ?? 'events.append';

  if (max_attempts < 1) throw new StoreError(`max_attempts must be >= 1, got ${max_attempts}`);

  const observed = await port.maxSeq();
  if (!Number.isFinite(observed) || !Number.isInteger(observed) || observed < 0) {
    // Never coerce. A NaN here would allocate seq NaN and corrupt every cursor
    // comparison downstream, silently.
    throw new StoreError(`MAX(seq) returned a non-integer: ${String(observed)}`);
  }

  let candidate = observed;

  for (let attempt = 1; attempt <= max_attempts; attempt += 1) {
    const seq = candidate + 1;
    try {
      const result = await port.insert(seq);
      if (attempt > 1) {
        log.info('seq.allocated_after_contention', 'seq allocated after losing races', {
          op, seq, attempts: attempt, started_from: observed + 1,
        });
      }
      return { seq, result, attempts: attempt, selects: 1 };
    } catch (err) {
      if (!(err instanceof DuplicateValueError)) throw err;

      if (err.column !== SEQ_COLUMN) {
        // Not our race. A replayed idempotency_key, a lost claim, or a Catalyst
        // message format we no longer recognise (column === null). All three
        // belong to the caller, and none is fixed by a higher seq.
        log.info('seq.duplicate_on_other_column', 'duplicate on a non-seq column, not retrying', {
          op, column: err.column, attempt, backend_message: err.backend_message,
        });
        throw err;
      }

      // Increment, do NOT re-read. See rule 2 above.
      candidate += 1;
      log.debug('seq.collision', 'seq taken by a concurrent append, incrementing', {
        op, tried: seq, next: candidate + 1, attempt,
      });
    }
  }

  const exhausted = new StoreBusyError(
    `seq allocation lost ${max_attempts} consecutive races starting at ${observed + 1}`,
  );
  log.error('seq.exhausted', 'seq allocation exhausted its attempts', {
    op, max_attempts, started_from: observed + 1, next_would_be: candidate + 1,
  });
  throw exhausted;
}
