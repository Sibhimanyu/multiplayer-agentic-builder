// GET /events?since_seq=&limit= -- read the ledger forward from a cursor.
//
// ORDER BY seq, never ROWID (order 0005). Capped at 300, and the cap is REPORTED
// rather than applied silently: has_more comes from asking for one row more than
// the limit, so it is measured rather than guessed.
//
// The human layer is filtered out for agent callers. That exclusion is normative
// -- an agent subscription that includes human-layer events is a protocol
// violation, and it is the rule the protocol calls its most important.
//
// NOT WIRED: the ZCQL call is behind EventsPort. Needs a project ID.

import type { Event, Layer, ProjectId, Seq } from '../../shared/store/types.ts';
import { LIMITS } from '../../shared/store/types.ts';
import type { Logger } from '../../shared/log.ts';
import { capLimit, probeMoreAfter, selectEvents, unwrapRows } from '../../catalyst/lib/zcql.ts';
import type { Principal } from '../_lib/auth.ts';
import { requireProject } from '../_lib/auth.ts';
import type { HttpResponse } from '../_lib/http.ts';
import { json } from '../_lib/http.ts';

export interface EventsPort { query(zcql: string): Promise<unknown> }

/** Agents receive contract and coordination events. Never human-layer. */
export const AGENT_LAYERS: Layer[] = ['contract', 'coordination'];

export async function handleEvents(
  port: EventsPort, principal: Principal, params: { project_id: ProjectId; since_seq: Seq; limit?: number },
  audience: 'agent' | 'dashboard', log: Logger,
): Promise<HttpResponse> {
  requireProject(principal, params.project_id);

  const cap = capLimit(params.limit ?? LIMITS.events);
  const { query, needs_probe } = selectEvents(params.project_id, params.since_seq, cap.applied);
  const rows = unwrapRows<Record<string, unknown>>(await port.query(query), 'events');

  const page = rows.length > cap.applied ? rows.slice(0, cap.applied) : rows;
  let over = rows.length > cap.applied;

  // At the 300 cap the over-fetch trick is unavailable, because ZCQL rejects a
  // LIMIT above 300 rather than clamping it. One extra SELECT, and only when the
  // page came back full.
  if (!over && needs_probe && page.length === cap.applied && page.length > 0) {
    const last = Number(page[page.length - 1].seq);
    const more = unwrapRows<Record<string, unknown>>(
      await port.query(probeMoreAfter(params.project_id, last)), 'events');
    over = more.length > 0;
  }

  if (cap.capped || over) {
    log.warn('store.events.capped', 'readEvents hit the row cap', {
      project_id: params.project_id, since_seq: params.since_seq,
      requested: cap.requested, applied: cap.applied, returned: page.length,
      dropped: rows.length - page.length, has_more: over,
    });
  }

  const events = page.map(toEvent);
  const delivered = audience === 'agent'
    ? events.filter((e) => AGENT_LAYERS.includes(e.layer))
    : events;

  if (audience === 'agent' && delivered.length !== events.length) {
    log.debug('events.human_layer_withheld', 'human-layer events withheld from an agent', {
      project_id: params.project_id, withheld: events.length - delivered.length,
    });
  }

  // The cursor advances past everything READ, not everything delivered --
  // otherwise a page of only human-layer events would loop forever.
  const next_cursor = page.length > 0 ? Number(page[page.length - 1].seq) : params.since_seq;

  return json(200, { events: delivered, next_cursor, has_more: over });
}

function toEvent(row: Record<string, unknown>): Event {
  return {
    event_id: String(row.event_id),
    project_id: String(row.project_id),
    seq: Number(row.seq),
    layer: row.layer as Layer,
    kind: row.kind as Event['kind'],
    actor_type: row.actor_type as Event['actor_type'],
    actor_id: String(row.actor_id),
    created_at: String(row.created_at),
    body: parseBody(row.body),
  };
}

function parseBody(raw: unknown): Record<string, unknown> {
  if (raw === null || raw === undefined) return {};
  if (typeof raw === 'object') return raw as Record<string, unknown>;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch {
    // A body that will not parse is not silently emptied -- the caller sees the
    // raw text and knows something is wrong with that row.
    return { _unparseable: String(raw) };
  }
}
