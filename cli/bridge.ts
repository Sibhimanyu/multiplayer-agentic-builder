// The CLI bridge: the only moving part between an agent's filesystem and the store.
//
// Deliberately the minimum the vertical slice needs (order 0038) and nothing wider.
//
//   drain  .agentic/outbox.jsonl from outbox.cursor -> publish via the store -> advance cursor
//   feed   store subscription -> .agentic/inbox.jsonl, CONTRACT AND COORDINATION LAYERS ONLY
//
// Publishing goes through the store adapter directly rather than the HTTP API, because the
// Cloud Functions API is not deployed yet and the slice does not need it. That is a deliberate
// narrowing, not an oversight: the slice proves the store, the subscriber, the dashboard wiring
// and the file contract. Auth and the webhook are the next layer, not this one.
//
// Four rules carried in from the other routes, all bought expensively:
//
//   1. Any git we shell out to gets a DEADLINE. A wedged `send-pack` with no timeout makes a
//      daemon sit forever, look healthy, and publish nothing. (No git on this path yet; the
//      rule is recorded where the git call would go, in cli/blackboard.ts, which has it.)
//   2. NEVER sleep on an injected clock in a transport path. Injected clocks are for staleness
//      derivation and the reaper. A retry that slept on a FakeClock nobody advanced turned one
//      transient socket error into a permanent hang. Every wait here uses real timers.
//   3. NEVER hand-walk or stringify an SDK response, and never treat "it did not throw" as
//      success. Every publish below is checked for a real `seq`.
//   4. A POSITIVE CONTROL separates "the platform is broken" from "my reader is broken".
//      `--selftest` writes a known line and asserts it comes back.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { LAYOUT, appendInbox, readState, writeState } from './agentic.ts';
import { materialise, publishToBlackboard, type BlackboardOptions } from './blackboard.ts';
import { readPending, writeCursor, type OutboxRecord } from './outbox.ts';
import type { Logger } from '../shared/log.ts';
import { StoreAuthError } from '../shared/store/errors.ts';
import {
  HEARTBEAT_INTERVAL_MS,
  LAYER_OF,
  type AgentId,
  type AgentStatus,
  type CoordinationStore,
  type EventKind,
  type Snapshot,
} from '../shared/store/types.ts';

export interface BridgeOptions {
  root: string;
  project_id: string;
  /**
   * The seam, and only the seam.
   *
   * Typed as CoordinationStore rather than the Firestore adapter on purpose: this file must not
   * import a backend SDK. It could not, in fact -- firebase-admin lives in firebase/ and does
   * not resolve from cli/, which is the module graph telling the truth about the architecture.
   * The CLI speaks the ten operations and nothing below them.
   */
  store: CoordinationStore;
  log: Logger;
  /** Poll interval for the outbox file. The STORE is push; only the local file is polled. */
  drain_interval_ms?: number;
  /**
   * The reaper. Absent means this bridge does not sweep.
   *
   * On Spark there are no Cloud Functions, so there is no scheduled reaper -- every bridge is a
   * candidate. See startReaper for the lease that stops them stampeding.
   */
  reaper?: ReaperPort;
  /**
   * The git half. Absent means contract-layer records are announced without being published,
   * which is only ever right in a test that is not exercising the blackboard.
   */
  blackboard?: BlackboardConfig;
}

/**
 * How often a lease-holding bridge sweeps for stale claims.
 *
 * 60 s against a CLAIM_TIMEOUT_MS of 15 min: a claim is detected within one minute of becoming
 * eligible, so the 15-minute bound F11 asserts has ~1 minute of slack rather than being a race
 * against its own interval. Sweeping faster buys nothing -- nothing becomes reapable in under
 * 15 minutes -- and each sweep reads the claim and agent tables.
 */
export const REAPER_SWEEP_INTERVAL_MS = 60_000;

/**
 * The three event kinds whose payload is a FILE in git rather than a body in the ledger.
 *
 * They are exactly the contract layer minus its lifecycle events: a contract, a schema and a
 * decision are durable artifacts a human reviews in a diff. `contract_superseded`,
 * `scope_locked` and the rest are coordination facts about artifacts, not artifacts.
 */
export const BLACKBOARD_KINDS = new Set<EventKind>([
  'contract_published',
  'schema_published',
  'decision_recorded',
]);

type BlackboardKind = 'contract_published' | 'schema_published' | 'decision_recorded';

/** What the bridge needs to run the git half. Absent means this bridge does not publish facts. */
export type BlackboardConfig = BlackboardOptions & {
  /** For private repos, on the CDN read. Never written to disk or into an event. */
  token?: string;
  /** Injectable so the inbox path can be tested without the network. */
  fetchImpl?: typeof fetch;
};

/**
 * Publish one outbox record through the correct store operation.
 *
 * `task_claimed` is not a plain append: a claim is the atomic operation, and routing it through
 * appendEvent would write the event without ever taking the claim. The CLI translates the
 * agent's stated intent into the right primitive — that translation is the CLI's whole job.
 */
export async function publishRecord(
  store: CoordinationStore,
  project_id: string,
  rec: OutboxRecord,
  log: Logger,
  blackboard?: BlackboardConfig,
  /** Workspace root, so a claim LOSS can be reported back on the agent's inbox. */
  inbox_root?: string,
): Promise<{ published: boolean; seq: number; note?: string }> {
  let body = rec.body ?? {};

  // ---- the git half -------------------------------------------------------------------
  //
  // RULE 3, blackboard.md: THE CLI COMMITS, NEVER THE AGENT. The agent wrote a file into its
  // working tree and named it; everything from here -- the worktree, the commit, the push, the
  // rebase on rejection -- happens on this side of the file contract, and the event body the
  // agent wrote is REPLACED by a pointer. The agent never sees, holds or types a commit sha.
  //
  // Done before appendEvent, not after, and that ordering is the whole design: an event
  // announcing a contract that is not yet pushed is a pointer into nothing. A consumer that
  // acted on it would fetch a 404 from the CDN. Publish the artifact, then announce it.
  if (BLACKBOARD_KINDS.has(rec.kind as EventKind) && blackboard) {
    const source = typeof body.file === 'string' ? body.file
      : typeof body.source_file === 'string' ? body.source_file
      : null;
    if (!source) {
      return { published: false, seq: 0, note: `${rec.kind} without a file to publish` };
    }
    const pub = await publishToBlackboard(
      { source_file: source, kind: rec.kind as BlackboardKind, body },
      blackboard,
      log,
    );
    // Not "it did not throw": a pointer without a real 40-hex sha is not a pointer.
    if (!/^[0-9a-f]{40}$/.test(pub.commit_sha)) {
      throw new Error(`publishToBlackboard returned no usable commit_sha for ${source}`);
    }
    // The pointer, and ONLY the pointer. `file` -- the agent's local scratch path -- is dropped
    // deliberately: it is meaningless on any other machine, and leaving it would invite a
    // consumer to try opening it.
    const { file: _dropped, source_file: _dropped2, ...rest } = body;
    body = { ...rest, path: pub.path, commit_sha: pub.commit_sha };
    log.info('bridge.blackboard_published', 'fact committed and pushed before announcing it', {
      kind: rec.kind, path: pub.path, commit_sha: pub.commit_sha,
      attempts: pub.attempts, unchanged: pub.unchanged,
    });
  }
  const task_id = typeof body.task_id === 'string' ? body.task_id : null;
  const agent_id = typeof body.agent_id === 'string' ? body.agent_id : 'agent_local';

  // `claim_requested` is how an AGENT asks for a task. Order 0051, entry 79.
  //
  // The agent appends a request; the BRIDGE calls claimTask. That keeps the atomic operation
  // exactly where it is already verified contended -- 20 racers x 50 rounds, 256 concurrent
  // single-document writers -- and keeps the agent off the network, holding no credential, as
  // the file contract requires. `task_claimed` is still accepted for the CLI's own use.
  if (rec.kind === 'claim_requested' || rec.kind === 'task_claimed') {
    if (!task_id) return { published: false, seq: 0, note: `${rec.kind} without task_id` };
    const res = await store.claimTask(project_id, task_id, agent_id);
    if (!res.ok) {
      // A lost claim is a NORMAL outcome, not an error. It is published in the sense that the
      // intent was resolved, so the cursor advances: re-draining it would only lose again.
      log.info('bridge.claim_lost', 'claim lost to another agent', {
        project_id, task_id, agent_id, owner: res.owner,
      });
      // AND THE AGENT IS TOLD. A loss produces no ledger event -- nothing happened -- so without
      // this the agent waits forever for a reply that cannot come. Delivered on the inbox as
      // coordination layer, which is where the agent already looks, and phrased as a result
      // rather than an error because losing a race is the system working.
      if (inbox_root) {
        await appendInbox(
          inbox_root,
          {
            v: '0.2', seq: 0, layer: 'coordination', kind: 'claim_denied',
            ts: new Date().toISOString(),
            body: { task_id, agent_id, owner: res.owner, claimed_at: res.claimed_at,
                    reason: 'another agent claimed it first' },
          },
          log,
        );
      }
      return { published: true, seq: 0, note: `lost to ${res.owner}` };
    }
    const after = await store.readEvents(project_id, 0);
    const claimed = after.events.filter(
      (e) => e.kind === 'task_claimed' && e.body.task_id === task_id,
    );
    const seq = claimed.at(-1)?.seq ?? 0;
    // Rule 3: do not treat "claimTask resolved" as proof an event landed. Check for the event.
    if (seq <= 0) {
      throw new Error(
        `claimTask(${task_id}) reported ok but no task_claimed event is on the ledger. ` +
          'Refusing to advance the cursor on an unverified publish.',
      );
    }
    return { published: true, seq };
  }

  const res = await store.appendEvent(
    project_id,
    {
      layer: LAYER_OF[rec.kind],
      kind: rec.kind,
      actor_type: 'agent',
      actor_id: agent_id,
      body,
    },
    rec.idempotency_key,
  );

  // Rule 3 again: a returned object is not success. A real append has a positive seq.
  if (!res || typeof res.seq !== 'number' || res.seq <= 0) {
    throw new Error(
      `appendEvent(${rec.kind}) returned no usable seq (${JSON.stringify(res)}). ` +
        'Not advancing the cursor.',
    );
  }
  return { published: true, seq: res.seq, note: res.duplicate ? 'duplicate' : undefined };
}

/** Drain the outbox once. Cursor advances only AFTER a verified publish. */
export async function drainOnce(opts: BridgeOptions): Promise<{ published: number; failed: number }> {
  const pending = await readPending(opts.root, opts.log);
  let published = 0;
  let failed = 0;

  for (const rec of pending.sort((a, b) => a.order - b.order)) {
    try {
      const r = await publishRecord(opts.store, opts.project_id, rec, opts.log, opts.blackboard, opts.root);
      if (!r.published) {
        opts.log.warn('bridge.unpublishable', 'record cannot ever be published, skipping', {
          kind: rec.kind, note: r.note,
        });
      } else {
        published += 1;
        opts.log.info('bridge.published', 'outbox record published', {
          kind: rec.kind, seq: r.seq, note: r.note ?? '',
        });
      }

      // AFTER the publish, never before. A crash here re-sends, which the idempotency key makes
      // free; a crash the other way round loses the record with nothing anywhere to notice.
      if (rec.source.type === 'jsonl') {
        await writeCursor(opts.root, LAYOUT.outbox_cursor, rec.source.offset + rec.source.length);
      } else {
        await fs.rm(path.join(opts.root, LAYOUT.outbox_spool, rec.source.file), { force: true });
      }
    } catch (err) {
      failed += 1;
      opts.log.warn('bridge.publish_failed', 'publish failed; cursor NOT advanced, will retry', {
        kind: rec.kind, error: String(err),
      });
      break; // stop at the first failure: skipping ahead would leave a hole the cursor cannot express
    }
  }
  return { published, failed };
}

/**
 * Feed the inbox from a live store subscription.
 *
 * THE HUMAN LAYER NEVER REACHES inbox.jsonl. That exclusion is the entire reason agents stay
 * coherent over a long session: `task_progress` narration and heartbeats are worthless to a peer
 * agent and actively cost it context. Filtered here AND at the API, because a leak into the
 * agent's own context file is the one that actually hurts.
 */
export function startInboxFeed(opts: BridgeOptions): () => void {
  let lastSeen = 0;
  let busy = false;

  const pump = async (snap: Snapshot) => {
    if (busy || snap.seq <= lastSeen) return;
    busy = true;
    try {
      const { events } = await opts.store.readEvents(opts.project_id, lastSeen);
      for (const e of events) {
        if (LAYER_OF[e.kind] === 'human') {
          opts.log.info('bridge.human_withheld', 'human-layer event withheld from the inbox', {
            kind: e.kind, seq: e.seq,
          });
          lastSeen = Math.max(lastSeen, e.seq);
          continue;
        }
        const body: Record<string, unknown> = { ...e.body };

        // RULE 4, blackboard.md: body.local is populated BEFORE the inbox line is appended.
        //
        // The bridge fetches the blob to disk here, so by the time the agent sees the line the
        // file already exists and the agent opens it. That is the whole point: the agent makes
        // NO network call, holds no token, and cannot be blocked by the CDN being slow. F7 --
        // "the frontend reads the contract from disk" -- is precisely the test of this line.
        //
        // A fetch failure must NOT produce an inbox line: announcing a contract whose file is
        // not on disk would send the agent to open something that is not there, which is worse
        // than a delayed announcement. lastSeen is left un-advanced so the next frame retries.
        if (typeof e.body.commit_sha === 'string' && typeof e.body.path === 'string' && opts.blackboard) {
          try {
            body.local = await materialise(
              { path: e.body.path, commit_sha: e.body.commit_sha },
              { root: opts.root, repo: opts.blackboard.repo, token: opts.blackboard.token, fetchImpl: opts.blackboard.fetchImpl },
              opts.log,
            );
          } catch (err) {
            opts.log.warn('bridge.materialise_failed', 'could not fetch a published fact; not announcing it yet', {
              kind: e.kind, seq: e.seq, path: e.body.path, error: String(err),
            });
            continue; // no inbox line, and lastSeen stays put so this is retried
          }
        }

        // C7: the agent never sees a commit sha. That is CLI plumbing.
        // AFTER materialise, deliberately: the sha is what makes the fetch sha-pinned and
        // therefore immutable, so it is needed right up to the moment the file is on disk.
        delete body.commit_sha;
        await appendInbox(
          opts.root,
          { v: '0.2', seq: e.seq, layer: e.layer, kind: e.kind, ts: e.created_at, body },
          opts.log,
        );
        lastSeen = Math.max(lastSeen, e.seq);
        opts.log.info('bridge.inbox_appended', 'inbox line appended', { kind: e.kind, seq: e.seq });
      }
      const st = await readState(opts.root, opts.log);
      await writeState(opts.root, { ...st, last_seen_seq: lastSeen });
    } catch (err) {
      opts.log.warn('bridge.inbox_failed', 'inbox feed failed; will retry on the next frame', {
        error: String(err),
      });
    } finally {
      busy = false;
    }
  };

  return opts.store.subscribe(opts.project_id, 0, (snap) => {
    void pump(snap);
  });
}

/**
 * Emit a heartbeat every HEARTBEAT_INTERVAL_MS, for as long as the bridge is running.
 *
 * This is the thing that makes the interval real. HEARTBEAT_INTERVAL_MS existed nowhere before
 * order 0041, nothing emitted on a schedule, and presence cost was consequently reported as two
 * different percentages of a quota -- arithmetic over an input no code had ever chosen. A
 * constant nothing reads is how that happens, so the constant and its emitter land together.
 *
 * Three things it deliberately does:
 *
 *   Beats IMMEDIATELY, then on the interval. Waiting a full period first would leave a freshly
 *   started agent invisible on the board for 30 s, which looks exactly like a dead one.
 *
 *   Uses a REAL timer. Rule 2: never sleep on an injected clock in a transport path. The clock
 *   is for deriving staleness and for tests; a heartbeat that slept on a FakeClock nobody
 *   advanced would simply never beat.
 *
 *   STOPS on StoreAuthError. A revoked agent that keeps beating is writing presence it is not
 *   entitled to and burning a read per beat doing it. Every other error is transient and is
 *   logged and retried on the next tick -- one failed beat is not a reason to go silent.
 */
export function startHeartbeat(
  opts: BridgeOptions & { agent_id: AgentId; status?: AgentStatus },
): () => void {
  const status = opts.status ?? 'connected';
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const beat = async () => {
    if (stopped) return;
    try {
      await opts.store.heartbeat(opts.project_id, opts.agent_id, status, null, null);
      opts.log.info('bridge.heartbeat', 'heartbeat emitted', {
        project_id: opts.project_id, agent_id: opts.agent_id, interval_ms: HEARTBEAT_INTERVAL_MS,
      });
    } catch (err) {
      if (err instanceof StoreAuthError) {
        opts.log.warn('bridge.heartbeat_revoked', 'token revoked; stopping heartbeats', {
          agent_id: opts.agent_id, error: String(err),
        });
        stop();
        return;
      }
      opts.log.warn('bridge.heartbeat_failed', 'heartbeat failed; retrying next tick', {
        agent_id: opts.agent_id, error: String(err),
      });
    }
  };

  const stop = () => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
  };

  void beat();
  timer = setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS);
  return stop;
}

/**
 * The reaper, injected. The bridge schedules and guards it; firebase/ supplies the sweep.
 *
 * Injected rather than imported because the sweep needs raw Firestore access and this file must
 * not touch a backend SDK -- the same boundary the module graph already enforces.
 */
export interface ReaperPort {
  /** One sweep. Returns what it actually released, never just "it didn't throw". */
  sweep(): Promise<{ examined: number; released: { task_id: string; agent_id: string }[] }>;
  /**
   * Force-release a lease whose holder died, with SYSTEM attribution.
   *
   * Separate from releaseTask(owner) on purpose: releasing as the dead agent would append a
   * task_unblocked event attributed to an agent that did nothing, and the ledger is the audit
   * record. firebase/ implements this with reapClaim, which exists for exactly this reason.
   */
  breakLease(task_id: string, owner: string, reason: string): Promise<void>;
}

/**
 * The task id the reaper lease is claimed against.
 *
 * It is a claim, not a task: claimTask writes only to claims/{id} and never to tasks/, so this
 * never appears as a card on the board. Verified by reading claimTask, not assumed.
 */
export const REAPER_LEASE_ID = '__reaper_lease';

/**
 * Run the reaper on an interval, with exactly one bridge sweeping at a time.
 *
 * THE STAMPEDE GUARD IS claimTask ITSELF. Order 0043 ruled that the lease reuse the primitive
 * already verified contended (A2, 20 racers x 50 rounds, and 256 concurrent writers absorbed on
 * production) rather than invent a second one. Ten bridges starting together produce one winner
 * and nine clean losses, because that is what claimTask is.
 *
 * The lease is HELD for the process lifetime rather than taken per sweep. Re-claiming a task you
 * already own returns ok and appends NOTHING (firebase/store.ts claimTask), so holding costs one
 * ledger event per bridge lifetime. Claim-and-release per sweep would have written two events a
 * minute, forever, into the audit log.
 *
 * BREAKING A DEAD HOLDER'S LEASE. If the winner dies still holding it, every other bridge would
 * defer to a corpse -- and the reaper is the very thing that fixes dead agents, so it cannot fix
 * itself. Liveness is decided by the holder's PRESENCE, not by lease age: a long-held lease by a
 * live bridge is correct and must not be broken, while a short-held lease by a dead one must be.
 * `stale` is already derived from last_heartbeat_at, and the bridge already heartbeats, so the
 * signal exists and is reused rather than duplicated.
 */
export function startReaper(
  opts: BridgeOptions & {
    agent_id: AgentId;
    reaper: ReaperPort;
    interval_ms?: number;
    /**
     * Which claim is the lease. Defaults to REAPER_LEASE_ID and should stay that way in
     * production -- one lease per project is the whole point. Overridable so the guard can be
     * NEGATIVE-controlled: give each bridge its own lease, nothing contends, and all of them
     * must sweep. Without that control, "one of five swept" is equally what four broken bridges
     * look like (entry 60).
     */
    lease_id?: string;
  },
): () => void {
  const interval = opts.interval_ms ?? REAPER_SWEEP_INTERVAL_MS;
  const LEASE = opts.lease_id ?? REAPER_LEASE_ID;
  let stopped = false;
  let holding = false;
  let timer: ReturnType<typeof setInterval> | null = null;

  const tryAcquire = async (): Promise<boolean> => {
    const got = await opts.store.claimTask(opts.project_id, LEASE, opts.agent_id);
    if (got.ok) return true;

    // Lost. Is the holder alive? A live holder is the normal case and we simply stand down.
    const presence = await opts.store.listPresence(opts.project_id);
    const holder = presence.find((p) => p.agent_id === got.owner);
    const dead = !holder || holder.stale;
    if (!dead) return false;

    opts.log.warn('bridge.reaper_lease_stale', 'reaper lease held by a dead bridge, breaking it', {
      project_id: opts.project_id, owner: got.owner, claimed_at: got.claimed_at,
      reason: holder ? 'owner presence is stale' : 'owner has no presence row',
    });
    await opts.reaper.breakLease(LEASE, got.owner, 'reaper lease holder is gone');
    const retry = await opts.store.claimTask(opts.project_id, LEASE, opts.agent_id);
    // One retry only. If another bridge won the race to take over, that is a correct outcome.
    return retry.ok;
  };

  const tick = async () => {
    if (stopped) return;
    try {
      if (!holding) holding = await tryAcquire();
      if (!holding) return;

      const result = await opts.reaper.sweep();
      // Not "it didn't throw": report what was actually released, and say so per claim.
      if (result.released.length > 0) {
        for (const r of result.released) {
          opts.log.info('bridge.reaped', 'stale claim released', {
            project_id: opts.project_id, task_id: r.task_id, agent_id: r.agent_id,
          });
        }
      } else {
        opts.log.info('bridge.reap_clean', 'sweep found nothing to release', {
          project_id: opts.project_id, examined: result.examined,
        });
      }
    } catch (err) {
      // A failed sweep must not kill the bridge, and must not silently drop the lease either:
      // holding stays true so the next tick retries rather than handing over on one blip.
      opts.log.warn('bridge.reap_failed', 'reaper sweep failed; retrying next interval', {
        project_id: opts.project_id, error: String(err),
      });
    }
  };

  // Sweeps IMMEDIATELY. "Any starting bridge sweeps first" is what makes the local-first reaper
  // sound: the first agent back finds a clean board rather than waiting out an interval.
  void tick();
  timer = setInterval(() => void tick(), interval);

  return () => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    // Hand the lease back so the next bridge does not have to wait for presence to go stale.
    // Best-effort: on a hard kill this does not run, which is exactly the case tryAcquire's
    // dead-holder path exists to handle.
    if (holding) {
      void opts.store
        .releaseTask(opts.project_id, LEASE, opts.agent_id)
        .catch((err) => opts.log.warn('bridge.reaper_lease_release_failed', 'could not release the reaper lease', { error: String(err) }));
    }
  };
}

/** Run the bridge until interrupted. */
export async function runBridge(opts: BridgeOptions): Promise<void> {
  const interval = opts.drain_interval_ms ?? 1_000;
  const stopInbox = startInboxFeed(opts);

  // Presence needs an identity. An agent that has not connected yet has none, and inventing one
  // would put a row on the board for an agent that does not exist.
  const state = await readState(opts.root, opts.log);
  const stopHeartbeat = state.agent_id
    ? startHeartbeat({ ...opts, agent_id: state.agent_id })
    : (() => {
        opts.log.warn('bridge.no_agent_id', 'no agent_id in state.json; not emitting presence', {
          root: opts.root,
        });
        return () => {};
      })();

  // The reaper needs an identity too -- the lease is claimed by an agent_id, and the dead-holder
  // check reads that agent's presence. No identity, no lease, no sweep.
  const stopReaper =
    opts.reaper && state.agent_id
      ? startReaper({ ...opts, agent_id: state.agent_id, reaper: opts.reaper })
      : () => {};
  let running = true;
  const stop = () => {
    running = false;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  opts.log.info('bridge.started', 'bridge running', {
    project_id: opts.project_id,
    root: opts.root,
    drain_interval_ms: interval,
  });

  while (running) {
    await drainOnce(opts);
    // Rule 2: a REAL timer. Never an injected clock on a transport path.
    await new Promise((r) => setTimeout(r, interval));
  }
  stopReaper();
  stopHeartbeat();
  stopInbox();
}

// The runnable entry point lives in firebase/bridge-run.ts, because constructing the store
// means importing the backend SDK and that is exactly what must not happen in this file.

export type { EventKind };
