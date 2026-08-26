// The reaper. F11 depends on this working: "kill the frontend agent's laptop;
// reaper releases the claim within 15 min".

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  REAP_BATCH, decideReaps, reapEventBody, reapIdempotencyKey, runReaper,
} from './reaper.ts';
import type { AgentLiveness, ReapableClaim, ReaperPort } from './reaper.ts';
import { CLAIM_TIMEOUT_MS } from '../../shared/store/types.ts';
import { CapturingLogger } from '../../shared/log.ts';

const NOW = Date.UTC(2026, 7, 26, 12, 0, 0);
const PROJECT = 'proj_inventory';

function claim(over: Partial<ReapableClaim> = {}): ReapableClaim {
  return {
    rowid: '530690000000001', claim_key: `${PROJECT}:task_items_api`, project_id: PROJECT,
    task_id: 'task_items_api', agent_id: 'agent_be01',
    claimed_at: new Date(NOW - 60_000).toISOString(), ...over,
  };
}

function live(over: Partial<AgentLiveness> = {}): AgentLiveness {
  return { agent_id: 'agent_be01', last_seen_ms: NOW - 1_000, revoked: 'false', ...over };
}

describe('decideReaps', () => {
  test('a fresh heartbeat is left alone', () => {
    assert.deepEqual(decideReaps({ claims: [claim()], liveness: [live()], now_ms: NOW }), []);
  });

  test('one second before the timeout is still safe', () => {
    const d = decideReaps({
      claims: [claim()], liveness: [live({ last_seen_ms: NOW - CLAIM_TIMEOUT_MS + 1_000 })], now_ms: NOW,
    });
    assert.deepEqual(d, []);
  });

  test('past the 15 minute timeout the claim is reaped as stale', () => {
    const d = decideReaps({
      claims: [claim()], liveness: [live({ last_seen_ms: NOW - CLAIM_TIMEOUT_MS - 1 })], now_ms: NOW,
    });
    assert.equal(d.length, 1);
    assert.equal(d[0].reason, 'stale');
    assert.ok(d[0].silent_ms > CLAIM_TIMEOUT_MS);
  });

  test('a revoked agent is reaped IMMEDIATELY, not after the timeout', () => {
    // A revoked token can never heartbeat again, so waiting 15 minutes serves no
    // purpose. Labelled distinctly so the log does not claim the agent went
    // quiet when it was actually cut off.
    const d = decideReaps({
      claims: [claim()], liveness: [live({ revoked: 'true', last_seen_ms: NOW })], now_ms: NOW,
    });
    assert.equal(d.length, 1);
    assert.equal(d[0].reason, 'revoked');
  });

  test('the STRING "false" does not count as revoked', () => {
    // Boolean("false") is true. A direct read would reap every live agent.
    for (const revoked of ['false', 'FALSE', '', '0', undefined, null]) {
      assert.deepEqual(decideReaps({ claims: [claim()], liveness: [live({ revoked })], now_ms: NOW }), []);
    }
  });

  test('an agent row that no longer exists is treated as revoked', () => {
    const d = decideReaps({ claims: [claim()], liveness: [], now_ms: NOW });
    assert.equal(d.length, 1);
    assert.equal(d[0].reason, 'revoked');
  });

  test('an agent that claimed and never heartbeated is aged from the CLAIM', () => {
    // Otherwise there is no timestamp to age from and the claim is immortal.
    const young = decideReaps({
      claims: [claim({ claimed_at: new Date(NOW - 60_000).toISOString() })],
      liveness: [live({ last_seen_ms: null })], now_ms: NOW,
    });
    assert.deepEqual(young, [], 'a recent claim with no heartbeat yet is not stale');

    const old = decideReaps({
      claims: [claim({ claimed_at: new Date(NOW - CLAIM_TIMEOUT_MS - 1_000).toISOString() })],
      liveness: [live({ last_seen_ms: null })], now_ms: NOW,
    });
    assert.equal(old.length, 1);
    assert.equal(old[0].reason, 'never_seen');
  });

  test('an unparseable claimed_at is reaped, not treated as brand new', () => {
    // Reading it as "now" would make the claim permanently unreapable, which is
    // the exact failure the reaper exists to prevent.
    const d = decideReaps({
      claims: [claim({ claimed_at: 'not a date' })],
      liveness: [live({ last_seen_ms: null })], now_ms: NOW,
    });
    assert.equal(d.length, 1);
    assert.equal(d[0].silent_ms, Number.POSITIVE_INFINITY);
  });

  test('only the stale claims in a mixed batch are reaped', () => {
    const d = decideReaps({
      claims: [
        claim({ task_id: 'task_fresh', agent_id: 'agent_a', rowid: '1' }),
        claim({ task_id: 'task_stale', agent_id: 'agent_b', rowid: '2' }),
        claim({ task_id: 'task_revoked', agent_id: 'agent_c', rowid: '3' }),
      ],
      liveness: [
        live({ agent_id: 'agent_a', last_seen_ms: NOW - 1_000 }),
        live({ agent_id: 'agent_b', last_seen_ms: NOW - CLAIM_TIMEOUT_MS - 1 }),
        live({ agent_id: 'agent_c', revoked: 'true' }),
      ],
      now_ms: NOW,
    });
    assert.deepEqual(d.map((x) => x.claim.task_id).sort(), ['task_revoked', 'task_stale']);
  });
});

describe('idempotency', () => {
  test('the key is deterministic, so two overlapping runs produce ONE event', () => {
    const c = claim();
    assert.equal(reapIdempotencyKey(c), reapIdempotencyKey({ ...c }));
  });

  test('the key contains no colon, so it can be a composite key part', () => {
    assert.equal(reapIdempotencyKey(claim()).includes(':'), false);
  });

  test('a re-claim and re-reap gets its own event rather than being absorbed', () => {
    const first = reapIdempotencyKey(claim({ claimed_at: '2026-08-26T11:00:00.000Z' }));
    const second = reapIdempotencyKey(claim({ claimed_at: '2026-08-26T13:00:00.000Z' }));
    assert.notEqual(first, second);
  });

  test('the event body names what was released and why', () => {
    const body = reapEventBody({ claim: claim(), reason: 'stale', silent_ms: 999_000 });
    assert.equal(body.task_id, 'task_items_api');
    assert.equal(body.released_agent_id, 'agent_be01');
    assert.equal(body.was_blocked_by, null);
    assert.match(String(body.reason_resolved), /stale/);
  });

  test('an infinite silent_ms is not emitted as Infinity, which JSON cannot carry', () => {
    const body = reapEventBody({ claim: claim(), reason: 'never_seen', silent_ms: Infinity });
    assert.equal(body.silent_ms, null);
    assert.equal(JSON.parse(JSON.stringify(body)).silent_ms, null);
  });
});

class FakeReaper implements ReaperPort {
  claims: ReapableClaim[] = [];
  liveness: AgentLiveness[] = [];
  appended: { project_id: string; key: string }[] = [];
  deleted: string[] = [];
  failAppendFor: string | null = null;
  failDeleteFor: string | null = null;

  listClaims = async (): Promise<ReapableClaim[]> => [...this.claims];
  listLiveness = async (): Promise<AgentLiveness[]> => [...this.liveness];

  appendUnblocked = async (project_id: string, _b: Record<string, unknown>, key: string): Promise<void> => {
    if (this.failAppendFor && key.includes(this.failAppendFor)) throw new Error('append exploded');
    this.appended.push({ project_id, key });
  };

  deleteClaim = async (rowid: string): Promise<void> => {
    if (this.failDeleteFor === rowid) throw new Error('delete exploded');
    this.deleted.push(rowid);
  };
}

describe('runReaper', () => {
  test('releases a stale claim: appends first, then deletes', async () => {
    const port = new FakeReaper();
    port.claims = [claim()];
    port.liveness = [live({ last_seen_ms: NOW - CLAIM_TIMEOUT_MS - 1 })];
    const log = new CapturingLogger();

    const r = await runReaper(port, NOW, log);
    assert.equal(r.scanned, 1);
    assert.equal(r.reaped, 1);
    assert.equal(r.by_reason.stale, 1);
    assert.equal(port.appended.length, 1);
    assert.deepEqual(port.deleted, ['530690000000001']);
    assert.ok(log.has('reaper.released'));
  });

  test('logs a heartbeat at BOTH ends, so a silent kill is detectable', async () => {
    // Cron and event functions are silently terminated on timeout with no log
    // line. Only a matched pair of start/end lines distinguishes a kill from a
    // clean pass that found nothing.
    const port = new FakeReaper();
    const log = new CapturingLogger();
    await runReaper(port, NOW, log);
    assert.ok(log.has('reaper.start'));
    assert.ok(log.has('reaper.end'));
  });

  test('an empty scan is a clean pass, not an error', async () => {
    const port = new FakeReaper();
    const log = new CapturingLogger();
    const r = await runReaper(port, NOW, log);
    assert.deepEqual(r, {
      scanned: 0, reaped: 0, failed: 0,
      by_reason: { stale: 0, revoked: 0, never_seen: 0 }, failures: [],
    });
    assert.equal(log.lines.filter((l) => l.level === 'error').length, 0);
  });

  test('one failing claim does not abort the pass', async () => {
    // The remaining claims are still holding up other agents.
    const port = new FakeReaper();
    port.claims = [
      claim({ task_id: 'task_a', agent_id: 'agent_a', rowid: '1' }),
      claim({ task_id: 'task_b', agent_id: 'agent_b', rowid: '2' }),
    ];
    port.liveness = [
      live({ agent_id: 'agent_a', last_seen_ms: NOW - CLAIM_TIMEOUT_MS - 1 }),
      live({ agent_id: 'agent_b', last_seen_ms: NOW - CLAIM_TIMEOUT_MS - 1 }),
    ];
    port.failDeleteFor = '1';
    const log = new CapturingLogger();

    const r = await runReaper(port, NOW, log);
    assert.equal(r.reaped, 1);
    assert.equal(r.failed, 1);
    assert.deepEqual(port.deleted, ['2'], 'the healthy claim was still released');
    assert.ok(log.has('reaper.release_failed'));
    // The detail rides in the RESULT, not only the log: a deployed function's
    // console output is not retrievable, so a log-only failure is undiagnosable.
    assert.equal(r.failures.length, 1);
    assert.equal(r.failures[0].task_id, 'task_a');
    assert.match(r.failures[0].message, /delete exploded/);
  });

  test('a crash between append and delete leaves the claim reapable next pass', async () => {
    // Append-then-delete means a crash loses the DELETE, not the event. The next
    // pass re-appends with the same idempotency key -- absorbed as a duplicate --
    // and completes the delete.
    const port = new FakeReaper();
    port.claims = [claim()];
    port.liveness = [live({ last_seen_ms: NOW - CLAIM_TIMEOUT_MS - 1 })];
    port.failDeleteFor = '530690000000001';
    const log = new CapturingLogger();

    const first = await runReaper(port, NOW, log);
    assert.equal(first.failed, 1);
    assert.equal(port.appended.length, 1, 'the event landed');

    // Second pass: same claim still present, same key.
    port.failDeleteFor = null;
    const second = await runReaper(port, NOW, log);
    assert.equal(second.reaped, 1);
    assert.equal(port.appended.length, 2, 'appended again...');
    assert.equal(port.appended[0].key, port.appended[1].key, '...with the SAME key, so the ledger keeps one');
    assert.deepEqual(port.deleted, ['530690000000001']);
  });

  test('a full batch is logged, because more may remain than one pass can reach', async () => {
    const port = new FakeReaper();
    port.claims = Array.from({ length: REAP_BATCH }, (_u, i) =>
      claim({ rowid: String(i), task_id: `task_${i}`, agent_id: 'agent_gone' }));
    port.liveness = [];
    const log = new CapturingLogger();

    const r = await runReaper(port, NOW, log);
    assert.equal(r.scanned, REAP_BATCH);
    assert.equal(r.reaped, REAP_BATCH, 'every claim had no agent row, so all are reapable');
    assert.ok(log.has('reaper.batch_full'));
  });

  test('F12: after a reap the task is free for another agent', async () => {
    // The reaper deletes the claim row, so the unique constraint no longer holds
    // and a fresh INSERT wins. Asserted here as the absence of the row.
    const port = new FakeReaper();
    port.claims = [claim()];
    port.liveness = [live({ last_seen_ms: NOW - CLAIM_TIMEOUT_MS - 1 })];
    await runReaper(port, NOW, new CapturingLogger());
    assert.deepEqual(port.deleted, ['530690000000001']);
  });
});
