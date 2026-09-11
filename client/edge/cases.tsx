// The nine edge cases of docs/designs/dashboard.md, RENDERED and asserted.
//
// Why server-rendering rather than a browser: no browser is reachable from this sandbox, and
// "I read the component and it looks right" is exactly the kind of claim this project has been
// burned by. renderToStaticMarkup runs the REAL frozen components.tsx and the REAL BoardView
// that App renders, so what is asserted here is what ships. What it cannot see is layout --
// anything decided by CSS (wrapping, overlay geometry) is checked against tokens.css by rule
// rather than by pixel, and that limit is stated per case below.
//
// Built and run by client/edge/run.mjs.

import { renderToStaticMarkup } from 'react-dom/server';
import { BoardView, blockedChain } from '../src/App';
import type {
  AgentPresence, ContractPointer, Freshness, Snapshot, TaskStatus, TaskView,
} from '../src/store/types';

let failed = 0;
const results: string[] = [];
const check = (ok: boolean, label: string) => {
  results.push(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed += 1;
};

const LIVE: Freshness = { mode: 'live', stale_ms: 0 };
const POLL: Freshness = { mode: 'poll', stale_ms: 5_000 };

const task = (over: Partial<TaskView> & { task_id: string }): TaskView => ({
  title: 'a task', kind: 'backend', status: 'open' as TaskStatus, claimed_by: null,
  branch: null, pr_url: null, pr_number: null, ci: null, depends_on: [],
  blocked_by: null, blocked_reason: null, file_scope: [], updated_at: '2026-09-11T10:00:00.000Z',
  ...over,
});

const agent = (over: Partial<AgentPresence> & { agent_id: string }): AgentPresence => ({
  role_slug: 'backend-builder', member_label: 'sibhi', initials: 'BE', harness: 'claude-code',
  status: 'working', current_task: null, branch: null,
  last_heartbeat_at: '2026-09-11T10:00:00.000Z', stale: false,
  ...over,
});

const snapshot = (over: Partial<Snapshot> = {}): Snapshot => ({
  project_id: 'proj_inventory', seq: 12, generated_at: '2026-09-11T10:00:00.000Z',
  project_name: 'Inventory Tracker', repo_url: 'Sibhimanyu/inventory-tracker',
  tasks: [], agents: [], locks: [], contracts: [],
  ...over,
});

const render = (snap: Snapshot, freshness: Freshness = LIVE, selected: string | null = null) =>
  renderToStaticMarkup(
    <BoardView snap={snap} freshness={freshness} selected={selected} onSelect={() => {}} />,
  );

// ---------------------------------------------------------------- locked patterns

{
  const html = render(snapshot({ tasks: [task({ task_id: 't1', status: 'open' })] }));
  for (const label of ['Open', 'Claimed', 'In progress', 'Needs review', 'PR open', 'Merged']) {
    check(html.includes(`<h3>${label}</h3>`), `locked 1: column "${label}" renders`);
  }
  check((html.match(/class="count"/g) ?? []).length === 6, 'locked 1: six count badges, one per column');
  check(html.includes('<span class="count">1</span>'), 'locked 1: the count reflects the tasks in the column');
}

{
  // locked 3: the panel OVERLAYS. The bug it replaced displaced the columns, which pushed
  // "PR open" and "Merged" off screen -- so the assertion is that all six survive with the
  // panel open, not merely that the panel exists.
  const snap = snapshot({ tasks: [task({ task_id: 't1' })] });
  const html = render(snap, LIVE, 't1');
  check(html.includes('class="panel"'), 'locked 3: detail panel renders when a task is selected');
  check(html.includes('<h3>PR open</h3>') && html.includes('<h3>Merged</h3>'),
    'locked 3: PR open and Merged still render WITH the panel open (not displaced)');
  check((html.match(/class="col"/g) ?? []).length === 6, 'locked 3: all six columns still present');
  // Geometry lives in the frozen tokens.css and is checked there by rule: .panel is
  // position:absolute;right:0;z-index:20 and .board carries padding-right:400px.
}

{
  const live = render(snapshot());
  const poll = render(snapshot(), POLL);
  check(live.includes('data-mode="live"') && live.includes('>live<'), 'locked 4: live mode shows a steady dot and the word live');
  check(!/updated \d+s ago/.test(live), 'locked 4: live mode shows NO counter');
  check(poll.includes('data-mode="poll"') && /updated \d+s ago/.test(poll), 'locked 4: poll mode counts up');
}

// ---------------------------------------------------------------- the nine edge cases

// 1. 47-char title wraps, never truncates mid-word.
{
  const t47 = 'Implement the inventory item quantity editor UI';   // 47
  check(t47.length === 47, `fixture is 47 chars (${t47.length})`);
  const html = render(snapshot({ tasks: [task({ task_id: 't1', title: t47 })] }));
  check(html.includes(t47), 'edge 1: the full 47-char title is present, not truncated');
  check(!html.includes('…' + t47.slice(-10)), 'edge 1: no ellipsis applied to the title');
  // Wrapping itself is CSS: .card .title sets overflow-wrap:break-word with no nowrap and no
  // text-overflow, so it wraps and the card grows. Asserted against tokens.css by run.mjs.
}

// 2. 90-char path truncates from the LEFT, filename stays visible.
{
  const path = 'functions/src/handlers/inventory/items/quantity/adjust/validators/quantity-bounds.ts';
  const long = path.padStart(90, 'x/');
  const html = render(
    snapshot({ tasks: [task({ task_id: 't1', file_scope: [long] })] }), LIVE, 't1',
  );
  check(long.length >= 90, `fixture is >=90 chars (${long.length})`);
  check(html.includes('…'), 'edge 2: an ellipsis is rendered for the long path');
  check(html.includes('quantity-bounds.ts'), 'edge 2: the FILENAME survives truncation');
  check(!html.includes(`<span class="nm">${long}`), 'edge 2: the full path is not rendered raw');
  check(html.includes(`title="${long}"`), 'edge 2: the untruncated path is still available on hover');
}

// 3. Zero tasks in a column -> dashed empty state with the approved copy.
{
  const html = render(snapshot({ tasks: [] }));
  check((html.match(/class="empty"/g) ?? []).length === 6, 'edge 3: every empty column gets the empty state');
  check(html.includes('Nothing claimed') && html.includes('Tasks land here the moment an agent calls claim.'),
    'edge 3: the approved copy is used verbatim');
  // Dashed border is tokens.css .empty{border:1.5px dashed} -- asserted by run.mjs.
}

// 4. Zero agents -> "no agents connected", not an empty gap.
{
  const html = render(snapshot({ agents: [] }));
  check(html.includes('no agents connected'), 'edge 4: zero agents shows the explicit label');
}

// 5. Blocked chain A -> B -> C: the panel must list the FULL chain.
{
  const a = task({ task_id: 'task_a', blocked_by: 'task_b', blocked_reason: 'waiting on the schema' });
  const b = task({ task_id: 'task_b', blocked_by: 'task_c' });
  const c = task({ task_id: 'task_c' });
  const byId = new Map([a, b, c].map((t) => [t.task_id, t]));

  const chain = blockedChain(a, byId);
  check(chain.map((t) => t.task_id).join('->') === 'task_b->task_c',
    `edge 5: blockedChain() computes the full chain (${chain.map((t) => t.task_id).join('->') || 'empty'})`);

  const cyclic = blockedChain(
    task({ task_id: 'x', blocked_by: 'y' }),
    new Map([['y', task({ task_id: 'y', blocked_by: 'x' })]]),
  );
  check(cyclic.length === 1, 'edge 5: a cyclic chain terminates instead of hanging');

  const html = render(snapshot({ tasks: [a, b, c] }), LIVE, 'task_a');
  check(html.includes('task_b'), 'edge 5: the immediate blocker is listed');
  check(html.includes('task_c'), 'edge 5: the REST of the chain is listed');
}

// 6. CI failed -> red badge on the CARD, visible without opening the panel.
{
  const html = render(snapshot({ tasks: [task({ task_id: 't1', ci: 'failed' })] }));
  check(html.includes('data-t="ci-failed"') && html.includes('CI failed'), 'edge 6: CI failed badge is on the card');
  const cardHtml = html.slice(0, html.indexOf('class="panel"') >>> 0 || undefined);
  check(cardHtml.includes('CI failed'), 'edge 6: and it is in the board, not only the panel');
}

// 7. Agent offline -> grey status ring, stale derived at read time.
{
  const offline = agent({ agent_id: 'a1', status: 'working', stale: true });
  const html = render(snapshot({
    tasks: [task({ task_id: 't1', status: 'claimed', claimed_by: 'a1' })], agents: [offline],
  }));
  check(html.includes('data-ring="offline"'), 'edge 7: a stale agent gets the offline (grey) ring');
  const live = render(snapshot({
    tasks: [task({ task_id: 't1', status: 'claimed', claimed_by: 'a1' })],
    agents: [agent({ agent_id: 'a1' })],
  }));
  check(live.includes('data-ring="ok"'), 'edge 7: a fresh agent does not');
  check(html.includes('data-ring="blocked"') === false, 'edge 7: stale outranks status, it does not show as blocked');
}

// 8. Snapshot stale -> the pill counts up and never claims a false live state.
{
  const poll = render(snapshot({ generated_at: new Date(Date.now() - 42_000).toISOString() }), POLL);
  check(/updated \d+s ago/.test(poll), 'edge 8: a stale snapshot counts up');
  check(!poll.includes('>live<'), 'edge 8: and never renders a false live state');
}

// 9. 10 agents -> avatars collapse to +6.
{
  const many = Array.from({ length: 10 }, (_, i) =>
    agent({ agent_id: `a${i}`, initials: `A${i}` }));
  const html = render(snapshot({ agents: many }));
  const more = /class="more">\+(\d+)</.exec(html)?.[1];
  check(more === '6', `edge 9: 10 agents collapse to +6 (rendered +${more ?? 'none'})`);
  check((html.match(/class="av"/g) ?? []).length === 4, 'edge 9: and exactly 4 avatars are shown');
}

// ---------------------------------------------------------------- no layout shift
{
  // locked 7: re-rendering identical data must produce byte-identical markup. If any key or
  // height depended on load state or array position, this would differ.
  const snap = snapshot({
    tasks: [task({ task_id: 't1' }), task({ task_id: 't2', status: 'merged' })],
    agents: [agent({ agent_id: 'a1' })],
  });
  check(render(snap) === render(snap), 'locked 7: identical data renders byte-identical markup');
  const reordered = snapshot({ ...snap, tasks: [snap.tasks[1], snap.tasks[0]] });
  check(render(snap).length === render(reordered).length,
    'locked 7: task array order does not change the rendered size (keys are stable ids)');
}

console.log(results.join('\n'));
console.log(
  `\n${failed === 0 ? 'EDGE CASES PASSED' : 'EDGE CASES FAILED'} ` +
    `(${results.length - failed}/${results.length} server-rendered assertions)`,
);
if (failed > 0) process.exitCode = 1;

export {};
