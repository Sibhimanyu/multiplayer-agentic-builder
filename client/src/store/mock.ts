// Mock store for Phase 0. Lets the dashboard be built and reviewed before either
// backend exists. Phase 1 replaces this import with catalystStore or firestoreStore.
// Nothing else in client/ changes.

import type { CoordinationStore, Snapshot, Freshness } from './types';

// Relative to call time. A fixed literal made the freshness pill read "842s ago"
// and the blocked badge read "22m" — both artefacts of a stale mock, not real state.
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();
const now = iso(0);

const SNAPSHOT: Snapshot = {
  project_id: 'proj_inventory', seq: 4211, generated_at: now,
  project_name: 'Inventory Tracker', repo_url: 'zoho-cat/inventory-tracker',
  agents: [
    { agent_id: 'a_arch', role_slug: 'architect', member_label: 'sibhi', initials: 'AR',
      harness: 'claude-code', status: 'idle', current_task: null, branch: null,
      last_heartbeat_at: now, stale: false },
    { agent_id: 'a_be', role_slug: 'backend-builder', member_label: 'sibhi', initials: 'BE',
      harness: 'claude-code', status: 'working', current_task: 'task_items_crud',
      branch: 'agent/backend/task-items-crud', last_heartbeat_at: now, stale: false },
    { agent_id: 'a_fe', role_slug: 'frontend-builder', member_label: 'priya', initials: 'FE',
      harness: 'codex', status: 'blocked', current_task: 'task_items_ui',
      branch: 'agent/frontend/task-items-ui', last_heartbeat_at: now, stale: false },
    { agent_id: 'a_qa', role_slug: 'qa-verifier', member_label: 'ci', initials: 'QA',
      harness: 'manual', status: 'offline', current_task: null, branch: null,
      last_heartbeat_at: iso(41 * 60_000), stale: true },
  ],
  tasks: [
    { task_id: 'task_qa_smoke', title: 'Smoke test create, list, update, delete', kind: 'qa',
      status: 'open', claimed_by: null, branch: null, pr_url: null, pr_number: null, ci: null,
      depends_on: ['task_items_crud'], blocked_by: null, blocked_reason: null,
      file_scope: ['test/**'], updated_at: now },
    { task_id: 'task_items_detail', title: 'Item detail view with edit and delete',
      kind: 'frontend', status: 'open', claimed_by: null, branch: null, pr_url: null,
      pr_number: null, ci: null, depends_on: [], blocked_by: null, blocked_reason: null,
      file_scope: ['client/src/routes/items/**'], updated_at: now },
    { task_id: 'task_api_docs', title: 'Write API reference for items endpoints', kind: 'docs',
      status: 'open', claimed_by: null, branch: null, pr_url: null, pr_number: null, ci: null,
      depends_on: [], blocked_by: null, blocked_reason: null, file_scope: ['docs/api/**'],
      updated_at: now },
    { task_id: 'task_items_crud', title: 'Implement item CRUD functions', kind: 'backend',
      status: 'in_progress', claimed_by: 'a_be',
      description: 'Create Advanced I/O handlers for POST, GET, PATCH and DELETE on /items. Use the published schema. Return 409 on duplicate SKU.',
      branch: 'agent/backend/task-items-crud', pr_url: null, pr_number: null, ci: null,
      depends_on: [], blocked_by: null, blocked_reason: null,
      file_scope: ['functions/items/**'], updated_at: now },
    { task_id: 'task_items_ui', title: 'Build item list and add-item form', kind: 'frontend',
      status: 'in_progress', claimed_by: 'a_fe', branch: 'agent/frontend/task-items-ui',
      pr_url: null, pr_number: null, ci: null, depends_on: ['task_items_crud'],
      blocked_by: 'task_items_crud',
      blocked_reason: 'Waiting on items-api v2. Contract v1 sent qty as a string.',
      blocked_since: iso(8 * 60_000),
      file_scope: ['client/src/routes/items/ItemList.tsx'], updated_at: now },
    { task_id: 'task_schema', title: 'Define items schema and API contract', kind: 'docs',
      status: 'needs_review', claimed_by: 'a_arch', branch: 'agent/arch/contract-v2',
      pr_url: null, pr_number: null, ci: null, depends_on: [], blocked_by: null,
      blocked_reason: null, file_scope: ['contracts/**', 'schema/**'], updated_at: now },
    { task_id: 'task_migration', title: 'Data Store table and seed migration', kind: 'backend',
      status: 'needs_review', claimed_by: 'a_be', branch: 'agent/backend/migration',
      pr_url: null, pr_number: null, ci: null, depends_on: [], blocked_by: null,
      blocked_reason: null, file_scope: ['schema/**'], updated_at: now },
    { task_id: 'task_crud_pr', title: 'Add item CRUD functions', kind: 'backend',
      status: 'pr_open', claimed_by: 'a_be', branch: 'agent/backend/task-items-crud',
      pr_url: 'https://github.com/zoho-cat/inventory-tracker/pull/12', pr_number: 12,
      ci: 'failed', depends_on: [], blocked_by: null, blocked_reason: null,
      file_scope: ['functions/items/**'], updated_at: now },
    { task_id: 'task_scaffold', title: 'Scaffold Catalyst project and Slate app',
      kind: 'devops', status: 'merged', claimed_by: 'a_arch', branch: 'agent/arch/scaffold',
      pr_url: 'https://github.com/zoho-cat/inventory-tracker/pull/9', pr_number: 9,
      ci: 'passed', depends_on: [], blocked_by: null, blocked_reason: null,
      file_scope: ['catalyst.json'], updated_at: now },
  ],
  locks: [
    { agent_id: 'a_be', task_id: 'task_items_crud', globs: ['functions/items/**'], acquired_at: now },
    { agent_id: 'a_fe', task_id: 'task_items_ui', globs: ['client/src/routes/items/**'], acquired_at: now },
  ],
  contracts: [
    { name: 'items-api', version: 2, path: 'contracts/items-api.v2.yaml',
      commit_sha: 'a3f9c1e0d4b28f6712c9ab3e5580f1d2c7e46a9b', supersedes: 1,
      published_by: 'a_be', published_at: now,
      preview: [
        'post /items:',
        '  body:',
        '    name:  string     # required',
        '    sku:   string     # unique',
        '    qty:   integer    # was string in v1',
        '  returns:',
        '    201  { item_id, name, sku, qty }',
        '    409  { error: "sku_exists" }',
      ].join('\n') },
  ],
};

/** Swap `mode` to 'live' to preview the Firebase-side freshness affordance. */
export function createMockStore(mode: Freshness['mode'] = 'poll'): CoordinationStore {
  return {
    freshness: { mode, stale_ms: mode === 'poll' ? 5000 : 0 },
    subscribe(_pid, _from, onChange) {
      // Fires immediately with current state, per the interface contract.
      onChange({ ...SNAPSHOT, generated_at: iso(0) });
      // Poll mode re-publishes so the freshness counter behaves like the real thing.
      if (mode !== 'poll') return () => {};
      const id = setInterval(() => onChange({ ...SNAPSHOT, generated_at: iso(0) }), 5000);
      return () => clearInterval(id);
    },
  };
}
