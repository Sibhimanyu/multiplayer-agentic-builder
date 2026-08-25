// In-process CoordinationStore. Required, not optional (store-interface.md).
//
// It is written FIRST because it is how interface mistakes get found before a
// cloud is involved, and it is what `catalyst-builder dev` runs against.
//
// Three properties make it a real test target rather than a stub:
//
//  1. Every operation yields to the microtask queue before its critical section,
//     so N concurrent claimTask calls genuinely interleave. A2 would pass
//     trivially against a synchronous map; here it exercises the same
//     check-and-set ordering the Catalyst INSERT relies on.
//  2. Appended events are deep-frozen. A6 (append-only) is structural, not a
//     promise -- a later operation that tried to mutate one would throw.
//  3. Faults are injectable (offline / busy / revoked / frozen snapshot), so
//     A11, A13, A14 and A15 test behaviour rather than reading code.
//
// Presence deliberately mimics Catalyst Cache, not a Data Store row: a PUT with
// a TTL, where key expiry IS the staleness signal. `stats.durable_updates` stays
// at 0 no matter how many heartbeats arrive, which is the free-tier constraint
// (1,000 UPDATEs per MONTH) expressed as an assertion instead of a comment.

import type {
  AgentId, AgentPresence, AgentStatus, AppendResult, ClaimResult, ContractPointer,
  CoordinationStore, Event, EventInput, Freshness, ProjectId, ScopeLock, ScopeResult,
  Seq, Snapshot, SnapshotRead, TaskId, TaskKind, TaskView,
} from './types.ts';
import { LAYER_OF, LIMITS, STALE_AFTER_MS } from './types.ts';
import type { Clock } from '../clock.ts';
import { systemClock } from '../clock.ts';
import type { Logger } from '../log.ts';
import { nullLogger } from '../log.ts';
import { StoreAuthError, StoreBusyError, StoreError, StoreOfflineError } from './errors.ts';
import { sanitizeBody, sanitizeText, TEXT_MAX, VARCHAR_MAX } from '../sanitize.ts';
import { findGlobConflicts } from '../globs.ts';

/** Durable agent identity. Separate from presence, which is cache-shaped. */
interface AgentRecord {
  agent_id: AgentId; role_slug: string; member_label: string; initials: string;
  harness: AgentPresence['harness'];
  revoked: boolean;
}

/** One Cache entry. A null value models Catalyst's delete()-leaves-a-null-key quirk. */
interface PresenceEntry {
  value: {
    status: AgentStatus; current_task: TaskId | null; branch: string | null;
    at_ms: number; at_iso: string;
  } | null;
  expires_at_ms: number;
}

interface ClaimRecord { agent_id: AgentId; claimed_at: string; claimed_at_ms: number }

interface Listener {
  from_seq: Seq;
  last_delivered: Seq;
  onChange: (s: Snapshot) => void;
  /** Set while a delivery was suppressed by an offline fault. */
  owed: boolean;
}

interface ProjectState {
  project_id: ProjectId;
  project_name: string;
  repo_url: string;
  events: Event[];
  dedupe: Map<string, { event_id: string; seq: Seq }>;
  claims: Map<TaskId, ClaimRecord>;
  locks: ScopeLock[];
  tasks: Map<TaskId, TaskView>;
  agents: Map<AgentId, AgentRecord>;
  presence: Map<AgentId, PresenceEntry>;
  contracts: Map<string, ContractPointer>;
  /** Bumps on every mutation. Backs the ETag. */
  version: number;
  /** How far the fold has advanced. Lags `events` while the snapshot is frozen. */
  fold_cursor: number;
  listeners: Set<Listener>;
}

export interface MemoryStoreOptions {
  clock?: Clock;
  log?: Logger;
  /** Presence staleness threshold. Default 90s, per the protocol. */
  stale_after_ms?: number;
  /** Presence TTL, mirroring the Catalyst Cache TTL. Default 1h. */
  presence_ttl_ms?: number;
}

/** Operation counters, so free-tier claims can be asserted rather than assumed. */
export interface StoreStats {
  inserts: number;
  selects: number;
  /** Must stay 0. A heartbeat that lands here has broken the free-tier budget. */
  durable_updates: number;
  cache_puts: number;
}

export interface SeedTask {
  task_id: TaskId; title: string; kind: TaskKind;
  status?: TaskView['status'];
  description?: string;
  depends_on?: TaskId[];
  file_scope?: string[];
}

export interface SeedAgent {
  agent_id: AgentId; role_slug: string; member_label: string;
  initials?: string;
  harness?: AgentPresence['harness'];
}

/** Injectable failures. Every adapter's test harness exposes the same four. */
export class FaultInjector {
  offline = false;
  busy = false;
  /** Retry-After the busy fault advertises, so backoff can be asserted. */
  busy_retry_after_ms: number | undefined = undefined;
  snapshot_frozen = false;

  #store: MemoryStore;
  constructor(store: MemoryStore) { this.#store = store; }

  setOffline(on: boolean): void {
    this.offline = on;
    // Coming back online flushes every delivery that was suppressed. This is the
    // "survives transient network loss" half of subscribe.
    if (!on) this.#store.flushSubscribers();
  }

  setBusy(on: boolean, retry_after_ms?: number): void {
    this.busy = on;
    this.busy_retry_after_ms = retry_after_ms;
  }

  /** Freeze the fold so readSnapshot lags the ledger, as a debounced writer does. */
  freezeSnapshot(on: boolean): void {
    this.snapshot_frozen = on;
    if (!on) this.#store.flushSubscribers();
  }

  revoke(project_id: ProjectId, agent_id: AgentId): void {
    this.#store.setRevoked(project_id, agent_id, true);
  }

  restore(project_id: ProjectId, agent_id: AgentId): void {
    this.#store.setRevoked(project_id, agent_id, false);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

export class MemoryStore implements CoordinationStore {
  readonly freshness: Freshness = { mode: 'live', stale_ms: 0 };
  readonly faults: FaultInjector;
  readonly stats: StoreStats = { inserts: 0, selects: 0, durable_updates: 0, cache_puts: 0 };

  #clock: Clock;
  #log: Logger;
  #staleAfterMs: number;
  #presenceTtlMs: number;
  #projects = new Map<ProjectId, ProjectState>();
  /** Global-monotonic, like a Catalyst ROWID. Gaps across projects are legal. */
  #seq = 0;
  /** >0 while a server-side injectEvent is in flight. See injectEvent. */
  #bypassGate = 0;

  constructor(opts: MemoryStoreOptions = {}) {
    this.#clock = opts.clock ?? systemClock;
    this.#log = opts.log ?? nullLogger;
    this.#staleAfterMs = opts.stale_after_ms ?? STALE_AFTER_MS;
    this.#presenceTtlMs = opts.presence_ttl_ms ?? 60 * 60_000;
    this.faults = new FaultInjector(this);
  }

  // ---- seeding (dev/test only, NOT part of CoordinationStore) -----------

  createProject(project_id: ProjectId, project_name: string, repo_url: string): void {
    if (this.#projects.has(project_id)) throw new StoreError(`project already exists: ${project_id}`);
    this.#projects.set(project_id, {
      project_id,
      project_name: sanitizeText(project_name, { field: 'project_name', max: VARCHAR_MAX, log: this.#log }),
      repo_url: sanitizeText(repo_url, { field: 'repo_url', log: this.#log }),
      events: [], dedupe: new Map(), claims: new Map(), locks: [], tasks: new Map(),
      agents: new Map(), presence: new Map(), contracts: new Map(),
      version: 0, fold_cursor: 0, listeners: new Set(),
    });
  }

  addTask(project_id: ProjectId, task: SeedTask): void {
    const p = this.#project(project_id);
    p.tasks.set(task.task_id, {
      task_id: task.task_id,
      title: sanitizeText(task.title, { field: 'tasks.title', log: this.#log }),
      kind: task.kind,
      status: task.status ?? 'open',
      description: task.description === undefined
        ? undefined
        : sanitizeText(task.description, { field: 'tasks.description', log: this.#log }),
      claimed_by: null, branch: null, pr_url: null, pr_number: null, ci: null,
      depends_on: task.depends_on ?? [],
      blocked_by: null, blocked_reason: null, blocked_since: null,
      file_scope: task.file_scope ?? [],
      updated_at: this.#clock.iso(),
    });
    this.#touch(p);
  }

  addAgent(project_id: ProjectId, agent: SeedAgent): void {
    const p = this.#project(project_id);
    const label = sanitizeText(agent.member_label, { field: 'agents.member_label', max: VARCHAR_MAX, log: this.#log });
    p.agents.set(agent.agent_id, {
      agent_id: agent.agent_id,
      role_slug: agent.role_slug,
      member_label: label,
      initials: agent.initials ?? initialsOf(label),
      harness: agent.harness ?? 'claude-code',
      revoked: false,
    });
    this.#touch(p);
  }

  setRevoked(project_id: ProjectId, agent_id: AgentId, revoked: boolean): void {
    const p = this.#project(project_id);
    const a = p.agents.get(agent_id);
    if (!a) throw new StoreError(`unknown agent: ${agent_id}`);
    a.revoked = revoked;
    this.#touch(p);
  }

  /**
   * Append without passing through the fault gate: a write by some other client
   * while THIS client's link is down. Dev/test only.
   */
  async injectEvent(project_id: ProjectId, event: EventInput, idempotency_key: string): Promise<AppendResult> {
    // Only the caller's gate is bypassed. Delivery still respects the outage --
    // the point is that the write lands while this subscriber cannot see it.
    this.#bypassGate += 1;
    try {
      return await this.appendEvent(project_id, event, idempotency_key);
    } finally {
      this.#bypassGate -= 1;
    }
  }

  /** Ledger length, for tests that assert the ledger grew by exactly one. */
  ledgerSize(project_id: ProjectId): number { return this.#project(project_id).events.length; }

  // ---- ledger ----------------------------------------------------------

  async appendEvent(project_id: ProjectId, event: EventInput, idempotency_key: string): Promise<AppendResult> {
    const p = this.#project(project_id);
    await this.#gate(p, event.actor_type === 'agent' ? event.actor_id : undefined);

    if (!idempotency_key) throw new StoreError('idempotency_key is required');

    const canonical_layer = LAYER_OF[event.kind];
    if (canonical_layer === undefined) throw new StoreError(`unknown event kind: ${event.kind}`);
    if (event.layer !== canonical_layer) {
      // Not silently corrected: a wrong layer decides who receives the event, and
      // a human-layer event reaching an agent is a protocol violation.
      throw new StoreError(
        `layer mismatch for ${event.kind}: got '${event.layer}', must be '${canonical_layer}'`,
      );
    }

    const prior = p.dedupe.get(idempotency_key);
    if (prior) {
      this.#log.info('store.append.duplicate', 'idempotency key replayed, nothing appended', {
        project_id, idempotency_key, event_id: prior.event_id, seq: prior.seq,
      });
      return { ...prior, duplicate: true };
    }

    const seq = ++this.#seq;
    const appended: Event = deepFreeze({
      event_id: `evt_${seq.toString(36).padStart(6, '0')}`,
      project_id,
      seq,
      layer: canonical_layer,
      kind: event.kind,
      actor_type: event.actor_type,
      actor_id: sanitizeText(event.actor_id, { field: 'events.actor_id', max: VARCHAR_MAX, log: this.#log }),
      created_at: this.#clock.iso(),
      body: sanitizeBody(event.body, this.#log, `${event.kind}.body`),
    });

    p.events.push(appended);
    p.dedupe.set(idempotency_key, { event_id: appended.event_id, seq: appended.seq });
    this.stats.inserts += 2; // the event row and the dedupe row
    this.#touch(p);
    this.#notify(p);

    return { event_id: appended.event_id, seq: appended.seq, duplicate: false };
  }

  async readEvents(
    project_id: ProjectId, since_seq: Seq, limit = LIMITS.events,
  ): Promise<{ events: Event[]; next_cursor: Seq; has_more: boolean }> {
    const p = this.#project(project_id);
    await this.#gate(p);
    this.stats.selects += 1;

    const applied = Math.max(1, Math.min(limit, LIMITS.events));
    const matching = p.events.filter((e) => e.seq > since_seq); // already ascending
    const events = matching.slice(0, applied);
    const has_more = matching.length > events.length;

    if (limit > LIMITS.events || has_more) {
      this.#log.warn('store.events.capped', 'readEvents hit the row cap', {
        project_id, since_seq, requested: limit, applied, returned: events.length,
        dropped: matching.length - events.length, has_more,
      });
    }

    const next_cursor = events.length > 0 ? events[events.length - 1].seq : since_seq;
    return { events, next_cursor, has_more };
  }

  // ---- claims ----------------------------------------------------------

  async claimTask(project_id: ProjectId, task_id: TaskId, agent_id: AgentId): Promise<ClaimResult> {
    const p = this.#project(project_id);
    await this.#gate(p, agent_id);
    this.#requireAgent(p, agent_id);

    // ---- critical section: no await below this line. The Catalyst adapter gets
    // ---- the same atomicity from an INSERT against an is_unique column.
    const existing = p.claims.get(task_id);
    if (existing) {
      if (existing.agent_id === agent_id) return { ok: true }; // re-claiming your own is a no-op
      return { ok: false, owner: existing.agent_id, claimed_at: existing.claimed_at };
    }
    p.claims.set(task_id, {
      agent_id, claimed_at: this.#clock.iso(), claimed_at_ms: this.#clock.now(),
    });
    this.stats.inserts += 1;
    // ---- end critical section
    this.#touch(p);
    this.#notify(p);
    return { ok: true };
  }

  async releaseTask(project_id: ProjectId, task_id: TaskId, agent_id: AgentId): Promise<void> {
    const p = this.#project(project_id);
    await this.#gate(p, agent_id);
    this.#requireAgent(p, agent_id);

    const existing = p.claims.get(task_id);
    if (!existing) return; // idempotent
    if (existing.agent_id !== agent_id) {
      this.#log.info('store.release.not_owner', 'release ignored, task is owned by another agent', {
        project_id, task_id, requested_by: agent_id, owner: existing.agent_id,
      });
      return; // a no-op, not an error
    }
    p.claims.delete(task_id);
    this.#touch(p);
    this.#notify(p);
  }

  /** Reaper support: release claims whose owner has been stale past the timeout. */
  reapStaleClaims(project_id: ProjectId, claim_timeout_ms: number): { task_id: TaskId; agent_id: AgentId }[] {
    const p = this.#project(project_id);
    this.#fold(p);
    const now = this.#clock.now();
    const released: { task_id: TaskId; agent_id: AgentId }[] = [];
    for (const [task_id, claim] of [...p.claims]) {
      const hb = p.presence.get(claim.agent_id);
      const last = hb?.value && hb.expires_at_ms > now ? hb.value.at_ms : claim.claimed_at_ms;
      if (now - last <= claim_timeout_ms) continue;
      p.claims.delete(task_id);
      released.push({ task_id, agent_id: claim.agent_id });
      this.#log.warn('store.claim.reaped', 'released a claim whose agent went stale', {
        project_id, task_id, agent_id: claim.agent_id, stale_ms: now - last,
      });
    }
    if (released.length > 0) { this.#touch(p); this.#notify(p); }
    return released;
  }

  // ---- file scope locks ------------------------------------------------

  async acquireScope(
    project_id: ProjectId, agent_id: AgentId, task_id: TaskId, globs: string[],
  ): Promise<ScopeResult> {
    const p = this.#project(project_id);
    await this.#gate(p, agent_id);
    this.#requireAgent(p, agent_id);
    if (globs.length === 0) throw new StoreError('acquireScope requires at least one glob');

    // ---- critical section: no await below this line.
    const others = p.locks.filter((l) => l.agent_id !== agent_id);
    const conflicts = others.filter((l) => findGlobConflicts(globs, l.globs).length > 0);
    if (conflicts.length > 0) {
      this.#log.info('store.scope.conflict', 'scope rejected, globs intersect a live lock', {
        project_id, agent_id, task_id, globs,
        conflicts: conflicts.map((c) => ({ agent_id: c.agent_id, task_id: c.task_id, globs: c.globs })),
      });
      return { ok: false, conflicts: conflicts.map((c) => ({ ...c })) };
    }

    if (p.locks.length >= LIMITS.locks) {
      this.#log.error('store.locks.at_cap', 'lock table is at its cap, refusing to add', {
        project_id, cap: LIMITS.locks, agent_id, task_id,
      });
      throw new StoreError(`scope lock table is at its cap of ${LIMITS.locks}`);
    }

    p.locks = p.locks.filter((l) => !(l.agent_id === agent_id && l.task_id === task_id));
    p.locks.push({ agent_id, task_id, globs: [...globs], acquired_at: this.#clock.iso() });
    this.stats.inserts += 1;
    // ---- end critical section
    this.#touch(p);
    this.#notify(p);
    return { ok: true };
  }

  async releaseScope(project_id: ProjectId, agent_id: AgentId): Promise<void> {
    const p = this.#project(project_id);
    await this.#gate(p, agent_id);
    this.#requireAgent(p, agent_id);
    const before = p.locks.length;
    p.locks = p.locks.filter((l) => l.agent_id !== agent_id);
    if (p.locks.length === before) return; // idempotent
    this.#touch(p);
    this.#notify(p);
  }

  // ---- presence --------------------------------------------------------

  async heartbeat(
    project_id: ProjectId, agent_id: AgentId, status: AgentStatus,
    current_task: TaskId | null = null, branch: string | null = null,
  ): Promise<void> {
    const p = this.#project(project_id);
    await this.#gate(p, agent_id);
    this.#requireAgent(p, agent_id);

    const now = this.#clock.now();
    // A Cache PUT with an explicit TTL. Never a durable row UPDATE -- the free
    // tier allows 1,000 of those per MONTH, which a 20s heartbeat burns in 5.6h.
    p.presence.set(agent_id, {
      value: {
        status, current_task, at_ms: now, at_iso: this.#clock.iso(),
        branch: branch === null ? null : sanitizeText(branch, { field: 'presence.branch', max: VARCHAR_MAX, log: this.#log }),
      },
      expires_at_ms: now + this.#presenceTtlMs,
    });
    this.stats.cache_puts += 1;
    // Deliberately not #touch(): a heartbeat is not a state change worth waking
    // every subscriber for. Presence is derived at read time.
  }

  async listPresence(project_id: ProjectId): Promise<AgentPresence[]> {
    const p = this.#project(project_id);
    await this.#gate(p);
    this.stats.selects += 1;
    return this.#presenceOf(p);
  }

  // ---- read + notify ---------------------------------------------------

  async readSnapshot(project_id: ProjectId, etag?: string): Promise<SnapshotRead | null> {
    const p = this.#project(project_id);
    await this.#gate(p);
    this.stats.selects += 1;
    this.#fold(p);

    const current = this.#etag(p);
    if (etag !== undefined && etag === current) return null; // a 304
    return { snapshot: this.#buildSnapshot(p), etag: current };
  }

  subscribe(project_id: ProjectId, from_seq: Seq, onChange: (s: Snapshot) => void): () => void {
    const p = this.#project(project_id);
    const listener: Listener = { from_seq, last_delivered: -1, onChange, owed: false };
    p.listeners.add(listener);

    // Fires once immediately with current state, before any change (A10).
    this.#deliver(p, listener, true);

    return () => { p.listeners.delete(listener); };
  }

  /** Re-deliver to every subscriber that was owed an update while offline. */
  flushSubscribers(): void {
    for (const p of this.#projects.values()) {
      this.#fold(p);
      for (const l of p.listeners) if (l.owed) this.#deliver(p, l, true);
    }
  }

  // ---- internals -------------------------------------------------------

  #project(project_id: ProjectId): ProjectState {
    const p = this.#projects.get(project_id);
    if (!p) throw new StoreError(`unknown project: ${project_id}`);
    return p;
  }

  /** Server-side relationship check. agent_id is never trusted from a client. */
  #requireAgent(p: ProjectState, agent_id: AgentId): AgentRecord {
    const a = p.agents.get(agent_id);
    if (!a) throw new StoreError(`unknown agent for project ${p.project_id}: ${agent_id}`);
    return a;
  }

  /**
   * The one place faults are applied. Also the await that makes concurrency real:
   * every operation yields before its critical section.
   */
  async #gate(p: ProjectState, agent_id?: AgentId): Promise<void> {
    await Promise.resolve();
    if (this.#bypassGate > 0) return;
    if (this.faults.offline) throw new StoreOfflineError('memory store fault: offline');
    if (this.faults.busy) {
      throw new StoreBusyError('memory store fault: rate limited', {
        retry_after_ms: this.faults.busy_retry_after_ms,
      });
    }
    if (agent_id !== undefined && p.agents.get(agent_id)?.revoked === true) {
      throw new StoreAuthError(`agent token revoked: ${agent_id}`);
    }
  }

  #touch(p: ProjectState): void { p.version += 1; }

  /**
   * Advance the projection over newly appended events. Held back while the
   * snapshot is frozen, which is how a debounced snapshot writer looks to a
   * caller: snapshot.seq < the seq it just wrote. Stale, not lost.
   */
  #fold(p: ProjectState): void {
    if (this.faults.snapshot_frozen) return;
    while (p.fold_cursor < p.events.length) {
      this.#apply(p, p.events[p.fold_cursor]);
      p.fold_cursor += 1;
    }
  }

  #apply(p: ProjectState, e: Event): void {
    const body = e.body as Record<string, any>;
    const task = typeof body.task_id === 'string' ? p.tasks.get(body.task_id) : undefined;
    const stamp = (t: TaskView, patch: Partial<TaskView>): void => {
      p.tasks.set(t.task_id, { ...t, ...patch, updated_at: e.created_at });
    };

    switch (e.kind) {
      case 'contract_published':
      case 'schema_published': {
        const name = String(body.name ?? '');
        const version = typeof body.version === 'number' ? body.version : 1;
        const prior = p.contracts.get(name);
        if (prior && prior.version > version) break; // never regress to an older version
        p.contracts.set(name, {
          name, version,
          path: String(body.path ?? ''),
          commit_sha: String(body.commit_sha ?? ''),
          supersedes: typeof body.supersedes === 'number' ? body.supersedes : null,
          published_by: e.actor_id, published_at: e.created_at,
        });
        break;
      }
      case 'task_blocked':
        if (task) {
          stamp(task, {
            status: 'blocked',
            blocked_by: typeof body.blocked_by_task_id === 'string' ? body.blocked_by_task_id : null,
            blocked_reason: typeof body.reason === 'string' ? body.reason : null,
            blocked_since: e.created_at,
          });
        }
        break;
      case 'task_unblocked':
        if (task) stamp(task, { status: 'open', blocked_by: null, blocked_reason: null, blocked_since: null });
        break;
      case 'task_completed':
        if (task) stamp(task, { status: 'needs_review' });
        break;
      case 'branch_pushed':
        if (task) {
          stamp(task, {
            status: task.status === 'claimed' || task.status === 'open' ? 'in_progress' : task.status,
            branch: typeof body.branch === 'string' ? body.branch : task.branch,
          });
        }
        break;
      case 'pr_opened':
        if (task) {
          stamp(task, {
            status: 'pr_open',
            pr_url: typeof body.pr_url === 'string' ? body.pr_url : null,
            pr_number: typeof body.pr_number === 'number' ? body.pr_number : null,
            ci: 'pending',
          });
        }
        break;
      case 'ci_passed': if (task) stamp(task, { ci: 'passed' }); break;
      case 'ci_failed': if (task) stamp(task, { ci: 'failed' }); break;
      case 'merged': if (task) stamp(task, { status: 'merged' }); break;
      // Claims and locks are live store state, folded in #buildSnapshot.
      // Human-layer events never change board state.
      case 'task_claimed': case 'scope_locked': case 'scope_released':
      case 'contract_superseded': case 'decision_recorded':
      case 'agent_heartbeat': case 'task_progress':
        break;
      default: {
        // Named, not swallowed: an unhandled kind means the protocol moved.
        this.#log.warn('store.fold.unhandled_kind', 'event kind not folded into the snapshot', {
          project_id: p.project_id, kind: e.kind, seq: e.seq,
        });
      }
    }
  }

  #presenceOf(p: ProjectState): AgentPresence[] {
    const now = this.#clock.now();
    const all: AgentPresence[] = [...p.agents.values()].map((a) => {
      const entry = p.presence.get(a.agent_id);
      // An expired key, or the null value a Cache delete() leaves behind, both
      // mean "absent". Absent is what makes an agent stale -- nothing is stored.
      const live = entry && entry.value !== null && entry.expires_at_ms > now ? entry.value : null;
      const last_heartbeat_at = live ? live.at_iso : null;
      return {
        agent_id: a.agent_id, role_slug: a.role_slug, member_label: a.member_label,
        initials: a.initials, harness: a.harness,
        status: a.revoked ? 'revoked' : live ? live.status : 'offline',
        current_task: live ? live.current_task : null,
        branch: live ? live.branch : null,
        last_heartbeat_at,
        stale: live === null ? true : now - live.at_ms > this.#staleAfterMs,
      };
    });

    if (all.length <= LIMITS.presence) return all;
    this.#log.warn('store.presence.capped', 'presence list hit the cap', {
      project_id: p.project_id, cap: LIMITS.presence, total: all.length,
      dropped: all.length - LIMITS.presence,
    });
    return all.slice(0, LIMITS.presence);
  }

  #locksOf(p: ProjectState): ScopeLock[] {
    if (p.locks.length <= LIMITS.locks) return p.locks.map((l) => ({ ...l, globs: [...l.globs] }));
    this.#log.warn('store.locks.capped', 'lock list hit the cap', {
      project_id: p.project_id, cap: LIMITS.locks, total: p.locks.length,
      dropped: p.locks.length - LIMITS.locks,
    });
    return p.locks.slice(0, LIMITS.locks).map((l) => ({ ...l, globs: [...l.globs] }));
  }

  #buildSnapshot(p: ProjectState): Snapshot {
    const folded = p.fold_cursor > 0 ? p.events[p.fold_cursor - 1].seq : 0;
    const tasks = [...p.tasks.values()].map((t) => {
      const claim = p.claims.get(t.task_id);
      const claimed_by = claim ? claim.agent_id : null;
      // A claim on an otherwise-untouched task moves it out of `open`.
      const status = claim && t.status === 'open' ? 'claimed' : t.status;
      return { ...t, claimed_by, status, depends_on: [...t.depends_on], file_scope: [...t.file_scope] };
    });

    return {
      project_id: p.project_id,
      seq: folded,
      generated_at: this.#clock.iso(),
      project_name: p.project_name,
      repo_url: p.repo_url,
      tasks,
      agents: this.#presenceOf(p),
      locks: this.#locksOf(p),
      contracts: [...p.contracts.values()].map((c) => ({ ...c })),
    };
  }

  #etag(p: ProjectState): string { return `W/"${p.project_id}-v${p.version}-f${p.fold_cursor}"`; }

  #notify(p: ProjectState): void {
    this.#fold(p);
    for (const l of p.listeners) this.#deliver(p, l, false);
  }

  #deliver(p: ProjectState, l: Listener, force: boolean): void {
    if (this.faults.offline) { l.owed = true; return; }
    this.#fold(p);
    const snapshot = this.#buildSnapshot(p);
    if (!force && snapshot.seq <= Math.max(l.from_seq, l.last_delivered)) return;
    l.last_delivered = snapshot.seq;
    l.owed = false;
    l.onChange(snapshot);
  }
}

function initialsOf(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '??';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function createMemoryStore(opts: MemoryStoreOptions = {}): MemoryStore {
  return new MemoryStore(opts);
}

export { TEXT_MAX, VARCHAR_MAX };
