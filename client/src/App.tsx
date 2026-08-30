// App owns the single subscription for the whole page. Everything below gets props.
// Phase 1: replace the createMockStore import with the platform store. Nothing else changes.
//   Catalyst  -> import { createCatalystStore }  from './store/catalyst';
//   Firebase  -> import { createFirestoreStore } from './store/firebase';

import { useEffect, useMemo, useState } from 'react';
import { COLUMNS, type Snapshot } from './store/types';
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

export default function App() {
  const store = useMemo(() => createFirestoreStore(), []);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [status, setStatus] = useState<StoreStatus>({ state: 'signing-in' });
  const [selected, setSelected] = useState<string | null>('task_items_crud');

  useEffect(() => store.subscribe(PROJECT_ID, 0, setSnap), [store]);
  useEffect(() => store.onStatus(setStatus), [store]);

  // Stable placeholder height: no layout shift when the first snapshot lands.
  if (!snap) return <Notice status={status} />;

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
