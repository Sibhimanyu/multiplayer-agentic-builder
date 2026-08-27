// Reaper behaviour, offline, against a fake store.
//
// The interesting cases are all the ones where reaping would be WRONG, because
// a reaper that is too eager steals a live agent's task -- which is worse than
// a task that stays claimed slightly too long.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FakeClock } from '../shared/clock.ts';
import { CapturingLogger } from '../shared/log.ts';
import { CLAIM_TIMEOUT_MS } from '../shared/store/types.ts';
import type { AgentPresence } from '../shared/store/types.ts';
import { reapStaleClaims } from './reaper.ts';
import type { ReaperDeps } from './reaper.ts';

const PROJECT = 'proj_inventory';

function presence(agent_id: string, last_heartbeat_at: string | null): AgentPresence {
  return {
    agent_id, role_slug: 'backend', member_label: 'Bea', initials: 'BB',
    harness: 'claude-code', status: 'working', current_task: null, branch: null,
    last_heartbeat_at, stale: false,
  };
}

function deps(over: {
  agents: AgentPresence[];
  claims: { task_id: string; agent_id: string; sha: string }[];
  clock: FakeClock;
  log: CapturingLogger;
  release?: (task_id: string, sha: string) => Promise<boolean>;
  appended?: { key: string; body: Record<string, unknown> }[];
}): ReaperDeps {
  const appended = over.appended ?? [];
  return {
    project_id: PROJECT,
    clock: over.clock,
    log: over.log,
    store: {
      listPresence: async () => over.agents,
      listClaims: async () => over.claims,
      forceReleaseClaim: async (_p: string, t: string, sha: string) =>
        (over.release ? over.release(t, sha) : true),
      appendEvent: async (
        _p: string, e: { body: Record<string, unknown> }, key: string,
      ) => {
        appended.push({ key, body: e.body });
        return { event_id: 'e', seq: appended.length, duplicate: false };
      },
    } as unknown as ReaperDeps['store'],
  };
}

test('a claim whose owner went stale past the timeout is released', async () => {
  const clock = new FakeClock();
  const log = new CapturingLogger();
  const appended: { key: string; body: Record<string, unknown> }[] = [];
  const stale = new Date(clock.now() - CLAIM_TIMEOUT_MS - 60_000).toISOString();

  const res = await reapStaleClaims(deps({
    agents: [presence('agent_dead', stale)],
    claims: [{ task_id: 'task_a', agent_id: 'agent_dead', sha: 'a'.repeat(40) }],
    clock, log, appended,
  }));

  assert.equal(res.reaped.length, 1);
  assert.equal(res.reaped[0]!.task_id, 'task_a');
  assert.equal(res.reaped[0]!.agent_id, 'agent_dead');
  assert.ok(res.reaped[0]!.stale_for_ms > CLAIM_TIMEOUT_MS);
  assert.equal(log.withCode('reaper.reaped').length, 1);

  // The announcement matters: a waiting agent learns the task is free without
  // polling the claim namespace itself.
  assert.equal(appended.length, 1);
  assert.equal(appended[0]!.body.task_id, 'task_a');
  assert.equal(appended[0]!.body.was_blocked_by, 'agent_dead');
});

test('a LIVE agent keeps its claim', async () => {
  const clock = new FakeClock();
  const log = new CapturingLogger();
  const fresh = new Date(clock.now() - 30_000).toISOString();

  const res = await reapStaleClaims(deps({
    agents: [presence('agent_alive', fresh)],
    claims: [{ task_id: 'task_a', agent_id: 'agent_alive', sha: 'a'.repeat(40) }],
    clock, log,
  }));

  assert.equal(res.reaped.length, 0, 'reaping a live agent is worse than a slow release');
  assert.equal(res.checked, 1);
});

test('exactly at the timeout is NOT yet stale', async () => {
  // Boundary, because "> timeout" and ">= timeout" differ by one agent's task
  // and only one of them matches "stale BEYOND claim_timeout".
  const clock = new FakeClock();
  const log = new CapturingLogger();
  const at = new Date(clock.now() - CLAIM_TIMEOUT_MS).toISOString();

  const res = await reapStaleClaims(deps({
    agents: [presence('agent_edge', at)],
    claims: [{ task_id: 'task_a', agent_id: 'agent_edge', sha: 'a'.repeat(40) }],
    clock, log,
  }));
  assert.equal(res.reaped.length, 0);
});

test('an agent with NO heartbeat yet is not reaped', async () => {
  // Deliberately the opposite default from presence, where absent means stale.
  // Here the dangerous mistake is stealing a claim from an agent that has just
  // started and not yet beaten, so absent-but-unknown means "not reapable".
  const clock = new FakeClock();
  const log = new CapturingLogger();

  const res = await reapStaleClaims(deps({
    agents: [presence('agent_new', null)],
    claims: [{ task_id: 'task_a', agent_id: 'agent_new', sha: 'a'.repeat(40) }],
    clock, log,
  }));

  assert.equal(res.reaped.length, 0);
  assert.equal(log.withCode('reaper.skipped').length, 1, 'and it says so rather than going quiet');
});

test('an owner who re-claims mid-reap keeps the task', async () => {
  // The race the pinned lease exists to close: the reaper read sha A, the owner
  // came back and re-claimed (sha B), so the release must FAIL rather than
  // steal a claim that is now live again.
  const clock = new FakeClock();
  const log = new CapturingLogger();
  const stale = new Date(clock.now() - CLAIM_TIMEOUT_MS - 60_000).toISOString();
  const appended: { key: string; body: Record<string, unknown> }[] = [];

  const res = await reapStaleClaims(deps({
    agents: [presence('agent_back', stale)],
    claims: [{ task_id: 'task_a', agent_id: 'agent_back', sha: 'a'.repeat(40) }],
    clock, log, appended,
    release: async () => false, // the lease was rejected: the sha moved
  }));

  assert.equal(res.reaped.length, 0, 'a claim that moved must not be reaped');
  assert.deepEqual(res.contested, ['task_a']);
  assert.equal(appended.length, 0, 'and nothing may be announced that did not happen');
  assert.equal(log.withCode('reaper.contested').length, 1);
});

test('a read failure reaps NOTHING and says so in the result, not only the log', async () => {
  // Order 0019: a failure that exists only in an unreadable log is a failure
  // nobody can diagnose. And "could not read" must never be treated as "no
  // claims are stale" -- unverifiable is not true.
  const clock = new FakeClock();
  const log = new CapturingLogger();
  const d = deps({ agents: [], claims: [], clock, log });
  d.store.listPresence = async () => { throw new Error('github unreachable'); };

  const res = await reapStaleClaims(d);
  assert.equal(res.reaped.length, 0);
  assert.equal(res.checked, 0);
  assert.match(res.error ?? '', /unreachable/);
  assert.equal(log.withCode('reaper.readFailed').length, 1);
});

test('a failed announcement does not un-release the claim', async () => {
  // The claim IS released -- that is the part that matters. A missing
  // announcement is recoverable from the next snapshot read; a held claim is
  // not.
  const clock = new FakeClock();
  const log = new CapturingLogger();
  const stale = new Date(clock.now() - CLAIM_TIMEOUT_MS - 60_000).toISOString();
  const d = deps({
    agents: [presence('agent_dead', stale)],
    claims: [{ task_id: 'task_a', agent_id: 'agent_dead', sha: 'a'.repeat(40) }],
    clock, log,
  });
  d.store.appendEvent = (async () => { throw new Error('ledger busy'); }) as never;

  const res = await reapStaleClaims(d);
  assert.equal(res.reaped.length, 1, 'the release stands even though the announcement failed');
  assert.equal(log.withCode('reaper.announceFailed').length, 1);
});

test('several stale claims are all reaped, and live ones in the same pass are not', async () => {
  const clock = new FakeClock();
  const log = new CapturingLogger();
  const stale = new Date(clock.now() - CLAIM_TIMEOUT_MS - 60_000).toISOString();
  const fresh = new Date(clock.now() - 5_000).toISOString();

  const res = await reapStaleClaims(deps({
    agents: [presence('agent_dead', stale), presence('agent_alive', fresh)],
    claims: [
      { task_id: 'task_a', agent_id: 'agent_dead', sha: 'a'.repeat(40) },
      { task_id: 'task_b', agent_id: 'agent_alive', sha: 'b'.repeat(40) },
      { task_id: 'task_c', agent_id: 'agent_dead', sha: 'c'.repeat(40) },
    ],
    clock, log,
  }));

  assert.deepEqual(res.reaped.map((r) => r.task_id).sort(), ['task_a', 'task_c']);
  assert.equal(res.checked, 3);
});
