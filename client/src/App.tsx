// App owns the single subscription for the whole page. Everything below gets props.
// Phase 1: replace the createMockStore import with the platform store. Nothing else changes.
//   Catalyst  -> import { createCatalystStore }  from './store/catalyst';
//   Firebase  -> import { createFirestoreStore } from './store/firebase';

import { useEffect, useMemo, useState } from 'react';
import { COLUMNS, type Freshness, type Snapshot, type TaskView } from './store/types';
import { createFirestoreStore, type StoreStatus } from './store/firebase';
import { DetailPanel, EmptyColumn, TaskCard, TopNav } from './components';

const PROJECT_ID = 'proj_inventory';

/**
 * The pre-board states, rendered as themselves.
 *
 * Deliberately the same shape as the "Connecting…" placeholder this replaces -- a padded block
 * using the existing colour tokens -- because components.tsx and tokens.css are frozen and a
 * failure message is not a reason to invent chrome. What changes is that it now SAYS which
 * failure it is, and what fixes it.
 */
function Notice({ status }: { status: StoreStatus }) {
  const base = { padding: 28, color: 'var(--muted)', maxWidth: 620, lineHeight: 1.6 } as const;

  if (status.state === 'signing-in') return <div style={base}>Connecting…</div>;

  if (status.state === 'live') {
    // Signed in and allowed, but no snapshot yet. Distinct from signing-in on purpose: it tells
    // you the rules are not the problem.
    return <div style={base}>Loading the board…</div>;
  }

  if (status.state === 'auth-unavailable') {
    return (
      <div style={base}>
        <strong style={{ color: 'var(--red)' }}>Sign-in is unavailable.</strong>
        <div style={{ marginTop: 8 }}>{status.detail}</div>
        <div style={{ marginTop: 8, opacity: 0.7 }}>({status.code})</div>
      </div>
    );
  }

  if (status.state === 'denied') {
    return (
      <div style={base}>
        <strong style={{ color: 'var(--amber)' }}>Not a member of this project.</strong>
        <div style={{ marginTop: 8 }}>
          Signed in, but the security rules do not grant this browser read access to{' '}
          <code>{status.project_id}</code>. This is the rules working, not an outage.
        </div>
        <div style={{ marginTop: 8 }}>Admit this browser by running:</div>
        <div style={{ marginTop: 6, color: 'var(--ink)', userSelect: 'all' }}>
          <code>node firebase/bridge-run.ts --admit {status.uid}</code>
        </div>
      </div>
    );
  }

  return (
    <div style={base}>
      <strong style={{ color: 'var(--red)' }}>Could not load the board.</strong>
      <div style={{ marginTop: 8 }}>{status.detail}</div>
    </div>
  );
}

/**
 * Walk `blocked_by` to its end, so the panel can show A -> B -> C rather than just A -> B.
 *
 * Cycle-guarded: a chain that loops is data corruption, and the right response is to stop and
 * render what was reached, not to hang the board.
 *
 * Lives here rather than in DetailPanel because the walk needs `taskById`, and components take
 * data in via props and look nothing up themselves.
 */
export function blockedChain(task: TaskView, byId: Map<string, TaskView>): TaskView[] {
  const chain: TaskView[] = [];
  const seen = new Set<string>([task.task_id]);
  let next = task.blocked_by;
  while (next && !seen.has(next)) {
    seen.add(next);
    const t = byId.get(next);
    if (!t) break;
    chain.push(t);
    next = t.blocked_by;
  }
  return chain;
}

/**
 * The whole board, as a pure function of a snapshot.
 *
 * Split out from App so the nine edge cases in docs/designs/dashboard.md can be rendered and
 * ASSERTED (client/edge/cases.tsx) rather than eyeballed. App keeps the single subscription;
 * everything below here receives props, which is what the design's component contract requires
 * and what keeps both builds' trees identical.
 */
export function BoardView({
  snap,
  freshness,
  selected,
  onSelect,
}: {
  snap: Snapshot;
  freshness: Freshness;
  selected: string | null;
  onSelect: (id: string | null) => void;
}) {
  const agentById = new Map(snap.agents.map((a) => [a.agent_id, a]));
  const taskById = new Map(snap.tasks.map((t) => [t.task_id, t]));
  const latestContract = snap.contracts.at(-1);
  const sel = selected ? taskById.get(selected) : undefined;

  return (
    <>
      <TopNav snap={snap} freshness={freshness} />
      <div className="stage">
        <div className="board">
          {COLUMNS.map(({ status, label }) => {
            const tasks = snap.tasks.filter((t) => t.status === status);
            return (
              <section className="col" key={status}>
                <div className="col-head">
                  <h3>{label}</h3><span className="count">{tasks.length}</span>
                </div>
                <div className="col-body">
                  {tasks.length === 0
                    ? <EmptyColumn label={label} />
                    : tasks.map((t) => (
                        <TaskCard
                          // task_id, never the array index: a stable key is what stops a
                          // re-render with identical data from reflowing the column.
                          key={t.task_id} task={t}
                          agent={t.claimed_by ? agentById.get(t.claimed_by) : undefined}
                          selected={t.task_id === selected}
                          onSelect={() => onSelect(t.task_id)}
                          // Same rule the panel uses, rather than the hardcoded task id this
                          // carried from the mock. There is no task->contract link in the data
                          // model, so card and panel at least agree on one rule instead of two.
                          contractVersion={t.kind === 'backend' ? latestContract?.version : undefined}
                        />
                      ))}
                </div>
              </section>
            );
          })}
        </div>

        {sel && (
          <DetailPanel
            task={sel}
            agent={sel.claimed_by ? agentById.get(sel.claimed_by) : undefined}
            contract={sel.kind === 'backend' ? latestContract : undefined}
            blockedChain={blockedChain(sel, taskById)}
            onClose={() => onSelect(null)}
          />
        )}
      </div>
    </>
  );
}

export default function App() {
  const store = useMemo(() => createFirestoreStore(), []);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [status, setStatus] = useState<StoreStatus>({ state: 'signing-in' });
  // No default selection: a hardcoded task id opened a panel for a task that need not exist.
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => store.subscribe(PROJECT_ID, 0, setSnap), [store]);
  useEffect(() => store.onStatus(setStatus), [store]);

  // Stable placeholder height: no layout shift when the first snapshot lands.
  if (!snap) return <Notice status={status} />;

  return (
    <BoardView snap={snap} freshness={store.freshness} selected={selected} onSelect={setSelected} />
  );
}
