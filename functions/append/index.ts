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
// Write order is deliberate: the dedupe row goes in FIRST, carrying the seq it
// reserved. A crash between the two writes leaves a dedupe row whose event is
// missing, and the replay path completes the write with the SAME seq rather than
// allocating a second one. The reverse order would let a crash produce two
// events for one request, which breaks A1 permanently.
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
  /** INSERT into events. Throws DuplicateValueError when seq collides. */
  insertEvent(row: Record<string, unknown>): Promise<void>;
  eventExists(seq: Seq): Promise<boolean>;
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
    if (!(await port.eventExists(prior.seq))) {
      // Crash recovery: the dedupe row landed, its event did not. Complete the
      // write with the SAME seq rather than allocating a new one.
      log.warn('append.completing_orphan_dedupe', 'dedupe row had no event; completing with the reserved seq', {
        project_id, idempotency_key, dedupe_key, seq: prior.seq,
      });
      await port.insertEvent(eventRow(prior.seq, project_id, layer, kind, principal, clean_body, now(), log));
    }
    return json(200, { event_id: prior.event_id, seq: prior.seq, duplicate: true });
  }

  const allocation = await allocateSeqAndInsert<void>({
    maxSeq: () => port.maxSeq(),
    insert: async (seq) => {
      // Reserve first: the dedupe row is what makes the append idempotent.
      try {
        await port.insertDedupe({
          dedupe_key, idempotency_key, project_id, seq,
          event_id: eventIdFor(seq), created_at: now(),
        });
      } catch (err) {
        if (err instanceof DuplicateValueError && err.column === 'dedupe_key') {
          // Two identical requests in flight at once. Rethrown so the allocator
          // leaves it alone -- a higher seq does not fix a replay.
          throw err;
        }
        throw err;
      }
      await port.insertEvent(eventRow(seq, project_id, layer, kind, principal, clean_body, now(), log));
    },
  }, { log, op: 'append' }).catch(async (err: unknown) => {
    if (err instanceof DuplicateValueError && err.column === 'dedupe_key') {
      const existing = await port.findDedupe(dedupe_key);
      if (existing) return { seq: existing.seq, result: undefined, attempts: 1, selects: 1 };
    }
    throw err;
  });

  return json(201, {
    event_id: eventIdFor(allocation.seq), seq: allocation.seq, duplicate: false,
  });
}

function eventRow(
  seq: Seq, project_id: ProjectId, layer: string, kind: string,
  principal: Principal, clean_body: Record<string, unknown>, created_at: string, log: Logger,
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
    body: JSON.stringify(clean_body),
  };
}
