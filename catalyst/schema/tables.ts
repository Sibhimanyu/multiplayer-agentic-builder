// The nine Data Store tables, declared rather than clicked.
//
// Build order step 3. Declarative so the same definitions can be typechecked,
// asserted against the platform constraints in tests, and later replayed through
// CatalystbyZoho_Create_Table / _Create_Column when a project ID arrives.
//
// Four probe results shape every choice here (see the notes file):
//
//  1. is_unique WORKS on varchar, rejecting with error_code DUPLICATE_VALUE.
//     It is the only atomic primitive on this platform, so every table that
//     needs atomicity gets exactly one unique column to fight over.
//  2. is_unique is NOT offered on `text` at all.
//  3. varchar silently clamps to 255 -- on DDL and on write, with status:success
//     both times. So user-authored text NEVER goes in a varchar.
//  4. UNIQUE IS GLOBAL, NOT PER PROJECT. A column is unique across the whole
//     table, so "one claim per task per project" cannot be expressed as
//     unique(task_id) -- two projects with a task called task_api would fight
//     over one row. Every per-project uniqueness constraint is therefore a
//     composite KEY COLUMN: "<project_id>:<task_id>". Same reasoning that made
//     seq allocate globally (order 0005).
//
// Free-tier shape: 1,000 UPDATEs per MONTH. So nothing here is designed to be
// updated. `tasks` rows carry the task DEFINITION and are written once; task
// STATUS is folded from the event ledger, never stored. Presence lives in Cache.
// The intended steady-state UPDATE count for this system is zero.

export type CatalystDataType = 'varchar' | 'text' | 'bigint' | 'int' | 'boolean' | 'datetime';

export interface ColumnSpec {
  name: string;
  type: CatalystDataType;
  /** varchar only. The platform silently clamps anything above 255. */
  max_length?: number;
  unique?: boolean;
  mandatory?: boolean;
  search_index?: boolean;
  /** Why this column is this type. Read by the schema conformance test. */
  note?: string;
}

export interface TableSpec {
  name: string;
  purpose: string;
  columns: ColumnSpec[];
  /**
   * The single column callers race on, if any. Exactly one per table -- two
   * unique columns means two ways to lose, and the loser cannot tell which.
   */
  atomic_on?: string;
}

/** Columns Catalyst adds to every table. They count against the ZCQL column cap. */
export const SYSTEM_COLUMNS = ['ROWID', 'CREATORID', 'CREATEDTIME', 'MODIFIEDTIME'] as const;

/** ZCQL caps a projection at 20 columns. `SELECT *` counts as one. */
export const ZCQL_COLUMN_CAP = 20;

const ID = { type: 'varchar', max_length: 255 } as const;

export const TABLES: TableSpec[] = [
  {
    name: 'events',
    purpose: 'The append-only ledger. Never updated, never deleted.',
    atomic_on: 'seq',
    columns: [
      { name: 'seq', type: 'bigint', unique: true, mandatory: true,
        note: 'Globally allocated (order 0005). NOT ROWID -- ROWID runs backwards across inserts.' },
      { name: 'event_id', ...ID, mandatory: true,
        note: 'Minted FROM seq as evt_<seq36>. Deliberately NOT unique: unique(seq) already implies it, and a second unique column would give an insert two ways to fail that the seq retry cannot tell apart.' },
      { name: 'project_id', ...ID, mandatory: true, search_index: true },
      { name: 'layer', ...ID, mandatory: true, note: 'contract | coordination | human. Derived from kind, never trusted from a caller.' },
      { name: 'kind', ...ID, mandatory: true },
      { name: 'actor_type', ...ID, mandatory: true },
      { name: 'actor_id', ...ID, mandatory: true, note: 'Resolved server-side from the token. Never accepted from the client.' },
      { name: 'created_at', type: 'datetime', mandatory: true, note: 'Server clock. Not a seq source -- ms resolution, and a batch shares one value.' },
      { name: 'body', type: 'text',
        note: 'JSON. text, not varchar: bodies exceed 255. Capped at 10,000 by the platform, enforced and logged in shared/sanitize.ts. Contract bodies are POINTERS, so they stay small.' },
    ],
  },
  {
    name: 'request_dedupe',
    purpose: 'Idempotency. One row per accepted write request, inserted BEFORE the event it guards.',
    atomic_on: 'dedupe_key',
    columns: [
      { name: 'dedupe_key', ...ID, unique: true, mandatory: true,
        note: 'COMPOSITE "<project_id>:<idempotency_key>". The key is CLIENT-SUPPLIED, and unique is table-global, so a bare unique(idempotency_key) would let one project silently swallow another project\'s append as a duplicate. Cross-tenant event loss, not merely a collision.' },
      { name: 'idempotency_key', ...ID, mandatory: true,
        note: 'The raw key as supplied, kept for diagnostics. Not unique on its own.' },
      { name: 'project_id', ...ID, mandatory: true },
      { name: 'seq', type: 'bigint', note: 'The seq handed to the event this request produced. Replays return THIS, not a new one.' },
      { name: 'event_id', ...ID },
      { name: 'created_at', type: 'datetime', mandatory: true },
    ],
  },
  {
    name: 'task_claims',
    purpose: 'Atomic task ownership. One row = one live claim.',
    atomic_on: 'claim_key',
    columns: [
      { name: 'claim_key', ...ID, unique: true, mandatory: true,
        note: 'COMPOSITE "<project_id>:<task_id>". Unique is global, so unique(task_id) alone would let one project block another project task of the same name.' },
      { name: 'project_id', ...ID, mandatory: true, search_index: true },
      { name: 'task_id', ...ID, mandatory: true, note: 'Lowercased before the key is built -- the constraint is case-sensitive (probe P4).' },
      { name: 'agent_id', ...ID, mandatory: true },
      { name: 'claimed_at', type: 'datetime', mandatory: true },
    ],
  },
  {
    name: 'scope_locks',
    purpose: 'Server-enforced file-scope locks. Glob intersection is checked in the function; this table only prevents a duplicate lock row.',
    atomic_on: 'lock_key',
    columns: [
      { name: 'lock_key', ...ID, unique: true, mandatory: true,
        note: 'COMPOSITE "<project_id>:<agent_id>:<task_id>".' },
      { name: 'project_id', ...ID, mandatory: true, search_index: true },
      { name: 'agent_id', ...ID, mandatory: true },
      { name: 'task_id', ...ID, mandatory: true },
      { name: 'globs', type: 'text', mandatory: true, note: 'JSON array. text, not varchar: a glob list passes 255 easily.' },
      { name: 'acquired_at', type: 'datetime', mandatory: true },
    ],
  },
  {
    name: 'tasks',
    purpose: 'Task DEFINITIONS, written once. Status is folded from the ledger and never stored -- the free tier allows 1,000 UPDATEs per month.',
    atomic_on: 'task_key',
    columns: [
      { name: 'task_key', ...ID, unique: true, mandatory: true, note: 'COMPOSITE "<project_id>:<task_id>".' },
      { name: 'project_id', ...ID, mandatory: true, search_index: true },
      { name: 'task_id', ...ID, mandatory: true },
      { name: 'title', type: 'text', mandatory: true,
        note: 'HUMAN TEXT -> text. A 47-char title fits varchar, but E6 tests a 90-char path and varchar would clamp it silently.' },
      { name: 'description', type: 'text' },
      { name: 'kind', ...ID, mandatory: true },
      { name: 'depends_on', type: 'text', note: 'JSON array of task ids.' },
      { name: 'file_scope', type: 'text', note: 'JSON array of globs.' },
      { name: 'created_at', type: 'datetime', mandatory: true },
    ],
  },
  {
    name: 'agents',
    purpose: 'Agent identity and role binding. Presence is NOT here -- it is a Cache key with a TTL.',
    atomic_on: 'agent_id',
    columns: [
      { name: 'agent_id', ...ID, unique: true, mandatory: true, note: 'agent_<8 hex>, server-generated. Globally unique by construction.' },
      { name: 'project_id', ...ID, mandatory: true, search_index: true },
      { name: 'member_id', ...ID, mandatory: true },
      { name: 'role_slug', ...ID, mandatory: true },
      { name: 'member_label', type: 'text', mandatory: true, note: 'HUMAN TEXT -> text. Names carry accents and long forms.' },
      { name: 'harness', ...ID, mandatory: true },
      { name: 'token_hash', ...ID, mandatory: true, note: 'SHA-256 hex of the agent token. The token itself is never stored.' },
      { name: 'revoked', type: 'boolean', note: 'Booleans come back as STRINGS. Always read through readBool() -- "false" is truthy in JS.' },
      { name: 'created_at', type: 'datetime', mandatory: true },
    ],
  },
  {
    name: 'members',
    purpose: 'Humans in a project, and what they may do.',
    atomic_on: 'member_key',
    columns: [
      { name: 'member_key', ...ID, unique: true, mandatory: true, note: 'COMPOSITE "<project_id>:<zuid>".' },
      { name: 'project_id', ...ID, mandatory: true, search_index: true },
      { name: 'zuid', ...ID, mandatory: true, note: 'Zoho user id from Authentication. Never accepted from the client.' },
      { name: 'label', type: 'text', mandatory: true },
      { name: 'is_owner', type: 'boolean', note: 'Read through readBool().' },
      { name: 'created_at', type: 'datetime', mandatory: true },
    ],
  },
  {
    name: 'roles',
    purpose: 'Role definitions and their permissions, including the one that decides who may merge.',
    atomic_on: 'role_key',
    columns: [
      { name: 'role_key', ...ID, unique: true, mandatory: true, note: 'COMPOSITE "<project_id>:<role_slug>".' },
      { name: 'project_id', ...ID, mandatory: true, search_index: true },
      { name: 'role_slug', ...ID, mandatory: true },
      { name: 'label', type: 'text', mandatory: true },
      { name: 'can_merge', type: 'boolean',
        note: 'READ THROUGH readBool(). A truthy "false" here is an agent merging when it must not -- non-negotiable H3.' },
      { name: 'prompt_path', ...ID, note: 'Pointer into the git blackboard. The prompt itself is never a column -- text caps at 10,000.' },
      { name: 'created_at', type: 'datetime', mandatory: true },
    ],
  },
  {
    name: 'github_links',
    purpose: 'Repo binding for the webhook. An unmappable repo is logged and dropped, never a 500 (D6).',
    atomic_on: 'repo_full_name',
    columns: [
      { name: 'repo_full_name', ...ID, unique: true, mandatory: true, note: 'owner/repo. One repo maps to one project.' },
      { name: 'project_id', ...ID, mandatory: true, search_index: true },
      { name: 'webhook_secret_hash', ...ID, mandatory: true, note: 'The secret is held in a Catalyst environment variable; only its hash is stored here.' },
      { name: 'installed_by', ...ID, mandatory: true },
      { name: 'created_at', type: 'datetime', mandatory: true },
    ],
  },
];

export function tableByName(name: string): TableSpec {
  const t = TABLES.find((x) => x.name === name);
  if (!t) throw new Error(`unknown table: ${name}`);
  return t;
}

/** Build the composite key that stands in for a per-project unique constraint. */
export function compositeKey(...parts: string[]): string {
  for (const p of parts) {
    if (p.includes(':')) {
      // A colon inside a part would let "a:b" + "c" collide with "a" + "b:c".
      throw new Error(`composite key part may not contain ':' -- got ${JSON.stringify(p)}`);
    }
    if (p.length === 0) throw new Error('composite key part may not be empty');
  }
  return parts.join(':');
}

/** The MCP/API payload for one column, ready for CatalystbyZoho_Create_Column. */
export function toCreateColumnPayload(col: ColumnSpec): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    column_name: col.name,
    data_type: col.type,
    is_mandatory: col.mandatory ? 'true' : 'false',
    audit_consent: 'false',
  };
  // text and encrypted text accept neither is_unique nor search_index_enabled.
  if (col.type !== 'text') {
    payload.is_unique = col.unique ? 'true' : 'false';
    payload.search_index_enabled = col.search_index ? 'true' : 'false';
  }
  if (col.type === 'varchar') payload.max_length = col.max_length ?? 255;
  if (col.note) payload.description = col.note.slice(0, 255);
  return payload;
}
