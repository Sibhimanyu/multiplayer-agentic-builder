// The signed-in chrome: sidebar, top bar, right rail. Order 0071.
//
// Presentational, like components.tsx. Data in via props, no fetching.
//
// WHAT THIS FIXES. The board answered "what is happening" and was also the landing page, so it
// had to answer "what do I do next" as well, and could not. Home is now a personal queue and the
// six-column state machine becomes a second view. The trunk test -- cover everything but the
// navigation and you can still name the app, the page and the sections -- previously failed: the
// whole nav was a wordmark and an account pill.

import { BrandLockup, AccountChip } from './components';
import type { Session } from './store/session';
import type { AgentPresence } from './store/types';

/**
 * The sections, and whether anything is behind them.
 *
 * `built:false` is not a placeholder to fill in later, it is a claim on screen. Order 0070 is the
 * reason it is modelled rather than styled: "no file locks held" and "file locks are not built"
 * are different sentences, and the dashed empty state already means the first one.
 */
export interface Section {
  slug: string;
  label: string;
  built: boolean;
  /** Live count, for built sections that have one. */
  count?: number;
  /** For unbuilt sections: what does the job today. */
  cli?: string;
  /** For unbuilt sections: what will live here. */
  blurb?: string;
}

/** Home. Named so callers can fall back to it without indexing the array. */
export const QUEUE_SECTION: Section = { slug: 'queue', label: 'My queue', built: true };

export const SECTIONS: Section[] = [
  QUEUE_SECTION,
  { slug: 'board', label: 'Fleet board', built: true },
  {
    slug: 'locks', label: 'File locks', built: false,
    blurb: 'Which agent holds which file scope, and what is queued behind each lock. The rail on '
      + 'this page already shows the held scopes; this view will show the waiting ones too.',
    cli: 'flotilla status',
  },
  {
    slug: 'prs', label: 'Pull requests', built: false,
    blurb: 'Branches, pull requests and CI results from GitHub. Nothing reads GitHub yet: the '
      + 'bridge poll that would fill this is unbuilt, so the board cannot show PR or CI state.',
    cli: 'gh pr list',
  },
  {
    slug: 'people', label: 'People & roles', built: false,
    blurb: 'Members, their roles, and the file scope each role may write. The roles exist and are '
      + 'enforced on every write; there is just no screen for editing them.',
    cli: 'flotilla status',
  },
];

function Icon({ name }: { name: string }) {
  // Drawn, one stroke weight, from one hand. A unicode glyph standing in for an icon system is
  // the thing the craft floor refuses, and an emoji would inherit the platform's own style.
  const d: Record<string, string> = {
    queue: 'M3 5h14M3 10h14M3 15h9',
    board: 'M3 4h4v12H3zM8.5 4h4v8h-4zM14 4h3v5h-3z',
    locks: 'M5 9V6.5a5 5 0 0110 0V9M4 9h12v7H4z',
    prs: 'M6 4v12M6 4a2 2 0 100 4 2 2 0 000-4zM6 16a2 2 0 100-4 2 2 0 000 4zM14 16V9l-4-4',
    people: 'M7 9a3 3 0 100-6 3 3 0 000 6zM2 17a5 5 0 0110 0M13 4.2a3 3 0 010 5.6M14.5 17a5 5 0 00-2-4',
    plus: 'M10 4v12M4 10h12',
  };
  return (
    <svg className="ic" viewBox="0 0 20 20" width="15" height="15" aria-hidden="true"
      fill="none" stroke="currentColor" strokeWidth="1.5"
      strokeLinecap="round" strokeLinejoin="round">
      <path d={d[name] ?? d.queue} />
    </svg>
  );
}

export function Sidebar({
  current, counts, projectName, onNavigate, onNewProject, agentsLive,
}: {
  current: string;
  counts: Record<string, number | undefined>;
  projectName: string;
  onNavigate: (slug: string) => void;
  onNewProject: () => void;
  agentsLive?: number;
}) {
  return (
    <nav className="side" aria-label="Sections">
      <div className="side-head"><BrandLockup /></div>

      <div className="side-sec">Project</div>
      <button className="newproj" onClick={onNewProject}>
        <Icon name="plus" /> New project
      </button>

      <div className="side-sec" id="sec-proj">{projectName}</div>
      <div className="side-nav" role="list" aria-labelledby="sec-proj">
        {SECTIONS.map((s) => (
          <a
            key={s.slug}
            role="listitem"
            href={s.built ? `#/${s.slug}` : undefined}
            aria-current={current === s.slug ? 'page' : undefined}
            data-unbuilt={!s.built}
            aria-disabled={!s.built}
            onClick={(e) => { e.preventDefault(); onNavigate(s.slug); }}
          >
            <Icon name={s.slug} />
            {s.label}
            <span className="ct">{s.built ? (counts[s.slug] ?? '') : 'soon'}</span>
          </a>
        ))}
      </div>

      <div className="side-foot">
        {agentsLive != null
          ? <>Agents on this repo: <strong>{agentsLive}</strong></>
          : 'No agents connected'}
      </div>
    </nav>
  );
}

export function TopBar({
  repoUrl, session, onSignOut, onNewTask, children,
}: {
  repoUrl: string;
  session?: Session;
  onSignOut?: () => void;
  onNewTask?: () => void;
  /** Freshness, presence: whatever the current view wants to put here. */
  children?: React.ReactNode;
}) {
  // The repo, as owner + name. Shown rather than the full URL because the host is the same for
  // every project and repeating it spends the widest element in the bar on nothing.
  const path = repoUrl.replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '');
  const [owner, name] = path.includes('/') ? path.split('/') : ['', path];

  return (
    <header className="topbar">
      <a className="switcher" href={repoUrl} target="_blank" rel="noreferrer">
        <span className="owner">{owner}/</span><span className="repo-name">{name}</span>
      </a>
      {children}
      <span className="grow" />
      {onNewTask && <button className="cta" onClick={onNewTask}>New task</button>}
      {session && onSignOut && <AccountChip session={session} onSignOut={onSignOut} />}
    </header>
  );
}

/**
 * A section with nothing behind it.
 *
 * Says what will be here, that it is not here, and what does the job today. It never renders the
 * dashed empty state: that pattern means "this works and found nothing", which would be a lie.
 */
export function Unbuilt({ section }: { section: Section }) {
  return (
    <div className="stub">
      <h1>{section.label}</h1>
      <p>{section.blurb}</p>
      <p>Not built yet. This is the whole of it — there is no data behind this screen.</p>
      {section.cli && (
        <div className="now">
          <div className="lbl">What does this today</div>
          <code>{section.cli}</code>
        </div>
      )}
    </div>
  );
}

/**
 * Who holds what, right now.
 *
 * The rail is the one place the product's actual mechanism is visible: scopes are held by people,
 * and a held scope is why someone else cannot start. Variant C drew a fuller file-scope map and
 * that is where it belongs, but it is out of scope for this build.
 *
 * A member with no scope is still shown. "Priya is here and holds nothing" and "Priya is not
 * here" are different facts, and the second one is the one that explains a stalled task.
 */
export function ScopeRail({ agents, locks }: {
  agents: AgentPresence[];
  /** scope glob -> agent_id holding it. */
  locks: Record<string, string>;
}) {
  const heldBy = (id: string) =>
    Object.entries(locks).filter(([, who]) => who === id).map(([glob]) => glob);

  return (
    <aside className="rail" aria-label="Who holds what">
      <h3>Agents holding scope</h3>
      {agents.length === 0 && (
        <p className="noagents">No agents connected. Nothing can pick up a claim yet.</p>
      )}
      {agents.map((a) => {
        const scopes = heldBy(a.agent_id);
        return (
          <div className="holder" key={a.agent_id}>
            <div className="who">
              <span className="nm">{a.member_label}</span>
              {a.stale && <span className="chip">stale</span>}
            </div>
            <div className="role">{a.role_slug} · {a.harness}</div>
            {scopes.length > 0
              ? (
                <div className="scopes">
                  {scopes.map((s) => <span className="chip scope" key={s}>{s}</span>)}
                </div>
              )
              : <div className="since">holds no scope</div>}
            {a.current_task && <div className="since">on task {a.current_task}</div>}
          </div>
        );
      })}
    </aside>
  );
}
