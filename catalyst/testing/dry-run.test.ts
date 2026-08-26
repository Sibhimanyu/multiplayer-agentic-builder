// Schema dry run: replay the Create_Table / Create_Column specs and drive the
// real handlers through them, before any of it touches a cloud.
//
// Suggested by the coordinator alongside order 0006. The point is not to
// simulate Catalyst -- it is to exercise the schema and the write paths end to
// end against the platform behaviours the probe actually measured, so that when
// a project ID arrives the first real run is a confirmation rather than a
// discovery.
//
// Everything here runs the SHIPPING code: handleClaim, handleAppend,
// handleEvents, handleWebhook and the real ZCQL builders. Only the Data Store
// underneath is a double.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { FakeDataStore, FakeDuplicateValue } from './fake-datastore.ts';
import { TABLES } from '../schema/tables.ts';
import { toDuplicateValueError } from '../lib/duplicate.ts';
import { selectDedupe, selectEventByDedupeKey, selectMaxSeq, readMaxSeq, unwrapRows } from '../lib/zcql.ts';
import { deliveryIdempotencyKey, mapGithubEvent, signGithubBody } from '../lib/webhook.ts';
import { CapturingLogger } from '../../shared/log.ts';
import { handleClaim, claimKeyFor } from '../../functions/claim/index.ts';
import type { ClaimPort } from '../../functions/claim/index.ts';
import { handleAppend, dedupeKeyFor, eventIdFor } from '../../functions/append/index.ts';
import type { AppendPort } from '../../functions/append/index.ts';
import { handleEvents } from '../../functions/events/index.ts';
import { handleWebhook } from '../../functions/github-webhook/index.ts';
import type { WebhookPort } from '../../functions/github-webhook/index.ts';
import type { Principal } from '../../functions/_lib/auth.ts';

const PROJECT = 'proj_inventory';
const OTHER_PROJECT = 'proj_rainfall';

function principal(over: Partial<Principal> = {}): Principal {
  return {
    agent_id: 'agent_be01', project_id: PROJECT, role_slug: 'backend',
    member_id: 'mem_1', member_label: 'Bea Backend', can_merge: false, ...over,
  };
}

let clock = 0;
const now = (): string => new Date(Date.UTC(2026, 7, 25, 9, 0, clock++)).toISOString();

function build(): { db: FakeDataStore; log: CapturingLogger } {
  clock = 0;
  const log = new CapturingLogger();
  const db = new FakeDataStore({ log, now });
  db.createAll();
  return { db, log };
}

/** Translate the fake's failure payload the way a real adapter would. */
function asStoreError(err: unknown): unknown {
  if (err instanceof FakeDuplicateValue) {
    const mapped = toDuplicateValueError(err.payload);
    if (mapped) return mapped;
  }
  return err;
}

function claimPort(db: FakeDataStore): ClaimPort {
  return {
    insertClaim: async (row) => {
      try { db.insert('task_claims', [{ ...row }]); } catch (err) { throw asStoreError(err); }
    },
    findClaim: async (claim_key) => {
      const rows = unwrapRows<Record<string, unknown>>(db.query(
        `SELECT claim_key FROM task_claims WHERE claim_key = '${claim_key}' LIMIT 0, 1`,
      ), 'task_claims');
      if (rows.length === 0) return null;
      return { agent_id: String(rows[0].agent_id), claimed_at: String(rows[0].claimed_at) };
    },
  };
}

function appendPort(db: FakeDataStore): AppendPort {
  return {
    maxSeq: async () => readMaxSeq(db.query(selectMaxSeq())),
    insertDedupe: async (row) => {
      try { db.insert('request_dedupe', [{ ...row }]); } catch (err) { throw asStoreError(err); }
    },
    findDedupe: async (dedupe_key) => {
      const rows = unwrapRows<Record<string, unknown>>(db.query(selectDedupe(dedupe_key)), 'request_dedupe');
      if (rows.length === 0) return null;
      const r = rows[0];
      return {
        dedupe_key: String(r.dedupe_key), idempotency_key: String(r.idempotency_key),
        project_id: String(r.project_id), seq: Number(r.seq), event_id: String(r.event_id),
      };
    },
    insertEvent: async (row) => {
      try { db.insert('events', [row]); } catch (err) { throw asStoreError(err); }
    },
    findEventByDedupeKey: async (dedupe_key) => {
      const rows = unwrapRows<Record<string, unknown>>(
        db.query(selectEventByDedupeKey(dedupe_key)), 'events');
      if (rows.length === 0) return null;
      return { seq: Number(rows[0].seq), event_id: String(rows[0].event_id) };
    },
  };
}

describe('dry run: the nine tables', () => {
  test('every declared table replays through Create_Table / Create_Column', () => {
    const { db } = build();
    assert.equal(db.tables.size, TABLES.length);
    for (const spec of TABLES) assert.ok(db.tables.has(spec.name));
  });

  test('no declared varchar is clamped -- the schema stays inside the platform limit', () => {
    const { db } = build();
    assert.deepEqual(db.clamped, [], 'a declared column would have been silently truncated');
  });
});

describe('dry run: claiming', () => {
  test('the first claim wins and the second is told who owns it', async () => {
    const { db } = build();
    const port = claimPort(db);

    const first = await handleClaim(port, principal(), { project_id: PROJECT, task_id: 'task_items_api' }, now);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body, { ok: true });

    const second = await handleClaim(port, principal({ agent_id: 'agent_fe01' }),
      { project_id: PROJECT, task_id: 'task_items_api' }, now);
    // 200, not 409: losing a claim is a normal outcome.
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, {
      ok: false, owner: 'agent_be01', claimed_at: (second.body as { claimed_at: string }).claimed_at,
    });
    assert.equal(db.rowCount('task_claims'), 1);
  });

  test('20 concurrent claims produce exactly one winner', async () => {
    const { db } = build();
    const port = claimPort(db);
    const results = await Promise.all(Array.from({ length: 20 }, (_u, i) =>
      handleClaim(port, principal({ agent_id: `agent_r${i}` }),
        { project_id: PROJECT, task_id: 'task_race' }, now)));

    const winners = results.filter((r) => (r.body as { ok: boolean }).ok);
    assert.equal(winners.length, 1);
    assert.equal(db.rowCount('task_claims'), 1);
  });

  test('THE CROSS-TENANT CASE: two projects claim the same task name independently', async () => {
    // A bare unique(task_id) would let the first project block the second
    // forever. This is the composite key earning its keep.
    const { db } = build();
    const port = claimPort(db);

    const a = await handleClaim(port, principal(), { project_id: PROJECT, task_id: 'task_api' }, now);
    const b = await handleClaim(port, principal({ project_id: OTHER_PROJECT, agent_id: 'agent_other' }),
      { project_id: OTHER_PROJECT, task_id: 'task_api' }, now);

    assert.deepEqual(a.body, { ok: true });
    assert.deepEqual(b.body, { ok: true }, 'a second project must be able to claim its own task_api');
    assert.equal(db.rowCount('task_claims'), 2);
    assert.notEqual(claimKeyFor(PROJECT, 'task_api'), claimKeyFor(OTHER_PROJECT, 'task_api'));
  });

  test('task ids are lowercased, because the constraint is case-sensitive', async () => {
    const { db } = build();
    const port = claimPort(db);
    await handleClaim(port, principal(), { project_id: PROJECT, task_id: 'task_items_api' }, now);
    const shouty = await handleClaim(port, principal({ agent_id: 'agent_fe01' }),
      { project_id: PROJECT, task_id: 'TASK_ITEMS_API' }, now);
    // Without normalisation the platform would treat these as two tasks and
    // hand out a second claim on the same work.
    assert.equal((shouty.body as { ok: boolean }).ok, false);
    assert.equal(db.rowCount('task_claims'), 1);
  });
});

const body = { project_id: PROJECT, kind: 'task_claimed', body: { task_id: 'task_items_api' } };

describe('dry run: appending', () => {

  test('an append allocates seq 1 and writes both rows', async () => {
    const { db, log } = build();
    const res = await handleAppend(appendPort(db), principal(), body, 'key-1', now, log);
    assert.equal(res.status, 201);
    assert.equal((res.body as { seq: number }).seq, 1);
    assert.equal((res.body as { event_id: string }).event_id, eventIdFor(1));
    assert.equal(db.rowCount('events'), 1);
    assert.equal(db.rowCount('request_dedupe'), 1);
  });

  test('A1: the same idempotency key twice returns the ORIGINAL seq and appends nothing', async () => {
    const { db, log } = build();
    const port = appendPort(db);
    const first = await handleAppend(port, principal(), body, 'key-1', now, log);
    const second = await handleAppend(port, principal(), body, 'key-1', now, log);

    assert.equal((second.body as { duplicate: boolean }).duplicate, true);
    assert.equal((second.body as { seq: number }).seq, (first.body as { seq: number }).seq);
    assert.equal(db.rowCount('events'), 1, 'the ledger grew by one, not two');
  });

  test('A4: sequential appends produce strictly ascending seq', async () => {
    const { db, log } = build();
    const port = appendPort(db);
    for (let i = 0; i < 10; i += 1) {
      await handleAppend(port, principal(), body, `key-${i}`, now, log);
    }
    const seqs = db.allRows('events').map((r) => Number(r.seq));
    assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test('concurrent appends do not collide, and seq stays dense', async () => {
    const { db, log } = build();
    const port = appendPort(db);
    await Promise.all(Array.from({ length: 12 }, (_u, i) =>
      handleAppend(port, principal(), body, `concurrent-${i}`, now, log)));

    const seqs = db.allRows('events').map((r) => Number(r.seq)).sort((a, b) => a - b);
    assert.deepEqual(seqs, Array.from({ length: 12 }, (_u, i) => i + 1));
  });

  test('MB1b: every dedupe row records the seq its event ACTUALLY received', async () => {
    // Under contention the first seq candidate is often NOT the one the event
    // ends up with. If the dedupe row recorded the candidate, a later replay
    // would return a seq belonging to a different event -- silent corruption.
    const { db, log } = build();
    const port = appendPort(db);
    await Promise.all(Array.from({ length: 12 }, (_u, i) =>
      handleAppend(port, principal(), body, `mb1b-${i}`, now, log)));

    const events = db.allRows('events');
    const dedupes = db.allRows('request_dedupe');
    assert.equal(dedupes.length, events.length);

    for (const d of dedupes) {
      const event = events.find((e) => Number(e.seq) === Number(d.seq));
      assert.ok(event, `dedupe row ${d.dedupe_key} points at seq ${d.seq}, which no event has`);
      // ...and it is THAT request's event, not merely some event at that seq.
      assert.equal(event.dedupe_key, d.dedupe_key,
        'the dedupe row points at an event produced by a different request');
      assert.equal(event.event_id, d.event_id);
    }
  });

  test('MB1b: a replay after contention returns the settled seq, not a candidate', async () => {
    const { db, log } = build();
    const port = appendPort(db);
    // Fill some seqs so the next allocation starts contended.
    await Promise.all(Array.from({ length: 6 }, (_u, i) =>
      handleAppend(port, principal(), body, `warm-${i}`, now, log)));

    const first = await handleAppend(port, principal(), body, 'replay-me', now, log);
    const replay = await handleAppend(port, principal(), body, 'replay-me', now, log);

    assert.equal((replay.body as { duplicate: boolean }).duplicate, true);
    assert.equal((replay.body as { seq: number }).seq, (first.body as { seq: number }).seq);
    const event = db.allRows('events').find((e) => Number(e.seq) === (replay.body as { seq: number }).seq);
    assert.ok(event, 'the replayed seq must belong to a real event');
    assert.equal(event.dedupe_key, dedupeKeyFor(PROJECT, 'replay-me'));
  });

  test('THE CROSS-TENANT CASE: two projects may use the SAME client-supplied key', async () => {
    // The bug the corrected mandatory behaviour 2 caught. A bare
    // unique(idempotency_key) would make the second append return the first
    // project's seq for an event that was never written: silent event loss.
    const { db, log } = build();
    const port = appendPort(db);
    const shared = 'client-picked-this-uuid';

    const a = await handleAppend(port, principal(), body, shared, now, log);
    const b = await handleAppend(port, principal({ project_id: OTHER_PROJECT }),
      { ...body, project_id: OTHER_PROJECT }, shared, now, log);

    assert.equal((a.body as { duplicate: boolean }).duplicate, false);
    assert.equal((b.body as { duplicate: boolean }).duplicate, false,
      'project B must not be told its append was a duplicate of project A');
    assert.notEqual((b.body as { seq: number }).seq, (a.body as { seq: number }).seq);
    assert.equal(db.rowCount('events'), 2);
    assert.notEqual(dedupeKeyFor(PROJECT, shared), dedupeKeyFor(OTHER_PROJECT, shared));
  });

  test('emoji are stripped before the write, and the strip is logged', async () => {
    const { db, log } = build();
    await handleAppend(appendPort(db), principal(),
      { ...body, body: { task_id: 'task_items_api', summary: 'shipped it 🚀 done' } },
      'emoji-1', now, log);

    const stored = JSON.parse(String(db.allRows('events')[0].body));
    assert.equal(stored.summary.includes('🚀'), false);
    assert.equal(stored.summary.includes('?'), false);
    assert.ok(log.has('sanitize.stripped'), 'a strip must never be silent');
  });

  test('actor_id comes from the token, never from the request', async () => {
    const { db, log } = build();
    await handleAppend(appendPort(db), principal({ agent_id: 'agent_be01' }), body, 'actor-1', now, log);
    assert.equal(db.allRows('events')[0].actor_id, 'agent_be01');
  });

  test('a forged agent_id in the body is rejected outright', async () => {
    const { db, log } = build();
    await assert.rejects(
      () => handleAppend(appendPort(db), principal(),
        { ...body, agent_id: 'agent_someone_else' }, 'forge-1', now, log),
      /resolved server-side/,
    );
    assert.equal(db.rowCount('events'), 0, 'a forgery must not write anything');
  });
});

describe('dry run: reading back', () => {
  test('events read in seq order despite ROWID running backwards', async () => {
    // The fake reproduces the probe's non-monotonic ROWID allocation, so a
    // regression to ORDER BY ROWID would visibly reorder here.
    const { db, log } = build();
    const port = appendPort(db);
    for (let i = 0; i < 8; i += 1) {
      await handleAppend(port, principal(), { ...body, body: { task_id: 'task_items_api', n: i } }, `read-${i}`, now, log);
    }

    const rowids = db.allRows('events').map((r) => String(r.ROWID));
    const byRowid = [...rowids].sort();
    assert.notDeepEqual(rowids, byRowid, 'the fake must actually reproduce non-monotonic ROWIDs');

    const res = await handleEvents({ query: async (q) => db.query(q) }, principal(),
      { project_id: PROJECT, since_seq: 0 }, 'agent', log);
    const seqs = (res.body as { events: { seq: number }[] }).events.map((e) => e.seq);
    assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6, 7, 8]);
  });

  test('a cursor walks the ledger without gaps or repeats', async () => {
    const { db, log } = build();
    const port = appendPort(db);
    for (let i = 0; i < 10; i += 1) {
      await handleAppend(port, principal(), body, `cursor-${i}`, now, log);
    }

    const seen: number[] = [];
    let cursor = 0;
    for (let page = 0; page < 10; page += 1) {
      const res = await handleEvents({ query: async (q) => db.query(q) }, principal(),
        { project_id: PROJECT, since_seq: cursor, limit: 3 }, 'agent', log);
      const payload = res.body as { events: { seq: number }[]; next_cursor: number; has_more: boolean };
      seen.push(...payload.events.map((e) => e.seq));
      cursor = payload.next_cursor;
      if (!payload.has_more) break;
    }
    assert.deepEqual(seen, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  test('human-layer events are withheld from agents but shown to the dashboard', async () => {
    const { db, log } = build();
    const port = appendPort(db);
    await handleAppend(port, principal(), body, 'h-1', now, log);
    await handleAppend(port, principal(),
      { project_id: PROJECT, kind: 'task_progress', body: { task_id: 'task_items_api', summary: 'halfway' } },
      'h-2', now, log);

    const forAgent = await handleEvents({ query: async (q) => db.query(q) }, principal(),
      { project_id: PROJECT, since_seq: 0 }, 'agent', log);
    const agentKinds = (forAgent.body as { events: { kind: string }[] }).events.map((e) => e.kind);
    assert.deepEqual(agentKinds, ['task_claimed'], 'human-layer events must never reach an agent');

    const forDash = await handleEvents({ query: async (q) => db.query(q) }, principal(),
      { project_id: PROJECT, since_seq: 0 }, 'dashboard', log);
    assert.equal((forDash.body as { events: unknown[] }).events.length, 2);
  });

  test('one project cannot read another project events', async () => {
    const { db, log } = build();
    const port = appendPort(db);
    await handleAppend(port, principal(), body, 'iso-1', now, log);
    await handleAppend(port, principal({ project_id: OTHER_PROJECT }),
      { ...body, project_id: OTHER_PROJECT }, 'iso-2', now, log);

    const res = await handleEvents({ query: async (q) => db.query(q) }, principal(),
      { project_id: PROJECT, since_seq: 0 }, 'agent', log);
    const projects = new Set((res.body as { events: { project_id: string }[] }).events.map((e) => e.project_id));
    assert.deepEqual([...projects], [PROJECT]);
  });
});

describe('dry run: the webhook end to end', () => {
  const SECRET = 'webhook-secret';
  const RAW = Buffer.from(JSON.stringify({
    ref: 'refs/heads/agent/backend/task_items_api',
    after: 'a3f9c1e0',
    repository: { full_name: 'acme/inventory' },
    sender: { login: 'bea' },
  }), 'utf8');

  function webhookPort(db: FakeDataStore, log: CapturingLogger): WebhookPort {
    const port = appendPort(db);
    return {
      findProjectForRepo: async (repo) => (repo === 'acme/inventory' ? { project_id: PROJECT } : null),
      secretFor: async () => SECRET,
      appendEvent: async (project_id, event, idempotency_key) => {
        const e = event as { kind: string; body: Record<string, unknown> };
        await handleAppend(port, principal({ agent_id: 'github' }),
          { project_id, kind: e.kind, body: e.body }, idempotency_key, now, log);
      },
    };
  }

  function req(raw: Buffer, sig: string, delivery = 'delivery-1') {
    return {
      method: 'POST', path: '/github/webhook', raw,
      headers: {
        'x-hub-signature-256': sig,
        'x-github-event': 'push',
        'x-github-delivery': delivery,
      },
    };
  }

  test('a signed push lands one event on the board', async () => {
    const { db, log } = build();
    const res = await handleWebhook(webhookPort(db, log), req(RAW, signGithubBody(RAW, SECRET)), log);
    assert.equal(res.status, 202);
    assert.equal(db.rowCount('events'), 1);
    assert.equal(db.allRows('events')[0].kind, 'branch_pushed');
  });

  test('D4: a replayed delivery appends nothing the second time', async () => {
    const { db, log } = build();
    const port = webhookPort(db, log);
    const sig = signGithubBody(RAW, SECRET);
    await handleWebhook(port, req(RAW, sig), log);
    await handleWebhook(port, req(RAW, sig), log);
    assert.equal(db.rowCount('events'), 1, 'GitHub retries with the same delivery id');
  });

  test('D2: a tampered body writes nothing and returns 401', async () => {
    const { db, log } = build();
    const sig = signGithubBody(RAW, SECRET);
    const tampered = Buffer.from(RAW.toString('utf8').replace('a3f9c1e0', 'deadbeef'));
    const res = await handleWebhook(webhookPort(db, log), req(tampered, sig), log);
    assert.equal(res.status, 401);
    assert.equal(db.rowCount('events'), 0);
  });

  test('D6: an unknown repo is dropped with 204 and writes nothing', async () => {
    const { db, log } = build();
    const raw = Buffer.from(JSON.stringify({
      ref: 'refs/heads/agent/backend/task_items_api', after: 'x',
      repository: { full_name: 'someone/else' }, sender: { login: 'x' },
    }), 'utf8');
    const res = await handleWebhook(webhookPort(db, log), req(raw, signGithubBody(raw, SECRET)), log);
    assert.equal(res.status, 204);
    assert.equal(db.rowCount('events'), 0);
    assert.ok(log.has('webhook.unmapped_repo'), 'a drop must be logged, never silent');
  });

  test('the mapped event is the one that actually reaches the ledger', async () => {
    const { db, log } = build();
    await handleWebhook(webhookPort(db, log), req(RAW, signGithubBody(RAW, SECRET)), log);
    const stored = JSON.parse(String(db.allRows('events')[0].body));
    const mapped = mapGithubEvent({ event: 'push', payload: JSON.parse(RAW.toString('utf8')) });
    assert.ok(mapped.ok);
    assert.deepEqual(stored, mapped.event.body);
    assert.equal(db.allRows('request_dedupe')[0].idempotency_key, deliveryIdempotencyKey('delivery-1'));
  });
});
