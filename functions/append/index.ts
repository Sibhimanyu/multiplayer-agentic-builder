// POST /append -- append one event to the ledger.
//
// Two guarantees, both from store-interface.md:
//
//   A1 idempotency. The same idempotency_key twice returns the ORIGINAL
//      {event_id, seq} and appends nothing. request_dedupe.dedupe_key is unique,
//      so the second attempt loses the INSERT rather than being checked for --
//      a read-then-write would be racy.
//
//      The dedupe key is COMPOSITE, "<project_id>:<idempotency_key>", because
//      is_unique is table-global and the key is CLIENT-SUPPLIED. A bare
//      unique(idempotency_key) would let one project's key silently swallow
//      another project's append as a duplicate: cross-tenant event loss.
//      Mandatory behaviour 2.
//
//   4  strictly ascending seq, via the global allocator (order 0005). NOT ROWID.
//
// WRITE ORDER, and why it is the opposite of what it first looks like.
//
// The obvious design writes the dedupe row first, reserving a seq, then writes
// the event. It is wrong, and the schema dry run caught it under concurrency:
// the seq retry loop re-runs its whole body, so attempt 2 re-inserts the SAME
// dedupe row and collides with its own attempt 1. Every contended append then
// failed with a duplicate error on a key it had just written itself. Eleven of
// twelve concurrent appends died that way.
//
// Nor can the dedupe row simply be hoisted out of the retry: it has to record
// the seq the event ACTUALLY got, and that is not known until the retry settles.
// Recording the first candidate would make a replay return a seq belonging to a
// different event -- silent corruption, which is worse than the failure.
//
// So: EVENT FIRST, carrying its dedupe_key, then the dedupe row.
//   - a seq collision retries the event insert alone, with nothing to collide with
//   - the dedupe row is written once, with the settled seq
//   - the crash window (event written, dedupe row missing) is recoverable
//     WITHOUT an UPDATE, because events.dedupe_key can be read back
//
// events.dedupe_key is deliberately NOT unique. The unique guard stays on
// request_dedupe, so the seq retry has exactly one unique column to fight over.
//
// NOT WIRED: Data Store calls are behind AppendPort. Needs a project ID.

import type { EventInput, ProjectId, Seq } from '../../shared/store/types.ts';
import { LAYER_OF } from '../../shared/store/types.ts';
import { StoreError } from '../../shared/store/errors.ts';
import { sanitizeBody, sanitizeText, VARCHAR_MAX } from '../../shared/sanitize.ts';
import type { Logger } from '../../shared/log.ts';
import { DuplicateValueError } from '../../catalyst/lib/duplicate.ts';
import { compositeKey } from '../../catalyst/schema/tables.ts';
import { allocateSeqAndInsert } from '../../catalyst/lib/seq.ts';
import type { Principal } from '../_lib/auth.ts';
import { requireProject } from '../_lib/auth.ts';
import type { HttpResponse } from '../_lib/http.ts';
import { json, rejectServerOwnedFields, requireString } from '../_lib/http.ts';

export interface DedupeRow {
  dedupe_key: string; idempotency_key: string; project_id: ProjectId; seq: Seq; event_id: string;
}

export interface AppendPort {
  maxSeq(): Promise<number>;
  /** INSERT into request_dedupe. Throws DuplicateValueError on a replay. */
  insertDedupe(row: DedupeRow & { created_at: string }): Promise<void>;
  findDedupe(dedupe_key: string): Promise<DedupeRow | null>;
  /** Crash recovery: the event for this request, if it already landed. */
  findEventByDedupeKey(dedupe_key: string): Promise<{ seq: Seq; event_id: string } | null>;
  /** INSERT into events. Throws DuplicateValueError when seq collides. */
  insertEvent(row: Record<string, unknown>): Promise<void>;
}

export function eventIdFor(seq: Seq): string {
  return `evt_${seq.toString(36).padStart(6, '0')}`;
}

/** Project-scoped dedupe key. See the header: the raw key comes from a client. */
export function dedupeKeyFor(project_id: ProjectId, idempotency_key: string): string {
  return compositeKey(project_id, idempotency_key);
}

export async function handleAppend(
  port: AppendPort, principal: Principal, body: unknown,
  idempotency_key: string, now: () => string, log: Logger,
): Promise<HttpResponse> {
  rejectServerOwnedFields(body);
  const project_id = requireString(body, 'project_id');
  const kind = requireString(body, 'kind') as EventInput['kind'];
  requireProject(principal, project_id);

  const layer = LAYER_OF[kind];
  if (layer === undefined) throw new StoreError(`unknown event kind: ${kind}`);

  const raw_body = (body as { body?: unknown }).body ?? {};
  if (raw_body === null || typeof raw_body !== 'object') {
    throw new StoreError('event body must be an object');
  }

  // Strip emoji / 4-byte UTF-8 and clamp to the column caps BEFORE the write,
  // logging whatever was dropped. Both builds do this so their ledgers match.
  const clean_body = sanitizeBody(raw_body as Record<string, unknown>, log, `${kind}.body`);

  const dedupe_key = dedupeKeyFor(project_id, idempotency_key);

  // A replay short-circuits before any allocation.
  const prior = await port.findDedupe(dedupe_key);
  if (prior) {
    return json(200, { event_id: prior.event_id, seq: prior.seq, duplicate: true });
  }

  // Crash recovery: the event landed but its dedupe row did not. Adopt the seq
  // that is already in the ledger rather than appending a second copy.
  const orphan = await port.findEventByDedupeKey(dedupe_key);
  if (orphan) {
    log.warn('append.adopting_orphan_event', 'event existed with no dedupe row; adopting its seq', {
      project_id, idempotency_key, dedupe_key, seq: orphan.seq,
    });
    await port.insertDedupe({
      dedupe_key, idempotency_key, project_id, seq: orphan.seq,
      event_id: orphan.event_id, created_at: now(),
    }).catch((err: unknown) => {
      // Another recoverer won. Harmless: the row it wrote says the same thing.
      if (err instanceof DuplicateValueError && err.column === 'dedupe_key') return;
      throw err;
    });
    return json(200, { event_id: orphan.event_id, seq: orphan.seq, duplicate: true });
  }

  const allocation = await allocateSeqAndInsert<void>({
    maxSeq: () => port.maxSeq(),
    // Only the event insert is retried, and `seq` is the only unique column it
    // touches, so a retry can never collide with its own earlier attempt.
    insert: async (seq) => {
      await port.insertEvent(
        eventRow(seq, project_id, layer, kind, principal, clean_body, now(), log, dedupe_key),
      );
    },
  }, { log, op: 'append' });

  try {
    await port.insertDedupe({
      dedupe_key, idempotency_key, project_id, seq: allocation.seq,
      event_id: eventIdFor(allocation.seq), created_at: now(),
    });
  } catch (err) {
    if (err instanceof DuplicateValueError && err.column === 'dedupe_key') {
      // A concurrent request with the SAME idempotency key beat us to the guard.
      // Ours is the duplicate, so report the winner's seq, not our own.
      const winner = await port.findDedupe(dedupe_key);
      if (winner) {
        log.warn('append.lost_dedupe_race', 'a concurrent request with the same key won the guard', {
          project_id, idempotency_key, dedupe_key, our_seq: allocation.seq, winner_seq: winner.seq,
        });
        return json(200, { event_id: winner.event_id, seq: winner.seq, duplicate: true });
      }
    }
    throw err;
  }

  return json(201, {
    event_id: eventIdFor(allocation.seq), seq: allocation.seq, duplicate: false,
  });
}

function eventRow(
  seq: Seq, project_id: ProjectId, layer: string, kind: string,
  principal: Principal, clean_body: Record<string, unknown>, created_at: string, log: Logger,
  dedupe_key: string,
): Record<string, unknown> {
  return {
    seq,
    event_id: eventIdFor(seq),
    project_id,
    layer,
    kind,
    actor_type: 'agent',
    // Resolved from the token, never from the request. H4.
    actor_id: sanitizeText(principal.agent_id, { field: 'events.actor_id', max: VARCHAR_MAX, log }),
    created_at,
    dedupe_key,
    body: JSON.stringify(clean_body),
  };
}
