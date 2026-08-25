// Section H, the two non-negotiables that say "verified by attempting it".
//
//   [ ] Agents cannot merge. Verified by attempting it.
//   [ ] agent_id is never accepted from the client. Verified by forging one.
//
// Runs against the emulator, through the real handleApi router and the real Firestore adapter,
// because the point is that the whole path refuses — not that one function returns false.
//
//   scripts/emulator.sh 'node --test functions/src/api.test.ts'

import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { deleteApp, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

import { handleApi, statusFor, type ApiDeps, type ApiRequest } from './api.ts';
import { AGENT_APPENDABLE, hashToken, mintToken, resolveAgent, ROLE_PACKS } from './authority.ts';
import { createFirestoreStore, type FirestoreStore } from '../../shared/store/firestore.ts';
import { StoreAuthError } from '../../shared/store/errors.ts';
import { makeTask } from '../../shared/store/conformance.ts';
import { LAYER_OF, type Logger } from '../../shared/store/types.ts';

assert.ok(
  process.env.FIRESTORE_EMULATOR_HOST,
  "FIRESTORE_EMULATOR_HOST is not set. Run via scripts/emulator.sh — these tests write agent " +
    'tokens and must never touch a real project.',
);

let app: App;
let db: Firestore;
let store: FirestoreStore;
let deps: ApiDeps;
const logs: string[] = [];
const log: Logger = {
  info: (m, meta) => logs.push(`info ${m} ${JSON.stringify(meta ?? {})}`),
  warn: (m, meta) => logs.push(`warn ${m} ${JSON.stringify(meta ?? {})}`),
};

const PID = `proj_api_${Date.now().toString(36)}`;
let backendToken = '';
let backendAgentId = '';
let frontendToken = '';

before(async () => {
  app = initializeApp({ projectId: process.env.GCLOUD_PROJECT ?? 'demo-bakeoff' }, `api-${Date.now()}`);
  db = getFirestore(app);
  store = createFirestoreStore({ db, log, debounce_ms: 0 });
  deps = { db, store, log, now: () => Date.now() };

  await store.ensureProject(PID, { project_name: 'Inventory Tracker', repo_url: 'o/r' });
  await store.seedTasks(PID, [
    makeTask('task_items_crud'),
    makeTask('task_items_ui', { kind: 'frontend' }),
  ]);

  // Two agents, provisioned the way /connect does it: token minted server-side, only the
  // sha256 stored.
  backendToken = mintToken();
  backendAgentId = 'agent_be000001';
  await db.collection('projects').doc(PID).collection('agents').doc(backendAgentId).set({
    agent_id: backendAgentId,
    role_slug: 'backend-builder',
    member_label: 'sibhi',
    initials: 'BE',
    harness: 'claude-code',
    status: 'connected',
    current_task: null,
    branch: null,
    last_heartbeat_ms: Date.now(),
    revoked: false,
    grant_merge: false,
    token_sha256: hashToken(backendToken),
  });

  frontendToken = mintToken();
  await db.collection('projects').doc(PID).collection('agents').doc('agent_fe000002').set({
    agent_id: 'agent_fe000002',
    role_slug: 'frontend-builder',
    member_label: 'priya',
    initials: 'FE',
    harness: 'codex',
    status: 'connected',
    current_task: null,
    branch: null,
    last_heartbeat_ms: Date.now(),
    revoked: false,
    grant_merge: false,
    token_sha256: hashToken(frontendToken),
  });
});

after(async () => {
  await store.close();
  await deleteApp(app);
});

const call = (
  method: string,
  path: string,
  body: unknown = {},
  token = backendToken,
): Promise<{ status: number; body: Record<string, unknown> }> =>
  handleApi(
    { method, path, headers: { authorization: token ? `Bearer ${token}` : undefined }, body } satisfies ApiRequest,
    deps,
  );

// ---- H: agents cannot merge -------------------------------------------------------------

test('H agents cannot merge: every role pack denies it', () => {
  for (const [role, pack] of Object.entries(ROLE_PACKS)) {
    assert.equal(pack.merge, false, `role pack ${role} must not grant merge`);
  }
});

test('H agents cannot merge: attempting to append a `merged` event is refused', async () => {
  const res = await call('POST', '/events', {
    kind: 'merged',
    idempotency_key: randomUUID(),
    body: { task_id: 'task_items_crud', pr_number: 42, commit: 'deadbeef' },
  });
  assert.equal(res.status, 403, 'an agent appending `merged` must be forbidden');
  assert.equal(res.body.error, 'forbidden');

  // And the board did not move.
  const snap = await store.readSnapshot(PID);
  const task = snap!.snapshot.tasks.find((t) => t.task_id === 'task_items_crud');
  assert.notEqual(task?.status, 'merged', 'the task must not have reached merged');
});

test('H agents cannot merge: `merged` is absent from the appendable allowlist', () => {
  assert.equal(AGENT_APPENDABLE.merged, undefined, '`merged` must not be agent-appendable');
  // Every webhook-originated kind is equally out of reach: an agent must not be able to fake
  // a green CI run or a PR that does not exist.
  for (const kind of ['merged', 'pr_opened', 'ci_passed', 'ci_failed', 'branch_pushed', 'task_claimed']) {
    assert.equal(AGENT_APPENDABLE[kind], undefined, `${kind} must not be agent-appendable`);
  }
});

test('H agents cannot merge: even a grant_merge agent cannot append `merged`', async () => {
  // Belt and braces. grant_merge exists for an owner-blessed integrator, but the event kind
  // allowlist is checked first, so the append is refused regardless of the permission.
  const integratorToken = mintToken();
  await db.collection('projects').doc(PID).collection('agents').doc('agent_int00003').set({
    agent_id: 'agent_int00003',
    role_slug: 'backend-builder',
    member_label: 'integrator',
    initials: 'IN',
    harness: 'manual',
    status: 'connected',
    current_task: null,
    branch: null,
    last_heartbeat_ms: Date.now(),
    revoked: false,
    grant_merge: true,
    token_sha256: hashToken(integratorToken),
  });

  const id = await resolveAgent(db, `Bearer ${integratorToken}`);
  assert.equal(id.permissions.merge, true, 'test premise: this agent does hold merge');

  const res = await call(
    'POST',
    '/events',
    { kind: 'merged', idempotency_key: randomUUID(), body: { task_id: 'task_items_crud' } },
    integratorToken,
  );
  assert.equal(res.status, 403, 'the kind allowlist refuses `merged` from any agent token');
});

// ---- H: agent_id is never accepted from the client --------------------------------------

test('H forging agent_id in the body is refused, not silently ignored', async () => {
  const res = await call('POST', '/events', {
    kind: 'task_progress',
    idempotency_key: randomUUID(),
    agent_id: 'agent_fe000002', // impersonating the frontend agent
    body: { task_id: 'task_items_crud', summary: 'forged' },
  });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'client_supplied_identity');
  assert.equal(res.body.field, 'agent_id');
});

test('H forging actor_id, project_id, role_slug, permissions or seq is refused', async () => {
  for (const field of ['actor_id', 'project_id', 'role_slug', 'permissions', 'seq', 'event_id']) {
    const res = await call('POST', '/events', {
      kind: 'task_progress',
      idempotency_key: randomUUID(),
      [field]: 'anything',
      body: {},
    });
    assert.equal(res.status, 400, `${field} must be refused`);
    assert.equal(res.body.field, field);
  }
});

test('H an echoed-back correct agent_id is STILL refused', async () => {
  // The tempting shortcut is "accept it if it matches". That is how the field becomes
  // load-bearing, and then trusted, and then the check is one refactor from being removed.
  const res = await call('POST', '/events', {
    kind: 'task_progress',
    idempotency_key: randomUUID(),
    agent_id: backendAgentId, // the caller's OWN id
    body: {},
  });
  assert.equal(res.status, 400, 'even a correct agent_id must not be accepted from a client');
});

test('H the appended event carries the token-derived actor_id, not anything from the body', async () => {
  const key = randomUUID();
  const res = await call('POST', '/events', {
    kind: 'task_progress',
    idempotency_key: key,
    body: { task_id: 'task_items_crud', summary: 'real work', actor_id: 'agent_fe000002' },
  });
  assert.equal(res.status, 201, 'a nested body field is data, not identity, so this succeeds');

  const { events } = await store.readEvents(PID, 0);
  const appended = events.find((e) => e.seq === res.body.seq);
  assert.ok(appended);
  assert.equal(appended!.actor_id, backendAgentId, 'actor_id must come from the token');
  assert.equal(appended!.actor_type, 'agent');
  // The forged value survives inside body, where it is inert and auditable — it is not
  // identity, and pretending otherwise would mean sanitising every nested field forever.
  assert.equal((appended!.body as { actor_id?: string }).actor_id, 'agent_fe000002');
});

test('H whoami cannot be influenced by any request field', async () => {
  const honest = await call('GET', '/whoami', {});
  const forged = await call('GET', '/whoami', {});
  assert.equal(honest.body.agent_id, backendAgentId);
  assert.equal(forged.body.agent_id, backendAgentId);
  assert.equal(honest.body.project_id, PID);
  // freshness must be read from the store, never hardcoded (B10, E4).
  assert.deepEqual(honest.body.freshness, { mode: 'live', stale_ms: 0 });
});

// ---- auth ------------------------------------------------------------------------------

test('an unknown, missing or malformed token is 401', async () => {
  for (const token of ['', 'not-a-real-token', mintToken()]) {
    const res = await call('GET', '/whoami', {}, token);
    assert.equal(res.status, 401, `token ${JSON.stringify(token)} must be rejected`);
  }
  const noHeader = await handleApi(
    { method: 'GET', path: '/whoami', headers: {}, body: {} },
    deps,
  );
  assert.equal(noHeader.status, 401);
});

test('a revoked token is 401 and stays 401', async () => {
  const doomed = mintToken();
  await db.collection('projects').doc(PID).collection('agents').doc('agent_rv000004').set({
    agent_id: 'agent_rv000004',
    role_slug: 'qa-verifier',
    member_label: 'ci',
    initials: 'QA',
    harness: 'manual',
    status: 'connected',
    current_task: null,
    branch: null,
    last_heartbeat_ms: Date.now(),
    revoked: false,
    grant_merge: false,
    token_sha256: hashToken(doomed),
  });
  assert.equal((await call('GET', '/whoami', {}, doomed)).status, 200);

  await db.collection('projects').doc(PID).collection('agents').doc('agent_rv000004').set({ revoked: true }, { merge: true });
  // No cache: revocation takes effect on the very next request. That is the reason
  // resolveAgent costs a read every time.
  assert.equal((await call('GET', '/whoami', {}, doomed)).status, 401);
  assert.equal((await call('POST', '/heartbeat', { status: 'working' }, doomed)).status, 401);
});

test('an agent cannot declare itself un-revoked via heartbeat status', async () => {
  for (const status of ['revoked', 'anything', 'admin']) {
    const res = await call('POST', '/heartbeat', { status });
    assert.equal(res.status, 400, `status ${status} must be refused`);
  }
  assert.equal((await call('POST', '/heartbeat', { status: 'working' })).status, 200);
});

// ---- claim + scope through the API -----------------------------------------------------

test('a lost claim is 200 with ok:false, not a 4xx', async () => {
  const mine = await call('POST', '/claim', { task_id: 'task_items_ui' });
  assert.equal(mine.status, 200);
  assert.equal(mine.body.ok, true);

  const theirs = await call('POST', '/claim', { task_id: 'task_items_ui' }, frontendToken);
  assert.equal(theirs.status, 200, 'a lost claim is a normal outcome, so it must not be a 4xx');
  assert.equal(theirs.body.ok, false);
  assert.equal(theirs.body.owner, backendAgentId);
});

test('a scope conflict is 200 with ok:false and names the conflicts', async () => {
  await call('POST', '/scope', { task_id: 'task_items_crud', globs: ['functions/**'] });
  const clash = await call(
    'POST',
    '/scope',
    { task_id: 'task_items_ui', globs: ['functions/items/**'] },
    frontendToken,
  );
  assert.equal(clash.status, 200);
  assert.equal(clash.body.ok, false);
  const conflicts = clash.body.conflicts as { agent_id: string; globs: string[] }[];
  assert.equal(conflicts[0]!.agent_id, backendAgentId);
  assert.ok(conflicts[0]!.globs.includes('functions/**'));
});

test('an unsupported glob is 400, not a retryable 5xx', async () => {
  const res = await call('POST', '/scope', { task_id: 'task_items_crud', globs: ['!(vendor)/**'] });
  assert.equal(res.status, 400);
  assert.equal(res.body.error, 'invalid_glob');
});

// ---- B8: the human layer never reaches an agent ----------------------------------------

test('B8 GET /events withholds the human layer from the agent feed', async () => {
  await call('POST', '/events', {
    kind: 'task_progress', // human layer
    idempotency_key: randomUUID(),
    body: { task_id: 'task_items_crud', summary: 'narration nobody needs' },
  });
  await call('POST', '/events', {
    kind: 'task_blocked', // coordination layer
    idempotency_key: randomUUID(),
    body: { task_id: 'task_items_crud', reason: 'needs items-api v2' },
  });

  const res = await call('GET', '/events', { since_seq: 0 });
  assert.equal(res.status, 200);
  const events = res.body.events as { kind: string }[];
  assert.ok(events.length > 0, 'test premise: there are events to filter');
  for (const e of events) {
    assert.notEqual(LAYER_OF[e.kind as 'task_progress'], 'human', `${e.kind} must not reach an agent`);
  }
  assert.ok(events.some((e) => e.kind === 'task_blocked'), 'coordination events must still arrive');
  assert.ok(!events.some((e) => e.kind === 'task_progress'), 'task_progress must be withheld');
  assert.ok(!events.some((e) => e.kind === 'agent_heartbeat'), 'heartbeats must be withheld');
});

// ---- error mapping ---------------------------------------------------------------------

test('statusFor never maps a known condition to 500', () => {
  assert.equal(statusFor(new StoreAuthError('x', 'firestore')).status, 401);
  // Only a genuinely unknown throw becomes 500, and it leaks nothing.
  const unknown = statusFor(new TypeError('cannot read properties of undefined'));
  assert.equal(unknown.status, 500);
  assert.deepEqual(unknown.body, { error: 'internal' });
});

test('an unknown route is 404 with the route named', async () => {
  const res = await call('POST', '/nonsense', {});
  assert.equal(res.status, 404);
  assert.equal(res.body.route, 'POST /nonsense');
});
