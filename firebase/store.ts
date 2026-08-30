// CoordinationStore over Cloud Firestore, admin SDK. Route F of the bake-off.
//
// Written against the shared foundation promoted by Order 0002: it implements
// shared/store/types.ts and is measured by shared/store/conformance.ts UNMODIFIED. Where this
// file used to carry its own copy of a shared concern (a logger, a clock, a sanitiser, an
// error taxonomy) it now consumes the shared one, so any behavioural difference between the
// two builds is a difference in the backend rather than in the scaffolding around it.
//
// This is the authoritative Firestore implementation: the Cloud Functions API calls it, and
// the conformance suite runs it against the emulator. The browser adapter
// (client/src/store/firebase.ts) is read-only and much smaller, because clients never write
// the ledger directly — every write arrives here through the API, which resolves
// token -> agent_id server-side.
//
// Collection layout, all under one project document:
//
//   projects/{pid}                        { project_name, repo_url }
//   projects/{pid}/meta/ledger            { seq }            <- the monotonic counter
//   projects/{pid}/events/{sha256(key)}   the ledger, append-only, id IS the dedupe record
//   projects/{pid}/tasks/{task_id}        folded board state
//   projects/{pid}/agents/{agent_id}      presence + revocation flag
//   projects/{pid}/claims/{task_id}       one doc per claim; existence IS the lock
//   projects/{pid}/locks/{agent_id}       file-scope locks
//   projects/{pid}/contracts/{name}.v{n}  contract pointers
//
// Three deliberate choices worth calling out:
//
// 1. The event document id is sha256 of the idempotency key. Firestore doc ids cannot contain
//    '/', which the natural scope key ("scope:proj:agent:task:functions/**") does, so the raw
//    key is unusable as an id. Hashing makes every key a legal id and keeps the "repeat write
//    is naturally a no-op" property the platform gives us for free.
//
// 2. seq comes from a counter document read inside the same transaction as the append. That
//    makes it strictly ascending (A4) and gap-free. It also makes that one document the
//    write-throughput ceiling for the whole ledger — see the cost note on appendEvent.
//
// 3. subscribe never listens to the events collection. Firestore bills per document
//    delivered, and a listener on an append-only log re-delivers on every append forever. It
//    listens to the bounded folded collections plus the counter doc instead.

import { createHash } from 'node:crypto';
import type {
  DocumentData,
  DocumentReference,
  Firestore,
  Transaction,
} from 'firebase-admin/firestore';

import { findGlobConflicts, globsIntersect, normalizeGlob } from '../shared/globs.ts';
import { applyEvent, emptyProjection, toSnapshot, type FoldOutcome, type Projection } from './fold.ts';
import { StoreAuthError, StoreBusyError, StoreError, StoreOfflineError } from '../shared/store/errors.ts';
import { sanitizeBody, sanitizeText, VARCHAR_MAX } from '../shared/sanitize.ts';
import { consoleLogger, type Logger } from '../shared/log.ts';
import { systemClock, type Clock } from '../shared/clock.ts';
import { backoffMs } from '../shared/store/retry.ts';
import {
  LAYER_OF,
  LIMITS,
  STALE_AFTER_MS,
  type AgentId,
  type AgentPresence,
  type AgentStatus,
  type ContractPointer,
  type CoordinationStore,
  type Event,
  type EventInput,
  type Freshness,
  type ProjectId,
  type ScopeLock,
  type Seq,
  type Snapshot,
  type TaskId,
  type TaskView,
} from '../shared/store/types.ts';

export interface FirestoreStoreOptions {
  db: Firestore;
  log?: Logger;
  clock?: Clock;
  /**
   * How long a subscription may be disconnected before we tear the listeners down and
   * re-establish them. Firestore rebills a resumed query as new after roughly 30 minutes
   * offline, so past that point there is no saving left to protect — and holding the old
   * listener risks leaking it. Re-subscribing deliberately is cheaper than discovering later
   * that three dead listeners are still attached.
   */
  resubscribe_after_offline_ms?: number;
  /** Coalesce the 6 collection listeners into one frame. 0 disables (tests). */
  debounce_ms?: number;
  /**
   * Transaction attempts before transient contention is surfaced as StoreBusyError.
   * Default 6. Set to 1 to see raw contention, which is what the contention test does.
   */
  tx_attempts?: number;
}

const HUMAN_READABLE_LIMIT = 1_500;

/**
 * How long heartbeat may serve its revocation check from cache. Order 0039 ruling 2.
 *
 * This IS the staleness window the order required be bounded and stated: at most 90 s between
 * an agent being revoked and its heartbeat starting to refuse. Chosen to equal STALE_AFTER_MS
 * so the window a revoked agent can keep writing presence never exceeds the window after which
 * the board calls presence stale anyway. No other operation uses it.
 */
const REVOCATION_CACHE_MS = STALE_AFTER_MS;

/** meta, counter, tasks, agents, locks, contracts. The first-frame gate counts these. */
const LISTENER_COUNT = 6;

/**
 * Structured reason codes carried on mapped errors, so callers branch on a FIELD and never on
 * message text.
 *
 * Order 0017 ruling 1b, and it caught a real defect here: withContentionRetry detected
 * contention with `/aborted|contention|lock/i.test(error.message)`. That happened to work only
 * because mapFirestoreError composes the message from Google's own wording. If Google reworded
 * "Transaction lock timeout" to "Transaction conflict detected", the adapter would silently
 * stop retrying contention and start surfacing it to every caller again -- reintroducing the
 * intermittent shared-suite failure that took three runs to pin down. Worse, a QUOTA error
 * whose text happened to contain "lock" would have been retried, which is the one thing the
 * retry must never do: retrying an exhausted quota consumes more of what ran out.
 */
const CODE_ABORTED = 'ABORTED';
const CODE_RESOURCE_EXHAUSTED = 'RESOURCE_EXHAUSTED';

/**
 * A StoreBusyError that actually retains its structured reason code.
 *
 * Needed because the shared `StoreBusyError` constructor accepts `cause_code` on `StoreError`
 * but does not forward it -- it passes only `{ backend_message }` to super, so `cause_code` is
 * always undefined on a busy error. I found that while fixing the message-matching defect: my
 * first fix read `mapped.cause_code === CODE_ABORTED`, which would have been permanently false
 * and would have silently disabled contention retry altogether. That is a worse bug than the
 * one it replaced, and it would have shown up only as the intermittent shared-suite failure
 * coming back.
 *
 * A subclass rather than an edit: `shared/store/errors.ts` is frozen, and `instanceof
 * StoreBusyError` still holds, so nothing downstream -- including `isRetryable` and the shared
 * conformance suite -- can tell the difference.
 *
 * ORDER REQUEST: `StoreBusyError` should forward `cause_code` to super. Both builds need to
 * branch on a structured reason (Catalyst has to parse which column a DUPLICATE_VALUE names,
 * where only `seq` may be retried), and ruling 1b makes structured-only matching normative.
 * One line in the shared file removes the need for this subclass on both sides.
 */
class FirestoreBusyError extends StoreBusyError {
  readonly grpc_code: string;
  constructor(message: string, opts: { backend_message?: string; retry_after_ms?: number; grpc_code: string }) {
    super(message, { backend_message: opts.backend_message, retry_after_ms: opts.retry_after_ms });
    this.name = 'StoreBusyError'; // keep the wire-visible name identical to the shared taxonomy
    this.grpc_code = opts.grpc_code;
  }
}

/** True only for transient transaction contention, decided by a FIELD and never by text. */
export const isContention = (err: unknown): boolean =>
  err instanceof FirestoreBusyError && err.grpc_code === CODE_ABORTED;

/**
 * Apply a list cap and log the drop. Never truncate silently (non-negotiable H).
 *
 * Local rather than shared because the foundation does not export one; the log CODE is what
 * matters for parity, and `store.<list>.capped` matches the shape conformance.ts asserts for
 * readEvents.
 */
function capList<T>(
  items: T[],
  cap: number,
  meta: { list: string; requested: number; project_id: ProjectId },
  log: Logger,
): T[] {
  if (items.length <= cap) return items;
  const out = items.slice(0, cap);
  log.warn(`store.${meta.list}.capped`, `${meta.list} hit the row cap`, {
    project_id: meta.project_id,
    requested: meta.requested,
    applied: cap,
    returned: out.length,
    dropped: items.length - out.length,
  });
  return out;
}

/**
 * Scope a client-supplied idempotency key to its project, then hash it.
 *
 * Mandatory behaviour 1a: the idempotency key comes from the CLIENT, so "it is a uuid v4, it is
 * already unique" is not a safe assumption. Two callers in two projects can send the same key,
 * deliberately or by copying a script.
 *
 * The document path already contains the project, so a raw-key document id could not collide
 * across projects — and that was the trap. `event_id` was derived from the same unscoped hash,
 * so two projects using one key produced the SAME event_id: two distinct events, one identity.
 * Anything keying on event_id across projects — an audit view, a log correlation, a client-side
 * dedupe cache — would conflate two tenants' events. Caught by
 * firebase/concurrency.test.ts, not by reading the code.
 *
 * The parts are hashed SEPARATELY and then combined, rather than concatenated with a separator.
 * Catalyst has to build `"<project>:<key>"` and police a separator inside either part, because
 * `"a:b" + "c"` collides with `"a" + "b:c"`. Hashing each part first makes both operands
 * fixed-length hex, so there is no separator to get wrong and no rule to enforce. Same
 * guarantee, one fewer class of bug — and it is available to either build, so this is a key
 * construction note rather than a platform asymmetry.
 */
export const scopedKeyFor = (project_id: ProjectId, idempotency_key: string): string => {
  const p = createHash('sha256').update(project_id, 'utf8').digest('hex');
  const k = createHash('sha256').update(idempotency_key, 'utf8').digest('hex');
  return createHash('sha256').update(`${p}/${k}`, 'utf8').digest('hex');
};

/**
 * Read the seq counter, distinguishing "fresh project" from "corrupted counter".
 *
 * Extracted and hardened after order 0019, which carried a finding from the Catalyst build: a
 * hand-rolled `MAX(seq)` read returned `undefined` because ZCQL ignores the aggregate's column
 * alias, the code defaulted it to 0, and it allocated seq 1 -- colliding with the first event
 * ever written. The append path's retry loop then ABSORBED the bug: correct output, silently
 * more expensive.
 *
 * The line here was the same shape:
 *
 *     const seq = ((snap.exists ? (snap.get('seq') as number) : 0) ?? 0) + 1;
 *
 * `?? 0` collapses three genuinely different situations into one: no counter document (a real
 * fresh project, where 0 is right), a counter document whose `seq` field is missing or renamed
 * (a corrupted counter, where 0 silently restarts the ledger), and a `seq` that is not a number
 * at all. Only the first is legitimate.
 *
 * So the two bad cases now throw. This build would probably have failed loudly anyway -- every
 * event would carry seq 1 and A4 would catch it -- but "it happens to fail loudly" is luck, not
 * design, and that luck lasts exactly until something downstream absorbs it.
 */
export function readCounter(exists: boolean, raw: unknown, project_id: ProjectId): number {
  // A genuinely fresh project: no counter document yet. The only case where 0 is correct.
  if (!exists) return 0;

  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 0) return raw;

  // The counter exists but carries no usable seq. Defaulting to 0 would restart the ledger from
  // 1 and duplicate every seq already issued.
  throw new StoreError(
    `seq counter for ${project_id} exists but holds no usable value (got ${typeof raw}: ` +
      `${JSON.stringify(raw)}). Refusing to default to 0: that would restart the ledger and ` +
      `duplicate every seq already issued.`,
  );
}

/**
 * sha256 hex of a raw string. Deterministic, always a legal Firestore document id.
 *
 * Kept exported for tests. Callers inside the adapter use scopedKeyFor: an unscoped id is
 * exactly the bug above.
 */
export const docIdFor = (key: string): string =>
  createHash('sha256').update(key, 'utf8').digest('hex');

/**
 * Map a Firestore/gRPC failure onto the shared error vocabulary.
 *
 * Every branch is named. A catch-all that turned PERMISSION_DENIED into a retryable error
 * would put the CLI in a tight loop against an auth endpoint, billed per attempt, against a
 * project with no spending cap.
 */
export function mapFirestoreError(err: unknown, op: string): StoreError {
  const e = err as { code?: number | string; message?: string; details?: string };
  const code = e?.code;
  const msg = `${op}: ${e?.message ?? String(err)}`;
  // The backend's own words are kept for logs only, never for control flow.
  const detail = e?.details ?? e?.message ?? String(err);

  // gRPC numeric codes (admin SDK) and their string spellings (client SDK).
  switch (code) {
    case 7:
    case 'permission-denied':
    case 16:
    case 'unauthenticated':
      return new StoreAuthError(msg, { backend_message: detail });
    // NOTE: StoreAuthError's constructor takes no cause_code, so the structured code for auth
    // failures is not carried. That is fine -- nothing branches on WHICH auth failure it was,
    // and auth is terminal either way. Every code a caller branches on IS carried below.
    case 8:
    case 'resource-exhausted':
      // Quota. Firestore supplies no reset window, so advising one would be a fiction and would
      // suppress the caller's backoff the same way the ABORTED hint did.
      return new FirestoreBusyError(msg, { backend_message: detail, grpc_code: CODE_RESOURCE_EXHAUSTED });
    case 10:
    case 'aborted':
      // Transaction contention. Retryable, and deliberately WITHOUT a retry_after_ms hint.
      //
      // This carried `retry_after_ms: 250` and that was a real bug. The shared withRetry honours
      // a server-advised wait VERBATIM in preference to its own backoff:
      //
      //     const advised = err instanceof StoreBusyError ? err.retry_after_ms : undefined;
      //     const wait = advised ?? backoffMs(attempt, policy);
      //
      // so a constant hint replaced the jittered exponential curve with a flat 250 ms, forever.
      // Observed in a failing run: delays [250,250,250,250,250,250,250]. Every contender then
      // retries in LOCKSTEP every 250 ms and re-collides indefinitely — the precise failure the
      // shared retry's own header warns about.
      //
      // A hint is right when the backend knows when to come back (a rate limit with a reset
      // window). It is wrong for lock contention, where the only useful advice is "spread out
      // and grow", which is exactly what backoffMs already does. So: no hint.
      //
      // cause_code carries the STRUCTURED reason so callers can branch on it. See the note on
      // withContentionRetry: detecting contention by message text was a real defect.
      return new FirestoreBusyError(msg, { backend_message: detail, grpc_code: CODE_ABORTED });
    case 4:
    case 'deadline-exceeded':
    case 14:
    case 'unavailable':
      return new StoreOfflineError(msg, { backend_message: detail });
    default:
      return new StoreError(msg, { backend_message: detail, cause_code: String(code) });
  }
}

/**
 * Run a transaction, retrying transient lock contention with jittered exponential backoff.
 *
 * Why this belongs in the ADAPTER and not in every caller.
 *
 * Every append reads and writes one counter document, so contention on it is not an unusual
 * condition — it is the normal shape of concurrent work in this design. The Firestore SDK
 * retries internally and then gives up with `ABORTED: Transaction lock timeout`, which maps to
 * StoreBusyError: legal per the contract, and retryable.
 *
 * But pushing it to callers means every caller writes the same retry loop, and the shared
 * conformance suite does not write one at all — so A2 (20 concurrent claims, 50 rounds) went
 * intermittently red on this platform while being perfectly green on a backend where a claim
 * conflict is a VALUE rather than a retryable error. That is a platform difference leaking
 * through the seam, which is the one thing the seam exists to prevent.
 *
 * So transient contention is absorbed here, and StoreBusyError is surfaced only once the
 * contention is genuinely sustained. That is the honest boundary: a caller cannot do anything
 * smarter with a lock timeout than wait and spread out, and this already does both.
 */
async function withContentionRetry<T>(
  op: string,
  attempts: number,
  log: Logger,
  fn: () => Promise<T>,
): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const mapped = err instanceof StoreError ? err : mapFirestoreError(err, op);
      // ONLY contention, identified by its STRUCTURED code and never by message text.
      // A permission error, a bad argument or an exhausted quota must not be retried here --
      // quota in particular, because retrying it burns more of the thing that ran out.
      const contended = isContention(mapped);
      if (!contended || attempt === attempts - 1) throw mapped;

      const wait = backoffMs(attempt, { base_ms: 40, cap_ms: 2_000 });
      log.info('store.tx.contended', 'transaction contended, backing off', {
        op,
        attempt: attempt + 1,
        wait_ms: wait,
      });
      // REAL time, deliberately not this.clock.
      //
      // The injected Clock exists so staleness derivation (A9) and timestamps are testable. It
      // is NOT a general "make waiting fake" seam: FakeClock.sleep() resolves only on
      // advance(), so backing off through it would hang forever the first time contention
      // fired under the conformance harness — and it fires only under load, so it would have
      // presented as a load-dependent HANG rather than a failure. Strictly worse than an
      // intermittent test: nothing to read, no assertion, just a stuck run.
      //
      // Caught by probing FakeClock directly rather than by a test, because the test that
      // would have caught it is the one that only fails under contention.
      await new Promise<void>((resolve) => setTimeout(resolve, wait));
      last = mapped;
    }
  }
  throw last;
}

/** Wrap every backend call so no native Firestore error can escape the seam. */
async function guard<T>(op: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof StoreError) throw err; // already mapped, or thrown by us
    throw mapFirestoreError(err, op);
  }
}

/**
 * Result of the read phase of an append. Either "already there" or everything needed to write.
 * Modelled as a discriminated union so the write phase cannot accidentally write a duplicate.
 */
type AppendPlan =
  | { duplicate: true; event_id: string; seq: Seq }
  | {
      duplicate: false;
      event_id: string;
      seq: Seq;
      event: Event;
      projection: Projection;
      outcome: FoldOutcome;
      eventRef: DocumentReference;
      idempotency_key: string;
    };

interface LiveCache {
  tasks: Map<string, TaskView>;
  agents: Map<string, StoredAgent>;
  locks: Map<string, ScopeLock>;
  contracts: Map<string, ContractPointer>;
  seq: number;
  /** Which listeners have delivered at least once. Gates the first frame (A10). */
  ready: Set<string>;
}

interface StoredAgent {
  agent_id: AgentId;
  role_slug: string;
  member_label: string;
  initials: string;
  harness: AgentPresence['harness'];
  status: AgentStatus;
  current_task: TaskId | null;
  branch: string | null;
  /** Epoch ms. Stored as a number, not a Timestamp: the fold and the stale check both want ms. */
  last_heartbeat_ms: number | null;
  revoked?: boolean;
}

export class FirestoreStore implements CoordinationStore {
  /** Firestore is genuinely push-based. Do not fake a poll counter (see the dashboard doc). */
  readonly freshness: Freshness = { mode: 'live', stale_ms: 0 };

  private readonly db: Firestore;
  private readonly log: Logger;
  private readonly clock: Clock;
  private readonly debounce_ms: number;
  private readonly resubscribe_after_offline_ms: number;
  private readonly caches = new Map<ProjectId, LiveCache>();
  private readonly teardowns = new Set<() => void>();
  /**
   * Seq the snapshot is pinned to while frozen, per project. -1 means not frozen.
   *
   * Firestore has no debounced snapshot writer, so this window does not arise naturally here:
   * readSnapshot reads the same state the fold wrote. A13 nevertheless has to run against both
   * adapters — it is testing the CALLER's rule ("stale, not lost; never re-append"), and that
   * rule is shared. So this reproduces the lag rather than skipping the box, and the notes file
   * records plainly that on this platform it is induced rather than observed.
   */
  private readonly frozenAt = new Map<ProjectId, number>();
  /** Transaction attempts before contention is surfaced to the caller. */
  private readonly tx_attempts: number;
  /**
   * When each agent was last CONFIRMED NOT revoked. Keyed by JSON.stringify([pid, agent_id]).
   *
   * Presence-only, and allows only -- a deny is never cached, so revocation takes effect on the
   * next call and un-revocation does too.
   *
   * JSON rather than a joined string on purpose, for the same reason scopedKeyFor() hashes its
   * parts separately: there is then no separator character whose absence from ids I have to keep
   * policing. Read by heartbeat only -- see assertNotRevokedCached().
   */
  private readonly revocation = new Map<string, { at: number }>();

  constructor(opts: FirestoreStoreOptions) {
    this.db = opts.db;
    this.log = opts.log ?? consoleLogger;
    this.clock = opts.clock ?? systemClock;
    this.debounce_ms = opts.debounce_ms ?? 40;
    this.resubscribe_after_offline_ms = opts.resubscribe_after_offline_ms ?? 25 * 60_000;
    this.tx_attempts = opts.tx_attempts ?? 6;
  }

  // ---- paths -------------------------------------------------------------------------

  private proj(pid: ProjectId) {
    return this.db.collection('projects').doc(pid);
  }
  private counterRef(pid: ProjectId): DocumentReference {
    return this.proj(pid).collection('meta').doc('ledger');
  }
  private eventsRef(pid: ProjectId) {
    return this.proj(pid).collection('events');
  }
  private tasksRef(pid: ProjectId) {
    return this.proj(pid).collection('tasks');
  }
  private agentsRef(pid: ProjectId) {
    return this.proj(pid).collection('agents');
  }
  private claimsRef(pid: ProjectId) {
    return this.proj(pid).collection('claims');
  }
  private locksRef(pid: ProjectId) {
    return this.proj(pid).collection('locks');
  }
  private contractsRef(pid: ProjectId) {
    return this.proj(pid).collection('contracts');
  }

  private iso(): string {
    return this.clock.iso();
  }

  /**
   * Every transaction in this adapter goes through here.
   *
   * One chokepoint rather than six call sites, so "transactions absorb transient contention" is
   * a property of the adapter rather than something six places have to remember.
   */
  private tx<T>(op: string, body: (tx: Transaction) => Promise<T>): Promise<T> {
    return withContentionRetry(op, this.tx_attempts, this.log, () => this.db.runTransaction(body));
  }

  // ---- setup (not one of the ten) ----------------------------------------------------

  async ensureProject(
    pid: ProjectId,
    meta: { project_name: string; repo_url: string },
  ): Promise<void> {
    await guard('ensureProject', async () => {
      await this.proj(pid).set(meta, { merge: true });
      await this.counterRef(pid).set({ seq: 0 }, { merge: true });
    });
  }

  async seedTasks(pid: ProjectId, tasks: TaskView[]): Promise<void> {
    await guard('seedTasks', async () => {
      const batch = this.db.batch();
      for (const t of tasks) batch.set(this.tasksRef(pid).doc(t.task_id), t);
      await batch.commit();
    });
  }

  async registerAgent(
    pid: ProjectId,
    a: Pick<AgentPresence, 'agent_id' | 'role_slug' | 'member_label' | 'initials' | 'harness'>,
  ): Promise<void> {
    await guard('registerAgent', async () => {
      await this.agentsRef(pid).doc(a.agent_id).set(
        {
          ...a,
          status: 'connected' satisfies AgentStatus,
          current_task: null,
          branch: null,
          last_heartbeat_ms: null,
          revoked: false,
        } satisfies StoredAgent,
        { merge: true },
      );
    });
  }

  /**
   * Freeze or thaw the folded snapshot for one project. Test seam for A13 only.
   *
   * Deliberately named for what it is. It does not touch the ledger, so a frozen snapshot is
   * genuinely stale rather than lossy, which is exactly the condition the caller must tolerate.
   */
  async setSnapshotFrozen(pid: ProjectId, on: boolean): Promise<void> {
    if (!on) {
      this.frozenAt.delete(pid);
      return;
    }
    const counter = await this.counterRef(pid).get();
    this.frozenAt.set(pid, ((counter.get('seq') as number) ?? 0));
  }

  /** Revoke or restore an agent's token. The API checks this on every request. */
  async setRevoked(pid: ProjectId, agent_id: AgentId, revoked: boolean): Promise<void> {
    await guard('setRevoked', () => this.agentsRef(pid).doc(agent_id).set({ revoked }, { merge: true }));
  }

  /**
   * Throw StoreAuthError if the agent's token has been revoked.
   *
   * Called on every write path. It costs one document read, which is the price of the
   * protocol's "resolve token -> agent_id -> project -> role on EVERY request" rule. Caching
   * it would mean a revoked agent keeps writing for the cache lifetime.
   */
  private async assertNotRevoked(pid: ProjectId, agent_id: AgentId | undefined): Promise<void> {
    if (!agent_id) return;
    const snap = await this.agentsRef(pid).doc(agent_id).get();
    const revoked = snap.exists && snap.get('revoked') === true;
    const key = JSON.stringify([pid, agent_id]);
    if (revoked) {
      // ONLY THE ALLOW IS EVER CACHED. Caching the deny looks safer and is worse: it is
      // fail-closed, so it cannot let a revoked agent through, but it makes UN-revoking take up
      // to the full window to be honoured on the heartbeat path. Found by the revocation check
      // against real Firestore -- re-instating an agent left it unable to beat for 90 s. A
      // revoked agent simply pays a fresh read per beat, which is the correct incentive.
      this.revocation.delete(key);
      throw new StoreAuthError(`token revoked for ${agent_id}`);
    }
    this.revocation.set(key, { at: this.clock.now() });
  }

  /**
   * The same check, for heartbeat only, served from a short-lived cache.
   *
   * Heartbeat is the most-repeated operation in the system and the only one whose revocation
   * read buys nothing -- see the argument at heartbeat(). Every OTHER caller still uses
   * assertNotRevoked() and still pays a fresh read, so a stale allow can never grant authority
   * over shared state; the worst it permits is an extra presence row that the board renders as
   * `revoked` regardless.
   *
   * The entry is written by BOTH paths, so an agent that claims a task (fresh read) also warms
   * this cache, and a revocation observed by any operation is honoured here immediately.
   */
  private async assertNotRevokedCached(pid: ProjectId, agent_id: AgentId): Promise<void> {
    const hit = this.revocation.get(JSON.stringify([pid, agent_id]));
    if (hit && this.clock.now() - hit.at < REVOCATION_CACHE_MS) return;
    await this.assertNotRevoked(pid, agent_id);
  }

  // ---- ledger ------------------------------------------------------------------------

  /**
   * READ phase of an append. Does every transactional read and returns a plan; writes nothing.
   *
   * Split into two phases because Firestore transactions require all reads before all writes,
   * and claimTask / releaseTask need to write their own document as part of the same
   * transaction. A single appendInTx() that read and wrote could only ever be called first,
   * which made "claim and its event land atomically" impossible to express. This was found by
   * A2 against the emulator, not by reading the docs.
   *
   * Cost per call: 2 reads (dedupe doc + counter) plus 1 read per task touched, and 2-3
   * writes. The counter document is the throughput ceiling — Firestore sustains about one
   * write per second per document, so this design caps ledger appends at ~1/s. At the volume
   * this protocol was designed for (5-30 facts a day, per blackboard.md) that is irrelevant;
   * at 100 appends/second it would need a sharded counter and seq would lose gap-freeness.
   */
  private async planAppend(
    tx: Transaction,
    pid: ProjectId,
    input: EventInput,
    idempotency_key: string,
  ): Promise<AppendPlan> {
    const id = scopedKeyFor(pid, idempotency_key);
    const eventRef = this.eventsRef(pid).doc(id);

    const existing = await tx.get(eventRef);
    if (existing.exists) {
      // The platform gives idempotency for free here, but the contract still requires the
      // ORIGINAL seq back, so we read it rather than assuming the caller does not care.
      return {
        duplicate: true,
        event_id: existing.get('event_id') as string,
        seq: existing.get('seq') as number,
      };
    }

    // Validation and sanitisation inlined to match shared/store/memory.ts EXACTLY. The
    // foundation has no shared prepare step, and the two behaviours that must not diverge are
    // (a) a layer mismatch THROWS rather than being silently corrected — the layer decides who
    // receives an event, and a human-layer event reaching an agent is a protocol violation —
    // and (b) durable text goes through the shared sanitiser with the same field names.
    if (!idempotency_key) throw new StoreError('idempotency_key is required');
    const canonical_layer = LAYER_OF[input.kind];
    if (canonical_layer === undefined) throw new StoreError(`unknown event kind: ${input.kind}`);
    if (input.layer !== canonical_layer) {
      throw new StoreError(
        `layer mismatch for ${input.kind}: got '${input.layer}', must be '${canonical_layer}'`,
      );
    }
    const prepared: EventInput = {
      layer: canonical_layer,
      kind: input.kind,
      actor_type: input.actor_type,
      actor_id: sanitizeText(input.actor_id, {
        field: 'events.actor_id',
        max: VARCHAR_MAX,
        log: this.log,
      }),
      body: sanitizeBody(input.body, this.log, `${input.kind}.body`),
    };
    const counterSnap = await tx.get(this.counterRef(pid));
    const seq = readCounter(counterSnap.exists, counterSnap.get('seq'), pid) + 1;

    const taskId = typeof prepared.body.task_id === 'string' ? prepared.body.task_id : null;
    const taskSnap = taskId ? await tx.get(this.tasksRef(pid).doc(taskId)) : null;

    const event: Event = {
      // Derived from the PROJECT-SCOPED hash, so event_id is unique across projects.
      event_id: `evt_${id.slice(0, 12)}`,
      project_id: pid,
      seq,
      created_at: this.iso(),
      ...prepared,
    };

    // Fold against a projection holding only what this event can touch. Reusing the shared
    // reducer is what keeps the two builds' board semantics from drifting.
    const p: Projection = emptyProjection();
    p.seq = seq - 1;
    if (taskSnap?.exists) p.tasks.set(taskId!, taskSnap.data() as TaskView);
    const outcome = applyEvent(p, event);
    for (const ig of outcome.ignored) this.log.warn('store.fold.ignored', 'event changed no state and was recorded as ignored', { ...ig, project_id: pid });

    return { duplicate: false, event_id: event.event_id, seq, event, projection: p, outcome, eventRef, idempotency_key };
  }

  /** WRITE phase. Pure buffering onto the transaction; performs no reads. */
  private commitAppend(tx: Transaction, pid: ProjectId, plan: AppendPlan): void {
    if (plan.duplicate) return; // a repeat appends nothing, by definition
    const { event, projection: p, outcome, eventRef, idempotency_key } = plan;

    tx.set(eventRef, { ...event, idempotency_key });
    tx.set(this.counterRef(pid), { seq: plan.seq }, { merge: true });
    for (const tid of outcome.touched_tasks) {
      const view = p.tasks.get(tid);
      if (view) tx.set(this.tasksRef(pid).doc(tid), view, { merge: true });
    }
    for (const [agent_id, lock] of p.locks) tx.set(this.locksRef(pid).doc(agent_id), lock);
    // scope_released empties p.locks, so a delete has to be driven off the event, not the map.
    if (event.kind === 'scope_released' && typeof event.body.agent_id === 'string') {
      tx.delete(this.locksRef(pid).doc(event.body.agent_id));
    }
    for (const c of p.contracts) {
      tx.set(this.contractsRef(pid).doc(`${c.name}.v${c.version}`), c);
    }
  }

  async appendEvent(
    pid: ProjectId,
    event: EventInput,
    idempotency_key: string,
  ): Promise<{ event_id: string; seq: Seq; duplicate: boolean }> {
    await this.assertNotRevoked(pid, event.actor_type === 'agent' ? event.actor_id : undefined);
    return guard('appendEvent', async () => {
      const r = await this.tx('appendEvent', async (tx) => {
        const plan = await this.planAppend(tx, pid, event, idempotency_key);
        this.commitAppend(tx, pid, plan);
        return plan;
      });
      return { event_id: r.event_id, seq: r.seq, duplicate: r.duplicate };
    });
  }

  async readEvents(
    pid: ProjectId,
    since_seq: Seq,
    limit = LIMITS.events,
  ): Promise<{ events: Event[]; next_cursor: Seq; has_more: boolean }> {
    return guard('readEvents', async () => {
      const requested = limit;
      const effective = Math.max(1, Math.min(limit, LIMITS.events));
      if (requested > LIMITS.events) {
        this.log.warn('store.events.capped', 'readEvents hit the row cap', {
          project_id: pid,
          since_seq,
          requested,
          applied: effective,
          returned: effective,
          dropped: requested - effective,
        });
      }
      // Fetch one extra to answer has_more without a second query (one extra document read
      // beats a count() aggregation, which is billed per 1,000 index entries scanned).
      const snap = await this.eventsRef(pid)
        .where('seq', '>', since_seq)
        .orderBy('seq', 'asc')
        .limit(effective + 1)
        .get();

      const all = snap.docs.map((d) => stripInternal(d.data()));
      const events = all.slice(0, effective);
      const last = events.at(-1);
      return {
        events,
        next_cursor: last ? last.seq : since_seq,
        has_more: all.length > events.length,
      };
    });
  }

  // ---- claims ------------------------------------------------------------------------

  async claimTask(
    pid: ProjectId,
    task_id: TaskId,
    agent_id: AgentId,
  ): Promise<{ ok: true } | { ok: false; owner: AgentId; claimed_at: string }> {
    await this.assertNotRevoked(pid, agent_id);
    return guard('claimTask', async () => {
      const claimRef = this.claimsRef(pid).doc(task_id);
      return this.tx('claimTask', async (tx) => {
        const held = await tx.get(claimRef);
        if (held.exists) {
          const owner = held.get('agent_id') as AgentId;
          // Re-claiming your own task is idempotent; a CLI restart must not lose its claim.
          if (owner === agent_id) return { ok: true as const };
          // A normal outcome of a race, not an error. Never logged as one.
          return {
            ok: false as const,
            owner,
            claimed_at: held.get('claimed_at') as string,
          };
        }
        const claimed_at = this.iso();
        // Read phase must finish before any write, so plan the append first even though the
        // claim document is conceptually the primary write.
        const plan = await this.planAppend(
          tx,
          pid,
          {
            layer: 'coordination',
            kind: 'task_claimed',
            actor_type: 'agent',
            actor_id: agent_id,
            body: { task_id, agent_id },
          },
          `claim:${pid}:${task_id}:${agent_id}:${claimed_at}`,
        );
        // create() fails if the doc appeared since our read, which is the belt to the
        // transaction's braces: exactly one caller can win even under aggressive retry.
        tx.create(claimRef, { task_id, agent_id, claimed_at });
        this.commitAppend(tx, pid, plan);
        return { ok: true as const };
      });
    });
  }

  async releaseTask(pid: ProjectId, task_id: TaskId, agent_id: AgentId): Promise<void> {
    await this.assertNotRevoked(pid, agent_id);
    await guard('releaseTask', async () => {
      const claimRef = this.claimsRef(pid).doc(task_id);
      await this.tx('releaseTask', async (tx) => {
        const held = await tx.get(claimRef);
        // Releasing a task you do not own is a no-op, not an error.
        if (!held.exists || held.get('agent_id') !== agent_id) return;
        const plan = await this.planAppend(
          tx,
          pid,
          {
            layer: 'contract',
            kind: 'task_unblocked',
            actor_type: 'agent',
            actor_id: agent_id,
            body: { task_id, was_blocked_by: null, reason_resolved: 'released by owner' },
          },
          `release:${pid}:${task_id}:${agent_id}:${held.get('claimed_at')}`,
        );
        tx.delete(claimRef);
        this.commitAppend(tx, pid, plan);
      });
    });
  }

  /**
   * Release a claim on behalf of the SYSTEM, not the owner. Used only by the reaper.
   *
   * Not one of the ten, and deliberately separate from releaseTask, because the reaper is not
   * the owning agent and pretending otherwise produced two real bugs:
   *
   *   1. Double-append. releaseTask appends its own `task_unblocked` attributed to the agent,
   *      so a reaper that called releaseTask AND appended its own reap event put two
   *      task_unblocked events on the ledger for one release.
   *   2. A revoked agent's claim could never be reaped at all. releaseTask calls
   *      assertNotRevoked, which throws for exactly the agent whose claim most needs releasing.
   *
   * So this deletes the claim and appends exactly ONE system-attributed event, in one
   * transaction, and does not consult the agent's token state — the reaper's authority does not
   * come from the agent.
   */
  async reapClaim(
    pid: ProjectId,
    task_id: TaskId,
    agent_id: AgentId,
    reason: string,
  ): Promise<{ released: boolean }> {
    return guard('reapClaim', async () => {
      const claimRef = this.claimsRef(pid).doc(task_id);
      return this.tx('reapClaim', async (tx) => {
        const held = await tx.get(claimRef);
        // Someone else already released it, or the owner changed since the survey. Either way
        // there is nothing to reap and nothing to append.
        if (!held.exists || held.get('agent_id') !== agent_id) return { released: false };
        const plan = await this.planAppend(
          tx,
          pid,
          {
            layer: 'contract',
            kind: 'task_unblocked',
            actor_type: 'system',
            actor_id: 'reaper',
            body: { task_id, was_blocked_by: null, reason_resolved: `claim reaped: ${reason}` },
          },
          `reap:${pid}:${task_id}:${agent_id}:${held.get('claimed_at')}`,
        );
        tx.delete(claimRef);
        this.commitAppend(tx, pid, plan);
        return { released: true };
      });
    });
  }

  async claimOwner(pid: ProjectId, task_id: TaskId): Promise<AgentId | null> {
    return guard('claimOwner', async () => {
      const d = await this.claimsRef(pid).doc(task_id).get();
      return d.exists ? (d.get('agent_id') as AgentId) : null;
    });
  }

  // ---- scope locks -------------------------------------------------------------------

  async acquireScope(
    pid: ProjectId,
    agent_id: AgentId,
    task_id: TaskId,
    globs: string[],
  ): Promise<{ ok: true } | { ok: false; conflicts: ScopeLock[] }> {
    await this.assertNotRevoked(pid, agent_id);
    // normalizeGlob throws GlobSyntaxError on an unsupported pattern. Deliberately outside
    // the transaction and outside guard(): a bad glob is a caller bug, not a backend failure,
    // and dressing it up as a StoreError would send the CLI into a retry loop over it.
    const want = globs.map(normalizeGlob);

    return guard('acquireScope', async () =>
      this.tx('acquireScope', async (tx) => {
        // Read the whole (bounded) lock table. Capped at LIMITS.locks so one project cannot
        // turn this into an unbounded transactional read.
        const snap = await tx.get(this.locksRef(pid).limit(LIMITS.locks + 1));
        const held = snap.docs.map((d) => d.data() as ScopeLock);
        if (held.length > LIMITS.locks) {
          this.log.warn('store.locks.capped', 'lock table at its cap, refusing a new lock', {
            project_id: pid,
            requested: held.length,
            applied: LIMITS.locks,
            dropped: held.length - LIMITS.locks,
          });
          throw new StoreBusyError('lock table full', { retry_after_ms: 1_000 });
        }

        const conflicts = held.filter(
          (lock) =>
            lock.agent_id !== agent_id &&
            lock.globs.some((h) => want.some((w) => globsIntersect(w, h))),
        );
        if (conflicts.length > 0) {
          this.log.info('store.scope.rejected', 'file-scope request intersects a live lock', {
            project_id: pid,
            agent_id,
            task_id,
            pairs: conflicts.flatMap((c) => findGlobConflicts(want, c.globs)),
          });
          return { ok: false as const, conflicts };
        }

        const plan = await this.planAppend(
          tx,
          pid,
          {
            layer: 'contract',
            kind: 'scope_locked',
            actor_type: 'agent',
            actor_id: agent_id,
            body: { agent_id, task_id, globs: want },
          },
          `scope:${pid}:${agent_id}:${task_id}:${want.join(',')}`,
        );
        this.commitAppend(tx, pid, plan);
        return { ok: true as const };
      }),
    );
  }

  async releaseScope(pid: ProjectId, agent_id: AgentId): Promise<void> {
    await this.assertNotRevoked(pid, agent_id);
    await guard('releaseScope', async () => {
      const ref = this.locksRef(pid).doc(agent_id);
      await this.tx('releaseScope', async (tx) => {
        const held = await tx.get(ref);
        if (!held.exists) return; // no-op
        const lock = held.data() as ScopeLock;
        const plan = await this.planAppend(
          tx,
          pid,
          {
            layer: 'contract',
            kind: 'scope_released',
            actor_type: 'agent',
            actor_id: agent_id,
            body: { agent_id, task_id: lock.task_id },
          },
          `unscope:${pid}:${agent_id}:${lock.task_id}:${lock.acquired_at}`,
        );
        this.commitAppend(tx, pid, plan);
      });
    });
  }

  // ---- presence ----------------------------------------------------------------------

  /**
   * One field write on the agent document. Not an event.
   *
   * Cost arithmetic, because this is the line item that surprises people: Firestore's free
   * tier is 20,000 document writes per DAY. A 20-second heartbeat is 4,320 writes per agent
   * per day; three agents would spend 12,960 of the 20,000 on presence alone and leave almost
   * nothing for actual work. At the 30s interval the CLI defaults to, three agents over an
   * 8-hour session cost 2,880 writes. That is the real constraint here, and it is a different
   * one from Catalyst's (1,000 Data Store UPDATEs per MONTH, which no interval survives).
   */
  async heartbeat(
    pid: ProjectId,
    agent_id: AgentId,
    status: AgentStatus,
    current_task: TaskId | null = null,
    branch: string | null = null,
  ): Promise<void> {
    // Order 0039 ruling 2, with one deviation the order could not have known about.
    //
    // The ruling approved DELETING this check, on my own recommendation. It cannot be deleted:
    // conformance A14 requires `heartbeat` to throw StoreAuthError for a revoked agent and to
    // not be retried, and shared/store/conformance.ts is frozen and must run unmodified by both
    // adapters. I found that by reading the suite before making the change, not after.
    //
    // So the read gets CHEAPER rather than removed: cached, for heartbeat only. Every other
    // mutating operation (appendEvent, claimTask, releaseTask, acquireScope, releaseScope) still
    // pays a fresh read, because those grant authority over shared state and a stale allow there
    // is a real security hole. A heartbeat grants nothing -- it writes the agent's own presence
    // row -- which is what makes the cached check safe HERE and only here.
    //
    // Why a revoked agent still cannot appear present, in three parts, none of which depend on
    // the cache being fresh:
    //
    //   1. It cannot un-revoke itself. This payload has no `revoked` field and the write is
    //      merge:true, so `revoked: true` survives every heartbeat a revoked agent can send.
    //   2. Both readers resolve it independently of the cache. toPresence() below and the
    //      browser adapter's emit() derive `status: revoked ? 'revoked' : ...` from the agent
    //      DOCUMENT, which they have already paid to fetch. So the board shows `revoked` within
    //      one push delivery no matter what this cache believes.
    //   3. Its claims are not protected by a fresh heartbeat. The reaper releases a revoked
    //      agent's claims immediately, without consulting the timeout at all
    //      (functions/src/reaper.ts). A revoked agent beating faster changes nothing.
    //
    // THE STALENESS BOUND, stated rather than left implicit, as the order requires:
    // at most REVOCATION_CACHE_MS (90 s) between revocation and this operation refusing. At a
    // 30 s beat that is at most three further presence writes by a revoked agent, each of which
    // the board renders as `revoked`. It is bounded by a constant, not by a retry or a timeout.
    await this.assertNotRevokedCached(pid, agent_id);
    await guard('heartbeat', async () => {
      await this.agentsRef(pid).doc(agent_id).set(
        {
          agent_id,
          status,
          current_task,
          branch,
          last_heartbeat_ms: this.clock.now(),
        },
        { merge: true },
      );
    });
  }

  async listPresence(pid: ProjectId): Promise<AgentPresence[]> {
    return guard('listPresence', async () => {
      const snap = await this.agentsRef(pid).limit(LIMITS.presence + 1).get();
      const rows = snap.docs.map((d) => this.toPresence(d.data() as StoredAgent));
      return capList(
        rows,
        LIMITS.presence,
        { list: 'presence', requested: rows.length, project_id: pid },
        this.log,
      );
    });
  }

  private toPresence(a: StoredAgent): AgentPresence {
    const hb = a.last_heartbeat_ms ?? null;
    return {
      agent_id: a.agent_id,
      role_slug: a.role_slug ?? 'unknown',
      member_label: a.member_label ?? a.agent_id,
      initials: a.initials ?? a.agent_id.slice(-2).toUpperCase(),
      harness: a.harness ?? 'manual',
      // A revoked agent is not merely offline; the dashboard must say so distinctly.
      status: a.revoked ? 'revoked' : (a.status ?? 'offline'),
      current_task: a.current_task ?? null,
      branch: a.branch ?? null,
      last_heartbeat_at: hb === null ? null : new Date(hb).toISOString(),
      // Derived at read time. There is no `stale` field in Firestore, deliberately — storing
      // it would need a write per agent per timeout to stay true.
      stale: hb === null || this.clock.now() - hb > STALE_AFTER_MS,
    };
  }

  // ---- read + notify -----------------------------------------------------------------

  async readSnapshot(
    pid: ProjectId,
    etag?: string,
  ): Promise<{ snapshot: Snapshot; etag: string } | null> {
    return guard('readSnapshot', async () => {
      const cached = this.caches.get(pid);
      // A live subscription already holds every document this needs, so reading from it costs
      // zero Firestore operations — the whole point of readSnapshot being described as "cheap,
      // high-frequency".
      //
      // But only once every listener has delivered its initial load. `subscribe` installs the
      // cache entry immediately, so a readSnapshot racing a fresh subscribe would otherwise
      // read a half-loaded cache and confidently report an EMPTY board with seq 0 — which is
      // indistinguishable, to a caller, from a project that genuinely has no tasks. Falling
      // back to the server costs a handful of reads and cannot lie.
      const usable = cached && cached.ready.size >= LISTENER_COUNT;
      const snapshot = usable ? this.assemble(pid, cached) : await this.assembleFromServer(pid);
      const frozen = this.frozenAt.get(pid);
      if (frozen !== undefined && frozen >= 0) {
        // Report the fold as it stood when the freeze began. The ledger is unaffected:
        // readEvents still sees every appended event, which is the whole point of A13.
        snapshot.seq = Math.min(snapshot.seq, frozen);
      }
      const tag = etagOf(snapshot);
      if (etag && etag === tag) return null; // 304 equivalent
      return { snapshot, etag: tag };
    });
  }

  private async assembleFromServer(pid: ProjectId): Promise<Snapshot> {
    const [meta, counter, tasks, agents, locks, contracts] = await Promise.all([
      this.proj(pid).get(),
      this.counterRef(pid).get(),
      this.tasksRef(pid).get(),
      this.agentsRef(pid).limit(LIMITS.presence + 1).get(),
      this.locksRef(pid).limit(LIMITS.locks + 1).get(),
      this.contractsRef(pid).get(),
    ]);
    const p = emptyProjection();
    p.seq = (counter.get('seq') as number) ?? 0;
    for (const d of tasks.docs) p.tasks.set(d.id, d.data() as TaskView);
    for (const d of locks.docs) p.locks.set(d.id, d.data() as ScopeLock);
    p.contracts = contracts.docs.map((d) => d.data() as ContractPointer);
    const presence = capList(
      agents.docs.map((d) => this.toPresence(d.data() as StoredAgent)),
      LIMITS.presence,
      { list: 'presence', requested: agents.size, project_id: pid },
      this.log,
    );
    return toSnapshot(
      p,
      {
        project_id: pid,
        project_name: (meta.get('project_name') as string) ?? pid,
        repo_url: (meta.get('repo_url') as string) ?? '',
        generated_at: this.iso(),
      },
      presence,
    );
  }

  private assemble(pid: ProjectId, c: LiveCache): Snapshot {
    const p = emptyProjection();
    p.seq = c.seq;
    for (const [k, v] of c.tasks) p.tasks.set(k, v);
    for (const [k, v] of c.locks) p.locks.set(k, v);
    p.contracts = [...c.contracts.values()];
    const presence = capList(
      [...c.agents.values()].map((a) => this.toPresence(a)),
      LIMITS.presence,
      { list: 'presence', requested: c.agents.size, project_id: pid },
      this.log,
    );
    return toSnapshot(
      p,
      {
        project_id: pid,
        project_name: this.projectMeta.get(pid)?.project_name ?? pid,
        repo_url: this.projectMeta.get(pid)?.repo_url ?? '',
        generated_at: this.iso(),
      },
      presence,
    );
  }

  private readonly projectMeta = new Map<ProjectId, { project_name: string; repo_url: string }>();

  /**
   * Live subscription over the folded collections plus the counter document.
   *
   * It deliberately does NOT listen to `events`. Firestore bills per document delivered on
   * change, so a listener on an append-only log pays for every event forever — and the
   * dashboard does not render the ledger, it renders the fold. The counter doc supplies `seq`
   * in one document instead of one per event.
   *
   * The six listeners are gated: the first frame fires only once all six have delivered
   * their initial load, so subscribers get one complete snapshot rather than six partial
   * ones (A10). An empty collection still delivers an initial empty snapshot, so the gate
   * cannot deadlock on a fresh project.
   */
  subscribe(pid: ProjectId, from_seq: Seq, onChange: (s: Snapshot) => void): () => void {
    const cache: LiveCache = this.caches.get(pid) ?? {
      tasks: new Map(),
      agents: new Map(),
      locks: new Map(),
      contracts: new Map(),
      seq: 0,
      ready: new Set(),
    };
    this.caches.set(pid, cache);

    let closed = false;
    let timer: NodeJS.Timeout | null = null;
    let firstFrameSent = false;
    let offlineSince: number | null = null;

    const emit = () => {
      if (closed) return;
      // Hold the first frame until every listener has loaded, then never gate again.
      if (!firstFrameSent && cache.ready.size < LISTENER_COUNT) return;
      firstFrameSent = true;
      const snap = this.assemble(pid, cache);
      try {
        onChange(snap);
      } catch (err) {
        // A throwing subscriber must not tear down the subscription for everyone else.
        this.log.warn('store.subscribe.callback_threw', 'a subscriber callback threw; other subscribers unaffected', { project_id: pid, error: String(err) });
      }
    };

    const schedule = () => {
      if (closed) return;
      if (this.debounce_ms <= 0) {
        emit();
        return;
      }
      // Coalesce: six collections settling after one transaction should be one frame, not
      // six. Also prevents the dashboard re-rendering mid-write (E9, no layout shift).
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        emit();
      }, this.debounce_ms);
    };

    const onErr = (name: string) => (err: Error) => {
      const mapped = mapFirestoreError(err, `subscribe.${name}`);
      if (mapped instanceof StoreOfflineError) {
        if (offlineSince === null) offlineSince = this.clock.now();
        const down = this.clock.now() - offlineSince;
        if (down > this.resubscribe_after_offline_ms) {
          // Past this point Firestore rebills the resumed query as a new one anyway, so the
          // only thing the old listener still does is leak. Log it and let the caller decide.
          this.log.warn('store.listener.rebill_threshold', 'listener offline past the point where a resumed query is rebilled as new', {
            project_id: pid,
            offline_ms: down,
            listener: name,
          });
        } else {
          this.log.info('store.listener.offline', 'listener transiently offline; the SDK will resume it', {
            project_id: pid,
            listener: name,
          });
        }
        return; // the SDK retries on its own; do not unsubscribe on a transient drop
      }
      // Auth and anything else is terminal for this listener. Surfacing it is the only
      // honest option — silently retrying a permission-denied listener bills forever.
      this.log.warn('store.listener.failed', 'listener failed terminally', { project_id: pid, listener: name, error: mapped.message });
    };

    const ready = (name: string) => {
      cache.ready.add(name);
      offlineSince = null;
      schedule();
    };

    const unsubs: (() => void)[] = [
      this.proj(pid).onSnapshot((d) => {
        this.projectMeta.set(pid, {
          project_name: (d.get('project_name') as string) ?? pid,
          repo_url: (d.get('repo_url') as string) ?? '',
        });
        ready('meta');
      }, onErr('meta')),

      this.counterRef(pid).onSnapshot((d) => {
        cache.seq = (d.get('seq') as number) ?? 0;
        ready('counter');
      }, onErr('counter')),

      this.tasksRef(pid).onSnapshot((s) => {
        for (const ch of s.docChanges()) {
          if (ch.type === 'removed') cache.tasks.delete(ch.doc.id);
          else cache.tasks.set(ch.doc.id, ch.doc.data() as TaskView);
        }
        ready('tasks');
      }, onErr('tasks')),

      this.agentsRef(pid)
        .limit(LIMITS.presence)
        .onSnapshot((s) => {
          for (const ch of s.docChanges()) {
            if (ch.type === 'removed') cache.agents.delete(ch.doc.id);
            else cache.agents.set(ch.doc.id, ch.doc.data() as StoredAgent);
          }
          ready('agents');
        }, onErr('agents')),

      this.locksRef(pid)
        .limit(LIMITS.locks)
        .onSnapshot((s) => {
          for (const ch of s.docChanges()) {
            if (ch.type === 'removed') cache.locks.delete(ch.doc.id);
            else cache.locks.set(ch.doc.id, ch.doc.data() as ScopeLock);
          }
          ready('locks');
        }, onErr('locks')),

      this.contractsRef(pid).onSnapshot((s) => {
        for (const ch of s.docChanges()) {
          if (ch.type === 'removed') cache.contracts.delete(ch.doc.id);
          else cache.contracts.set(ch.doc.id, ch.doc.data() as ContractPointer);
        }
        ready('contracts');
      }, onErr('contracts')),
    ];

    const teardown = () => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      // Every listener, unconditionally. A leaked onSnapshot keeps billing.
      for (const u of unsubs) {
        try {
          u();
        } catch (err) {
          this.log.warn('store.listener.teardown_threw', 'unsubscribing a listener threw; continuing with the rest', { project_id: pid, error: String(err) });
        }
      }
      this.teardowns.delete(teardown);
    };
    this.teardowns.add(teardown);
    void from_seq; // the fold is absolute, not a delta: from_seq cannot skip a frame

    // If the cache is ALREADY warm, deliver the first frame synchronously rather than waiting
    // for six fresh listeners to round-trip. This is not a test accommodation: a second
    // dashboard panel subscribing to a project the page is already watching should render from
    // memory, not pay a network round trip and a blank frame to learn what it already knows.
    // It is also what lets a network-backed adapter satisfy "fires once immediately" in the
    // shared suite, whose settle() is a handful of microtask turns.
    if (cache.ready.size >= LISTENER_COUNT) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      emit();
    }

    return teardown;
  }

  async close(): Promise<void> {
    for (const t of [...this.teardowns]) t();
    this.caches.clear();
    this.projectMeta.clear();
  }
}

/** Drop storage-only fields so callers see exactly the Event shape. */
function stripInternal(data: DocumentData): Event {
  const { idempotency_key, ...rest } = data;
  void idempotency_key;
  return rest as Event;
}

/**
 * Content-addressed etag. Covers seq AND presence, because a heartbeat changes the board
 * without advancing seq; keying on seq alone would freeze the agent rail.
 */
function etagOf(s: Snapshot): string {
  const material = JSON.stringify([
    s.seq,
    s.tasks.map((t) => [t.task_id, t.status, t.claimed_by, t.ci, t.updated_at]),
    s.agents.map((a) => [a.agent_id, a.status, a.last_heartbeat_at]),
    s.locks.map((l) => [l.agent_id, l.globs.join(',')]),
    s.contracts.map((c) => [c.name, c.version, c.commit_sha]),
  ]);
  return `"f${createHash('sha1').update(material).digest('hex').slice(0, 16)}"`;
}

export function createFirestoreStore(opts: FirestoreStoreOptions): FirestoreStore {
  return new FirestoreStore(opts);
}

/** Truncate over-long durable text, loudly. Firestore's own cap is 1 MiB per document. */
export function clampText(s: string, field: string, log: Logger): string {
  if (s.length <= HUMAN_READABLE_LIMIT) return s;
  log.warn('store.text.truncated', 'value exceeded the readable cap and was truncated', { field, from: s.length, to: HUMAN_READABLE_LIMIT });
  return s.slice(0, HUMAN_READABLE_LIMIT);
}
