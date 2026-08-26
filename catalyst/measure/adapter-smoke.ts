// Adapter smoke check against the real backend.
//
// THIS IS NOT A CONFORMANCE RUN AND MUST NOT BE REPORTED AS ONE. The suite is
// `shared/store/conformance.ts`, it is run once against a real backend per order
// 0005, and it is blocked on the Stratus gate because A10, A11 and A13 need
// `subscribe` and `readSnapshot`.
//
// What this exercises is narrower and, until now, untested: `catalyst/store/
// catalyst.ts` itself. The endpoints were verified with curl and the mapping was
// verified through an injected fetch, but the adapter had never run against the
// real service. Those are three different things, and the middle one passing says
// nothing about the third.
//
// Cost is deliberately ~12 requests. It does NOT run A2 (50 rounds x 20 claimants
// is 1,000 claims, about 20% of both the SELECT and INSERT monthly allowance) or
// A5 (~1,505 SELECTs). Those belong to the single full run.
//
// Usage: node catalyst/measure/adapter-smoke.ts

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { createCatalystStore, NotProvisionedError } from '../store/catalyst.ts';
import { stripUnstorable } from '../../shared/sanitize.ts';
import { CapturingLogger } from '../../shared/log.ts';

const BASE = process.env.COORDINATION_URL
  ?? 'https://multiplayer-agents-60083782173.development.catalystserverless.in/server/coordination';
const PROJECT = 'proj_inventory';
const AGENT = 'agent_be01';

function token(): string {
  if (process.env.CATALYST_AGENT_TOKEN) return process.env.CATALYST_AGENT_TOKEN;
  const env = readFileSync(new URL('../../.context/measure.env', import.meta.url), 'utf8');
  const m = /^CATALYST_AGENT_TOKEN=(.+)$/m.exec(env);
  if (!m) throw new Error('no agent token available');
  return m[1].trim();
}

interface Check { name: string; shape: string; ok: boolean; detail: string }
const checks: Check[] = [];

function record(name: string, shape: string, ok: boolean, detail: string): void {
  checks.push({ name, shape, ok, detail });
  process.stdout.write(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(46)} ${detail}\n`);
}

async function main(): Promise<number> {
  const log = new CapturingLogger();
  const store = createCatalystStore({ base_url: BASE, token: token(), log });
  const stamp = Date.now().toString(36);
  let requests = 0;
  const count = <T>(p: Promise<T>): Promise<T> => { requests += 1; return p; };

  // --- append, and a replay of the same key (A1's shape)
  const key = randomUUID();
  const event = {
    layer: 'coordination' as const, kind: 'task_claimed' as const,
    actor_type: 'agent' as const, actor_id: AGENT,
    body: { task_id: `task_smoke_${stamp}`, role_slug: 'backend' },
  };
  const first = await count(store.appendEvent(PROJECT, event, key));
  const replay = await count(store.appendEvent(PROJECT, event, key));
  record('append returns a seq', 'A1', typeof first.seq === 'number' && first.seq > 0, `seq=${first.seq}`);
  record('replay returns the ORIGINAL seq', 'A1',
    replay.duplicate === true && replay.seq === first.seq,
    `duplicate=${replay.duplicate} seq=${replay.seq}`);

  // --- human-layer events are WITHHELD from an agent read
  //
  // This check exists because the first version of this script got it wrong: it
  // appended a task_progress event and read it back expecting to see it. The read
  // returned nothing, which was the filter working correctly. The protocol calls
  // that exclusion its most important rule, so it is now asserted rather than
  // tripped over.
  const humanKey = randomUUID();
  const human = await count(store.appendEvent(PROJECT, {
    layer: 'human' as const, kind: 'task_progress' as const,
    actor_type: 'agent' as const, actor_id: AGENT,
    body: { task_id: `task_smoke_${stamp}`, summary: 'progress nobody should receive' },
  }, humanKey));
  const humanRead = await count(store.readEvents(PROJECT, human.seq - 1, 5));
  record('human-layer event withheld from an agent', 'protocol',
    humanRead.events.every((e) => e.layer !== 'human'),
    `${humanRead.events.length} events returned, none human-layer`);

  // --- emoji stripped on a durable write (A12's shape)
  //
  // Uses a COORDINATION-layer kind, because an agent read never returns
  // human-layer events and the assertion needs to read its own write back.
  const dirty = 'blocked on the contract 🚀 waiting ✔';
  const emojiKey = randomUUID();
  const appended = await count(store.appendEvent(PROJECT, {
    layer: 'coordination' as const, kind: 'task_blocked' as const,
    actor_type: 'agent' as const, actor_id: AGENT,
    body: { task_id: `task_smoke_${stamp}`, reason: dirty, blocked_by_task_id: null },
  }, emojiKey));
  const page = await count(store.readEvents(PROJECT, appended.seq - 1, 1));
  const stored = String((page.events[0]?.body as { reason?: unknown })?.reason ?? '');
  record('emoji stripped before the write', 'A12',
    stored === stripUnstorable(dirty).value && stored !== '' && !stored.includes('?'),
    JSON.stringify(stored));

  // --- readEvents ascending (A4's shape)
  const all = await count(store.readEvents(PROJECT, 0, 50));
  let ascending = true;
  for (let i = 1; i < all.events.length; i += 1) {
    if (all.events[i].seq <= all.events[i - 1].seq) ascending = false;
  }
  record('readEvents is strictly ascending by seq', 'A4', ascending,
    `${all.events.length} events, has_more=${all.has_more}`);

  // --- claim, lose, release, reclaim (A3's shape + F12's mechanism)
  const task = `task_smoke_claim_${stamp}`;
  const won = await count(store.claimTask(PROJECT, task, AGENT));
  const lost = await count(store.claimTask(PROJECT, task, AGENT));
  record('first claim wins', 'A3', won.ok === true, JSON.stringify(won));
  // Re-claiming as the SAME agent is a no-op that succeeds; the loss path is
  // covered by the deployed handler and by the dry run with two agents.
  record('second claim is answered, not thrown', 'A3', typeof lost.ok === 'boolean', JSON.stringify(lost));

  await count(store.releaseTask(PROJECT, task, AGENT));
  const reclaimed = await count(store.claimTask(PROJECT, task, AGENT));
  record('reclaim after release succeeds', 'F12', reclaimed.ok === true, JSON.stringify(reclaimed));
  await count(store.releaseTask(PROJECT, task, AGENT));

  // --- scope
  const scope = await count(store.acquireScope(PROJECT, AGENT, task, [`functions/smoke_${stamp}/**`]));
  record('acquireScope grants a disjoint glob', 'A8', scope.ok === true, JSON.stringify(scope));
  await count(store.releaseScope(PROJECT, AGENT));

  // --- presence (A9's shape, without waiting 90s)
  await count(store.heartbeat(PROJECT, AGENT, 'working', task, 'agent/backend/smoke'));
  const presence = await count(store.listPresence(PROJECT));
  const me = presence.find((p) => p.agent_id === AGENT);
  record('heartbeat then presence is fresh', 'A9',
    me !== undefined && me.stale === false && me.status === 'working',
    me ? `status=${me.status} stale=${me.stale}` : 'agent absent');

  // --- the gated operations must REFUSE, not fake
  let snapshotRefused = false;
  try {
    await store.readSnapshot(PROJECT);
  } catch (err) {
    snapshotRefused = err instanceof NotProvisionedError;
  }
  record('readSnapshot refuses with NotProvisionedError', 'gate', snapshotRefused,
    'Stratus bucket not provisioned');

  let subscribeRefused = false;
  try {
    store.subscribe(PROJECT, 0, () => {});
  } catch (err) {
    subscribeRefused = err instanceof NotProvisionedError;
  }
  record('subscribe refuses with NotProvisionedError', 'gate', subscribeRefused,
    'Stratus bucket not provisioned');

  const failed = checks.filter((c) => !c.ok);
  process.stdout.write('\n');
  process.stdout.write(`ADAPTER SMOKE, NOT A CONFORMANCE RUN. ${checks.length - failed.length}/${checks.length} checks, ${requests} requests.\n`);
  process.stdout.write('Blocked and NOT covered here: A10, A11, A13 (need subscribe/readSnapshot),\n');
  process.stdout.write('A2 (1,000 claims) and A5 (~1,505 SELECTs) deferred to the single full run.\n');
  return failed.length === 0 ? 0 : 1;
}

process.exit(await main());
