// Checklist section B, the file-contract half. No network, no emulator.
//
//   node --test cli/outbox.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { LAYOUT, appendInbox, readState, writeAgenticTree, writeState, renderAgentsMd } from './agentic.ts';
import {
  SPOOL_THRESHOLD_BYTES,
  appendOutbox,
  drain,
  keyFor,
  readCursor,
  readPending,
  writeCursor,
  type OutboxRecord,
} from './outbox.ts';
import { StoreOfflineError } from '../shared/store/errors.ts';
import type { Logger } from '../shared/log.ts';
import type { TaskView } from '../shared/store/types.ts';

/** A seeded task row. The shared suite has its own; this is for the tests it does not own. */
function makeTask(task_id: string, over: Partial<TaskView> = {}): TaskView {
  return {
    task_id,
    title: `task ${task_id}`,
    kind: 'backend',
    status: 'open',
    claimed_by: null,
    branch: null,
    pr_url: null,
    pr_number: null,
    ci: null,
    depends_on: [],
    blocked_by: null,
    blocked_reason: null,
    file_scope: [],
    updated_at: '2026-08-25T09:00:00.000Z',
    ...over,
  };
}

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
function recorder(): { log: Logger; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    log: {
      debug: (c, m, f) => lines.push(`debug ${c} ${m} ${JSON.stringify(f ?? {})}`),
      info: (c, m, f) => lines.push(`info ${c} ${m} ${JSON.stringify(f ?? {})}`),
      warn: (c, m, f) => lines.push(`warn ${c} ${m} ${JSON.stringify(f ?? {})}`),
      error: (c, m, f) => lines.push(`error ${c} ${m} ${JSON.stringify(f ?? {})}`),
    },
  };
}

const ROLE = {
  role_slug: 'backend-builder',
  title: 'Backend Builder',
  responsibilities:
    'You own backend functions, data access, API contracts and backend tests\nfor the Inventory Tracker project.',
  may_edit: ['functions/**', 'schema/**'],
  may_not_edit: ['client/**', 'test/e2e/**'],
  branch_prefix: 'agent/backend/',
  push_branches: true,
  open_prs: true,
  merge: false,
};

const PROJECT = {
  project_id: 'proj_inventory',
  name: 'Inventory Tracker',
  repo_url: 'zoho-cat/inventory-tracker',
  brief: 'Track items, quantities and SKUs.',
  protocol_version: '0.2',
};

async function tmpRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'agentic-'));
}

async function connected(): Promise<string> {
  const root = await tmpRoot();
  await writeAgenticTree(
    root,
    { role: ROLE, project: PROJECT, task: makeTask('task_items_crud'), state: { agent_id: 'agent_be01', last_seen_seq: 0, last_written_seq: 0 } },
    silent,
  );
  return root;
}

// ---- B1 -------------------------------------------------------------------------------

test('B1 connect writes AGENTS.md and the full .agentic tree', async () => {
  const root = await connected();
  const expected = [
    LAYOUT.agents_md,
    LAYOUT.project,
    LAYOUT.role,
    LAYOUT.protocol,
    LAYOUT.current_task,
    LAYOUT.inbox,
    LAYOUT.inbox_cursor,
    LAYOUT.outbox,
    LAYOUT.outbox_cursor,
    LAYOUT.state,
  ];
  for (const rel of expected) {
    const stat = await fs.stat(path.join(root, rel));
    assert.ok(stat.isFile(), `${rel} must be a file`);
  }
  for (const rel of [LAYOUT.contracts_dir, LAYOUT.decisions_dir, LAYOUT.outbox_spool]) {
    const stat = await fs.stat(path.join(root, rel));
    assert.ok(stat.isDirectory(), `${rel} must be a directory`);
  }
  assert.equal((await fs.readFile(path.join(root, LAYOUT.outbox_cursor), 'utf8')).trim(), '0');
});

// ---- B2 -------------------------------------------------------------------------------

test('B2 the generated tree names no backend, so both builds can be byte-identical', async () => {
  const root = await connected();
  // state.json is CLI-owned and legitimately differs; everything else must be portable.
  const portable = [
    LAYOUT.agents_md,
    LAYOUT.project,
    LAYOUT.role,
    LAYOUT.protocol,
    LAYOUT.current_task,
  ];
  // Platform terms only. Deliberately NOT the org name: the demo repo is owned by whoever
  // owns it, that string is identical in both builds, and banning it would just mean this
  // test fails on the real repo url rather than on a real leak.
  const forbidden = [
    /firestore/i,
    /firebase/i,
    /catalyst/i,
    /cloudfunctions/i,
    /run\.app/i,
    /zcql/i,
    /stratus/i,
    /appsail/i,
    /onsnapshot/i,
    /runtransaction/i,
    /\bdata store\b/i,
  ];
  for (const rel of portable) {
    let text = await fs.readFile(path.join(root, rel), 'utf8');
    // repo_url is project identity, not platform identity, and both builds carry the same
    // value. Redact it so the scan is about the generator, not about the fixture.
    text = text.replace(/"repo_url":\s*"[^"]*"/g, '"repo_url":"<redacted>"');
    for (const pattern of forbidden) {
      assert.ok(
        !pattern.test(text),
        `${rel} mentions ${pattern} — the agent must not be able to tell which build it is on`,
      );
    }
  }
});

test('B2b generation is deterministic: same inputs, identical bytes', async () => {
  const a = await connected();
  const b = await connected();
  for (const rel of [LAYOUT.agents_md, LAYOUT.role, LAYOUT.protocol, LAYOUT.current_task, LAYOUT.project]) {
    const [ta, tb] = await Promise.all([
      fs.readFile(path.join(a, rel), 'utf8'),
      fs.readFile(path.join(b, rel), 'utf8'),
    ]);
    assert.equal(ta, tb, `${rel} must be byte-identical between two runs`);
  }
});

test('B2c AGENTS.md reports merge:no from the role pack', () => {
  const text = renderAgentsMd(ROLE, PROJECT);
  assert.match(text, /merge: no/);
  // "branches pushed FOR YOU", not "push branches" — the old wording read as an instruction to
  // run git, which contradicted the role pack's "never run git yourself". A real agent hit that
  // contradiction on its first run and stopped to report it rather than guessing.
  assert.match(text, /branches pushed for you: yes/);
  // If a role ever did carry merge, the file must say so rather than lie — the enforcement is
  // server-side, and a hardcoded "no" here would hide a real misconfiguration.
  const withMerge = renderAgentsMd({ ...ROLE, merge: true }, PROJECT);
  assert.match(withMerge, /merge: yes/);
});

// ---- B4 -------------------------------------------------------------------------------

test('B4 report appends exactly one line to outbox.jsonl and touches nothing else', async () => {
  const root = await connected();
  const before = await snapshotTree(root);

  const r = await appendOutbox(
    root,
    { kind: 'task_progress', body: { task_id: 'task_items_crud', summary: 'CRUD handlers done' } },
    silent,
  );
  assert.equal(r.target, 'jsonl');

  const after = await snapshotTree(root);
  const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
  assert.deepEqual(changed, [LAYOUT.outbox], 'only outbox.jsonl may change');

  const lines = (await fs.readFile(path.join(root, LAYOUT.outbox), 'utf8')).split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]!);
  assert.equal(parsed.kind, 'task_progress');
  assert.equal(parsed.v, '0.2');
  assert.equal(parsed.body.summary, 'CRUD handlers done');
});

// ---- B5 -------------------------------------------------------------------------------

test('B5 a payload over 4 KiB goes to outbox.d as one file, never appended', async () => {
  const root = await connected();
  const big = 'x'.repeat(SPOOL_THRESHOLD_BYTES + 500);

  const r = await appendOutbox(root, { kind: 'contract_published', body: { name: 'items-api', yaml: big } }, silent);
  assert.equal(r.target, 'spool');
  assert.ok(r.bytes > SPOOL_THRESHOLD_BYTES);

  const outbox = await fs.readFile(path.join(root, LAYOUT.outbox), 'utf8');
  assert.equal(outbox, '', 'outbox.jsonl must stay empty: an over-page append is not atomic');

  const spooled = await fs.readdir(path.join(root, LAYOUT.outbox_spool));
  assert.equal(spooled.length, 1, 'exactly one spool file');
  assert.match(spooled[0]!, /^[0-9a-f-]{36}\.json$/, 'named <uuid>.json');
  assert.ok(!spooled[0]!.startsWith('.tmp-'), 'the temp name must have been renamed away');
});

test('B5b a partially-written spool file is never drained', async () => {
  const root = await connected();
  // A .tmp- file is what a crash mid-write leaves behind.
  await fs.writeFile(path.join(root, LAYOUT.outbox_spool, '.tmp-half'), '{"kind":"task_prog', 'utf8');
  const pending = await readPending(root, silent);
  assert.equal(pending.length, 0, 'an in-progress write must be invisible to the drain');
});

// ---- B6 -------------------------------------------------------------------------------

test('B6 killing the CLI mid-publish re-sends and produces no duplicate in the ledger', async () => {
  const root = await connected();
  for (let i = 0; i < 5; i++) {
    await appendOutbox(root, { kind: 'task_progress', body: { task_id: 't', n: i } }, silent);
  }

  // Simulate the ledger: idempotency_key -> seq. This is exactly what appendEvent guarantees.
  const ledger = new Map<string, number>();
  let seq = 0;
  const publish = async (rec: OutboxRecord) => {
    const prior = ledger.get(rec.idempotency_key);
    if (prior !== undefined) return { seq: prior, duplicate: true };
    ledger.set(rec.idempotency_key, ++seq);
    return { seq, duplicate: false };
  };

  // First run dies after the third publish, BEFORE its cursor write would have landed.
  let count = 0;
  const dying = async (rec: OutboxRecord) => {
    if (count++ === 3) throw new StoreOfflineError('killed mid-publish');
    return publish(rec);
  };
  const first = await drain(root, dying, silent);
  assert.equal(first.published, 3);
  assert.equal(first.remaining, 2);

  // Restart: same tree, same offsets, therefore the same derived keys.
  const second = await drain(root, publish, silent);
  assert.equal(second.published, 2, 'the two unsent lines must go');
  assert.equal(second.duplicates, 0, 'the three already sent must not be re-read past the cursor');

  assert.equal(ledger.size, 5, 'the ledger must hold exactly five events, not eight');

  const third = await drain(root, publish, silent);
  assert.equal(third.published, 0, 'a third drain has nothing to do');
  assert.equal(third.remaining, 0);
});

test('B6b re-publishing the same line yields the same idempotency key across restarts', async () => {
  const payload = JSON.stringify({ v: '0.2', kind: 'task_progress', ts: 'fixed', body: { n: 1 } });
  assert.equal(keyFor(payload, 0), keyFor(payload, 0), 'stable for one offset');
  assert.notEqual(
    keyFor(payload, 0),
    keyFor(payload, 120),
    'two identical payloads at different offsets are different events',
  );
});

test('B6c a crash BEFORE the cursor write re-sends, and the store dedupes it', async () => {
  const root = await connected();
  await appendOutbox(root, { kind: 'task_progress', body: { n: 1 } }, silent);

  const ledger = new Map<string, number>();
  let seq = 0;
  const publish = async (rec: OutboxRecord) => {
    const prior = ledger.get(rec.idempotency_key);
    if (prior !== undefined) return { seq: prior, duplicate: true };
    ledger.set(rec.idempotency_key, ++seq);
    return { seq, duplicate: false };
  };

  // Publish succeeded, then the process died before writeCursor. Reproduce by publishing and
  // rewinding the cursor.
  await drain(root, publish, silent);
  await writeCursor(root, LAYOUT.outbox_cursor, 0);

  const again = await drain(root, publish, silent);
  assert.equal(again.duplicates, 1, 'the re-sent line must come back as a duplicate');
  assert.equal(again.published, 0);
  assert.equal(ledger.size, 1, 'and the ledger must still hold exactly one event');
});

// ---- B7 -------------------------------------------------------------------------------

test('B7 with the network down the outbox grows and the cursor does not move', async () => {
  const root = await connected();
  const offline = async (): Promise<{ seq: number; duplicate: boolean }> => {
    throw new StoreOfflineError('backend unreachable');
  };

  await appendOutbox(root, { kind: 'task_progress', body: { n: 1 } }, silent);
  const cursorStart = await readCursor(root, LAYOUT.outbox_cursor, silent);
  const sizeStart = (await fs.stat(path.join(root, LAYOUT.outbox))).size;

  let offlineSeen = 0;
  const r1 = await drain(root, offline, silent, { onOffline: () => offlineSeen++ });
  assert.equal(r1.published, 0);
  assert.equal(offlineSeen, 1, 'offline must be surfaced to the caller, not swallowed');
  assert.equal(await readCursor(root, LAYOUT.outbox_cursor, silent), cursorStart, 'cursor unmoved');

  // The agent keeps working while offline. That is the whole point.
  for (let i = 0; i < 3; i++) {
    await appendOutbox(root, { kind: 'task_progress', body: { n: 10 + i } }, silent);
  }
  const sizeAfter = (await fs.stat(path.join(root, LAYOUT.outbox))).size;
  assert.ok(sizeAfter > sizeStart, 'the outbox must have grown while offline');
  assert.equal(await readCursor(root, LAYOUT.outbox_cursor, silent), cursorStart, 'cursor still unmoved');

  // When the network returns, everything queued goes, in order, exactly once.
  const sent: number[] = [];
  const online = async (rec: OutboxRecord) => {
    sent.push(rec.body.n as number);
    return { seq: sent.length, duplicate: false };
  };
  const r2 = await drain(root, online, silent);
  assert.equal(r2.published, 4);
  assert.deepEqual(sent, [1, 10, 11, 12], 'published in append order');
  assert.ok(r2.cursor_after > cursorStart, 'now the cursor advances');
});

// ---- B9 -------------------------------------------------------------------------------

test('B9 an inbox line naming a body.local that does not exist is refused', async () => {
  const root = await connected();
  await assert.rejects(
    () =>
      appendInbox(
        root,
        {
          v: '0.2',
          seq: 4211,
          layer: 'contract',
          kind: 'contract_published',
          ts: '2026-08-25T09:41:02Z',
          body: { name: 'items-api', version: 2, local: '.agentic/contracts/items-api.v2.yaml' },
        },
        silent,
      ),
    /body\.local does not exist yet/,
    'announcing a file before materialising it breaks the promise that the agent never networks',
  );
  const inbox = await fs.readFile(path.join(root, LAYOUT.inbox), 'utf8');
  assert.equal(inbox, '', 'and nothing may be appended');
});

test('B9b once the blob is on disk the line is appended', async () => {
  const root = await connected();
  const local = `${LAYOUT.contracts_dir}/items-api.v2.yaml`;
  await fs.writeFile(path.join(root, local), 'name: items-api\nversion: 2\n', 'utf8');

  await appendInbox(
    root,
    {
      v: '0.2',
      seq: 4211,
      layer: 'contract',
      kind: 'contract_published',
      ts: '2026-08-25T09:41:02Z',
      body: { name: 'items-api', version: 2, path: 'contracts/items-api.v2.yaml', local, supersedes: 1 },
    },
    silent,
  );

  const lines = (await fs.readFile(path.join(root, LAYOUT.inbox), 'utf8')).split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]!);
  assert.equal(parsed.body.local, local);
  // C7: the agent never sees a commit sha.
  assert.equal(parsed.body.commit_sha, undefined, 'the agent must never see a commit sha');
  assert.ok(!lines[0]!.includes('commit_sha'), 'not anywhere in the line');
});

test('B9c an inbox line with a raw newline is refused, not silently reflowed', async () => {
  const root = await connected();
  // JSON.stringify escapes newlines, so this can only happen if a caller pre-serialises.
  // The guard exists because one raw newline turns one JSONL record into two malformed ones.
  await appendInbox(root, { kind: 'task_unblocked', body: { reason: 'line\nbreak' } }, silent);
  const text = await fs.readFile(path.join(root, LAYOUT.inbox), 'utf8');
  assert.equal(text.split('\n').filter(Boolean).length, 1, 'still exactly one record');
  assert.match(text, /line\\nbreak/, 'the newline must be escaped, not literal');
});

// ---- cursors and state ----------------------------------------------------------------

test('a corrupt cursor resets to zero loudly rather than crashing', async () => {
  const root = await connected();
  const { log, lines } = recorder();
  await fs.writeFile(path.join(root, LAYOUT.outbox_cursor), 'not-a-number\n', 'utf8');
  assert.equal(await readCursor(root, LAYOUT.outbox_cursor, log), 0);
  assert.ok(lines.some((l) => l.includes('cursor file is not a non-negative number')));
});

test('a cursor past EOF re-reads from the start rather than losing the tail', async () => {
  const root = await connected();
  const { log, lines } = recorder();
  await appendOutbox(root, { kind: 'task_progress', body: { n: 1 } }, silent);
  await writeCursor(root, LAYOUT.outbox_cursor, 999_999);

  const pending = await readPending(root, log);
  assert.equal(pending.length, 1, 'the line must still be found');
  assert.ok(lines.some((l) => l.includes('past EOF')), 'and the anomaly must be reported');
});

test('a malformed outbox line is skipped with a warning and does not block the rest', async () => {
  const root = await connected();
  const { log, lines } = recorder();
  await fs.appendFile(
    path.join(root, LAYOUT.outbox),
    'this is not json\n' + JSON.stringify({ v: '0.2', kind: 'task_progress', body: { n: 7 } }) + '\n',
    'utf8',
  );
  const pending = await readPending(root, log);
  assert.equal(pending.length, 1, 'the good line must still be drained');
  assert.equal(pending[0]!.body.n, 7);
  assert.ok(lines.some((l) => l.includes('not valid JSON')), 'and the bad line reported');
});

test('an outbox line with an unknown kind is skipped, not sent', async () => {
  const root = await connected();
  const { log, lines } = recorder();
  await fs.appendFile(
    path.join(root, LAYOUT.outbox),
    JSON.stringify({ v: '0.2', kind: 'definitely_not_a_kind', body: {} }) + '\n',
    'utf8',
  );
  const pending = await readPending(root, log);
  assert.equal(pending.length, 0);
  assert.ok(lines.some((l) => l.includes('unknown kind')));
});

test('state round-trips and a corrupt state file degrades to zeros', async () => {
  const root = await connected();
  await writeState(root, { agent_id: 'agent_x', last_seen_seq: 42, last_written_seq: 43 });
  assert.deepEqual(await readState(root, silent), {
    agent_id: 'agent_x',
    last_seen_seq: 42,
    last_written_seq: 43,
  });

  const { log, lines } = recorder();
  await fs.writeFile(path.join(root, LAYOUT.state), '{ broken', 'utf8');
  assert.deepEqual(await readState(root, log), { agent_id: '', last_seen_seq: 0, last_written_seq: 0 });
  assert.ok(lines.some((l) => l.includes('state.json unreadable')));
});

test('reconnecting does not truncate a queued outbox or an unread inbox', async () => {
  const root = await connected();
  await appendOutbox(root, { kind: 'task_progress', body: { n: 1 } }, silent);
  await appendInbox(root, { kind: 'task_unblocked', body: { task_id: 't' } }, silent);
  const outboxBefore = await fs.readFile(path.join(root, LAYOUT.outbox), 'utf8');
  const inboxBefore = await fs.readFile(path.join(root, LAYOUT.inbox), 'utf8');

  // A second connect, as would happen on `drydock connect` being run twice.
  await writeAgenticTree(
    root,
    { role: ROLE, project: PROJECT, task: makeTask('task_items_crud'), state: { agent_id: 'agent_be01', last_seen_seq: 0, last_written_seq: 0 } },
    silent,
  );

  assert.equal(await fs.readFile(path.join(root, LAYOUT.outbox), 'utf8'), outboxBefore, 'unsent work must survive');
  assert.equal(await fs.readFile(path.join(root, LAYOUT.inbox), 'utf8'), inboxBefore, 'unread messages must survive');
});

// ---- helper ----------------------------------------------------------------------------

/** rel path -> contents, for every file in the tree. */
async function snapshotTree(root: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (dir: string) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else out[path.relative(root, abs)] = await fs.readFile(abs, 'utf8');
    }
  };
  await walk(root);
  return out;
}
