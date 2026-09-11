// Presence on the Realtime Database. Order 0040.
//
// Why RTDB for presence and nothing else:
//
//   onDisconnect() is a SERVER-SIDE hook. The client registers it once, and the RTDB server
//   executes it when the socket drops -- including when the laptop's lid closes and nothing
//   client-side gets to run. Firestore has no equivalent, which is why a dead agent is
//   currently invisible for the full 90 s staleness timeout.
//
//   RTDB bills BANDWIDTH (bytes downloaded), not operations. Presence is the highest-frequency
//   write in the system and the binding constraint on Firestore's 20,000 writes/day. Moving it
//   to a meter it does not saturate is the point.
//
// What stays on Firestore, per the order's scope ruling: the ledger, claims, and the doorbell.
// onSnapshot is already a persistent WebChannel connection and is where the measured 191 ms
// publish-to-visible comes from. Notifying on RTDB and then reading Firestore would add a round
// trip to a path that already works.
//
// PATHS, and the composite-key rule. RTDB paths are hierarchical, so presence lives at
//   presence/{project_id}/{agent_id}
// and there is no composite key to build. That is deliberate: NUL bytes have twice appeared in
// this codebase from joining ids with a separator, and the fix both times was to stop joining.

import type { Database, Reference } from 'firebase-admin/database';

import type { PresenceBackend, StoredPresence } from './presence.ts';
import type { AgentId, AgentStatus, ProjectId, TaskId } from '../shared/store/types.ts';
import type { Clock } from '../shared/clock.ts';
import type { Logger } from '../shared/log.ts';

export interface RtdbPresenceOptions {
  db: Database;
  clock: Clock;
  log: Logger;
  /**
   * Register onDisconnect handlers. Off by default.
   *
   * A server process that heartbeats on behalf of many agents must NOT register these: its
   * socket dropping would mark every agent offline at once. Only a process that owns exactly
   * one agent's presence -- the CLI -- should turn this on.
   */
  on_disconnect?: boolean;
}

export class RtdbPresence implements PresenceBackend {
  private readonly db: Database;
  private readonly clock: Clock;
  private readonly log: Logger;
  private readonly on_disconnect: boolean;
  /** Agents whose onDisconnect is already registered, so it is not re-registered per beat. */
  private readonly armed = new Set<string>();

  constructor(opts: RtdbPresenceOptions) {
    this.db = opts.db;
    this.clock = opts.clock;
    this.log = opts.log;
    this.on_disconnect = opts.on_disconnect ?? false;
  }

  private ref(pid: ProjectId, agent_id?: AgentId): Reference {
    const base = this.db.ref(`presence/${pid}`);
    return agent_id ? base.child(agent_id) : base;
  }

  async write(
    pid: ProjectId,
    agent_id: AgentId,
    status: AgentStatus,
    current_task: TaskId | null,
    branch: string | null,
  ): Promise<void> {
    const ref = this.ref(pid, agent_id);

    // Armed once per agent per process, before the first write. onDisconnect is registered ON
    // THE SERVER, so re-registering it every heartbeat would be a wasted round trip per beat --
    // which on a bandwidth meter is the one thing worth not doing.
    const key = `${pid}/${agent_id}`;
    if (this.on_disconnect && !this.armed.has(key)) {
      // Only `connected` and `status`. NOT last_heartbeat_ms: `stale` is derived from that
      // value against the adapter's clock, and letting the server write it would put a
      // server-owned timestamp into a field A9 drives with a fake clock.
      await ref.onDisconnect().update({ connected: false, status: 'offline' satisfies AgentStatus });
      this.armed.add(key);
      this.log.info('rtdb.presence.armed', 'onDisconnect armed for agent', { project_id: pid, agent_id });
    }

    await ref.update({
      agent_id,
      status,
      current_task,
      branch,
      // The adapter's clock, never database.ServerValue.TIMESTAMP -- see presence.ts.
      last_heartbeat_ms: this.clock.now(),
      connected: true,
    });
  }

  async list(pid: ProjectId): Promise<StoredPresence[]> {
    const snap = await this.ref(pid).get();
    // `it did not throw` is not success: a missing node returns a snapshot whose val() is null,
    // and .val() on a non-existent path is indistinguishable from an empty project unless it is
    // checked explicitly.
    if (!snap.exists()) return [];
    const val = snap.val() as Record<string, StoredPresence> | null;
    if (val === null || typeof val !== 'object') return [];
    return Object.entries(val).map(([agent_id, row]) => ({ ...row, agent_id: row.agent_id ?? agent_id }));
  }

  async register(pid: ProjectId, row: StoredPresence): Promise<void> {
    await this.ref(pid, row.agent_id).update({ ...row, connected: true });
  }

  async setRevoked(pid: ProjectId, agent_id: AgentId, revoked: boolean): Promise<void> {
    await this.ref(pid, agent_id).update({ revoked });
  }

  async isRevoked(pid: ProjectId, agent_id: AgentId): Promise<boolean | undefined> {
    const snap = await this.ref(pid, agent_id).child('revoked').get();
    if (!snap.exists()) return undefined;
    return snap.val() === true;
  }

  async close(): Promise<void> {
    this.armed.clear();
    await this.db.goOffline();
  }
}
