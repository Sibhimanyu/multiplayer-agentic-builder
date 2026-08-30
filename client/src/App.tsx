// App owns the single subscription for the whole page. Everything below gets props.
// Phase 1: replace the createMockStore import with the platform store. Nothing else changes.
//   Catalyst  -> import { createCatalystStore }  from './store/catalyst';
//   Firebase  -> import { createFirestoreStore } from './store/firebase';

import { useEffect, useMemo, useState } from 'react';
import { COLUMNS, type Snapshot } from './store/types';
import { createFirestoreStore } from './store/firebase';
import { DetailPanel, EmptyColumn, TaskCard, TopNav } from './components';

const PROJECT_ID = 'proj_inventory';

export default function App() {
  const store = useMemo(() => createFirestoreStore(), []);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [selected, setSelected] = useState<string | null>('task_items_crud');

  useEffect(() => store.subscribe(PROJECT_ID, 0, setSnap), [store]);

  // Stable placeholder height: no layout shift when the first snapshot lands.
  if (!snap) return <div style={{ padding: 28, color: 'var(--muted)' }}>Connecting…</div>;

  const agentById = new Map(snap.agents.map((a) => [a.agent_id, a]));
  const taskById = new Map(snap.tasks.map((t) => [t.task_id, t]));
  const latestContract = snap.contracts.at(-1);
  const sel = selected ? taskById.get(selected) : undefined;

  return (
    <>
      <TopNav snap={snap} freshness={store.freshness} />
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
                          key={t.task_id} task={t}
                          agent={t.claimed_by ? agentById.get(t.claimed_by) : undefined}
                          selected={t.task_id === selected}
                          onSelect={() => setSelected(t.task_id)}
                          contractVersion={
                            t.task_id === 'task_schema' ? latestContract?.version : undefined
                          }
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
            blockedByTask={sel.blocked_by ? taskById.get(sel.blocked_by) : undefined}
            onClose={() => setSelected(null)}
          />
        )}
      </div>
    </>
  );
}
