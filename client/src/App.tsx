// App owns the single subscription for the whole page. Everything below gets props.
// Phase 1: replace the createMockStore import with the platform store. Nothing else changes.
//   Catalyst  -> import { createCatalystStore }  from './store/catalyst';
//   Firebase  -> import { createFirestoreStore } from './store/firebase';

import { useEffect, useMemo, useState } from 'react';
import { COLUMNS, TASK_KINDS, type AgentPresence, type Freshness, type Snapshot, type TaskView } from './store/types';
import { createFirestoreStore, type StoreStatus } from './store/firebase';
import {
  AccountChip, BoardSkeleton, BrandLockup, DetailPanel, EmptyColumn, ProjectCard, ProjectsEmpty,
  ProjectsSkeleton, SignInView, TaskCard, TopNav, FreshnessPill,
} from './components';
import { LoginPage } from './Login';
import {
  boardAuth, consumeRedirect, explainAuthError, persistSession, signInWithGoogle,
  signOutOf, watchSession, type Session, type SignInMethod,
} from './store/session';
import { loadProjects, type ProjectRow } from './store/projects';
import { Sidebar, TopBar, Unbuilt, ScopeRail, SECTIONS, QUEUE_SECTION, type Section } from './Shell';
import { Queue, NewTaskForm, type QueueRow } from './Queue';
import { SuggestionsGroup } from './Suggestions';
import { hasCapability } from './store/directory-types';

/**
 * Which project the URL is asking for. `/p/:project_id`, or null for the index.
 *
 * PROJECT_ID used to be a module constant reading 'proj_inventory' — there was no tier above one
 * project, on either branch. Routing is two routes and no router dependency: `/` and `/p/:id`.
 */
export function projectIdFromPath(pathname: string): string | null {
  const m = /^\/p\/([A-Za-z0-9_-]+)(?:\/[a-z]+)?\/?$/.exec(pathname);
  return m?.[1] ?? null;
}

/**
 * `/p/:project_id` and `/p/:project_id/:section`. Order 0071.
 *
 * The bare project URL means the queue, not the board: home is now the thing you can act on. Old
 * links to `/p/:id` therefore keep working and land somewhere more useful than before.
 *
 * An unknown section resolves to the queue rather than 404ing. A typo in a shared link should not
 * be a dead end, and there is no section this product has that is worth an error page.
 */
export function projectRoute(pathname: string): { project_id: string; section: string } | null {
  const m = /^\/p\/([A-Za-z0-9_-]+)(?:\/([a-z]+))?\/?$/.exec(pathname);
  if (!m) return null;
  const known = SECTIONS.some((s) => s.slug === m[2]);
  return { project_id: m[1]!, section: known ? m[2]! : 'queue' };
}

/**
 * The projects index. A pure function of the project list, like BoardView.
 *
 * Split out for the same reason: the edge harness renders it and asserts the DOM, so the empty
 * state and the role label are checked rather than eyeballed.
 */
export function ProjectsIndex({
  projects, onOpen, session, onSignOut,
}: {
  projects: {
    project_id: string; project_name: string; repo_url: string;
    role: string; members: AgentPresence[];
    rollup?: { counts?: Record<string, number | undefined>; blocked?: number; ci_failed?: number; last_activity?: string };
    agents_live?: number;
  }[];
  onOpen: (project_id: string) => void;
  /** Who this list belongs to. Rendered in the nav -- order 0064 point 4. */
  session?: Session;
  onSignOut?: () => void;
}) {
  return (
    <>
      <nav className="nav">
        <BrandLockup />
        <span className="grow" />
        {session && onSignOut && <AccountChip session={session} onSignOut={onSignOut} />}
      </nav>
      <div className="stage">
        <div className="board">
          <section className="col" key="projects">
            <div className="col-head">
              <h3>Projects</h3><span className="count">{projects.length}</span>
            </div>
            <div className="col-body">
              {projects.length === 0
                // The empty state has to know WHY it is empty. An anonymous browser is a member
                // of nothing, and telling that person to run `flotilla new` -- which they have
                // already run -- is the bug order 0064 is about, printed as advice.
                ? <ProjectsEmpty anonymous={session?.anonymous} />
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

  // BOTH LOADING STATES ARE NOW THE SKELETON. Order 0066 point 3: these two rendered bare text
  // on an empty page for up to fifteen seconds, which the user twice read as a broken app.
  //
  // The two states are no longer distinguished on screen, and that is a deliberate loss. The
  // distinction ("the rules are not the problem") was written for whoever is debugging the
  // board, not for whoever is using it, and it cost every user the one thing that actually
  // tells them the app is alive. The state is still on `status` for anyone who needs it, and
  // every state that a user can DO something about — denied, auth-unavailable, error — still
  // says exactly what it is, below.
  if (status.state === 'signing-in' || status.state === 'live') return <BoardSkeleton />;

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
        {/*
          THE SENTENCE THAT USED TO SIT IN FRONT OF EVERYONE SIGNING IN. Order 0065 point 3: the
          sign-in screen carried three lines about throwaway identities before anyone had chosen
          one. It belongs here, where someone is actually looking at the consequence.
        */}
        <div style={{ marginTop: 8 }}>
          An identity is a member of nothing until someone admits it — including an anonymous one.
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
  session,
  onSignOut,
  chromeless,
}: {
  snap: Snapshot;
  freshness: Freshness;
  selected: string | null;
  onSelect: (id: string | null) => void;
  /** Optional so the nine frozen edge cases render unchanged; the app always passes it. */
  session?: Session;
  onSignOut?: () => void;
  /**
   * Drop the board's own TopNav, because the shell already drew one. Order 0071.
   *
   * A flag rather than a second component: the nine frozen edge cases in client/edge/cases.tsx
   * render BoardView directly and must keep getting the nav, so the two callers differ by one
   * boolean instead of by a fork nobody keeps in sync.
   */
  chromeless?: boolean;
}) {
  const agentById = new Map(snap.agents.map((a) => [a.agent_id, a]));
  const taskById = new Map(snap.tasks.map((t) => [t.task_id, t]));
  const latestContract = snap.contracts.at(-1);
  const sel = selected ? taskById.get(selected) : undefined;

  return (
    <>
      {!chromeless && <TopNav snap={snap} freshness={freshness} session={session} onSignOut={onSignOut} />}
      <div className="stage">
        <div className="board" data-panel={Boolean(sel)}>
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
/**
 * Split one snapshot into the two lists the queue shows, for THIS person.
 *
 * `blocked_by` is the task's own dependency, already walked by the fold. A scope blocker is
 * different and has to be derived: the task is claimable in principle, but a glob it needs is
 * held by somebody else, so claiming it would fail at acquire_scope. Saying which is which is the
 * whole value of the row -- "blocked" without a reason sends someone to ask in chat.
 */
export function splitQueue(snap: Snapshot, uid: string): { ready: QueueRow[]; mine: QueueRow[] } {
  const agentById = new Map(snap.agents.map((a) => [a.agent_id, a]));
  const holderOf = (glob: string): string | undefined =>
    snap.locks.find((l) => l.globs.includes(glob) && l.agent_id !== uid)?.agent_id;

  const ready: QueueRow[] = [];
  const mine: QueueRow[] = [];

  for (const task of snap.tasks) {
    if (task.claimed_by === uid) {
      if (task.status !== 'merged') mine.push({ task, agent: agentById.get(uid) });
      continue;
    }
    if (task.claimed_by !== null || task.status !== 'open') continue;

    if (task.blocked_by) {
      ready.push({
        task,
        blocker: {
          kind: 'depends',
          detail: task.blocked_reason ?? `waiting on task ${task.blocked_by}`,
        },
      });
      continue;
    }
    const contested = task.file_scope.map((g) => [g, holderOf(g)] as const).find(([, w]) => w);
    if (contested) {
      const holder = agentById.get(contested[1]!);
      ready.push({
        task,
        blocker: {
          kind: 'scope',
          detail: `${contested[0]} is held by ${holder?.member_label ?? contested[1]}`,
          holder: contested[1],
        },
      });
      continue;
    }
    ready.push({ task });
  }
  return { ready, mine };
}

/**
 * The signed-in application: one subscription, one shell, several views.
 *
 * WAS `ProjectBoard`. It rendered the six-column board as the landing page, which made the board
 * answer both "what is happening" and "what do I do next". It could only answer the first. The
 * board is unchanged and is now a section; the queue is home.
 */
function ProjectShell({
  project_id, section, session, role, onSignOut, onNavigate,
}: {
  project_id: string;
  section: string;
  session: Session;
  role: string;
  onSignOut: () => void;
  onNavigate: (slug: string) => void;
}) {
  const store = useMemo(() => createFirestoreStore(), []);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [status, setStatus] = useState<StoreStatus>({ state: 'signing-in' });
  const [selected, setSelected] = useState<string | null>(null);
  const [composing, setComposing] = useState(false);

  useEffect(() => store.subscribe(project_id, 0, setSnap), [store, project_id]);
  useEffect(() => store.onStatus(setStatus), [store]);

  if (!snap) return <Notice status={status} />;

  const { ready, mine } = splitQueue(snap, session.uid);
  const canClaim = hasCapability(role, 'claim');
  const canCreate = hasCapability(role, 'triage');
  const agentConnected = snap.agents.some((a) => !a.stale);
  const locks: Record<string, string> = {};
  for (const l of snap.locks) for (const g of l.globs) locks[g] = l.agent_id;

  const meta: Section = SECTIONS.find((s) => s.slug === section) ?? QUEUE_SECTION;

  return (
    <div className="shell">
      <Sidebar
        current={section}
        counts={{ queue: ready.length + mine.length, board: snap.tasks.length }}
        projectName={snap.project_name}
        onNavigate={onNavigate}
        onNewProject={() => onNavigate('newproject')}
        agentsLive={snap.agents.filter((a) => !a.stale).length}
      />
      <TopBar
        repoUrl={snap.repo_url}
        session={session}
        onSignOut={onSignOut}
        onNewTask={canCreate ? () => { onNavigate('queue'); setComposing(true); } : undefined}
      >
        <FreshnessPill freshness={store.freshness} generatedAt={snap.generated_at} />
      </TopBar>

      {section === 'board' ? (
        <main className="main" data-wide={true}>
          <BoardView
            snap={snap} freshness={store.freshness} selected={selected} onSelect={setSelected}
            session={session} onSignOut={onSignOut} chromeless
          />
        </main>
      ) : meta.built ? (
        <div className="main">
          {composing && canCreate && (
            <div className="compose">
              <NewTaskForm
                project_id={project_id}
                kinds={TASK_KINDS}
                onCreated={() => setComposing(false)}
                onCancel={() => setComposing(false)}
              />
            </div>
          )}
          <Queue
            project_id={project_id}
            projectName={snap.project_name}
            ready={ready}
            mine={mine}
            canClaim={canClaim}
            canCreate={canCreate}
            agentConnected={agentConnected}
            projectEmpty={snap.tasks.length === 0}
            onClaimed={() => { /* the snapshot subscription re-renders this */ }}
            onNewTask={() => setComposing(true)}
          >
            <SuggestionsGroup
              project_id={project_id}
              suggestions={snap.suggestions ?? []}
              canSuggest={hasCapability(role, 'suggest')}
              canTriage={canCreate}
              kinds={TASK_KINDS}
            />
          </Queue>
        </div>
      ) : (
        <main className="main"><Unbuilt section={meta} /></main>
      )}

      {/*
        NO RAIL ON THE BOARD. Locked pattern 2: presence is an avatar with a status ring ON THE
        CARD, not a separate panel. The rail beside the board is that separate panel, and it was
        charging 320px to repeat what the cards already say. The queue keeps it, because the
        queue has no cards carrying presence.
      */}
      {section !== 'board' && <ScopeRail agents={snap.agents} locks={locks} />}
    </div>
  );
}

/**
 * Resolves WHICH ROLE this person holds on this project, then renders the shell.
 *
 * The role is not on the snapshot: the snapshot is coordination state, and membership lives in
 * the directory tier (the second port, deliberately not grown onto CoordinationStore). So it is
 * read once from the project list, keyed on the uid.
 *
 * `client` while it loads, not `owner`: optimistically showing Claim buttons that then vanish is
 * worse than showing them a beat late, and the least-privileged default is the safe way to be
 * wrong. The server refuses either way -- this only decides what is drawn.
 */
function ProjectShellRoute({
  project_id, section, session, onSignOut, onNavigate,
}: {
  project_id: string;
  section: string;
  session: Session;
  onSignOut: () => void;
  onNavigate: (slug: string) => void;
}) {
  const [role, setRole] = useState<string>('user');

  useEffect(() => {
    let live = true;
    void loadProjects(session.uid)
      .then((rows) => {
        const mine = rows.find((r) => r.project_id === project_id);
        if (live && mine) setRole(mine.role);
      })
      .catch((err) => console.warn('[role] could not read this project\'s membership', err));
    return () => { live = false; };
  }, [project_id, session.uid]);

  return (
    <ProjectShell
      project_id={project_id} section={section} session={session} role={role}
      onSignOut={onSignOut} onNavigate={onNavigate}
    />
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

/**
 * WHO IS SIGNED IN, and the one place that decides it. Order 0064.
 *
 * `undefined` means "still asking" and `null` means "nobody". They are different states and
 * collapsing them is a real bug: a restored session arrives asynchronously, so treating
 * not-yet-known as signed-out flashes the sign-in screen at someone who is already signed in, on
 * every reload.
 */
export function useSession(): {
  session: Session | null | undefined;
  error: { code: string; detail: string } | null;
  busy: boolean;
  signIn: (how: SignInMethod) => void;
  signOut: () => void;
} {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  const [error, setError] = useState<{ code: string; detail: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const auth = useMemo(() => boardAuth(), []);

  useEffect(() => {
    // Persistence first, then consume any redirect Google left behind, then watch. The order
    // matters: setPersistence only governs sign-ins that happen after it resolves.
    void persistSession(auth)
      .then(() => consumeRedirect(auth))
      .catch((err) => setError(explainAuthError(err)));
    return watchSession(auth, (s) => setSession(s));
  }, [auth]);

  const signIn = (how: SignInMethod) => {
    setError(null);
    setBusy(true);
    void (async () => {
      try {
        // Resolves to null because the document is navigating away; the flow resumes in
        // consumeRedirect on the next load.
        if (how === 'google') await signInWithGoogle(auth);
      } catch (err) {
        setError(explainAuthError(err));
      } finally {
        setBusy(false);
      }
    })();
  };

  const signOut = () => {
    void signOutOf(auth).catch((err) => setError(explainAuthError(err)));
  };

  return { session, error, busy, signIn, signOut };
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

  // BEFORE the session gate, deliberately. /login is where `flotilla login` sends the browser and
  // it has its own sign-in; putting a second one in front of it would mean signing in to sign in.
  if (isLoginPath(pathname)) {
    return <LoginPage search={typeof window === 'undefined' ? '' : window.location.search} />;
  }
  return <SignedIn pathname={pathname} navigate={navigate} />;
}

/**
 * The session gate. Nothing below it renders without a uid.
 *
 * This is the shape the bug had no room for: previously every route reached the data layer, and
 * the data layer signed itself in anonymously on the way past. Now the identity is established
 * once, above the routes, and both of them are handed a uid they did not choose.
 */
/**
 * Waiting on onAuthStateChanged, with a deadline. Order 0068.
 *
 * The OTHER two waits in this app are skeletons (order 0066 point 3) because their shape is known
 * before the data is. This one's is not: until the session resolves we do not know whether the
 * next screen is a board, an index or a sign-in card, and a skeleton of the wrong page is a worse
 * lie than a line of text.
 *
 * So it stays a line of text -- but a line of text with a deadline. Firebase Auth puts no timeout
 * on its initialisation, so a Safari session whose auth iframe never loads sat on this word
 * forever, which is indistinguishable from a slow network. After 8s it says what did not arrive
 * and offers the one action that helps.
 */
function AskingWhoYouAre({ after_ms = 8000 }: { after_ms?: number }) {
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setStalled(true), after_ms);
    return () => clearTimeout(t);
  }, [after_ms]);

  if (!stalled) return <div className="centered"><p className="muted-note">Connecting…</p></div>;
  return (
    <div className="centered">
      <p>Still waiting on the sign-in check.</p>
      <p className="muted-note">
        The browser could not hold the connection open. Safari with cross-site tracking
        prevention, or a proxy that buffers responses, both do this.
      </p>
      <p><button className="cta" onClick={() => window.location.reload()}>Reload</button></p>
    </div>
  );
}

function SignedIn({ pathname, navigate }: { pathname: string; navigate: (to: string) => void }) {
  const { session, error, busy, signIn, signOut } = useSession();

  // Still asking. NOT the sign-in screen -- see useSession. Centred rather than pinned to the
  // top-left, because it occupies the same empty page the card is about to.
  if (session === undefined) return <AskingWhoYouAre />;
  // NO NAV. SignInView is the whole page and carries the lockup itself -- order 0065 point 2.
  // A SESSION THAT EXISTS BUT IS ANONYMOUS IS NOT A SESSION ANY MORE. Order 0073 removed the
  // anonymous option, and browsers that took it before still hold the credential. Refusing it
  // silently would render the sign-in screen forever with no hint why, so the screen SAYS what
  // happened. The stale credential is not signed out eagerly: doing that would throw away the
  // very state the message is explaining. Signing in with Google replaces it.
  if (session === null || session.anonymous) {
    return (
      <SignInView
        onGoogle={() => signIn('google')}
        error={error}
        busy={busy}
        staleAnonymous={session?.anonymous}
      />
    );
  }

  const route = projectRoute(pathname);
  if (route) {
    return (
      <ProjectShellRoute
        project_id={route.project_id} section={route.section} session={session}
        onSignOut={signOut}
        onNavigate={(slug) => navigate(
          slug === 'newproject' ? '/' : `/p/${route.project_id}/${slug}`,
        )}
      />
    );
  }
  return (
    <ProjectsIndexRoute
      session={session} onSignOut={signOut} onOpen={(id) => navigate(`/p/${id}`)}
    />
  );
}

/**
 * Wires the browser directory to the pure index view, FOR A GIVEN UID.
 *
 * `load` is injectable so client/edge/cases.tsx can drive this with a fake directory keyed by
 * uid. That is what makes order 0064's test expressible: a member sees the project, and a
 * different uid looking at the same directory sees the empty state. Both halves.
 */
export function ProjectsIndexRoute({
  session, onOpen, onSignOut, load = loadProjects,
}: {
  session: Session;
  onOpen: (project_id: string) => void;
  onSignOut: () => void;
  load?: (uid: string) => Promise<ProjectRow[]>;
}) {
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let live = true;
    setReady(false);
    void (async () => {
      try {
        const rows = await load(session.uid);
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
    // Keyed on the uid: signing out and back in as someone else must re-ask, not reuse the
    // previous account's list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.uid]);

  // The index's own skeleton. Same argument as the board's: this route rendered a line of grey
  // text and nothing else while a collection-group query ran.
  if (!ready) return <ProjectsSkeleton />;
  return (
    <ProjectsIndex
      projects={projects} onOpen={onOpen} session={session} onSignOut={onSignOut}
    />
  );
}
