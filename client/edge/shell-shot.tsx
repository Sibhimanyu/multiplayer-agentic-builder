// Renders the order-0071 shell with fixture data, so the layout can be SEEN.
// The board itself needs membership; this needs nothing, which is the point.
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, writeFileSync } from 'node:fs';
import { Sidebar, TopBar, ScopeRail } from '../src/Shell';
import { Queue } from '../src/Queue';
import type { TaskView, AgentPresence } from '../src/store/types';

const t = (o: Partial<TaskView> & { task_id: string; title: string }): TaskView => ({
  kind: 'backend', status: 'open', claimed_by: null, branch: null, pr_url: null, pr_number: null,
  ci: null, depends_on: [], blocked_by: null, blocked_reason: null, file_scope: [],
  updated_at: '2026-09-17T09:00:00.000Z', ...o,
});
const a = (o: Partial<AgentPresence> & { agent_id: string; member_label: string }): AgentPresence => ({
  role_slug: 'backend', initials: 'XX', harness: 'claude-code', status: 'working',
  current_task: null, branch: null, last_heartbeat_at: '2026-09-17T09:00:00.000Z', stale: false, ...o,
});

const ready = [
  { task: t({ task_id: '0412', title: 'PATCH /items/:sku returns 404 for existing rows', kind: 'backend', file_scope: ['server/routes/items/**'] }) },
  { task: t({ task_id: '0409', title: 'Duplicate SKU returns 201 instead of 409', kind: 'backend', file_scope: ['server/services/sku/**'] }) },
  { task: t({ task_id: '0407', title: 'docs/api.md is missing the DELETE contract', kind: 'docs', file_scope: ['docs/**'] }) },
  { task: t({ task_id: '0402', title: 'smoke test does not cover the 409 path', kind: 'qa', file_scope: ['test/smoke/**'] }),
    blocker: { kind: 'depends' as const, detail: 'the 409 response does not exist yet, so the test would assert nothing' } },
  { task: t({ task_id: '0398', title: 'Warehouse filter drops rows when the sku has a trailing space', kind: 'frontend', file_scope: ['web/**'] }),
    blocker: { kind: 'scope' as const, detail: 'web/** is held by Marcus Bell' } },
];
const mine = [
  { task: t({ task_id: '0391', title: 'GET /items returns stale counts after a bulk import', kind: 'backend', status: 'in_progress', claimed_by: 'u1', file_scope: ['server/services/inventory/**'] }) },
];
const agents = [
  a({ agent_id: 'u1', member_label: 'Sibhimanyu G', initials: 'SG', role_slug: 'backend' }),
  a({ agent_id: 'u2', member_label: 'Marcus Bell', initials: 'MB', role_slug: 'frontend', harness: 'codex' }),
  a({ agent_id: 'u3', member_label: 'Priya Raghavan', initials: 'PR', role_slug: 'client', harness: 'manual', status: 'connected' }),
];
const locks = { 'server/services/inventory/**': 'u1', 'web/**': 'u2' };
const session = { uid: 'u1', email: 'sibhi.gv@gmail.com', anonymous: false };

const body = renderToStaticMarkup(
  <div className="shell">
    <Sidebar current="queue" counts={{ queue: 6, board: 31 }} projectName="inventory-tracker"
      onNavigate={() => {}} onNewProject={() => {}} agentsLive={3} />
    <TopBar repoUrl="https://github.com/sibhimanyu/inventory-tracker" session={session}
      onSignOut={() => {}} onNewTask={() => {}} />
    <div className="main">
      <Queue project_id="p1" projectName="inventory-tracker" ready={ready} mine={mine}
        canClaim canCreate agentConnected projectEmpty={false}
        onClaimed={() => {}} onNewTask={() => {}} />
    </div>
    <ScopeRail agents={agents} locks={locks} />
  </div>,
);

const css = readFileSync(new URL('../src/tokens.css', import.meta.url), 'utf8');
writeFileSync(process.argv[2] ?? '/tmp/shell.html',
  `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>`
  + `<body><div id="root">${body}</div></body></html>`);
console.log('SHELL_SHOT_OK');
