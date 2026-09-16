// Section A of docs/how-to/acceptance-checklist.md, as executable tests.
//
// The whole bake-off depends on this file being adapter-agnostic. It imports no
// adapter and knows nothing about Catalyst or Firestore -- it drives a
// StoreHarness. If a test here needed an `if (harness.name === 'catalyst')`, the
// comparison would be measuring two interpretations instead of two platforms.
//
// Four capabilities cannot be expressed through CoordinationStore itself, so the
// harness must provide them: seeding, ledger size, fault injection, and a
// controllable clock. Every adapter implements all four. None of them are
// optional and no test here skips -- a skipped test is a box that gets ticked
// without evidence.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type {
  AgentId, AgentPresence, CoordinationStore, EventInput, ProjectId, Snapshot, TaskId, TaskKind,
} from './types.ts';
import { LIMITS, STALE_AFTER_MS } from './types.ts';
import { StoreAuthError, StoreBusyError, StoreOfflineError, isRetryable } from './errors.ts';
import { withRetry } from './retry.ts';
import type { CapturingLogger } from '../log.ts';
import { stripUnstorable } from '../sanitize.ts';

export interface HarnessSeedTask {
  task_id: TaskId; title: string; kind: TaskKind; file_scope?: string[];
}
export interface HarnessSeedAgent {
  agent_id: AgentId; role_slug: string; member_label: string;
}

export interface HarnessFaults {
  /** Backend unreachable. Ops throw StoreOfflineError. */
  setOffline(on: boolean): Promise<void>;
  /** Backend rate limited / at its concurrency ceiling. Ops throw StoreBusyError. */
  setBusy(on: boolean, retry_after_ms?: number): Promise<void>;
  /** Hold the folded snapshot behind the ledger, as a debounced writer does. */
  freezeSnapshot(on: boolean): Promise<void>;
  /** Revoke an agent's token. Its ops throw StoreAuthError. */
  revoke(agent_id: AgentId): Promise<void>;
  restore(agent_id: AgentId): Promise<void>;
}

export interface StoreHarness {
  readonly name: string;
  readonly store: CoordinationStore;
  readonly log: CapturingLogger;
  readonly project_id: ProjectId;
  readonly faults: HarnessFaults;
  seedTask(task: HarnessSeedTask): Promise<void>;
  seedAgent(agent: HarnessSeedAgent): Promise<void>;
  /**
   * Append as some OTHER client, bypassing this client's injected faults. Models
   * the case A11 is about: this subscriber's link is down while another agent or
   * the GitHub webhook keeps writing.
   */
  seedEvent(event: EventInput, idempotency_key: string): Promise<{ seq: number }>;
  ledgerSize(): Promise<number>;
  /** Move the store's notion of now forward. Real backends fake their own read clock. */
  advanceTime(ms: number): Promise<void>;
  dispose(): Promise<void>;
}

export type HarnessFactory = () => Promise<StoreHarness>;

// ---- helpers ---------------------------------------------------------------

let keyCounter = 0;
/** Unique idempotency key. Deterministic: Math.random would make reruns unequal. */
function key(prefix = 'k'): string { keyCounter += 1; return `${prefix}-${keyCounter.toString(36)}`; }

function progressEvent(actor_id: string, body: Record<string, unknown> = {}): EventInput {
  return { layer: 'human', kind: 'task_progress', actor_type: 'agent', actor_id, body };
}

function claimedEvent(actor_id: string, task_id: TaskId): EventInput {
  return {
    layer: 'coordination', kind: 'task_claimed', actor_type: 'agent', actor_id,
    body: { task_id, agent_id: actor_id, role_slug: 'backend' },
  };
}

async function presenceOf(h: StoreHarness, agent_id: AgentId): Promise<AgentPresence> {
  const all = await h.store.listPresence(h.project_id);
  const found = all.find((a) => a.agent_id === agent_id);
  assert.ok(found, `presence missing for ${agent_id}`);
  return found;
}

/** Wait for the event loop to drain, so an async delivery has a chance to land. */
async function settle(turns = 4): Promise<void> {
  for (let i = 0; i < turns; i += 1) await new Promise((r) => setImmediate(r));
}

// ---- the suite -------------------------------------------------------------

export function registerConformanceSuite(factory: HarnessFactory): void {
  describe('section A: store interface conformance', () => {
    /** Fresh harness, one seeded task and two agents. Disposed after each test. */
    async function setup(): Promise<StoreHarness> {
      const h = await factory();
      await h.seedTask({ task_id: 'task_items_api', title: 'Items API', kind: 'backend' });
      await h.seedAgent({ agent_id: 'agent_be01', role_slug: 'backend', member_label: 'Bea Backend' });
      await h.seedAgent({ agent_id: 'agent_fe01', role_slug: 'frontend', member_label: 'Fern Frontend' });
      return h;
    }

    it('A1 same idempotency_key twice -> same seq, duplicate:true, ledger grew by 1', async () => {
      const h = await setup();
      try {
        const before = await h.ledgerSize();
        const k = key('a1');
        const first = await h.store.appendEvent(h.project_id, progressEvent('agent_be01', { task_id: 'task_items_api', summary: 'wiring the store' }), k);
        const second = await h.store.appendEvent(h.project_id, progressEvent('agent_be01', { task_id: 'task_items_api', summary: 'wiring the store' }), k);

        assert.equal(first.duplicate, false);
        assert.equal(second.duplicate, true);
        assert.equal(second.seq, first.seq);
        assert.equal(second.event_id, first.event_id);
        assert.equal(await h.ledgerSize(), before + 1);
      } finally { await h.dispose(); }
    });

    it('A2 20 concurrent claimTask -> exactly one winner, 50 consecutive rounds', async () => {
      const h = await setup();
      try {
        const CLAIMANTS = 20;
        const ROUNDS = 50;
        const claimants = Array.from({ length: CLAIMANTS }, (_u, i) => `agent_r${i}`);
        for (const agent_id of claimants) {
          await h.seedAgent({ agent_id, role_slug: 'backend', member_label: `Racer ${agent_id}` });
        }

        for (let round = 0; round < ROUNDS; round += 1) {
          const task_id = `task_race_${round}`;
          await h.seedTask({ task_id, title: `Race ${round}`, kind: 'backend' });

          const results = await Promise.all(
            claimants.map((agent_id) => h.store.claimTask(h.project_id, task_id, agent_id)),
          );

          const winners = results.filter((r) => r.ok);
          assert.equal(winners.length, 1, `round ${round}: expected 1 winner, got ${winners.length}`);

          const losers = results.filter((r) => !r.ok) as { ok: false; owner: AgentId }[];
          assert.equal(losers.length, CLAIMANTS - 1);
          // Every loser names the same owner, and it is a real claimant.
          const owners = new Set(losers.map((l) => l.owner));
          assert.equal(owners.size, 1, `round ${round}: losers disagree on the owner`);
          assert.ok(claimants.includes([...owners][0]), `round ${round}: owner is not a claimant`);
        }
      } finally { await h.dispose(); }
    });

    it('A3 losing claimant gets {ok:false, owner}, never a thrown error', async () => {
      const h = await setup();
      try {
        const won = await h.store.claimTask(h.project_id, 'task_items_api', 'agent_be01');
        assert.deepEqual(won, { ok: true });

        // Must not throw. A claim loss is a normal outcome, not an error.
        const lost = await h.store.claimTask(h.project_id, 'task_items_api', 'agent_fe01');
        assert.equal(lost.ok, false);
        assert.ok(!lost.ok && lost.owner === 'agent_be01');
        assert.ok(!lost.ok && typeof lost.claimed_at === 'string' && lost.claimed_at.length > 0);

        // And it was not logged as an error anywhere.
        assert.equal(h.log.lines.filter((l) => l.level === 'error').length, 0);
      } finally { await h.dispose(); }
    });

    it('A4 readEvents returns strictly ascending seq', async () => {
      const h = await setup();
      try {
        for (let i = 0; i < 25; i += 1) {
          await h.store.appendEvent(h.project_id, progressEvent('agent_be01', { n: i }), key('a4'));
        }
        const { events } = await h.store.readEvents(h.project_id, 0);
        assert.ok(events.length >= 25);
        for (let i = 1; i < events.length; i += 1) {
          assert.ok(events[i].seq > events[i - 1].seq,
            `seq not ascending at ${i}: ${events[i - 1].seq} then ${events[i].seq}`);
        }
      } finally { await h.dispose(); }
    });

    it('A5 readEvents caps at 300 when asked for 1000, and logs the cap', async () => {
      const h = await setup();
      try {
        const OVER = LIMITS.events + 1;
        for (let i = 0; i < OVER; i += 1) {
          await h.store.appendEvent(h.project_id, progressEvent('agent_be01', { n: i }), key('a5'));
        }
        h.log.clear();

        const page = await h.store.readEvents(h.project_id, 0, 1000);
        assert.equal(page.events.length, LIMITS.events);
        assert.equal(page.has_more, true);
        assert.equal(page.next_cursor, page.events[page.events.length - 1].seq);

        const capLines = h.log.withCode('store.events.capped');
        assert.ok(capLines.length >= 1, 'expected a store.events.capped log line');
        assert.equal(capLines[0].fields.requested, 1000);
        assert.equal(capLines[0].fields.applied, LIMITS.events);
        assert.ok(Number(capLines[0].fields.dropped) >= 1, 'cap log must say what it dropped');

        // The rest is reachable, so the cap paged rather than lost anything.
        const rest = await h.store.readEvents(h.project_id, page.next_cursor);
        assert.ok(rest.events.length >= 1);
        assert.ok(rest.events[0].seq > page.next_cursor);
      } finally { await h.dispose(); }
    });

    it('A6 an appended event is never mutated or deleted by a later operation', async () => {
      const h = await setup();
      try {
        const appended = await h.store.appendEvent(
          h.project_id,
          { layer: 'contract', kind: 'contract_published', actor_type: 'agent', actor_id: 'agent_be01',
            body: { name: 'items-api', version: 1, path: 'contracts/items-api.v1.yaml', commit_sha: 'a'.repeat(40), supersedes: null } },
          key('a6'),
        );
        const before = (await h.store.readEvents(h.project_id, appended.seq - 1, 1)).events[0];
        assert.equal(before.seq, appended.seq);
        const frozen = structuredClone(before);

        // Churn: everything that could plausibly touch the ledger.
        await h.store.claimTask(h.project_id, 'task_items_api', 'agent_be01');
        await h.store.acquireScope(h.project_id, 'agent_be01', 'task_items_api', ['functions/**']);
        await h.store.heartbeat(h.project_id, 'agent_be01', 'working', 'task_items_api', 'feat/items');
        await h.store.appendEvent(h.project_id, progressEvent('agent_be01', { after: true }), key('a6b'));
        await h.store.releaseScope(h.project_id, 'agent_be01');
        await h.store.releaseTask(h.project_id, 'task_items_api', 'agent_be01');
        await h.store.readSnapshot(h.project_id);

        const after = (await h.store.readEvents(h.project_id, appended.seq - 1, 1)).events[0];
        assert.deepEqual(after, frozen, 'the appended event changed');

        // And it is still there: the ledger only ever grows.
        const all = await h.store.readEvents(h.project_id, 0);
        assert.ok(all.events.some((e) => e.event_id === appended.event_id));
      } finally { await h.dispose(); }
    });

    it('A7 acquireScope rejects intersecting globs and names the conflicts', async () => {
      const h = await setup();
      try {
        await h.seedTask({ task_id: 'task_ui', title: 'Board UI', kind: 'frontend' });

        const first = await h.store.acquireScope(h.project_id, 'agent_fe01', 'task_ui', ['client/src/**']);
        assert.deepEqual(first, { ok: true });

        const second = await h.store.acquireScope(
          h.project_id, 'agent_be01', 'task_items_api', ['client/src/store/catalyst.ts'],
        );
        assert.equal(second.ok, false, 'intersecting globs must be rejected server-side');
        assert.ok(!second.ok && second.conflicts.length === 1);
        assert.ok(!second.ok && second.conflicts[0].agent_id === 'agent_fe01');
        assert.ok(!second.ok && second.conflicts[0].task_id === 'task_ui');
        assert.ok(!second.ok && second.conflicts[0].globs.includes('client/src/**'));

        // The rejection did not partially apply: the loser holds no lock.
        const snap = await h.store.readSnapshot(h.project_id);
        assert.ok(snap);
        assert.equal(snap.snapshot.locks.filter((l) => l.agent_id === 'agent_be01').length, 0);
      } finally { await h.dispose(); }
    });

    it('A8 acquireScope allows disjoint globs concurrently', async () => {
      const h = await setup();
      try {
        await h.seedTask({ task_id: 'task_ui', title: 'Board UI', kind: 'frontend' });
        const [a, b] = await Promise.all([
          h.store.acquireScope(h.project_id, 'agent_fe01', 'task_ui', ['client/src/**']),
          h.store.acquireScope(h.project_id, 'agent_be01', 'task_items_api', ['functions/**', 'shared/store/*.ts']),
        ]);
        assert.deepEqual(a, { ok: true });
        assert.deepEqual(b, { ok: true });

        const snap = await h.store.readSnapshot(h.project_id);
        assert.ok(snap);
        assert.equal(snap.snapshot.locks.length, 2);
      } finally { await h.dispose(); }
    });

    it('A9 AgentPresence.stale flips true after the 90s timeout with no heartbeat', async () => {
      const h = await setup();
      try {
        await h.store.heartbeat(h.project_id, 'agent_be01', 'working', 'task_items_api', 'feat/items');
        const fresh = await presenceOf(h, 'agent_be01');
        assert.equal(fresh.stale, false);
        assert.equal(fresh.status, 'working');
        assert.ok(fresh.last_heartbeat_at, 'last_heartbeat_at must be set');

        await h.advanceTime(STALE_AFTER_MS - 1_000);
        assert.equal((await presenceOf(h, 'agent_be01')).stale, false, 'not stale one second early');

        await h.advanceTime(2_000);
        const stale = await presenceOf(h, 'agent_be01');
        assert.equal(stale.stale, true, 'stale must flip past the 90s timeout');

        // Derived, not stored: a fresh heartbeat clears it with no repair step.
        await h.store.heartbeat(h.project_id, 'agent_be01', 'working', 'task_items_api', 'feat/items');
        assert.equal((await presenceOf(h, 'agent_be01')).stale, false);
      } finally { await h.dispose(); }
    });

    it('A10 subscribe fires once immediately, before any change', async () => {
      const h = await setup();
      try {
        const seen: Snapshot[] = [];
        const unsubscribe = h.store.subscribe(h.project_id, 0, (s) => { seen.push(s); });
        await settle();

        assert.equal(seen.length, 1, 'exactly one immediate delivery expected');
        assert.equal(seen[0].project_id, h.project_id);
        assert.ok(seen[0].tasks.some((t) => t.task_id === 'task_items_api'));

        await h.store.appendEvent(h.project_id, claimedEvent('agent_be01', 'task_items_api'), key('a10'));
        await settle();
        assert.ok(seen.length >= 2, 'a change must deliver again');

        unsubscribe();
        const after = seen.length;
        await h.store.appendEvent(h.project_id, progressEvent('agent_be01', { x: 1 }), key('a10b'));
        await settle();
        assert.equal(seen.length, after, 'unsubscribe must stop deliveries');
      } finally { await h.dispose(); }
    });

    it('A11 subscribe survives a network drop and resumes from the cursor', async () => {
      const h = await setup();
      try {
        const seen: Snapshot[] = [];
        const unsubscribe = h.store.subscribe(h.project_id, 0, (s) => { seen.push(s); });
        await settle();
        const beforeDrop = seen.length;
        assert.equal(beforeDrop, 1);

        // This client's link goes down. Its own calls fail loudly...
        await h.faults.setOffline(true);
        await assert.rejects(
          () => h.store.readEvents(h.project_id, 0),
          (err: unknown) => err instanceof StoreOfflineError,
        );

        // ...while the rest of the world keeps writing: another agent, the webhook.
        const mid = await h.seedEvent(claimedEvent('agent_be01', 'task_items_api'), key('a11a'));
        const later = await h.seedEvent(progressEvent('agent_fe01', { summary: 'still going' }), key('a11b'));
        await settle();
        assert.equal(seen.length, beforeDrop, 'a subscriber must not be fed while its link is down');

        // Link restored: it resumes from its cursor rather than staying blind.
        await h.faults.setOffline(false);
        await settle();

        assert.ok(seen.length > beforeDrop, 'nothing delivered after the outage cleared');
        const last = seen[seen.length - 1];
        assert.ok(last.seq >= later.seq,
          `resumed snapshot must include seq ${later.seq}, saw ${last.seq}`);
        assert.ok(last.tasks.some((t) => t.task_id === 'task_items_api'));
        assert.ok(mid.seq < later.seq, 'server-side writes kept their order');

        unsubscribe();
      } finally { await h.dispose(); }
    });

    it('A12 emoji and 4-byte UTF-8 in durable text is stripped', async () => {
      const h = await setup();
      try {
        const dirty = 'shipped items-api v2 🚀 all green ✔ 𝕏';
        const expected = stripUnstorable(dirty).value;

        const appended = await h.store.appendEvent(
          h.project_id,
          progressEvent('agent_be01', { task_id: 'task_items_api', summary: dirty, files_changed: [`src/🔥hot.ts`] }),
          key('a12'),
        );
        const { events } = await h.store.readEvents(h.project_id, appended.seq - 1, 1);
        const body = events[0].body as { summary: string; files_changed: string[] };

        assert.equal(body.summary, expected);
        assert.equal(body.summary.includes('🚀'), false);
        assert.equal(body.summary.includes('✔'), false);
        // No '?' substitution either: stripped, not mangled by the backend.
        assert.equal(body.summary.includes('?'), false);
        assert.equal(body.files_changed[0], stripUnstorable('src/🔥hot.ts').value);
        // Nothing above the BMP survived anywhere in the stored body.
        assert.equal(/[\u{10000}-\u{10FFFF}]/u.test(JSON.stringify(events[0].body)), false);
      } finally { await h.dispose(); }
    });

    it('A13 a snapshot reporting seq < last_written_seq is stale, not lost', async () => {
      const h = await setup();
      try {
        // Hold the fold back, exactly as a debounced snapshot writer does.
        await h.faults.freezeSnapshot(true);
        const written = await h.store.appendEvent(h.project_id, claimedEvent('agent_be01', 'task_items_api'), key('a13'));

        const read = await h.store.readSnapshot(h.project_id);
        assert.ok(read);
        assert.ok(read.snapshot.seq < written.seq,
          `expected a lagging snapshot, got ${read.snapshot.seq} vs ${written.seq}`);

        // The event is already durable: readEvents sees it while the snapshot does not.
        const { events } = await h.store.readEvents(h.project_id, written.seq - 1, 1);
        assert.equal(events[0].seq, written.seq);

        // The correct caller response is to wait. A caller that wrongly re-appends
        // with the same key must not grow the ledger either.
        const size = await h.ledgerSize();
        const replay = await h.store.appendEvent(h.project_id, claimedEvent('agent_be01', 'task_items_api'), key('a13'));
        assert.equal(replay.duplicate, false, 'a fresh key is a genuinely new event');
        const retry = await h.store.appendEvent(h.project_id, claimedEvent('agent_be01', 'task_items_api'), 'a13-fixed-key');
        const retryAgain = await h.store.appendEvent(h.project_id, claimedEvent('agent_be01', 'task_items_api'), 'a13-fixed-key');
        assert.equal(retryAgain.duplicate, true);
        assert.equal(retryAgain.seq, retry.seq);
        assert.equal(await h.ledgerSize(), size + 2);

        // Once the writer catches up the snapshot converges.
        await h.faults.freezeSnapshot(false);
        const caught = await h.store.readSnapshot(h.project_id);
        assert.ok(caught);
        assert.ok(caught.snapshot.seq >= written.seq);
      } finally { await h.dispose(); }
    });

    it('A14 a revoked token throws StoreAuthError and is not retried', async () => {
      const h = await setup();
      try {
        await h.faults.revoke('agent_be01');

        await assert.rejects(
          () => h.store.claimTask(h.project_id, 'task_items_api', 'agent_be01'),
          (err: unknown) => {
            assert.ok(err instanceof StoreAuthError, `expected StoreAuthError, got ${String(err)}`);
            assert.equal(isRetryable(err), false);
            return true;
          },
        );

        // The retry policy must abandon it on the first attempt, not back off.
        let calls = 0;
        const slept: number[] = [];
        await assert.rejects(
          () => withRetry(
            async () => { calls += 1; return h.store.heartbeat(h.project_id, 'agent_be01', 'working'); },
            { attempts: 5, sleep: async (ms) => { slept.push(ms); }, log: h.log, op: 'a14' },
          ),
          (err: unknown) => err instanceof StoreAuthError,
        );
        assert.equal(calls, 1, 'a revoked token must not be retried');
        assert.deepEqual(slept, [], 'no backoff for an auth failure');
        assert.ok(h.log.has('retry.abandoned'), 'the abandonment must be logged');

        // Restoring the token restores service -- the error was about the token.
        await h.faults.restore('agent_be01');
        assert.deepEqual(await h.store.claimTask(h.project_id, 'task_items_api', 'agent_be01'), { ok: true });
      } finally { await h.dispose(); }
    });

    it('A15 a rate-limited backend throws StoreBusyError and backs off with jitter', async () => {
      const h = await setup();
      try {
        await h.faults.setBusy(true);
        await assert.rejects(
          () => h.store.readEvents(h.project_id, 0),
          (err: unknown) => {
            assert.ok(err instanceof StoreBusyError, `expected StoreBusyError, got ${String(err)}`);
            assert.equal(isRetryable(err), true);
            return true;
          },
        );

        // Deterministic pseudo-jitter so the assertions below are stable.
        let n = 0;
        const random = () => { n += 1; return (n * 0.37) % 1; };
        const slept: number[] = [];
        let calls = 0;

        await assert.rejects(
          () => withRetry(
            async () => { calls += 1; return h.store.readEvents(h.project_id, 0); },
            { attempts: 4, base_ms: 250, cap_ms: 8_000, random, sleep: async (ms) => { slept.push(ms); }, log: h.log, op: 'a15' },
          ),
          (err: unknown) => err instanceof StoreBusyError,
        );

        assert.equal(calls, 4, 'all attempts should be used while the backend is busy');
        assert.equal(slept.length, 3, 'one backoff between each pair of attempts');
        for (const ms of slept) assert.ok(ms > 0, 'a zero backoff is a tight loop');
        // The floor doubles per attempt: growth, not a fixed interval.
        assert.ok(slept[1] >= slept[0] * 1.2, `backoff did not grow: ${slept.join(',')}`);
        assert.ok(slept[2] >= slept[1] * 1.2, `backoff did not grow: ${slept.join(',')}`);
        assert.ok(new Set(slept).size > 1, 'identical delays mean no jitter');
        assert.ok(h.log.withCode('retry.backoff').length === 3);

        // Recovery: the same call succeeds once the limit clears, no restart needed.
        await h.faults.setBusy(false);
        const page = await h.store.readEvents(h.project_id, 0);
        assert.ok(Array.isArray(page.events));
      } finally { await h.dispose(); }
    });

    // ---- A16-A18: createTask (Order 0063) --------------------------------------------
    //
    // These three exist because the operation they cover did not. `claimTask` was pinned by A2
    // and A3 while taking an id that nothing in the product could produce -- the suite proved a
    // race was safe on a task only a fixture could create. A16 proves creation works, A17 proves
    // repeating it is a value rather than a second card, and A18 closes the loop by claiming
    // what A16 made, which is the sentence the whole board rests on.

    it('A16 createTask puts an open task on the board and appends one coordination event', async () => {
      const h = await setup();
      try {
        const before = await h.ledgerSize();
        const created = await h.store.createTask(
          h.project_id,
          {
            title: 'Items list page',
            kind: 'frontend',
            description: 'render the list',
            file_scope: ['client/src/routes/items/**'],
            depends_on: ['task_items_api'],
          },
          { actor_type: 'owner', actor_id: 'uid_owner' },
        );

        assert.ok(created.ok, 'createTask must succeed on a fresh id');
        assert.ok(created.ok && created.task_id === 'task_items_list_page',
          `id must be derived from the title, got ${created.ok ? created.task_id : '(none)'}`);
        assert.equal(await h.ledgerSize(), before + 1, 'exactly one event per created task');

        const snap = await h.store.readSnapshot(h.project_id);
        assert.ok(snap);
        const t = snap.snapshot.tasks.find((x) => x.task_id === 'task_items_list_page');
        assert.ok(t, 'the created task must appear on the board');
        assert.equal(t.status, 'open');
        assert.equal(t.title, 'Items list page');
        assert.equal(t.kind, 'frontend');
        assert.equal(t.claimed_by, null);
        assert.deepEqual(t.file_scope, ['client/src/routes/items/**']);
        assert.deepEqual(t.depends_on, ['task_items_api']);

        // The event is on the COORDINATION layer, so an agent's inbox receives it. A human-layer
        // creation would put a card on the board that no agent is ever told about.
        const { events } = await h.store.readEvents(h.project_id, 0);
        const ev = events.filter((e) => e.kind === 'task_created');
        assert.equal(ev.length, 1);
        assert.equal(ev[0].layer, 'coordination');
        assert.equal(ev[0].body.task_id, 'task_items_list_page');
      } finally { await h.dispose(); }
    });

    it('A17 createTask on an existing id returns the existing task, never a second card', async () => {
      const h = await setup();
      try {
        const first = await h.store.createTask(
          h.project_id, { title: 'Wire the webhook', kind: 'backend' },
          { actor_type: 'owner', actor_id: 'uid_owner' },
        );
        assert.ok(first.ok);

        const size = await h.ledgerSize();
        // The retry a CLI performs after a timeout it could not distinguish from a failure.
        const again = await h.store.createTask(
          h.project_id, { title: 'Wire the webhook', kind: 'backend' },
          { actor_type: 'owner', actor_id: 'uid_owner' },
        );

        assert.equal(again.ok, false, 'a repeat must not report a fresh creation');
        assert.ok(!again.ok && again.task_id === (first.ok ? first.task_id : ''));
        assert.ok(!again.ok && again.existing.status === 'open',
          'the loser is handed the task that is actually there');
        assert.equal(await h.ledgerSize(), size, 'a repeat appends nothing');

        const snap = await h.store.readSnapshot(h.project_id);
        assert.ok(snap);
        const matching = snap.snapshot.tasks.filter((t) => t.title === 'Wire the webhook');
        assert.equal(matching.length, 1, 'exactly one card, however many times it was created');

        // And it was not logged as an error. An existing task is a normal outcome.
        assert.equal(h.log.lines.filter((l) => l.level === 'error').length, 0);
      } finally { await h.dispose(); }
    });

    it('A18 a task created through the port is immediately claimable', async () => {
      const h = await setup();
      try {
        const created = await h.store.createTask(
          h.project_id, { title: 'Seed the board', kind: 'devops' },
          { actor_type: 'owner', actor_id: 'uid_owner' },
        );
        assert.ok(created.ok);
        const task_id = created.ok ? created.task_id : '';

        // THE SENTENCE THE PRODUCT RESTS ON: `flotilla task` then `flotilla claim`. Before
        // Order 0063 the second half took an id the first half could not produce.
        assert.deepEqual(await h.store.claimTask(h.project_id, task_id, 'agent_be01'), { ok: true });
        const lost = await h.store.claimTask(h.project_id, task_id, 'agent_fe01');
        assert.equal(lost.ok, false, 'a created task races exactly like a seeded one');

        const snap = await h.store.readSnapshot(h.project_id);
        assert.ok(snap);
        const t = snap.snapshot.tasks.find((x) => x.task_id === task_id);
        assert.ok(t);
        assert.equal(t.claimed_by, 'agent_be01');
        assert.equal(t.status, 'claimed');
      } finally { await h.dispose(); }
    });

  });
}
