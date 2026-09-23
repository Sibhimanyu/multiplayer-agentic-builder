// The Fleet board INSIDE the shell, so the horizontal-scroll arithmetic can be measured.
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, writeFileSync } from 'node:fs';
import { Sidebar, TopBar } from '../src/Shell';
import { BoardView } from '../src/App';
import type { Snapshot } from '../src/store/types';

const snap: Snapshot = {
  project_id: 'p1', seq: 9, generated_at: '2026-09-17T09:00:00.000Z',
  project_name: 'inventory-tracker', repo_url: 'https://github.com/sibhimanyu/inventory-tracker',
  tasks: [
    { task_id:'0412', title:'PATCH /items/:sku returns 404 for existing rows', kind:'backend', status:'open', claimed_by:null, branch:'agent/backend-sku-404', pr_url:null, pr_number:null, ci:null, depends_on:[], blocked_by:null, blocked_reason:null, file_scope:['server/**'], updated_at:'2026-09-17T09:00:00.000Z' },
    { task_id:'0409', title:'Duplicate SKU returns 201 instead of 409', kind:'backend', status:'claimed', claimed_by:'u1', branch:'agent/backend-sku-409', pr_url:null, pr_number:null, ci:null, depends_on:[], blocked_by:null, blocked_reason:null, file_scope:['server/**'], updated_at:'2026-09-17T09:00:00.000Z' },
    { task_id:'0402', title:'smoke test does not cover the 409 path', kind:'qa', status:'in_progress', claimed_by:'u2', branch:'agent/qa-smoke-409', pr_url:null, pr_number:null, ci:'failed', depends_on:[], blocked_by:'0409', blocked_reason:'waiting on 0409', blocked_since:'2026-09-17T08:30:00.000Z', file_scope:['test/**'], updated_at:'2026-09-17T09:00:00.000Z' },
    { task_id:'0398', title:'Warehouse filter drops rows when the sku has a trailing space', kind:'frontend', status:'needs_review', claimed_by:'u2', branch:'agent/ui-filter-trim', pr_url:null, pr_number:null, ci:null, depends_on:[], blocked_by:null, blocked_reason:null, file_scope:['web/**'], updated_at:'2026-09-17T09:00:00.000Z' },
    { task_id:'0391', title:'GET /items returns stale counts after a bulk import', kind:'backend', status:'pr_open', claimed_by:'u1', branch:'agent/backend-bulk-stale', pr_url:'x', pr_number:182, ci:'passed', depends_on:[], blocked_by:null, blocked_reason:null, file_scope:['server/**'], updated_at:'2026-09-17T09:00:00.000Z' },
    { task_id:'0384', title:'SKU lookup is case-insensitive again', kind:'backend', status:'merged', claimed_by:'u1', branch:'agent/backend-sku-case', pr_url:'x', pr_number:176, ci:'passed', depends_on:[], blocked_by:null, blocked_reason:null, file_scope:['server/**'], updated_at:'2026-09-17T09:00:00.000Z' },
  ] as any, agents: [
    { agent_id:'u1', role_slug:'backend', member_label:'Sibhimanyu G', initials:'SG', harness:'claude-code', status:'working', current_task:null, branch:null, last_heartbeat_at:'2026-09-17T09:00:00.000Z', stale:false },
    { agent_id:'u2', role_slug:'frontend', member_label:'Marcus Bell', initials:'MB', harness:'codex', status:'working', current_task:null, branch:null, last_heartbeat_at:'2026-09-17T09:00:00.000Z', stale:false },
  ] as any, locks: [], contracts: [],
};
const session = { uid: 'u1', email: 'sibhi.gv@gmail.com', anonymous: false };

const body = renderToStaticMarkup(
  <div className="shell">
    <Sidebar current="board" counts={{ queue: 0, board: 0 }} projectName="inventory-tracker"
      onNavigate={() => {}} onNewProject={() => {}} agentsLive={0} />
    <TopBar repoUrl={snap.repo_url} session={session} onSignOut={() => {}} onNewTask={() => {}} />
    <main className="main" data-wide={true}>
      <BoardView snap={snap} freshness={{ mode: 'live', stale_ms: 0 }} selected={null}
        onSelect={() => {}} session={session} onSignOut={() => {}} chromeless />
    </main>
  </div>,
);
const css = readFileSync(new URL('../src/tokens.css', import.meta.url), 'utf8');
writeFileSync(process.argv[2] ?? '/tmp/board.html',
  `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>`
  + `<body><div id="root">${body}</div></body></html>`);
console.log('BOARD_SHOT_OK');
