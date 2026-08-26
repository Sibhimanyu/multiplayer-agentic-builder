// Presence: heartbeat and listPresence, via Cache. NEVER a Data Store row.
//
// THE WHOLE POINT. The free tier allows 1,000 Data Store UPDATEs per MONTH. A 20 s
// heartbeat from a single agent is 4,320 a day, so one agent would exhaust the
// monthly allowance in 5.6 hours. Presence therefore lives in Cache, where a PUT
// is not an UPDATE, and the EXPIRY OF THE KEY IS THE STALENESS SIGNAL rather than
// something a reaper has to write.
//
// TWO CACHE QUIRKS THIS CODE IS SHAPED BY, both documented platform behaviours:
//
//  - `delete()` leaves a key present with a NULL value. So "absent" has two
//    representations and a null value must be treated as absent, not as a
//    zero-valued heartbeat.
//  - `update()` without an explicit expiry RESETS the TTL to 48 hours. Every
//    write here passes an explicit TTL for that reason; a heartbeat that
//    accidentally lived for two days would make a dead agent look connected
//    long after its laptop closed.

import type { AgentId, AgentStatus, ProjectId, TaskId } from '../../shared/store/types.ts';
import { STALE_AFTER_MS } from '../../shared/store/types.ts';
import { StoreError } from '../../shared/store/errors.ts';
import { sanitizeText, VARCHAR_MAX } from '../../shared/sanitize.ts';
import type { Logger } from '../../shared/log.ts';
import type { PresenceEntry } from '../../catalyst/lib/snapshot-fold.ts';
import type { Principal } from '../_lib/auth.ts';
import { requireProject } from '../_lib/auth.ts';
import type { HttpResponse } from '../_lib/http.ts';
import { json, rejectServerOwnedFields, requireString } from '../_lib/http.ts';

/** Cache TTL for a heartbeat. One hour: far longer than the 90 s staleness
 * threshold, so `stale` is decided by arithmetic on the timestamp rather than by
 * the key vanishing mid-session, but short enough that a dead agent disappears. */
export const PRESENCE_TTL_MS = 60 * 60_000;

/** Cache segment holding presence. Keys are project-scoped, same reasoning as
 * every other key on this platform: the namespace is shared. */
export const PRESENCE_SEGMENT = 'presence';

export function presenceKey(project_id: ProjectId, agent_id: AgentId): string {
  return `presence:${project_id}:${agent_id}`;
}

/** The value stored under a presence key. Kept small: Cache is not a database. */
export interface PresenceValue {
  status: AgentStatus;
  current_task: TaskId | null;
  branch: string | null;
  /** Epoch ms. The staleness computation needs a number, not a formatted date. */
  at_ms: number;
}

export interface PresencePort {
  /** Cache PUT with an EXPLICIT TTL. Never a Data Store write. */
  put(key: string, value: string, ttl_ms: number): Promise<void>;
  /** Returns null for both "no key" and "key with a null value". */
  get(key: string): Promise<string | null>;
  /** Bulk read for the dashboard. Missing keys are simply absent from the result. */
  getMany(keys: string[]): Promise<Map<string, string | null>>;
}

export interface PresenceDeps {
  port: PresencePort;
  log: Logger;
  now_ms: () => number;
  /** Agent ids in the project, from the `agents` table. */
  listAgentIds: (project_id: ProjectId) => Promise<AgentId[]>;
}

/**
 * Record a heartbeat.
 *
 * `agent_id` comes from the principal, never the body: a client that could name
 * another agent could fake its liveness and keep a dead agent's claim alive.
 */
export async function handleHeartbeat(
  deps: PresenceDeps, principal: Principal, body: unknown,
): Promise<HttpResponse> {
  rejectServerOwnedFields(body);
  const project_id = requireString(body, 'project_id');
  requireProject(principal, project_id);

  const status = requireString(body, 'status') as AgentStatus;
  if (!isAgentStatus(status)) throw new StoreError(`unknown agent status: ${status}`);

  const raw = body as { current_task?: unknown; branch?: unknown };
  const value: PresenceValue = {
    status,
    current_task: typeof raw.current_task === 'string' ? raw.current_task : null,
    branch: typeof raw.branch === 'string'
      ? sanitizeText(raw.branch, { field: 'presence.branch', max: VARCHAR_MAX, log: deps.log })
      : null,
    at_ms: deps.now_ms(),
  };

  await deps.port.put(
    presenceKey(project_id, principal.agent_id), JSON.stringify(value), PRESENCE_TTL_MS,
  );

  // Deliberately no Data Store write of any kind on this path. If this handler
  // ever grows one, the free-tier budget is gone in an afternoon.
  return json(204, null);
}

/** Read presence for every agent in the project, deriving `stale` at read time. */
export async function handleListPresence(
  deps: PresenceDeps, principal: Principal, project_id: ProjectId,
): Promise<HttpResponse> {
  requireProject(principal, project_id);
  const entries = await readPresence(deps, project_id);
  const now = deps.now_ms();
  return json(200, {
    presence: entries.map((e) => ({
      ...e,
      last_heartbeat_at: new Date(e.at_ms).toISOString(),
      // Derived, never stored (mandatory behaviour 7).
      stale: now - e.at_ms > STALE_AFTER_MS,
    })),
  });
}

/** The entries the snapshot fold consumes. Absent agents are simply not present. */
export async function readPresence(
  deps: PresenceDeps, project_id: ProjectId,
): Promise<PresenceEntry[]> {
  const ids = await deps.listAgentIds(project_id);
  if (ids.length === 0) return [];

  const keys = ids.map((id) => presenceKey(project_id, id));
  const found = await deps.port.getMany(keys);

  const out: PresenceEntry[] = [];
  ids.forEach((agent_id, i) => {
    const raw = found.get(keys[i]);
    // A null value is what `delete()` leaves behind. Absent, not zero.
    if (raw === null || raw === undefined || raw === '') return;
    const parsed = parsePresence(raw, deps.log, agent_id);
    if (parsed) out.push({ agent_id, ...parsed });
  });
  return out;
}

function parsePresence(
  raw: string, log: Logger, agent_id: AgentId,
): Omit<PresenceEntry, 'agent_id'> | null {
  try {
    const v = JSON.parse(raw) as Partial<PresenceValue>;
    if (typeof v.at_ms !== 'number' || !Number.isFinite(v.at_ms)) {
      // Without a usable timestamp there is no way to decide staleness, and
      // guessing "now" would make a dead agent look alive.
      log.warn('presence.no_timestamp', 'presence value had no usable at_ms, treated as absent', { agent_id });
      return null;
    }
    return {
      status: (v.status ?? 'idle') as AgentStatus,
      current_task: v.current_task ?? null,
      branch: v.branch ?? null,
      at_ms: v.at_ms,
    };
  } catch {
    log.warn('presence.unparseable', 'presence value did not parse, treated as absent', { agent_id });
    return null;
  }
}

const STATUSES: AgentStatus[] = [
  'connected', 'idle', 'working', 'blocked', 'reviewing', 'offline', 'revoked',
];

function isAgentStatus(v: string): v is AgentStatus {
  return (STATUSES as string[]).includes(v);
}
