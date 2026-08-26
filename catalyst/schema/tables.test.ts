// The schema tested against the platform constraints, not against my intentions.
//
// Every assertion here corresponds to a documented constraint or a probe result.
// A table definition that violates one fails the build rather than failing in
// production six weeks later with silently truncated data.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  SYSTEM_COLUMNS, TABLES, ZCQL_COLUMN_CAP, compositeKey, tableByName, toCreateColumnPayload,
} from './tables.ts';

const REQUIRED_TABLES = [
  'events', 'task_claims', 'scope_locks', 'tasks', 'agents',
  'members', 'roles', 'github_links', 'request_dedupe',
];

describe('Data Store schema', () => {
  test('all nine tables from build order step 3 are declared', () => {
    const names = TABLES.map((t) => t.name).sort();
    assert.deepEqual(names, [...REQUIRED_TABLES].sort());
  });

  test('no varchar exceeds 255 -- the platform clamps silently, on DDL and on write', () => {
    for (const t of TABLES) {
      for (const c of t.columns) {
        if (c.type !== 'varchar') continue;
        const len = c.max_length ?? 255;
        assert.ok(len <= 255, `${t.name}.${c.name} declares varchar(${len}), which becomes 255 with no error`);
      }
    }
  });

  test('no human-authored text is stored in a varchar', () => {
    // Titles, labels, summaries, descriptions, globs, bodies. A varchar here
    // loses the tail of a long value and reports success.
    const HUMAN = /^(title|description|label|member_label|summary|body|globs|blocked_reason|pr_url|depends_on|file_scope)$/;
    for (const t of TABLES) {
      for (const c of t.columns) {
        if (!HUMAN.test(c.name)) continue;
        assert.equal(c.type, 'text', `${t.name}.${c.name} holds human or unbounded text and must be text, not ${c.type}`);
      }
    }
  });

  test('no text column claims is_unique -- the platform does not offer it', () => {
    for (const t of TABLES) {
      for (const c of t.columns) {
        if (c.type === 'text') {
          assert.notEqual(c.unique, true, `${t.name}.${c.name} is text and cannot be unique`);
        }
      }
    }
  });

  test('each table has at most one unique column, and it is the one named in atomic_on', () => {
    for (const t of TABLES) {
      const unique = t.columns.filter((c) => c.unique);
      assert.ok(unique.length <= 1, `${t.name} has ${unique.length} unique columns; a loser cannot tell which it lost`);
      if (t.atomic_on) {
        assert.equal(unique[0]?.name, t.atomic_on, `${t.name}.atomic_on names ${t.atomic_on} but that column is not the unique one`);
      }
    }
  });

  test('every per-project uniqueness constraint uses a composite key, since unique is global', () => {
    // The trap: unique(task_id) is unique across the WHOLE TABLE, so project A
    // claiming task_api would block project B from ever claiming its own task_api.
    for (const t of TABLES) {
      const uniqueCol = t.columns.find((c) => c.unique);
      if (!uniqueCol) continue;
      const scoped = t.columns.some((c) => c.name === 'project_id');
      if (!scoped) continue;
      // A unique column in a project-scoped table must either be globally unique
      // by construction (a uuid, a server-minted id, an owner/repo pair) or be a
      // composite key naming the project.
      const globallyUniqueByConstruction = [
        'seq',             // globally allocated on purpose (order 0005); a per-project seq deadlocks
        'idempotency_key', // uuid v4 from the caller, or a GitHub delivery id
        'agent_id',        // agent_<8 hex>, server-minted
        'repo_full_name',  // owner/repo is already globally unique
      ];
      if (globallyUniqueByConstruction.includes(uniqueCol.name)) continue;
      assert.match(uniqueCol.name, /_key$/,
        `${t.name}.${uniqueCol.name} is unique in a project-scoped table but is not a composite _key column`);
      assert.match(String(uniqueCol.note), /COMPOSITE/,
        `${t.name}.${uniqueCol.name} must document its composite shape`);
    }
  });

  test('no table exceeds the ZCQL 20-column projection cap once system columns are counted', () => {
    for (const t of TABLES) {
      const total = t.columns.length + SYSTEM_COLUMNS.length;
      assert.ok(total <= ZCQL_COLUMN_CAP,
        `${t.name} has ${t.columns.length} columns + ${SYSTEM_COLUMNS.length} system = ${total}, over the ${ZCQL_COLUMN_CAP} cap`);
    }
  });

  test('every boolean column warns that booleans come back as strings', () => {
    // "false" is truthy in JS. A missed readBool() on can_merge is an agent
    // merging when it must not.
    for (const t of TABLES) {
      for (const c of t.columns) {
        if (c.type !== 'boolean') continue;
        assert.match(String(c.note), /readBool/,
          `${t.name}.${c.name} is boolean and must document the readBool() requirement`);
      }
    }
  });

  test('events carries seq as a unique bigint, and never uses ROWID as the sequence', () => {
    const events = tableByName('events');
    const seq = events.columns.find((c) => c.name === 'seq');
    assert.ok(seq);
    assert.equal(seq.type, 'bigint');
    assert.equal(seq.unique, true);
    assert.equal(seq.mandatory, true);
    assert.equal(events.atomic_on, 'seq');
    assert.equal(events.columns.some((c) => c.name.toUpperCase() === 'ROWID'), false);
  });

  test('the ledger has no status or mutable column -- it is append-only', () => {
    const events = tableByName('events');
    for (const c of events.columns) {
      assert.doesNotMatch(c.name, /^(status|updated_at|modified)/, `events.${c.name} implies mutation`);
    }
  });

  test('tasks stores definitions only; status is folded, because UPDATEs cost 1,000/month', () => {
    const tasks = tableByName('tasks');
    const mutable = tasks.columns.filter((c) => /^(status|claimed_by|branch|pr_url|pr_number|ci|updated_at)$/.test(c.name));
    assert.deepEqual(mutable, [], `tasks must not store folded state: ${mutable.map((c) => c.name).join(', ')}`);
  });

  test('presence is not a table -- it lives in Cache with a TTL', () => {
    for (const t of TABLES) {
      assert.doesNotMatch(t.name, /presence|heartbeat/);
      for (const c of t.columns) {
        assert.doesNotMatch(c.name, /heartbeat/, `${t.name}.${c.name} would make a heartbeat a durable write`);
      }
    }
  });

  test('the agent token is stored only as a hash', () => {
    const agents = tableByName('agents');
    assert.ok(agents.columns.some((c) => c.name === 'token_hash'));
    assert.equal(agents.columns.some((c) => c.name === 'token'), false, 'a raw token must never be a column');
  });
});

describe('compositeKey', () => {
  test('joins parts with a colon', () => {
    assert.equal(compositeKey('proj_inventory', 'task_items_api'), 'proj_inventory:task_items_api');
  });

  test('rejects a part containing a colon, which would make keys ambiguous', () => {
    // "a:b" + "c" and "a" + "b:c" would otherwise produce the same key, so two
    // different tasks could collide on one claim row.
    assert.throws(() => compositeKey('a:b', 'c'), /may not contain/);
  });

  test('rejects an empty part', () => {
    assert.throws(() => compositeKey('proj', ''), /may not be empty/);
  });
});

describe('Create_Column payloads', () => {
  test('flags are the strings the API requires, not JSON booleans', () => {
    const payload = toCreateColumnPayload({ name: 'seq', type: 'bigint', unique: true, mandatory: true });
    assert.equal(payload.is_unique, 'true');
    assert.equal(payload.is_mandatory, 'true');
    assert.equal(payload.search_index_enabled, 'false');
    assert.equal(payload.audit_consent, 'false');
  });

  test('varchar carries an explicit max_length', () => {
    const payload = toCreateColumnPayload({ name: 'project_id', type: 'varchar', max_length: 255 });
    assert.equal(payload.max_length, 255);
  });

  test('text omits is_unique and search_index_enabled, which the API rejects for it', () => {
    const payload = toCreateColumnPayload({ name: 'body', type: 'text' });
    assert.equal('is_unique' in payload, false);
    assert.equal('search_index_enabled' in payload, false);
    assert.equal(payload.data_type, 'text');
  });

  test('every declared column produces a payload the API schema would accept', () => {
    for (const t of TABLES) {
      for (const c of t.columns) {
        const p = toCreateColumnPayload(c);
        assert.equal(typeof p.column_name, 'string');
        assert.ok(['varchar', 'text', 'bigint', 'int', 'boolean', 'datetime'].includes(String(p.data_type)));
        assert.ok(p.is_mandatory === 'true' || p.is_mandatory === 'false');
        if (p.description !== undefined) {
          assert.ok(String(p.description).length <= 255, `${t.name}.${c.name} description would be clamped`);
        }
      }
    }
  });
});
