// Presence, behind a seam, so the backing store can change without the port changing.
//
// Order 0040: presence moves to RTDB. `heartbeat` and `listPresence` keep their exact
// signatures on CoordinationStore -- only what backs them changes. That is the whole point of
// this file: FirestoreStore delegates to a PresenceBackend, and which backend it holds is a
// constructor argument rather than a rewrite.
//
// WHAT DOES NOT MOVE, and why it must not:
//
//   `stale` STAYS DERIVED, in the adapter, from last_heartbeat_ms and the injected clock.
//
// Conformance A9 (shared/store/conformance.ts:287) drives staleness with `advanceTime`, a fake
// clock, and asserts stale is false one second early, true two seconds later, and clears on a
// fresh heartbeat "with no repair step". Its comment says "Derived, not stored." If `stale`
// came from RTDB server state -- a serverTimestamp, a connection flag, anything the platform
// owns -- the fake clock could not move it and A9 would fail. Read A9 before touching this.
//
// So there are TWO signals with different meanings, and they are not interchangeable:
//
//   stale    derived, last_heartbeat_at + 90s   the agent stopped reporting
//   offline  RTDB onDisconnect, server-side     the socket actually dropped
//
// onDisconnect is the faster one and it is the reason to be on RTDB at all: Firestore has no
// server-side hook that fires when a client vanishes, so a dead laptop is invisible until the
// staleness timeout expires. Both converge on the same grey ring in the dashboard, which is
// what the design asks for, while remaining distinct fields.

import { STALE_AFTER_MS, type AgentId, type AgentPresence, type AgentStatus, type ProjectId, type TaskId } from '../shared/store/types.ts';
import type { Clock } from '../shared/clock.ts';

/** The stored shape, shared by both backends so the derivation below is identical. */
export interface StoredPresence {
  agent_id: string;
  role_slug?: string;
  member_label?: string;
  initials?: string;
  harness?: AgentPresence['harness'];
  status?: AgentStatus;
  current_task?: string | null;
  branch?: string | null;
  last_heartbeat_ms?: number | null;
  revoked?: boolean;
  /**
   * Written false by RTDB's onDisconnect handler when the socket drops.
   *
   * Absent means "no opinion" -- the Firestore backend never sets it -- and absent must be
   * treated as connected, or every Firestore-backed agent would render offline.
   */
  connected?: boolean;
}

export interface PresenceBackend {
  /** Same signature as CoordinationStore.heartbeat, minus the revocation check. */
  write(
    pid: ProjectId,
    agent_id: AgentId,
    status: AgentStatus,
    current_task: TaskId | null,
    branch: string | null,
  ): Promise<void>;
  list(pid: ProjectId): Promise<StoredPresence[]>;
  register(pid: ProjectId, row: StoredPresence): Promise<void>;
  setRevoked(pid: ProjectId, agent_id: AgentId, revoked: boolean): Promise<void>;
  /** Cached revocation lookups still need a read; returns undefined if there is no row. */
  isRevoked(pid: ProjectId, agent_id: AgentId): Promise<boolean | undefined>;
  close(): Promise<void>;
}

/**
 * The one derivation, in one place, used by every backend.
 *
 * Kept out of the backends deliberately: if each backend derived `stale` itself, the RTDB one
 * would eventually be "improved" to use a server timestamp and A9 would start failing under the
 * fake clock with no obvious cause.
 */
export function toPresence(a: StoredPresence, clock: Clock): AgentPresence {
  const hb = a.last_heartbeat_ms ?? null;
  // Absent `connected` means the backend has no opinion, NOT that the agent is gone.
  const dropped = a.connected === false;
  return {
    agent_id: a.agent_id,
    role_slug: a.role_slug ?? 'unknown',
    member_label: a.member_label ?? a.agent_id,
    initials: a.initials ?? a.agent_id.slice(-2).toUpperCase(),
    harness: a.harness ?? 'manual',
    // Precedence: revoked is a decision about the token and outranks everything. A dropped
    // socket outranks whatever the agent last claimed to be doing, because that claim is stale
    // by definition once the connection is gone.
    status: a.revoked ? 'revoked' : dropped ? 'offline' : (a.status ?? 'offline'),
    current_task: a.current_task ?? null,
    branch: a.branch ?? null,
    last_heartbeat_at: hb === null ? null : new Date(hb).toISOString(),
    // DERIVED. Never read from server state -- see the header and A9.
    stale: hb === null || clock.now() - hb > STALE_AFTER_MS,
  };
}
