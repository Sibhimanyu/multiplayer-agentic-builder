// Checklist section D. No emulator, no network: the webhook logic is pure.
//
//   node --test functions/src/webhook.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';

import {
  CHECK_SUITE_CONCLUSIONS,
  mapDelivery,
  repoKey,
  taskIdFromBranch,
  verifySignature,
} from './webhook.ts';
import { createMemoryStore } from '../../shared/store/memory.ts';

const SECRET = 'a-webhook-secret-that-is-long-enough';
const sign = (raw: Buffer | string, secret = SECRET) =>
  'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');

// ---- D1 -------------------------------------------------------------------------------

test('D1 a valid HMAC over the raw body verifies', () => {
  const raw = Buffer.from(JSON.stringify({ zen: 'Keep it logically awesome.' }), 'utf8');
  assert.deepEqual(verifySignature(raw, sign(raw), SECRET), { ok: true });
});

test('D1b verification is over raw bytes, so a re-serialised body fails', () => {
  // GitHub signs the bytes it sent. This is the whole reason index.ts must reach for
  // req.rawBody: key order and unicode escaping both survive the wire and not JSON.parse.
  const raw = Buffer.from('{"b":1,"a":2,"emoji":"\\ud83d\\ude80"}', 'utf8');
  const signature = sign(raw);
  const reserialised = Buffer.from(JSON.stringify(JSON.parse(raw.toString('utf8'))), 'utf8');

  assert.notEqual(raw.toString('utf8'), reserialised.toString('utf8'), 'test premise');
  assert.deepEqual(verifySignature(raw, signature, SECRET), { ok: true });
  assert.equal(
    verifySignature(reserialised, signature, SECRET).ok,
    false,
    'a re-serialised body must NOT verify — that is the bug this test exists to catch',
  );
});

// ---- D2 -------------------------------------------------------------------------------

test('D2 a tampered body is rejected', () => {
  const raw = Buffer.from(JSON.stringify({ action: 'closed', merged: false }), 'utf8');
  const signature = sign(raw);
  const tampered = Buffer.from(JSON.stringify({ action: 'closed', merged: true }), 'utf8');

  const res = verifySignature(tampered, signature, SECRET);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.reason, 'bad_signature');
});

test('D2b a missing or malformed signature header is rejected by reason, not by crash', () => {
  const raw = Buffer.from('{}', 'utf8');
  const missing = verifySignature(raw, undefined, SECRET);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.reason, 'missing_signature');

  // Short, long, wrong prefix, and non-hex all have to be handled without throwing —
  // timingSafeEqual throws on a length mismatch, so this is a real crash risk.
  for (const bad of ['sha256=', 'sha256=deadbeef', 'sha1=' + 'a'.repeat(40), 'garbage', '']) {
    const r = verifySignature(raw, bad, SECRET);
    assert.equal(r.ok, false, `must reject ${JSON.stringify(bad)}`);
  }
});

test('D2c a signature from the wrong secret is rejected', () => {
  const raw = Buffer.from('{"a":1}', 'utf8');
  assert.equal(verifySignature(raw, sign(raw, 'the-wrong-secret'), SECRET).ok, false);
});

// ---- D3 -------------------------------------------------------------------------------

test('D3 comparison is timing-safe: source contains no === on the digest', async () => {
  // Reviewing the code IS the evidence the checklist asks for, so assert on the source rather
  // than on timing, which is unmeasurably noisy in a test runner.
  const src = await import('node:fs/promises').then((fs) =>
    fs.readFile(new URL('./webhook.ts', import.meta.url), 'utf8'),
  );
  assert.ok(src.includes('timingSafeEqual'), 'must use crypto.timingSafeEqual');
  const verifyBody = src.slice(src.indexOf('export function verifySignature'), src.indexOf('/**\n * Recover a task id'));
  assert.ok(
    !/expected\s*===|===\s*expected|header\s*===|===\s*header/.test(verifyBody),
    'the digest must never be compared with === (found one in verifySignature)',
  );
});

test('D3b timing-safe comparison still returns false for a same-length near-miss', () => {
  const raw = Buffer.from('{"a":1}', 'utf8');
  const good = sign(raw);
  // Flip the last hex nibble: same length, one byte different.
  const near = good.slice(0, -1) + (good.at(-1) === '0' ? '1' : '0');
  assert.equal(near.length, good.length, 'test premise: same length');
  const r = verifySignature(raw, near, SECRET);
  assert.equal(r.ok, false);
  if (!r.ok) assert.equal(r.reason, 'bad_signature');
});

// ---- D4 -------------------------------------------------------------------------------

test('D4 a replayed X-GitHub-Delivery appends nothing the second time', async () => {
  const store = createMemoryStore();
  const pid = 'proj_inventory';
  store.createProject(pid, 'Inventory Tracker', 'example/inventory-tracker');
  store.addTask(pid, { task_id: 'task_items_crud', title: 'CRUD handlers', kind: 'backend' });

  const delivery_id = randomUUID();
  const payload = {
    ref: 'refs/heads/agent/backend/task-items-crud',
    after: 'a3f9c1e0d4b28f6712c9ab3e5580f1d2c7e46a9b',
    repository: { full_name: 'zoho-cat/inventory-tracker' },
  };

  const deliver = async () => {
    const m = mapDelivery('push', payload, { project_id: pid, delivery_id });
    assert.equal(m.kind, 'event');
    if (m.kind !== 'event') return null;
    return store.appendEvent(pid, m.event, m.idempotency_key);
  };

  const first = await deliver();
  const replay = await deliver();

  assert.equal(first?.duplicate, false);
  assert.equal(replay?.duplicate, true, 'the replay must be recognised as a duplicate');
  assert.equal(replay?.seq, first?.seq, 'and must return the original seq');

  const { events } = await store.readEvents(pid, 0);
  const pushes = events.filter((e) => e.kind === 'branch_pushed');
  assert.equal(pushes.length, 1, 'the ledger must contain exactly one branch_pushed');

  // Order 0009: correlate, do not count. "The count held at one" also passes if the replay
  // REPLACED the original with an identical-looking event, or if the surviving event belongs to
  // a different delivery. So assert this is the ORIGINAL, by identity and by content.
  assert.equal(pushes[0]!.seq, first!.seq, 'the surviving event is the one first appended');
  assert.equal(pushes[0]!.event_id, first!.event_id, 'same event_id, not a look-alike');
  assert.equal(pushes[0]!.body.commit, payload.after, 'and it still carries the original commit');
  assert.equal(pushes[0]!.body.branch, 'agent/backend/task-items-crud');
  assert.equal(pushes[0]!.actor_type, 'github');
});

// ---- D5 -------------------------------------------------------------------------------

const CTX = { project_id: 'proj_inventory', delivery_id: 'd-1' };
const BRANCH = 'agent/backend/task-items-crud';

test('D5.1 push -> branch_pushed', () => {
  const m = mapDelivery('push', { ref: `refs/heads/${BRANCH}`, after: 'abc123' }, CTX);
  assert.equal(m.kind, 'event');
  if (m.kind !== 'event') return;
  assert.equal(m.event.kind, 'branch_pushed');
  assert.equal(m.event.layer, 'coordination');
  assert.equal(m.event.actor_type, 'github');
  assert.deepEqual(m.event.body, { branch: BRANCH, commit: 'abc123', task_id: 'task_items_crud' });
});

test('D5.2 pull_request opened -> pr_opened', () => {
  const m = mapDelivery(
    'pull_request',
    {
      action: 'opened',
      pull_request: { number: 42, html_url: 'https://github.com/o/r/pull/42', head: { ref: BRANCH } },
    },
    CTX,
  );
  assert.equal(m.kind, 'event');
  if (m.kind !== 'event') return;
  assert.equal(m.event.kind, 'pr_opened');
  assert.equal(m.event.body.pr_number, 42);
  assert.equal(m.event.body.task_id, 'task_items_crud');
});

test('D5.3 pull_request synchronize -> branch_pushed, not pr_opened', () => {
  const m = mapDelivery(
    'pull_request',
    { action: 'synchronize', pull_request: { number: 42, head: { ref: BRANCH } } },
    CTX,
  );
  assert.equal(m.kind, 'event');
  if (m.kind !== 'event') return;
  assert.equal(
    m.event.kind,
    'branch_pushed',
    'synchronize is new commits; mapping it to pr_opened would reset the CI badge every push',
  );
});

test('D5.4 pull_request closed+merged -> merged; closed unmerged -> dropped with a reason', () => {
  const merged = mapDelivery(
    'pull_request',
    {
      action: 'closed',
      pull_request: { number: 42, merged: true, merge_commit_sha: 'ff00', head: { ref: BRANCH } },
    },
    CTX,
  );
  assert.equal(merged.kind, 'event');
  if (merged.kind === 'event') {
    assert.equal(merged.event.kind, 'merged');
    assert.equal(merged.event.body.commit, 'ff00');
  }

  const abandoned = mapDelivery(
    'pull_request',
    { action: 'closed', pull_request: { number: 43, merged: false, head: { ref: BRANCH } } },
    CTX,
  );
  assert.equal(abandoned.kind, 'drop');
  if (abandoned.kind === 'drop') assert.match(abandoned.reason, /closed unmerged/);
});

test('D5a check_suite conclusion mapping is EXACTLY the normative table', () => {
  // Ruled by Order 0010 and pinned in acceptance-checklist.md. Both builds must implement this
  // exactly; a divergence here is worse than a missing badge because it is far harder to notice.
  //
  // Driven off CHECK_SUITE_CONCLUSIONS so it is exhaustive over what GitHub can send rather
  // than a sample -- if a conclusion is added to the list and not to the table, this fails.
  const EXPECTED: Record<string, 'ci_passed' | 'ci_failed' | 'drop'> = {
    success: 'ci_passed',
    failure: 'ci_failed',
    // Conclusive terminal failure, not inconclusive. GitHub renders it with a red X, and
    // dropping it leaves the board silent while the agent believes CI is still pending.
    timed_out: 'ci_failed',
    neutral: 'drop',
    cancelled: 'drop',
    skipped: 'drop',
    stale: 'drop',
    action_required: 'drop',
    null: 'drop',
  };

  assert.equal(
    CHECK_SUITE_CONCLUSIONS.length,
    Object.keys(EXPECTED).length,
    'the table must cover every conclusion the mapper knows about',
  );

  for (const conclusion of CHECK_SUITE_CONCLUSIONS) {
    const want = EXPECTED[String(conclusion)];
    assert.ok(want, `no expectation declared for conclusion ${String(conclusion)}`);

    const m = mapDelivery(
      'check_suite',
      {
        action: 'completed',
        check_suite: {
          conclusion,
          head_branch: BRANCH,
          app: { name: 'GitHub Actions' },
          pull_requests: [{ number: 42 }],
        },
      },
      CTX,
    );

    if (want === 'drop') {
      assert.equal(m.kind, 'drop', `${String(conclusion)} must drop`);
      if (m.kind === 'drop') assert.ok(m.reason.length > 0, 'a drop must carry a reason');
    } else {
      assert.equal(m.kind, 'event', `${String(conclusion)} must map to ${want}`);
      if (m.kind === 'event') {
        assert.equal(m.event.kind, want, `${String(conclusion)} -> ${want}`);
        // Correlation, not just count (Order 0009): the event must carry the right task and
        // check, not merely be of the right kind.
        assert.equal(m.event.body.task_id, 'task_items_crud');
        assert.equal(m.event.body.pr_number, 42);
        assert.equal(m.event.body.check_name, 'GitHub Actions');
        assert.equal(m.event.actor_type, 'github');
        assert.equal(m.event.layer, 'coordination');
      }
    }
  }
});

test('D5a timed_out is NOT dropped — this was the ruled correction', () => {
  // Called out separately because it is the one line Order 0010 reversed, and a regression here
  // would be silent: the board simply stays quiet on a CI timeout.
  const m = mapDelivery(
    'check_suite',
    { action: 'completed', check_suite: { conclusion: 'timed_out', head_branch: BRANCH } },
    CTX,
  );
  assert.equal(m.kind, 'event');
  if (m.kind === 'event') assert.equal(m.event.kind, 'ci_failed');
});

test('D5b pull_request closed maps to merged ONLY on strict merged === true', () => {
  // Four assertions: true, false, undefined, null. A truthy check would let an absent field
  // read as unmerged-but-present, and a loose check would mark an abandoned PR merged --
  // which, in an append-only ledger, cannot be corrected afterwards.
  const cases: { merged: unknown; expect: 'merged' | 'drop' }[] = [
    { merged: true, expect: 'merged' },
    { merged: false, expect: 'drop' },
    { merged: undefined, expect: 'drop' },
    { merged: null, expect: 'drop' },
  ];

  for (const { merged, expect } of cases) {
    const m = mapDelivery(
      'pull_request',
      {
        action: 'closed',
        pull_request: { number: 42, merged, merge_commit_sha: 'ff00', head: { ref: BRANCH } },
      },
      CTX,
    );
    if (expect === 'drop') {
      assert.equal(m.kind, 'drop', `merged=${String(merged)} must drop`);
      if (m.kind === 'drop') assert.match(m.reason, /closed unmerged/);
    } else {
      assert.equal(m.kind, 'event', `merged=${String(merged)} must map`);
      if (m.kind === 'event') {
        assert.equal(m.event.kind, 'merged');
        assert.equal(m.event.body.task_id, 'task_items_crud');
        assert.equal(m.event.body.commit, 'ff00');
        assert.equal(m.event.actor_type, 'github', 'only the webhook may produce `merged`');
      }
    }
  }
});

// ---- D6 -------------------------------------------------------------------------------

test('D6 an unmappable delivery is dropped with a reason, never thrown', () => {
  const cases: [string, unknown][] = [
    ['push', { ref: 'refs/heads/main' }], // not an agent branch
    ['push', {}], // no ref at all
    ['pull_request', { action: 'labeled', pull_request: { head: { ref: BRANCH } } }],
    ['pull_request', { action: 'opened', pull_request: { head: { ref: 'main' } } }],
    ['issue_comment', { action: 'created' }], // event we never subscribed to
    ['workflow_run', { action: 'completed' }],
    ['ping', { zen: 'x' }],
    [undefined as unknown as string, {}],
  ];
  for (const [name, payload] of cases) {
    const m = mapDelivery(name, payload, CTX);
    assert.equal(m.kind, 'drop', `${name} should drop`);
    if (m.kind === 'drop') {
      assert.ok(m.reason.length > 0, 'a drop must always carry a reason for the log');
    }
  }
});

test('D6b a malformed payload does not throw', () => {
  for (const payload of [null, undefined, 'a string', 42, [], { pull_request: null }]) {
    assert.doesNotThrow(() => mapDelivery('pull_request', payload, CTX));
    assert.doesNotThrow(() => mapDelivery('push', payload, CTX));
    assert.doesNotThrow(() => mapDelivery('check_suite', payload, CTX));
  }
});

// ---- branch -> task id ----------------------------------------------------------------

test('taskIdFromBranch follows the agent/<role>/<slug> convention and refuses to guess', () => {
  assert.equal(taskIdFromBranch('agent/backend/task-items-crud'), 'task_items_crud');
  assert.equal(taskIdFromBranch('agent/frontend/items-ui'), 'task_items_ui');
  assert.equal(taskIdFromBranch('agent/qa/task_smoke'), 'task_smoke');
  // Anything off-convention returns null rather than moving the wrong card.
  assert.equal(taskIdFromBranch('main'), null);
  assert.equal(taskIdFromBranch('feature/thing'), null);
  assert.equal(taskIdFromBranch('agent/backend/'), null);
  assert.equal(taskIdFromBranch('agent/backend'), null);
  assert.equal(taskIdFromBranch(null), null);
  assert.equal(taskIdFromBranch(''), null);
  assert.equal(taskIdFromBranch('agent/backend/---'), null);
});

test('repoKey makes a repo full_name usable as a Firestore document id', () => {
  assert.equal(repoKey('zoho-cat/inventory-tracker'), 'zoho-cat__inventory-tracker');
  assert.equal(repoKey('ZOHO-Cat/Inventory-Tracker'), 'zoho-cat__inventory-tracker');
  assert.ok(!repoKey('a/b').includes('/'), 'a Firestore document id cannot contain a slash');
});
