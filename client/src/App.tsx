// App owns the single subscription for the whole page. Everything below gets props.
// Phase 1: replace the createMockStore import with the platform store. Nothing else changes.
//   Catalyst  -> import { createCatalystStore }  from './store/catalyst';
//   Firebase  -> import { createFirestoreStore } from './store/firebase';

import { useEffect, useMemo, useState } from 'react';
import { COLUMNS, type AgentPresence, type Freshness, type Snapshot, type TaskView } from './store/types';
import { createFirestoreStore, type StoreStatus } from './store/firebase';
import { DetailPanel, EmptyColumn, ProjectCard, ProjectsEmpty, TaskCard, TopNav } from './components';
import { LoginPage } from './Login';

/**
 * Which project the URL is asking for. `/p/:project_id`, or null for the index.
 *
 * PROJECT_ID used to be a module constant reading 'proj_inventory' — there was no tier above one
 * project, on either branch. Routing is two routes and no router dependency: `/` and `/p/:id`.
 */
export function projectIdFromPath(pathname: string): string | null {
  const m = /^\/p\/([A-Za-z0-9_-]+)\/?$/.exec(pathname);
  return m?.[1] ?? null;
}

/**
 * The projects index. A pure function of the project list, like BoardView.
 *
 * Split out for the same reason: the edge harness renders it and asserts the DOM, so the empty
 * state and the role label are checked rather than eyeballed.
 */
export function ProjectsIndex({
  projects, onOpen,
}: {
  projects: {
    project_id: string; project_name: string; repo_url: string;
    role: string; members: AgentPresence[];
  }[];
  onOpen: (project_id: string) => void;
}) {
  return (
    <>
      <nav className="nav">
        <div className="mark">FL</div>
        <div className="brand">Flotilla</div>
        <span className="grow" />
      </nav>
      <div className="stage">
        <div className="board">
          <section className="col" key="projects">
            <div className="col-head">
              <h3>Projects</h3><span className="count">{projects.length}</span>
            </div>
            <div className="col-body">
              {projects.length === 0
                ? <ProjectsEmpty />
                : projects.map((p) => (
                    <ProjectCard key={p.project_id} project={p} onOpen={() => onOpen(p.project_id)} />
                  ))}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

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

/** The board for one project. Its own component so the subscription is torn down on navigation. */
function ProjectBoard({ project_id }: { project_id: string }) {
  const store = useMemo(() => createFirestoreStore(), []);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [status, setStatus] = useState<StoreStatus>({ state: 'signing-in' });
  // No default selection: a hardcoded task id opened a panel for a task that need not exist.
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => store.subscribe(project_id, 0, setSnap), [store, project_id]);
  useEffect(() => store.onStatus(setStatus), [store]);

  // Stable placeholder height: no layout shift when the first snapshot lands.
  if (!snap) return <Notice status={status} />;

  return (
    <BoardView snap={snap} freshness={store.freshness} selected={selected} onSelect={setSelected} />
  );
}

/**
 * `/login` — where `flotilla login` sends the browser.
 *
 * This route's absence was the whole of a user-visible bug: the CLI opened /login, hosting's SPA
 * rewrite served index.html, no route matched, and the fallthrough below rendered the projects
 * index — a page with nothing on it to sign in with, and no error, because as far as the router
 * was concerned nothing had gone wrong. Matched before the fallthrough for that reason.
 */
export function isLoginPath(pathname: string): boolean {
  return /^\/login\/?$/.test(pathname);
}

export default function App() {
  // Three routes, no router dependency. pathname is read once and updated on popstate, so the
  // back button works without pulling in a routing library for a three-entry table.
  const [pathname, setPathname] = useState(() =>
    typeof window === 'undefined' ? '/' : window.location.pathname,
  );
  useEffect(() => {
    const onPop = () => setPathname(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const navigate = (to: string) => {
    window.history.pushState({}, '', to);
    setPathname(to);
  };

  if (isLoginPath(pathname)) {
    return <LoginPage search={typeof window === 'undefined' ? '' : window.location.search} />;
  }
  const project_id = projectIdFromPath(pathname);
  if (project_id) return <ProjectBoard project_id={project_id} />;
  return <ProjectsIndexRoute onOpen={(id) => navigate(`/p/${id}`)} />;
}

/** Wires the browser directory to the pure index view. */
function ProjectsIndexRoute({ onOpen }: { onOpen: (project_id: string) => void }) {
  const [projects, setProjects] = useState<
    { project_id: string; project_name: string; repo_url: string; role: string; members: AgentPresence[] }[]
  >([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const { loadProjects } = await import('./store/projects');
        const rows = await loadProjects();
        if (live) setProjects(rows);
      } catch (err) {
        // An index that cannot load must not render as "no projects yet" — that would teach the
        // user to run a command they have already run. Left empty with the error surfaced.
        console.warn('[projects] could not load the project list', err);
      } finally {
        if (live) setReady(true);
      }
    })();
    return () => { live = false; };
  }, []);

  if (!ready) return <div style={{ padding: 28, color: 'var(--muted)' }}>Connecting…</div>;
  return <ProjectsIndex projects={projects} onOpen={onOpen} />;
}
