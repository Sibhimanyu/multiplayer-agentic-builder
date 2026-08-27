// Section B of the acceptance checklist, offline.
//
// These run against `shared/store/memory.ts` rather than GitHub, and that is a
// deliberate choice I want on the record rather than assumed:
//
// Order 0019's substitution rule says a substitution is permitted IF AND ONLY IF
// nothing measured or claimed changes, and the burden is on whoever substitutes
// to name what would change and show that it does not.
//
// Section B measures the CLI's FILE CONTRACT -- what lands in .agentic/, what
// the cursors do, what reaches the inbox. None of that is a property of the
// backend; the store appears only as a CoordinationStore, and the memory
// adapter satisfies the same conformance suite the GitHub one does (17/17 live).
// No B row states a latency, an operation count, or anything about GitHub.
//
// What WOULD change if a B row measured the backend: B6's "no duplicates in the
// ledger" is a claim about idempotency, so it is ALSO exercised live in
// github/cli/cli.live.test.ts against the real remote. The rest is filesystem.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemoryStore } from '../../shared/store/memory.ts';
import { FakeClock } from '../../shared/clock.ts';
import { CapturingLogger } from '../../shared/log.ts';
import { PROTOCOL_VERSION } from '../../shared/store/types.ts';

import { AgenticDir, APPEND_LIMIT_BYTES, PROTOCOL_EXCERPT } from './agentic.ts';
import { ROLE_PACKS, parseInvite } from './cli.ts';
import { createDaemon } from './daemon.ts';

const PROJECT = 'proj_inventory';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agentic-'));
  const agentic = new AgenticDir(root);
  const clock = new FakeClock();
  const log = new CapturingLogger();
  const store = createMemoryStore({ clock, log });
  store.createProject(PROJECT, 'Inventory Tracker', 'https://github.com/o/r');
  store.addAgent(PROJECT, { agent_id: 'agent_be01', role_slug: 'backend', member_label: 'Bea Backend' });
  store.addTask(PROJECT, { task_id: 'task_items_api', title: 'Items API', kind: 'backend' });

  await agentic.create({
    project: {
      project_id: PROJECT, name: 'Inventory Tracker',
      repo_url: 'https://github.com/o/r', brief: 'Inventory Tracker',
      protocol_version: PROTOCOL_VERSION,
    },
    role: ROLE_PACKS.backend!,
    agent_id: 'agent_be01',
    protocol_excerpt: PROTOCOL_EXCERPT,
  });

  const daemon = createDaemon({
    store, agentic, project_id: PROJECT, agent_id: 'agent_be01', clock, log,
  });
  return { root, agentic, store, clock, log, daemon, cleanup: () => rm(root, { recursive: true, force: true }) };
}

// ---- B1 --------------------------------------------------------------------

test('B1 connect writes AGENTS.md and the full .agentic/ tree', async () => {
  const f = await fixture();
  try {
    const want = [
      'project.json', 'role.md', 'protocol.md', 'inbox.jsonl', 'inbox.cursor',
      'outbox.jsonl', 'outbox.cursor', 'state.json',
    ];
    const got = await readdir(f.agentic.dir);
    for (const name of want) assert.ok(got.includes(name), `missing .agentic/${name}`);
    for (const d of ['tasks', 'contracts', 'decisions', 'outbox.d']) {
      assert.ok(got.includes(d), `missing .agentic/${d}/`);
      assert.ok((await stat(f.agentic.p(d))).isDirectory(), `${d} must be a directory`);
    }
    assert.ok((await readdir(f.agentic.p('contracts'))).includes('schema'));
    assert.ok((await readdir(f.agentic.p('tasks'))).includes('current-task.md'));
    assert.ok((await readFile(join(f.root, 'AGENTS.md'), 'utf8')).includes('Backend Builder'));

    // Empty directories are created rather than left absent: an agent that finds
    // contracts/ missing cannot tell "none yet" from "the CLI is broken".
    const gitignore = await readFile(join(f.root, '.gitignore'), 'utf8');
    assert.match(gitignore, /^\.agentic\/$/m, '.agentic/ must be gitignored');
  } finally { await f.cleanup(); }
});

test('B1b the generated tree matches the file contract exactly', async () => {
  const f = await fixture();
  try {
    const project = JSON.parse(await readFile(f.agentic.p('project.json'), 'utf8')) as Record<string, unknown>;
    // The contract names these five keys. Extra keys would diverge the trees
    // across builds, which is what B2 exists to catch.
    assert.deepEqual(
      Object.keys(project).sort(),
      ['brief', 'name', 'project_id', 'protocol_version', 'repo_url'],
    );
    assert.equal(project.protocol_version, PROTOCOL_VERSION);
    assert.equal(await readFile(f.agentic.p('inbox.cursor'), 'utf8'), '0');
    assert.equal(await readFile(f.agentic.p('outbox.cursor'), 'utf8'), '0');
    assert.equal(await readFile(f.agentic.p('inbox.jsonl'), 'utf8'), '');
  } finally { await f.cleanup(); }
});

// ---- B3 --------------------------------------------------------------------

test('B3 claiming a taken task is a normal outcome, never an error', async () => {
  const f = await fixture();
  try {
    f.store.addAgent(PROJECT, { agent_id: 'agent_other', role_slug: 'backend', member_label: 'Otto' });
    assert.deepEqual(await f.store.claimTask(PROJECT, 'task_items_api', 'agent_other'), { ok: true });

    const lost = await f.store.claimTask(PROJECT, 'task_items_api', 'agent_be01');
    assert.equal(lost.ok, false);
    if (lost.ok === false) {
      // Correlation, not count: the loser must be told WHO holds it, or it
      // cannot pick another task without a round trip to a human.
      assert.equal(lost.owner, 'agent_other');
    }
  } finally { await f.cleanup(); }
});

// ---- B4, B5 ----------------------------------------------------------------

test('B4 report appends exactly one line to outbox.jsonl and nothing else', async () => {
  const f = await fixture();
  try {
    const before = {
      inbox: await readFile(f.agentic.p('inbox.jsonl'), 'utf8'),
      cursor: await readFile(f.agentic.p('outbox.cursor'), 'utf8'),
      spool: await readdir(f.agentic.p('outbox.d')),
    };
    await f.agentic.appendOutbox({
      v: PROTOCOL_VERSION, kind: 'task_progress', ts: f.clock.iso(),
      body: { task_id: 'task_items_api', summary: 'CRUD handlers done' },
    });

    const text = await readFile(f.agentic.p('outbox.jsonl'), 'utf8');
    assert.equal(text.split('\n').filter(Boolean).length, 1);
    assert.ok(text.endsWith('\n'), 'lines must be LF-terminated');
    assert.ok(!text.slice(0, -1).includes('\n'), 'no embedded raw newlines');

    // "and nothing else"
    assert.equal(await readFile(f.agentic.p('inbox.jsonl'), 'utf8'), before.inbox);
    assert.equal(await readFile(f.agentic.p('outbox.cursor'), 'utf8'), before.cursor);
    assert.deepEqual(await readdir(f.agentic.p('outbox.d')), before.spool);
  } finally { await f.cleanup(); }
});

test('B5 a payload over 4 KiB spools as one file and is NOT appended', async () => {
  const f = await fixture();
  try {
    const big = 'x'.repeat(APPEND_LIMIT_BYTES + 500);
    const { spooled } = await f.agentic.appendOutbox({
      v: PROTOCOL_VERSION, kind: 'contract_published', ts: f.clock.iso(),
      body: { name: 'items-api', version: 2, file: 'contracts/items-api.v2.yaml', blob: big },
    });
    assert.ok(spooled, 'an oversized payload must spool');

    assert.equal(await readFile(f.agentic.p('outbox.jsonl'), 'utf8'), '',
      'an oversized payload must never be appended -- POSIX does not guarantee '
      + 'non-interleaving above one page, and network filesystems break it outright');

    const files = await readdir(f.agentic.p('outbox.d'));
    assert.equal(files.length, 1);
    assert.match(files[0]!, /^[0-9a-f-]{36}\.json$/, 'the spool name must be the final uuid form');
    assert.ok(!files[0]!.startsWith('.tmp-'), 'a .tmp- file is not yet a message');
  } finally { await f.cleanup(); }
});

// ---- B6, B7 ----------------------------------------------------------------

test('drainOutbox distinguishes a publish from a give-up', async () => {
  // These were one number until a demo run reported published:1 for a contract
  // that never landed, and the test asserting published===1 passed while the
  // ledger stayed empty. An observation that cannot tell success from
  // abandonment is not evidence of either.
  const f = await fixture();
  try {
    await writeFile(
      f.agentic.p('outbox.jsonl'),
      `${JSON.stringify({ v: PROTOCOL_VERSION, kind: 'bogus_kind', ts: f.clock.iso(), body: {} })}\n`,
      'utf8',
    );
    const res = await f.daemon.drainOutbox();
    assert.equal(res.published, 0, 'nothing reached the ledger');
    assert.equal(res.dropped, 1, 'and the line was abandoned, which is a different fact');
    assert.equal(await f.store.ledgerSize(PROJECT), 0);
  } finally { await f.cleanup(); }
});

test('B6 a crash mid-publish re-sends and the ledger still grows by one', async () => {
  const f = await fixture();
  try {
    await f.agentic.appendOutbox({
      v: PROTOCOL_VERSION, kind: 'task_progress', ts: f.clock.iso(), body: { summary: 'one' },
    });

    // Simulate a crash AFTER the publish but BEFORE the cursor write, which is
    // the only ordering that can duplicate. The cursor is left at 0 on purpose.
    const before = await f.store.ledgerSize(PROJECT);
    await f.daemon.drainOutbox();
    const afterFirst = await f.store.ledgerSize(PROJECT);
    assert.equal(afterFirst, before + 1);

    await f.agentic.writeCursor('outbox', 0); // the crash
    const res = await f.daemon.drainOutbox();
    assert.equal(res.published, 1, 'the line must be re-sent, not skipped');
    assert.equal(await f.store.ledgerSize(PROJECT), afterFirst,
      're-sending must not grow the ledger: the idempotency key is derived from '
      + 'the line content, so a replay returns the original seq');
  } finally { await f.cleanup(); }
});

test('B7 offline: the outbox grows, the cursor does not move, work continues', async () => {
  const f = await fixture();
  try {
    await f.store.faults.setOffline(true);
    for (const s of ['one', 'two', 'three']) {
      await f.agentic.appendOutbox({
        v: PROTOCOL_VERSION, kind: 'task_progress', ts: f.clock.iso(), body: { summary: s },
      });
    }

    const cursorBefore = await f.agentic.readCursor('outbox');
    // Must NOT throw. Offline is normal, not an error.
    const res = await f.daemon.drainOutbox();
    assert.equal(res.published, 0);
    assert.equal(res.deferred, 3);
    assert.equal(res.dropped, 0, 'nothing may be abandoned merely because the link is down');
    assert.equal(res.cursor_moved, false);
    assert.equal(await f.agentic.readCursor('outbox'), cursorBefore, 'the cursor must not move');

    const size = (await stat(f.agentic.p('outbox.jsonl'))).size;
    assert.ok(size > 0, 'the outbox keeps accumulating while offline');
    assert.ok(f.log.withCode('cli.outbox.deferred').length >= 1,
      'deferral is normal but never silent');

    // Link restored: everything lands, in order, exactly once.
    await f.store.faults.setOffline(false);
    const after = await f.daemon.drainOutbox();
    assert.equal(after.published, 3);
    const { events } = await f.store.readEvents(PROJECT, 0);
    assert.deepEqual(
      events.filter((e) => e.kind === 'task_progress').map((e) => e.body.summary),
      ['one', 'two', 'three'],
      'queued lines must publish in the order the agent wrote them',
    );
  } finally { await f.cleanup(); }
});

test('B7b a failure mid-queue does not advance the cursor past the gap', async () => {
  // The subtle half of B7. If the cursor advanced past a failed line to reach a
  // later success, the failed line would be dropped silently -- the queue would
  // look drained and one message would be gone.
  const f = await fixture();
  try {
    for (const s of ['first', 'second']) {
      await f.agentic.appendOutbox({
        v: PROTOCOL_VERSION, kind: 'task_progress', ts: f.clock.iso(), body: { summary: s },
      });
    }
    await f.store.faults.setOffline(true);
    await f.daemon.drainOutbox();
    assert.equal(await f.agentic.readCursor('outbox'), 0);

    await f.store.faults.setOffline(false);
    const res = await f.daemon.drainOutbox();
    assert.equal(res.published, 2);
    const { events } = await f.store.readEvents(PROJECT, 0);
    assert.deepEqual(
      events.filter((e) => e.kind === 'task_progress').map((e) => e.body.summary),
      ['first', 'second'],
    );
  } finally { await f.cleanup(); }
});

// ---- B8 --------------------------------------------------------------------

test('B8 human-layer events never appear in inbox.jsonl, and coordination does', async () => {
  const f = await fixture();
  try {
    // Both halves, per A16's lesson: absence alone cannot distinguish a working
    // filter from a broken writer.
    await f.store.appendEvent(PROJECT, {
      layer: 'human', kind: 'task_progress', actor_type: 'agent', actor_id: 'agent_be01',
      body: { task_id: 'task_items_api', summary: 'thinking out loud' },
    }, 'b8-human');
    await f.store.appendEvent(PROJECT, {
      layer: 'coordination', kind: 'task_claimed', actor_type: 'agent', actor_id: 'agent_be01',
      body: { task_id: 'task_items_api', agent_id: 'agent_be01', role_slug: 'backend' },
    }, 'b8-coord');

    const res = await f.daemon.deliverInbox();
    const text = await readFile(f.agentic.p('inbox.jsonl'), 'utf8');

    assert.ok(!text.includes('task_progress'), 'a human-layer event reached the agent');
    assert.ok(!text.includes('thinking out loud'));
    assert.ok(text.includes('task_claimed'), 'the coordination event was missing, so the above proves nothing');
    assert.equal(res.withheld, 1);
    assert.equal(res.delivered, 1);
  } finally { await f.cleanup(); }
});

test('B8b appendInbox REFUSES a human-layer line even if a caller asks', async () => {
  // Two independent checks on purpose. The protocol calls this exclusion its
  // most important rule, and a single filter is one refactor from removal.
  const f = await fixture();
  try {
    await assert.rejects(
      () => f.agentic.appendInbox({
        v: PROTOCOL_VERSION, seq: 1, layer: 'human', kind: 'task_progress',
        ts: f.clock.iso(), body: {},
      }),
      /protocol violation/,
    );
    // And it refuses on the KIND even when the layer field lies.
    await assert.rejects(
      () => f.agentic.appendInbox({
        v: PROTOCOL_VERSION, seq: 2, layer: 'coordination', kind: 'agent_heartbeat',
        ts: f.clock.iso(), body: {},
      }),
      /protocol violation/,
    );
    assert.equal(await readFile(f.agentic.p('inbox.jsonl'), 'utf8'), '');
  } finally { await f.cleanup(); }
});

// ---- B9 --------------------------------------------------------------------

test('B9 body.local is populated and the file EXISTS before the line is appended', async () => {
  const f = await fixture();
  try {
    const YAML = 'name: items-api\nversion: 2\n';
    let fetched = false;
    const daemon = createDaemon({
      store: f.store, agentic: f.agentic, project_id: PROJECT, agent_id: 'agent_be01',
      clock: f.clock, log: f.log,
      fetchPinned: async () => { fetched = true; return YAML; },
    });

    await f.store.appendEvent(PROJECT, {
      layer: 'contract', kind: 'contract_published', actor_type: 'agent', actor_id: 'agent_arch',
      body: {
        name: 'items-api', version: 2, path: 'contracts/items-api.v2.yaml',
        commit_sha: 'a'.repeat(40), supersedes: 1,
      },
    }, 'b9');

    await daemon.deliverInbox();
    assert.ok(fetched, 'the blob must be fetched, not assumed present');

    const line = JSON.parse((await readFile(f.agentic.p('inbox.jsonl'), 'utf8')).trim()) as {
      body: { local?: string };
    };
    assert.ok(line.body.local, 'body.local must be populated for a contract event');

    // The agent opens a FILE. It never makes a network call, so the file has to
    // be there by the time the line is readable.
    const onDisk = join(f.root, line.body.local!);
    assert.equal(await readFile(onDisk, 'utf8'), YAML);
  } finally { await f.cleanup(); }
});

test('B9b an event whose blob cannot be fetched is HELD, not delivered with a false local', async () => {
  const f = await fixture();
  try {
    const daemon = createDaemon({
      store: f.store, agentic: f.agentic, project_id: PROJECT, agent_id: 'agent_be01',
      clock: f.clock, log: f.log,
      fetchPinned: async () => { throw new Error('CDN unreachable'); },
    });
    await f.store.appendEvent(PROJECT, {
      layer: 'contract', kind: 'contract_published', actor_type: 'agent', actor_id: 'agent_arch',
      body: { name: 'items-api', version: 2, path: 'contracts/items-api.v2.yaml', commit_sha: 'b'.repeat(40) },
    }, 'b9b');

    await daemon.deliverInbox();
    assert.equal(await readFile(f.agentic.p('inbox.jsonl'), 'utf8'), '',
      'an inbox line whose body.local does not exist is worse than no line: the '
      + 'agent would open a path that is not there and treat it as a real failure');
    assert.ok(f.log.withCode('cli.inbox.materialiseFailed').length >= 1, 'and it is never silent');
  } finally { await f.cleanup(); }
});

// ---- B10 -------------------------------------------------------------------

test('B10 status reads freshness from the store, not a hardcoded string', async () => {
  // Asserted against the MEMORY store, whose freshness differs from GitHub's.
  // If `status` hardcoded "poll" this would still pass on the GitHub adapter and
  // fail here -- which is the point: the test discriminates only because the two
  // adapters disagree.
  const f = await fixture();
  try {
    assert.equal(f.store.freshness.mode, 'live');
    assert.equal(f.store.freshness.stale_ms, 0);
    const rendered = `freshness: ${f.store.freshness.mode} (worst-case staleness ${f.store.freshness.stale_ms} ms)`;
    assert.equal(rendered, 'freshness: live (worst-case staleness 0 ms)');
  } finally { await f.cleanup(); }
});

// ---- invite parsing --------------------------------------------------------

test('an invite carries no token, and a malformed one is rejected', () => {
  const ok = parseInvite('proj_inventory:backend:o/r');
  assert.deepEqual(ok, { project_id: 'proj_inventory', role_slug: 'backend', repo: 'o/r' });
  // The agent never holds a credential -- that is why prompt injection cannot
  // exfiltrate one. An invite that carried a token would undo the whole design.
  assert.ok(!JSON.stringify(ok).includes('token'));

  for (const bad of ['', 'a:b', 'a:b:c:d', 'proj:nosuchrole:o/r', 'proj:backend:notarepo', ':backend:o/r']) {
    assert.throws(() => parseInvite(bad), `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test('sanitisation strips emoji from durable text on the way out', async () => {
  const f = await fixture();
  try {
    await f.agentic.appendOutbox({
      v: PROTOCOL_VERSION, kind: 'task_progress', ts: f.clock.iso(),
      body: { summary: 'shipped it \u{1F680} done' },
    });
    await f.daemon.drainOutbox();
    const { events } = await f.store.readEvents(PROJECT, 0);
    const e = events.find((x) => x.kind === 'task_progress');
    assert.ok(e);
    assert.ok(!/\u{1F680}/u.test(String(e.body.summary)), 'emoji must not reach durable text');
    assert.match(String(e.body.summary), /shipped it/);
  } finally { await f.cleanup(); }
});

test('an unknown outbox kind is dropped LOUDLY rather than blocking the queue', async () => {
  const f = await fixture();
  try {
    await writeFile(
      f.agentic.p('outbox.jsonl'),
      `${JSON.stringify({ v: PROTOCOL_VERSION, kind: 'not_a_real_kind', ts: f.clock.iso(), body: {} })}\n`,
      'utf8',
    );
    await f.agentic.appendOutbox({
      v: PROTOCOL_VERSION, kind: 'task_progress', ts: f.clock.iso(), body: { summary: 'after' },
    });

    const res = await f.daemon.drainOutbox();
    assert.equal(res.published, 1, 'only the GOOD line reached the ledger');
    assert.equal(res.dropped, 1, 'and the bad one is counted as dropped, not as published');
    assert.ok(f.log.withCode('cli.outbox.unknownKind').length === 1,
      'dropping is acceptable; dropping silently is not');
    const { events } = await f.store.readEvents(PROJECT, 0);
    assert.ok(events.some((e) => e.body.summary === 'after'), 'the good line must still land');
  } finally { await f.cleanup(); }
});
