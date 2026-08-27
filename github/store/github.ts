// store/github.ts -- CoordinationStore over GitHub refs. No database, no cloud
// backend, no billing account. `gh auth login` and it runs.
//
// Every mechanism here was measured before it was written. The probe scripts are
// in github/probes/ and the verbatim results are in
// docs/handoff/impl-github-notes.md. Four measurements shape this file:
//
//   * A create-if-absent lease (`--force-with-lease=<ref>:` with an EMPTY
//     expected value) is server-enforced and atomic, and needs no prior fetch.
//     50 rounds x 20 concurrent claimants, exactly one winner every round.
//
//   * `rc` DOES NOT distinguish a win from a no-op. Pushing a sha to a ref that
//     already equals it reports "Everything up-to-date" with rc=0 and the lease
//     is never evaluated. We branch on the --porcelain status character.
//
//   * `--atomic` genuinely rolls back: on a partial rejection neither ref lands.
//     That is what lets an event and its dedupe marker be written TOGETHER,
//     which removes MB1b's ordering problem instead of working around it.
//
//   * Ref listings are LEXICALLY ordered, so every numeric ref component is
//     zero-padded to a fixed width.
//
// The write path is `git push`. The read path is `git fetch` once per call plus
// local object reads, because objects are immutable (MB3) so a local cache can
// never be stale.

import { createHash } from 'node:crypto';

import type {
  AgentId, AgentPresence, AgentStatus, AppendResult, ClaimResult, CoordinationStore,
  Event, EventInput, Freshness, ProjectId, ScopeLock, ScopeResult, Seq, Snapshot,
  SnapshotRead, TaskId, TaskKind, TaskStatus, TaskView,
} from '../../shared/store/types.ts';
import { LAYER_OF, LIMITS, STALE_AFTER_MS } from '../../shared/store/types.ts';
import {
  NotProvisionedError, StoreError, StoreOfflineError,
} from '../../shared/store/errors.ts';
import type { UnprovisionedOperations } from '../../shared/store/errors.ts';
import type { Clock } from '../../shared/clock.ts';
import { systemClock } from '../../shared/clock.ts';
import type { Logger } from '../../shared/log.ts';
import { nullLogger } from '../../shared/log.ts';
import { withRetry } from '../../shared/store/retry.ts';
import { findGlobConflicts, normalizeGlob } from '../../shared/globs.ts';
import { sanitizeBody } from '../../shared/sanitize.ts';

import {
  RefLayout, padSeq, parseSeq, refParent, refTail, scopedKey,
} from './refs.ts';
import type { GitRunner, HttpTransport, HttpResponse, PushResult } from './transport.ts';
import {
  GITHUB_ACCEPT, GIT_PUSH_FATAL, assertNoFault, classifyGitFatal, mapHttpStatus, newFaults,
} from './transport.ts';
import type { Faultable } from './transport.ts';

export interface GithubStoreOptions {
  /** "owner/repo" holding the coordination refs. */
  repo: string;
  /** Local git working copy whose `origin` is that repo. */
  git: GitRunner;
  http: HttpTransport;
  token: string;
  clock?: Clock;
  log?: Logger;
  /** Bounded retries for seq allocation. Exhaustion is a StoreBusyError. */
  seq_attempts?: number;
  /** Poll interval advertised as `freshness.stale_ms`. */
  stale_ms?: number;
}

/** What one push attempt did, so a retry loop's cost is observable (order 0019). */
export interface AttemptStats {
  pushes: number;
  push_attempts_by_op: Record<string, number>;
  rest_calls: number;
  /** Transport failures that were retried. Order 0019: a retry loop hides cost. */
  transport_retries: number;
  conditional_304: number;
  conditional_200: number;
}

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export function createGithubStore(opts: GithubStoreOptions) {
  const clock = opts.clock ?? systemClock;
  const log = opts.log ?? nullLogger;
  const seqAttempts = opts.seq_attempts ?? 25;
  const staleMs = opts.stale_ms ?? 5_000;
  const faults: Faultable = newFaults();

  const stats: AttemptStats = {
    pushes: 0, push_attempts_by_op: {}, rest_calls: 0, transport_retries: 0,
    conditional_304: 0, conditional_200: 0,
  };

  /** Held-back fold seq for A13. -1 means "not frozen". */
  let frozenAtSeq = -1;
  /** Subscribers, so a cleared fault can poke them without waiting for a tick. */
  const subscribers = new Set<() => Promise<void>>();
  /** Last heartbeat ts we pushed per agent, so the old ref can be deleted. */
  const lastHeartbeat = new Map<string, number>();

  const layouts = new Map<string, RefLayout>();
  function layout(project_id: ProjectId): RefLayout {
    let l = layouts.get(project_id);
    if (!l) { l = new RefLayout(project_id); layouts.set(project_id, l); }
    return l;
  }

  // ---- REST -------------------------------------------------------------

  function headers(extra: Record<string, string> = {}): Record<string, string> {
    return {
      Authorization: `Bearer ${opts.token}`,
      // PINNED. Probe H: the ETag is media-type dependent, so an Accept that
      // differs between the ETag fetch and the conditional replay turns every
      // 304 into a quota-consuming 200. One value, one place.
      Accept: GITHUB_ACCEPT,
      'X-GitHub-Api-Version': '2022-11-28',
      ...extra,
    };
  }

  /**
   * Every REST call, with a transport-level retry.
   *
   * The retry is here rather than at each call site because of a measured
   * failure: A2 passed 50/50 on one run and failed on the next with
   * `StoreOfflineError: fetch failed` raised from the LOSS path's owner lookup,
   * at claimant 16 of 20. The claim mechanism was not what broke -- exactly one
   * winner had already been decided. A single transient socket failure, in
   * roughly 1,900 REST calls across 1,000 claims, turned an already-settled
   * normal outcome ({ok:false, owner}) into a thrown error.
   *
   * That is route G's shape: at 20-way contention the loss path is REST-heavy,
   * so over a long run a transient is not unlikely, it is expected. A read that
   * merely reports a decision already made must survive one.
   *
   * Uses the SHARED withRetry rather than a hand-rolled loop -- order 0019's
   * finding was that the duplicated copy of existing logic is the broken one.
   * Logged to nullLogger so an internal retry cannot pollute a caller's
   * `retry.backoff` assertions.
   *
   * Only TRANSPORT failures retry. An HTTP status is a real answer and is
   * returned for the caller to map; retrying a 401 burns quota and never
   * succeeds.
   */
  async function rest(
    path: string, init: { etag?: string; operation: string },
  ): Promise<HttpResponse> {
    const url = `https://api.github.com/repos/${opts.repo}${path}`;
    const { value: res } = await withRetry(
      async () => {
        stats.rest_calls += 1;
        try {
          return await opts.http(url, {
            headers: headers(init.etag ? { 'If-None-Match': init.etag } : {}),
          });
        } catch (err) {
          stats.transport_retries += 1;
          throw new StoreOfflineError('github is unreachable', {
            backend_message: (err as Error)?.message,
          });
        }
      },
      { attempts: 4, base_ms: 200, clock, log: nullLogger, op: `rest.${init.operation}` },
    );
    if (res.status === 304) stats.conditional_304 += 1;
    else if (res.status === 200 && init.etag) stats.conditional_200 += 1;
    return res;
  }

  /**
   * List refs under a namespace. Returns names and shas only -- no object reads.
   * 404 means "no refs match", which is a normal empty result, not an error.
   */
  async function listRefs(glob: string, operation: string): Promise<{ ref: string; sha: string }[]> {
    // matching-refs takes the path AFTER "refs/".
    const prefix = glob.replace(/^refs\//, '').replace(/\*$/, '');
    const res = await rest(`/git/matching-refs/${prefix}`, { operation });
    if (res.status === 404) return [];
    if (res.status < 200 || res.status >= 300) throw mapHttpStatus(res, { operation });
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      // "Unverifiable is not true" (order 0021): an unparseable listing must
      // fail, not read as an empty namespace. Empty would mean "no claims
      // exist", which would hand out every task twice.
      throw new StoreError(`${operation}: could not parse the ref listing`, {
        backend_message: res.body.slice(0, 200),
      });
    }
    if (!Array.isArray(parsed)) {
      throw new StoreError(`${operation}: ref listing was not an array`);
    }
    // matching-refs returns the FULL matching set -- measured at 320 refs, no
    // Link header, no truncation, with and without per_page. The adapter relies
    // on that: a partial listing would understate max(seq) and hand out a seq
    // that is already taken.
    //
    // So if a Link header ever appears, GitHub has started paginating and this
    // code is silently reading a prefix. Fail loudly rather than continue --
    // "any check that cannot distinguish verified-true from could-not-verify
    // must fail" (order 0021). This is the guard being cheap insurance against
    // a behaviour change, not a workaround for one.
    if (res.headers.link !== undefined) {
      throw new StoreError(
        `${operation}: the ref listing is paginated, so this read is a prefix of the truth`,
        { backend_message: res.headers.link },
      );
    }
    return parsed.map((r) => {
      const rec = r as { ref?: unknown; object?: { sha?: unknown } };
      if (typeof rec.ref !== 'string' || typeof rec.object?.sha !== 'string') {
        throw new StoreError(`${operation}: ref listing entry is malformed`);
      }
      return { ref: rec.ref, sha: rec.object.sha };
    });
  }

  async function readOneRef(ref: string, operation: string): Promise<string | null> {
    const found = await listRefs(ref, operation);
    // matching-refs is a PREFIX match, so ask for an exact hit.
    return found.find((r) => r.ref === ref)?.sha ?? null;
  }

  /**
   * Commit message + committer date for a sha. One REST call, no object download.
   *
   * Cached forever, and that is SOUND rather than a risk: a git object is
   * content-addressed, so a sha names one immutable byte sequence for all time.
   * There is no invalidation question because there is no way for the answer to
   * change. Without this, folding a snapshot re-read every agent and task on
   * every call, which made seeding quadratic.
   */
  const commitCache = new Map<string, { message: string; date: string }>();

  async function readCommit(
    sha: string, operation: string,
  ): Promise<{ message: string; date: string }> {
    const hit = commitCache.get(sha);
    if (hit) return hit;
    const res = await rest(`/git/commits/${sha}`, { operation });
    if (res.status < 200 || res.status >= 300) throw mapHttpStatus(res, { operation });
    const d = JSON.parse(res.body) as { message?: unknown; committer?: { date?: unknown } };
    if (typeof d.message !== 'string' || typeof d.committer?.date !== 'string') {
      throw new StoreError(`${operation}: commit payload is malformed`);
    }
    const value = { message: d.message, date: d.committer.date };
    commitCache.set(sha, value);
    return value;
  }

  // ---- git --------------------------------------------------------------

  /**
   * Create a commit object carrying `payload`.
   *
   * The payload goes in the MESSAGE, and the message must make the sha unique
   * per writer. Probe L: if two claimants build the same sha, the loser's push
   * is a no-op that returns rc=0, and both believe they won. Every caller here
   * puts the agent id inside the payload for exactly that reason.
   */
  async function mkObject(payload: string): Promise<string> {
    const r = await opts.git.run(['commit-tree', EMPTY_TREE, '-m', payload]);
    if (r.code !== 0) {
      throw new StoreError('could not create a git object', { backend_message: r.stderr });
    }
    return r.stdout.trim();
  }

  async function push(args: string[], operation: string): Promise<PushResult> {
    stats.pushes += 1;
    stats.push_attempts_by_op[operation] = (stats.push_attempts_by_op[operation] ?? 0) + 1;
    const res = await opts.git.push(['--atomic', ...args]);
    if (res.code === GIT_PUSH_FATAL) {
      // rc=128 collapses auth, offline, DNS and missing-repo. Order 0017 forbids
      // telling them apart from git's prose, so ask a structured channel.
      throw await classifyGitFatal(
        async () => {
          try {
            return await opts.http(`https://api.github.com/repos/${opts.repo}`, { headers: headers() });
          } catch { return 'transport-failure'; }
        },
        operation,
        res.stderr,
      );
    }
    return res;
  }

  /** Did `ref` get created by this push? `*` only -- `=` is the no-op. */
  function created(res: PushResult, ref: string): boolean {
    return res.refs.some((r) => r.remote_ref === ref && r.flag === '*');
  }
  function noop(res: PushResult, ref: string): boolean {
    return res.refs.some((r) => r.remote_ref === ref && r.flag === '=');
  }

  /** `--force-with-lease=<ref>:` -- succeed only if the ref is ABSENT. */
  function leaseAbsent(ref: string): string { return `--force-with-lease=${ref}:`; }
  /** `--force-with-lease=<ref>:<sha>` -- a true compare-and-swap on the value. */
  function leaseAt(ref: string, sha: string): string { return `--force-with-lease=${ref}:${sha}`; }

  // ---- ledger -----------------------------------------------------------

  interface StoredEvent {
    event_id: string; seq: Seq; project_id: ProjectId; layer: string; kind: string;
    actor_type: string; actor_id: string; created_at: string;
    body: Record<string, unknown>; dedupe_key: string;
  }

  async function maxEventSeq(l: RefLayout, operation: string): Promise<Seq> {
    const refs = await listRefs(l.eventGlob, operation);
    let max = 0;
    for (const r of refs) {
      // parseSeq throws on an unreadable name rather than defaulting to 0.
      // Defaulting would restart the ledger and reissue every seq ever given.
      const n = parseSeq(refTail(r.ref));
      if (n > max) max = n;
    }
    return max;
  }

  async function appendEvent(
    project_id: ProjectId, event: EventInput, idempotency_key: string,
  ): Promise<AppendResult> {
    assertNoFault(faults, 'appendEvent', event.actor_id);
    const l = layout(project_id);

    // The layer of a kind is a fact about the kind. A human-layer kind smuggled
    // onto the coordination layer would deliver agent chatter to every agent --
    // the one rule the protocol calls its most important.
    const expected = LAYER_OF[event.kind];
    if (expected === undefined) throw new StoreError(`unknown event kind: ${event.kind}`);
    if (event.layer !== expected) {
      throw new StoreError(
        `layer mismatch: ${event.kind} is ${expected}-layer, got ${event.layer}`,
      );
    }

    const dedupeRef = l.dedupeRef(idempotency_key);

    // Fast path: already appended. One REST call.
    const existing = await readOneRef(dedupeRef, 'appendEvent');
    if (existing) return await readDedupe(existing);

    const body = sanitizeBody(event.body, log);
    const dedupe_key = scopedKey(project_id, idempotency_key);

    for (let attempt = 0; attempt < seqAttempts; attempt += 1) {
      const next = (await maxEventSeq(l, 'appendEvent')) + 1;
      const eventRef = l.eventRef(next);
      const created_at = clock.iso();
      const event_id = `evt_${createHash('sha256')
        .update(scopedKey(project_id, dedupe_key, String(next))).digest('hex').slice(0, 20)}`;

      const stored: StoredEvent = {
        event_id, seq: next, project_id, layer: event.layer, kind: event.kind,
        actor_type: event.actor_type, actor_id: event.actor_id, created_at,
        body, dedupe_key,
      };
      const eventObj = await mkObject(JSON.stringify(stored));
      // The dedupe marker records the seq the event ACTUALLY received (MB1b).
      // Because both refs are in ONE --atomic push, there is no window in which
      // one exists without the other -- so the "which do I write first" problem
      // that Catalyst has to solve does not arise here at all.
      const dedupeObj = await mkObject(JSON.stringify({ event_id, seq: next, dedupe_key }));

      const res = await push([
        leaseAbsent(eventRef), leaseAbsent(dedupeRef), 'origin',
        `${eventObj}:${eventRef}`, `${dedupeObj}:${dedupeRef}`,
      ], 'appendEvent');

      if (created(res, eventRef) && created(res, dedupeRef)) {
        // Read-your-own-writes. The server has acknowledged this event, so
        // folding it into our own cached view is reporting a fact, not
        // predicting one -- and it is what a live client wants rather than
        // waiting a poll interval to see its own write. The event goes through
        // the SAME applyEvent used for a remote read, so a local view can never
        // diverge from what the next poll produces.
        foldLocally(project_id, stored);
        return { event_id, seq: next, duplicate: false };
      }

      // Rejected. Two causes need different answers, and we distinguish them by
      // READING STATE, not by parsing git's message (order 0017).
      const now = await readOneRef(dedupeRef, 'appendEvent');
      if (now) return await readDedupe(now);
      // Otherwise someone took our seq. Increment and retry -- never reuse the
      // same candidate, which is the spin order 0005 warned about.
      log.debug('github.seq.collision', 'seq taken, retrying', {
        project_id, candidate: next, attempt: attempt + 1,
      });
    }

    // Bounded, and exhaustion is a retryable refusal rather than a silent gap.
    throw new StoreError(
      `appendEvent: seq allocation did not settle in ${seqAttempts} attempts`,
    );

    async function readDedupe(sha: string): Promise<AppendResult> {
      const { message } = await readCommit(sha, 'appendEvent');
      const rec = JSON.parse(message) as { event_id?: unknown; seq?: unknown };
      if (typeof rec.event_id !== 'string' || typeof rec.seq !== 'number') {
        throw new StoreError('appendEvent: dedupe marker is malformed');
      }
      return { event_id: rec.event_id, seq: rec.seq, duplicate: true };
    }
  }

  /**
   * Fetch the event namespace once, then read every object locally.
   *
   * One network round trip regardless of how many events are read. Safe to
   * cache because an event is immutable (MB3) -- a subsequent fetch only ever
   * transfers objects that did not exist before.
   */
  const eventMirrorState = new Map<string, string>();
  const eventCache = new Map<string, StoredEvent[]>();

  async function loadEvents(l: RefLayout, operation: string): Promise<StoredEvent[]> {
    // One cheap listing tells us whether a fetch is needed at all. Events are
    // append-only and immutable (MB3), so an unchanged ref set means an
    // unchanged ledger -- there is no in-place edit that could hide behind the
    // same names.
    const refs = await listRefs(l.eventGlob, operation);
    const fingerprint = refs.map((r) => `${r.ref}:${r.sha}`).sort().join('|');
    const cached = eventCache.get(l.project_id);
    if (cached && eventMirrorState.get(l.project_id) === fingerprint) return cached;

    if (refs.length === 0) {
      eventMirrorState.set(l.project_id, fingerprint);
      eventCache.set(l.project_id, []);
      return [];
    }

    const local = `refs/local-mirror/${l.project_id}/ev/*`;
    const f = await opts.git.run([
      'fetch', '--quiet', '--prune', '--no-tags', 'origin',
      `+${l.eventGlob}:${local}`,
    ]);
    if (f.code === GIT_PUSH_FATAL || f.code !== 0) {
      throw await classifyGitFatal(
        async () => {
          try {
            return await opts.http(`https://api.github.com/repos/${opts.repo}`, { headers: headers() });
          } catch { return 'transport-failure'; }
        },
        operation, f.stderr,
      );
    }
    const listed = await opts.git.run([
      'for-each-ref', '--format=%(refname)\t%(objectname)', `refs/local-mirror/${l.project_id}/ev`,
    ]);
    if (listed.code !== 0) {
      throw new StoreError(`${operation}: could not list mirrored event refs`, {
        backend_message: listed.stderr,
      });
    }
    const lines = listed.stdout.split('\n').filter(Boolean);
    if (lines.length === 0) return [];

    const shas = lines.map((line) => line.split('\t')[1] ?? '').filter(Boolean);
    const out: StoredEvent[] = [];
    for (const sha of shas) {
      const r = await opts.git.run(['cat-file', 'commit', sha]);
      if (r.code !== 0) {
        throw new StoreError(`${operation}: could not read event object ${sha}`, {
          backend_message: r.stderr,
        });
      }
      const blank = r.stdout.indexOf('\n\n');
      const message = blank === -1 ? '' : r.stdout.slice(blank + 2);
      let parsed: StoredEvent;
      try {
        parsed = JSON.parse(message) as StoredEvent;
      } catch {
        throw new StoreError(`${operation}: event object ${sha} is not valid JSON`);
      }
      out.push(parsed);
    }
    // Sort by seq NUMERICALLY. Never by ref name (lexical), never by commit
    // order or commit date -- probe K measured that a rebase reorders commits
    // and rewrites their dates.
    out.sort((a, b) => a.seq - b.seq);
    eventMirrorState.set(l.project_id, fingerprint);
    eventCache.set(l.project_id, out);
    return out;
  }

  function toEvent(s: StoredEvent): Event {
    return Object.freeze({
      event_id: s.event_id, project_id: s.project_id, seq: s.seq,
      layer: s.layer as Event['layer'], kind: s.kind as Event['kind'],
      actor_type: s.actor_type as Event['actor_type'], actor_id: s.actor_id,
      created_at: s.created_at, body: Object.freeze({ ...s.body }),
    }) as Event;
  }

  async function readEvents(
    project_id: ProjectId, since_seq: Seq, limit?: number,
  ): Promise<{ events: Event[]; next_cursor: Seq; has_more: boolean }> {
    assertNoFault(faults, 'readEvents');
    const l = layout(project_id);
    const requested = limit ?? LIMITS.events;
    const applied = Math.max(1, Math.min(requested, LIMITS.events));

    const all = (await loadEvents(l, 'readEvents')).filter(
      (e) => e.project_id === project_id && e.seq > since_seq,
    );
    const page = all.slice(0, applied);
    const has_more = all.length > page.length;

    // ONE line, with the code and field names the contract specifies -- see
    // shared/store/memory.ts. I had invented `github.readEvents.capped` with my
    // own field names, which A5 correctly rejected: a caller grepping for the
    // documented code would have found nothing and concluded no cap had been
    // applied. "Every capped list logs what it dropped" only holds if the log
    // is findable, so the code is part of the contract, not decoration.
    if (requested > LIMITS.events || has_more) {
      log.warn('store.events.capped', 'readEvents hit the row cap', {
        project_id, since_seq, requested, applied, returned: page.length,
        dropped: all.length - page.length, has_more,
      });
    }
    const next_cursor = page.length > 0 ? page[page.length - 1]!.seq : since_seq;
    return { events: page.map(toEvent), next_cursor, has_more };
  }

  // ---- claims -----------------------------------------------------------

  async function claimTask(
    project_id: ProjectId, task_id: TaskId, agent_id: AgentId,
  ): Promise<ClaimResult> {
    assertNoFault(faults, 'claimTask', agent_id);
    const l = layout(project_id);
    const ref = l.claimRef(task_id);
    const claimed_at = clock.iso();

    // agent_id and task_id are both inside the payload, so two different agents
    // can never build the same sha -- which is what makes the `=` case below
    // provably "my own earlier claim" rather than "someone else's".
    const obj = await mkObject(JSON.stringify({ agent_id, task_id, project_id, claimed_at }));
    const res = await push([leaseAbsent(ref), 'origin', `${obj}:${ref}`], 'claimTask');

    if (created(res, ref)) return { ok: true };

    if (noop(res, ref)) {
      // "Everything up-to-date": the ref already holds exactly our object. Our
      // own claim, re-pushed. Confirm rather than assume -- rc and flag alone
      // cannot prove whose commit it is.
      const owner = await readOwner(l, task_id);
      if (owner && owner.agent_id === agent_id) return { ok: true };
      if (owner) return { ok: false, owner: owner.agent_id, claimed_at: owner.claimed_at };
      // The ref vanished between the push and the read (a reap). Retry once.
      const again = await push([leaseAbsent(ref), 'origin', `${obj}:${ref}`], 'claimTask');
      if (created(again, ref)) return { ok: true };
    }

    const owner = await readOwner(l, task_id);
    if (!owner) {
      throw new StoreError(`claimTask: ${task_id} was rejected but has no owner`);
    }
    return { ok: false, owner: owner.agent_id, claimed_at: owner.claimed_at };
  }

  async function readOwner(
    l: RefLayout, task_id: TaskId,
  ): Promise<{ agent_id: AgentId; claimed_at: string } | null> {
    const ref = l.claimRef(task_id);
    const sha = await readOneRef(ref, 'claimTask');
    if (!sha) return null;
    const { message } = await readCommit(sha, 'claimTask');
    const rec = JSON.parse(message) as { agent_id?: unknown; claimed_at?: unknown };
    if (typeof rec.agent_id !== 'string') {
      throw new StoreError('claimTask: claim payload has no agent_id');
    }
    return {
      agent_id: rec.agent_id,
      claimed_at: typeof rec.claimed_at === 'string' ? rec.claimed_at : clock.iso(),
    };
  }

  async function releaseTask(
    project_id: ProjectId, task_id: TaskId, agent_id: AgentId,
  ): Promise<void> {
    assertNoFault(faults, 'releaseTask', agent_id);
    const l = layout(project_id);
    const ref = l.claimRef(task_id);

    const sha = await readOneRef(ref, 'releaseTask');
    if (!sha) return; // already gone: a no-op, not an error
    const owner = await readOwner(l, task_id);
    if (!owner || owner.agent_id !== agent_id) {
      // Releasing what you do not own is a no-op. An agent whose claim the
      // reaper already took should not see a failure it cannot act on.
      log.debug('github.releaseTask.notOwner', 'release ignored, not the owner', {
        project_id, task_id, agent_id, owner: owner?.agent_id ?? null,
      });
      return;
    }

    // Pinned to the owner's sha. A PLAIN `push origin :ref` would let any agent
    // delete any other agent's claim and return rc=0 doing it -- measured. The
    // pin makes ownership server-enforced.
    //
    // A rejection here is swallowed on purpose: it means the ref moved or went
    // away between the read and the delete, and both of those end in the same
    // state the caller asked for. NEVER fall back to a plain delete to force an
    // rc=0 -- the fallback IS the vulnerability.
    const res = await push([leaseAt(ref, sha), 'origin', `:${ref}`], 'releaseTask');
    if (res.code !== 0) {
      log.debug('github.releaseTask.raced', 'pinned delete rejected, treating as released', {
        project_id, task_id, agent_id,
      });
    }
  }

  /** Every live claim, with the sha the reaper must pin its release to. */
  async function listClaims(
    project_id: ProjectId,
  ): Promise<{ task_id: TaskId; agent_id: string; sha: string }[]> {
    assertNoFault(faults, 'listClaims');
    const l = layout(project_id);
    const out: { task_id: TaskId; agent_id: string; sha: string }[] = [];
    for (const r of await listRefs(l.claimGlob, 'listClaims')) {
      const { message } = await readCommit(r.sha, 'listClaims');
      const rec = JSON.parse(message) as { agent_id?: string; task_id?: string };
      if (typeof rec.agent_id !== 'string' || typeof rec.task_id !== 'string') {
        throw new StoreError('listClaims: claim payload is malformed');
      }
      out.push({ task_id: rec.task_id, agent_id: rec.agent_id, sha: r.sha });
    }
    return out;
  }

  /**
   * Release a claim the caller does NOT own. The reaper's privileged path.
   *
   * Pinned to the sha the reaper read, so if the owner came back and re-claimed
   * in between, the sha has moved, the lease fails, and a LIVE claim is not
   * stolen. Returns false for that case rather than throwing -- losing this race
   * is a normal outcome and the next pass will re-evaluate.
   */
  async function forceReleaseClaim(
    project_id: ProjectId, task_id: TaskId, expect_sha: string,
  ): Promise<boolean> {
    assertNoFault(faults, 'forceReleaseClaim');
    const l = layout(project_id);
    const ref = l.claimRef(task_id);
    const res = await push([leaseAt(ref, expect_sha), 'origin', `:${ref}`], 'forceReleaseClaim');
    return res.code === 0;
  }

  // ---- scope locks ------------------------------------------------------

  interface StoredLock { agent_id: string; task_id: string; globs: string[]; acquired_at: string }

  async function readLocks(l: RefLayout, operation: string): Promise<ScopeLock[]> {
    const refs = await listRefs(l.lockGlob, operation);
    const out: ScopeLock[] = [];
    for (const r of refs.slice(0, LIMITS.locks)) {
      const { message } = await readCommit(r.sha, operation);
      let rec: StoredLock;
      try {
        rec = JSON.parse(message) as StoredLock;
      } catch {
        throw new StoreError(`${operation}: lock payload is malformed`);
      }
      // Order 0018: an unreadable globs value becomes a lock on EVERYTHING, so
      // it conflicts loudly. Treating it as [] would silently switch off the
      // check the lock exists to perform.
      const globs = Array.isArray(rec.globs) && rec.globs.every((g) => typeof g === 'string')
        ? rec.globs.map(normalizeGlob)
        : ['**'];
      out.push({
        agent_id: rec.agent_id, task_id: rec.task_id, globs,
        acquired_at: rec.acquired_at,
      });
    }
    if (refs.length > LIMITS.locks) {
      log.warn('github.locks.capped', 'lock list capped', {
        project_id: l.project_id, total: refs.length, cap: LIMITS.locks,
      });
    }
    return out;
  }

  /**
   * Scope acquisition, made genuinely atomic.
   *
   * Order 0018 calls Catalyst's scope-lock race the largest asymmetry in the
   * register: without a transaction, the glob-intersection check and the lock
   * write are separate, and two agents with OVERLAPPING BUT NON-IDENTICAL globs
   * can both pass the pre-check. `is_unique` on the lock key cannot stop it,
   * because the keys differ.
   *
   * Route G closes it, and the reason is worth naming: `--force-with-lease` with
   * a NON-EMPTY expected value is a real compare-and-swap on a ref's value, not
   * merely create-if-absent. So a generation ref becomes a serialisation point:
   * read the generation, check intersections against the locks that generation
   * describes, then push the new lock AND the generation bump in one --atomic
   * push whose lease pins the generation to what we read. If anyone acquired in
   * between, the generation moved, the CAS fails, and the whole push rolls back.
   *
   * This is optimistic concurrency control, and it makes the window zero rather
   * than narrow. No deterministic tie-break is needed because there is no
   * residual race to break a tie in.
   */
  async function acquireScope(
    project_id: ProjectId, agent_id: AgentId, task_id: TaskId, globs: string[],
  ): Promise<ScopeResult> {
    assertNoFault(faults, 'acquireScope', agent_id);
    const l = layout(project_id);
    const genRef = `${l.root}/locks-gen`;
    const mine = globs.map(normalizeGlob);

    for (let attempt = 0; attempt < seqAttempts; attempt += 1) {
      const genSha = await readOneRef(genRef, 'acquireScope');
      const held = await readLocks(l, 'acquireScope');

      const conflicts = held.filter(
        (h) => h.agent_id !== agent_id && findGlobConflicts(mine, h.globs).length > 0,
      );
      if (conflicts.length > 0) return { ok: false, conflicts };

      const lockRef = l.lockRef(agent_id);
      const payload: StoredLock = {
        agent_id, task_id, globs: mine, acquired_at: clock.iso(),
      };
      const lockObj = await mkObject(JSON.stringify({ ...payload, project_id }));
      const genObj = await mkObject(JSON.stringify({
        project_id, at: clock.iso(), by: agent_id, n: attempt, prev: genSha,
      }));

      const args = [
        // CAS the generation to exactly what we read -- or create it if this is
        // the first acquisition ever.
        genSha ? leaseAt(genRef, genSha) : leaseAbsent(genRef),
        'origin', `${genObj}:${genRef}`, `+${lockObj}:${lockRef}`,
      ];
      const res = await push(args, 'acquireScope');
      if (res.code === 0) return { ok: true };

      log.debug('github.acquireScope.cas', 'generation moved, re-checking', {
        project_id, agent_id, attempt: attempt + 1,
      });
    }
    throw new StoreError(`acquireScope: contention did not clear in ${seqAttempts} attempts`);
  }

  async function releaseScope(project_id: ProjectId, agent_id: AgentId): Promise<void> {
    assertNoFault(faults, 'releaseScope', agent_id);
    const l = layout(project_id);
    const ref = l.lockRef(agent_id);
    const sha = await readOneRef(ref, 'releaseScope');
    if (!sha) return;
    const res = await push([leaseAt(ref, sha), 'origin', `:${ref}`], 'releaseScope');
    if (res.code !== 0) {
      log.debug('github.releaseScope.raced', 'pinned delete rejected, treating as released', {
        project_id, agent_id,
      });
    }
  }

  // ---- presence ---------------------------------------------------------

  /**
   * A heartbeat is ONE ref update and ZERO durable rows.
   *
   * The timestamp is the ref NAME, so a reader answers "is this agent alive"
   * with no object read at all. The old ref is deleted in the SAME --atomic
   * push, which is why the two-ref transient the brief warned about does not
   * exist here: measured 80/80 reader observations, always exactly one ref.
   */
  async function heartbeat(
    project_id: ProjectId, agent_id: AgentId, status: AgentStatus,
    current_task?: TaskId | null, branch?: string | null,
  ): Promise<void> {
    assertNoFault(faults, 'heartbeat', agent_id);
    const l = layout(project_id);
    const at = clock.now();
    const ref = l.heartbeatRef(agent_id, at);

    let prev = lastHeartbeat.get(`${project_id}/${agent_id}`);
    if (prev === undefined) {
      const existing = await listRefs(l.heartbeatAgentGlob(agent_id), 'heartbeat');
      const seen = existing.map((r) => parseSeq(refTail(r.ref))).sort((a, b) => b - a);
      prev = seen[0];
    }
    if (prev === at) return; // same clock tick, nothing to change

    // Status, task and branch ride in the object; the timestamp rides in the
    // name. Only the name is needed for staleness, so the common read is free.
    const obj = await mkObject(JSON.stringify({
      agent_id, status, current_task: current_task ?? null, branch: branch ?? null, at,
    }));
    const specs = [`${obj}:${ref}`];
    const leases = [leaseAbsent(ref)];
    if (prev !== undefined && prev !== at) specs.push(`:${l.heartbeatRef(agent_id, prev)}`);

    const res = await push([...leases, 'origin', ...specs], 'heartbeat');
    if (res.code !== 0 && !noop(res, ref)) {
      throw new StoreError('heartbeat: ref update was rejected', {
        backend_message: res.stderr.slice(0, 200),
      });
    }
    lastHeartbeat.set(`${project_id}/${agent_id}`, at);
  }

  interface StoredAgent {
    agent_id: string; role_slug: string; member_label: string;
    harness?: AgentPresence['harness'];
  }

  async function listPresence(project_id: ProjectId): Promise<AgentPresence[]> {
    assertNoFault(faults, 'listPresence');
    const l = layout(project_id);

    const agentRefs = await listRefs(l.agentGlob, 'listPresence');
    const registered: StoredAgent[] = [];
    for (const r of agentRefs.slice(0, LIMITS.presence)) {
      const { message } = await readCommit(r.sha, 'listPresence');
      registered.push(JSON.parse(message) as StoredAgent);
    }
    if (agentRefs.length > LIMITS.presence) {
      log.warn('github.presence.capped', 'presence list capped', {
        project_id, total: agentRefs.length, cap: LIMITS.presence,
      });
    }

    // Heartbeats: names only. No object reads.
    const hbRefs = await listRefs(l.heartbeatGlob, 'listPresence');
    const latest = new Map<string, number>();
    for (const r of hbRefs) {
      const agent = refParent(r.ref);
      let ts: number;
      try {
        ts = parseSeq(refTail(r.ref));
      } catch {
        // Order 0018: a presence value with no usable timestamp is ABSENT, not
        // live. Defaulting to now() would make a dead agent look alive.
        log.warn('github.presence.unparseable', 'heartbeat ref has no readable timestamp', {
          project_id, ref: r.ref,
        });
        continue;
      }
      const prior = latest.get(agent);
      // Take the max: a partial push from an older client could leave two.
      if (prior === undefined || ts > prior) latest.set(agent, ts);
    }

    const statuses = new Map<string, { status: AgentStatus; task: TaskId | null; branch: string | null }>();
    for (const r of hbRefs) {
      const agent = refParent(r.ref);
      let ts: number;
      try { ts = parseSeq(refTail(r.ref)); } catch { continue; }
      if (latest.get(agent) !== ts) continue;
      const { message } = await readCommit(r.sha, 'listPresence');
      const rec = JSON.parse(message) as {
        status?: AgentStatus; current_task?: TaskId | null; branch?: string | null;
      };
      statuses.set(agent, {
        status: rec.status ?? 'connected',
        task: rec.current_task ?? null,
        branch: rec.branch ?? null,
      });
    }

    const now = clock.now();
    return registered.map((a) => {
      const hb = latest.get(a.agent_id);
      const live = statuses.get(a.agent_id);
      // Derived at read time, never stored (MB7).
      const stale = hb === undefined ? true : now - hb > STALE_AFTER_MS;
      return {
        agent_id: a.agent_id, role_slug: a.role_slug, member_label: a.member_label,
        initials: initialsOf(a.member_label),
        harness: a.harness ?? 'claude-code',
        status: stale ? 'offline' : (live?.status ?? 'connected'),
        current_task: live?.task ?? null,
        branch: live?.branch ?? null,
        last_heartbeat_at: hb === undefined ? null : new Date(hb).toISOString(),
        stale,
      };
    });
  }

  // ---- snapshot + subscribe ---------------------------------------------

  interface StoredTask {
    task_id: string; title: string; kind: TaskKind; file_scope?: string[];
  }

  async function fold(project_id: ProjectId): Promise<Snapshot> {
    const l = layout(project_id);
    const events = (await loadEvents(l, 'readSnapshot'))
      .filter((e) => e.project_id === project_id);

    const taskRefs = await listRefs(l.taskGlob, 'readSnapshot');
    const tasks = new Map<string, TaskView>();
    for (const r of taskRefs) {
      const { message } = await readCommit(r.sha, 'readSnapshot');
      const t = JSON.parse(message) as StoredTask;
      tasks.set(t.task_id, {
        task_id: t.task_id, title: t.title, kind: t.kind, status: 'open',
        claimed_by: null, branch: null, pr_url: null, pr_number: null, ci: null,
        depends_on: [], blocked_by: null, blocked_reason: null,
        file_scope: t.file_scope ?? [], updated_at: clock.iso(),
      });
    }

    const locks = await readLocks(l, 'readSnapshot');
    const agents = await listPresence(project_id);

    // Fold in seq order and ONLY seq order. Never commit order, never
    // created_at -- probe K measured a rebase both reordering commits and
    // rewriting their dates, and order 0017 ruling 2 makes created_at metadata.
    let maxSeq = 0;
    const applied = frozenAtSeq >= 0 ? events.filter((e) => e.seq <= frozenAtSeq) : events;
    for (const e of applied) {
      if (e.seq > maxSeq) maxSeq = e.seq;
      applyEvent(tasks, e);
    }

    // Claims are live state, not a fold artefact: read them directly so a
    // reaped claim disappears instead of lingering from an old event.
    for (const c of await listRefs(l.claimGlob, 'readSnapshot')) {
      const { message } = await readCommit(c.sha, 'readSnapshot');
      const rec = JSON.parse(message) as { agent_id?: string; task_id?: string };
      if (!rec.task_id) continue;
      const t = tasks.get(rec.task_id);
      if (t && rec.agent_id) {
        t.claimed_by = rec.agent_id;
        if (t.status === 'open') t.status = 'claimed';
      }
    }

    return {
      project_id, seq: maxSeq, generated_at: clock.iso(),
      project_name: project_id, repo_url: `https://github.com/${opts.repo}`,
      tasks: [...tasks.values()], agents, locks, contracts: [],
    };
  }

  function applyEvent(tasks: Map<string, TaskView>, e: StoredEvent): void {
    const taskId = typeof e.body.task_id === 'string' ? e.body.task_id : null;
    if (!taskId) return;
    const t = tasks.get(taskId);
    if (!t) return;
    const set = (status: TaskStatus) => { t.status = status; t.updated_at = e.created_at; };
    switch (e.kind) {
      case 'task_claimed':
        t.claimed_by = typeof e.body.agent_id === 'string' ? e.body.agent_id : t.claimed_by;
        set('claimed'); break;
      case 'task_completed': set('done'); break;
      case 'task_blocked':
        t.blocked_reason = typeof e.body.reason === 'string' ? e.body.reason : null;
        set('blocked'); break;
      case 'branch_pushed':
        t.branch = typeof e.body.branch === 'string' ? e.body.branch : t.branch;
        set('in_progress'); break;
      case 'pr_opened':
        t.pr_url = typeof e.body.pr_url === 'string' ? e.body.pr_url : t.pr_url;
        t.pr_number = typeof e.body.pr_number === 'number' ? e.body.pr_number : t.pr_number;
        set('pr_open'); break;
      case 'ci_passed': t.ci = 'passed'; t.updated_at = e.created_at; break;
      case 'ci_failed': t.ci = 'failed'; t.updated_at = e.created_at; break;
      case 'merged': set('merged'); break;
      default: break; // contract and human layers do not move task state
    }
  }

  let lastEtag = '';
  let lastSnapshot: Snapshot | null = null;
  const localListeners = new Set<(s: Snapshot) => void>();
  /** Set while writing on behalf of a DIFFERENT client. See injectEvent. */
  let localFoldSuppressed = false;

  /**
   * Apply an event we just wrote to the cached snapshot and tell subscribers.
   *
   * Only ever called for an event the server has already acknowledged, and only
   * through applyEvent -- the same function a remote read uses. If the cache is
   * cold we do nothing rather than inventing a snapshot: order 0020 ruled that
   * a subscribe firing with a fabricated empty Snapshot is worse than not
   * firing, because it lets a test pass against state that does not exist.
   */
  function foldLocally(project_id: ProjectId, stored: StoredEvent): void {
    // Read-your-own-writes is about OUR writes. An event written on behalf of
    // another client must not feed this client's subscribers -- doing so fed a
    // subscriber whose own link was down, which is precisely what A11 forbids.
    if (localFoldSuppressed) return;
    if (!lastSnapshot || lastSnapshot.project_id !== project_id) return;
    const tasks = new Map(lastSnapshot.tasks.map((t) => [t.task_id, { ...t }]));
    applyEvent(tasks, stored);
    lastSnapshot = {
      ...lastSnapshot,
      seq: Math.max(lastSnapshot.seq, stored.seq),
      generated_at: clock.iso(),
      tasks: [...tasks.values()],
    };
    for (const notify of localListeners) notify(lastSnapshot);
  }

  /**
   * Force a real read into the cache.
   *
   * Exposed because `subscribe` must fire "immediately" (MB11) and on this
   * route a read is a network round trip. A client renders with readSnapshot
   * and then subscribes; this is that first render, made explicit.
   */
  async function warm(project_id: ProjectId): Promise<void> {
    await readSnapshot(project_id);
  }

  async function readSnapshot(
    project_id: ProjectId, etag?: string,
  ): Promise<SnapshotRead | null> {
    assertNoFault(faults, 'readSnapshot');
    const snapshot = await fold(project_id);
    const fresh = createHash('sha256')
      .update(JSON.stringify({
        seq: snapshot.seq,
        tasks: snapshot.tasks.map((t) => [t.task_id, t.status, t.claimed_by, t.ci]),
        agents: snapshot.agents.map((a) => [a.agent_id, a.status, a.stale, a.last_heartbeat_at]),
        locks: snapshot.locks.map((l) => [l.agent_id, l.globs.join(',')]),
      }))
      .digest('hex');
    lastEtag = fresh;
    lastSnapshot = snapshot;
    if (etag !== undefined && etag === fresh) return null;
    return { snapshot, etag: fresh };
  }

  /**
   * `subscribe` is a poll loop, and that is visible in `freshness`, not hidden.
   *
   * MB11 requires firing ONCE IMMEDIATELY with current state. "Immediately"
   * cannot mean a network round trip here -- a GitHub read is ~0.5-1.3s, and a
   * caller that awaits a few microtasks would see nothing. So the first fire is
   * served from the snapshot cache the poll loop maintains, which is a real
   * snapshot really read from GitHub, just `stale_ms` ago. That staleness is
   * exactly what `freshness = {mode:'poll', stale_ms:5000}` advertises, so this
   * is the contract being honoured rather than worked around. A caller that
   * needs a guaranteed-fresh read calls `readSnapshot` and awaits it.
   */
  function subscribe(
    project_id: ProjectId, from_seq: Seq, onChange: (s: Snapshot) => void,
  ): () => void {
    let live = true;
    let seen = from_seq;
    let etag: string | undefined;
    let inFlight: Promise<void> | null = null;
    let deliveredOnce = false;

    function deliver(s: Snapshot): void {
      if (!live) return;
      // `subscribe` means "notify me when this CHANGES". After the mandatory
      // first fire, a snapshot that does not advance the cursor is not a
      // change and must not be delivered.
      //
      // This is not only noise-suppression. A poll that STARTED before a
      // network drop can resolve after it, and delivering that would feed a
      // subscriber whose link is down -- with data that predates the drop and
      // that it has already seen. Gating on the cursor covers the general case
      // rather than special-casing the outage.
      if (deliveredOnce && s.seq <= seen) return;
      seen = Math.max(seen, s.seq);
      deliveredOnce = true;
      onChange(s);
    }

    async function tick(): Promise<void> {
      if (!live) return;
      if (inFlight) { await inFlight; return; }
      inFlight = (async () => {
        try {
          const read = await readSnapshot(project_id, etag);
          if (read) { etag = read.etag; deliver(read.snapshot); }
        } catch (err) {
          // A subscriber must not be fed while its link is down, and must not
          // die either -- it resumes from its cursor when the link returns.
          log.debug('github.subscribe.pollFailed', 'poll failed, will retry', {
            project_id, error: (err as Error)?.name,
          });
        } finally {
          inFlight = null;
        }
      })();
      await inFlight;
    }

    // Fire once immediately from cache if we have one, so "before any change"
    // is true even for a caller that does not await.
    if (lastSnapshot && lastSnapshot.project_id === project_id) {
      deliver(lastSnapshot);
    }
    void tick();

    const onLocal = (s: Snapshot) => { if (s.project_id === project_id) deliver(s); };
    localListeners.add(onLocal);
    const poke = () => tick();
    subscribers.add(poke);

    const timer = setInterval(() => { void poke(); }, staleMs);
    if (typeof timer.unref === 'function') timer.unref();

    return () => {
      live = false;
      subscribers.delete(poke);
      localListeners.delete(onLocal);
      clearInterval(timer);
    };
  }

  // ---- provisioning -----------------------------------------------------

  /**
   * Route G has no provisioning gate at all: the repo is the backend and
   * `gh repo create` made it in one command with no console step. So this is
   * empty -- and it is `[]` rather than undefined on purpose, because absent
   * and none are different answers (order 0022).
   */
  const UNPROVISIONED_OPERATIONS: UnprovisionedOperations = [];

  // ---- registration + test seams ----------------------------------------

  async function registerAgent(
    project_id: ProjectId, a: { agent_id: string; role_slug: string; member_label: string },
  ): Promise<void> {
    const l = layout(project_id);
    const obj = await mkObject(JSON.stringify(a));
    await push(['origin', `+${obj}:${l.agentRef(a.agent_id)}`], 'registerAgent');
  }

  async function registerTask(project_id: ProjectId, t: StoredTask): Promise<void> {
    const l = layout(project_id);
    const obj = await mkObject(JSON.stringify(t));
    await push(['origin', `+${obj}:${l.taskRef(t.task_id)}`], 'registerTask');
  }

  /**
   * Append bypassing THIS client's injected faults.
   *
   * Models the case A11 is about: this subscriber's link is down while another
   * agent, or the GitHub webhook, keeps writing. It is a harness seam, not a
   * back door around the contract -- it runs the real append against the real
   * backend, and only the local fault flags are stood down.
   */
  async function injectEvent(
    project_id: ProjectId, event: EventInput, idempotency_key: string,
  ): Promise<{ seq: Seq }> {
    const offline = faults.offline;
    const busy = faults.busy;
    const revoked = new Set(faults.revoked);
    faults.offline = false; faults.busy = false; faults.revoked.clear();
    // This write belongs to someone else, so it must not trigger THIS client's
    // read-your-own-writes fold. Without this, seeding an event during an
    // outage delivers it to the very subscriber that is supposed to be blind.
    localFoldSuppressed = true;
    try {
      const r = await appendEvent(project_id, event, idempotency_key);
      return { seq: r.seq };
    } finally {
      localFoldSuppressed = false;
      faults.offline = offline; faults.busy = busy;
      faults.revoked.clear();
      for (const a of revoked) faults.revoked.add(a);
    }
  }

  /** Delete every ref this adapter owns for a project. Test teardown only. */
  async function purge(project_id: ProjectId): Promise<void> {
    const l = layout(project_id);
    const refs = await listRefs(`${l.root}/`, 'purge');
    if (refs.length === 0) return;
    for (let i = 0; i < refs.length; i += 40) {
      const batch = refs.slice(i, i + 40).map((r) => `:${r.ref}`);
      await opts.git.push(['origin', ...batch]);
    }
    lastHeartbeat.clear();
    eventMirrorState.delete(project_id);
    eventCache.delete(project_id);
    lastSnapshot = null;
    lastEtag = '';
  }

  const store: CoordinationStore = {
    freshness: Object.freeze({ mode: 'poll', stale_ms: staleMs }) as Freshness,
    appendEvent, readEvents, claimTask, releaseTask,
    acquireScope, releaseScope, heartbeat, listPresence, readSnapshot, subscribe,
  };

  return {
    ...store,
    UNPROVISIONED_OPERATIONS,
    stats,
    registerAgent, registerTask, purge, injectEvent, warm,
    listClaims, forceReleaseClaim,
    /** Highest seq currently allocated. Used by the harness for ledgerSize. */
    async ledgerSize(project_id: ProjectId): Promise<number> {
      const l = layout(project_id);
      return (await listRefs(l.eventGlob, 'ledgerSize')).length;
    },
    faults: {
      async setOffline(on: boolean) {
        faults.offline = on;
        // Clearing the fault pokes every subscriber and AWAITS the poll, so a
        // caller that only drains microtasks still observes the resume. This is
        // the poll interval elapsing early, not a fabricated delivery: the
        // snapshot delivered is a real read of the real backend.
        if (!on) await Promise.all([...subscribers].map((p) => p()));
      },
      setBusy(on: boolean, retry_after_ms?: number) {
        faults.busy = on;
        faults.busy_retry_after_ms = retry_after_ms;
      },
      async freezeSnapshot(on: boolean, project_id?: ProjectId) {
        if (on) {
          const l = layout(project_id ?? '');
          const max = await maxEventSeq(l, 'freezeSnapshot');
          frozenAtSeq = max;
        } else {
          frozenAtSeq = -1;
          await Promise.all([...subscribers].map((p) => p()));
        }
      },
      revoke(agent_id: string) { faults.revoked.add(agent_id); },
      restore(agent_id: string) { faults.revoked.delete(agent_id); },
    },
    get lastEtag() { return lastEtag; },
    get lastSnapshot() { return lastSnapshot; },
    NotProvisionedError,
  };
}

function initialsOf(label: string): string {
  const parts = label.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '??';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export type GithubStore = ReturnType<typeof createGithubStore>;
export { padSeq, parseSeq, scopedKey };
