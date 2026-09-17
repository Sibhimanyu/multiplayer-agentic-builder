// Presentational only. Data in via props, no fetching, no backend SDK imports.
// If a backend SDK appears in this file, the store seam has leaked.

import { useEffect, useState } from 'react';
// COLUMNS, not a local list: the index must not invent a second definition of the board's
// columns. If the board gains a column, this gains it too, or the two screens disagree.
import { COLUMNS } from './store/types';
import type {
  AgentPresence, ContractPointer, Freshness, Snapshot, TaskView,
} from './store/types';

/**
 * Left-truncate a path so the filename stays visible.
 * Do NOT use CSS `direction:rtl` for this — it reorders the whole string, so
 * "functions/items/**" renders as "**\/functions/items".
 */
export function truncPath(p: string, max = 34): string {
  return p.length <= max ? p : '\u2026' + p.slice(-(max - 1));
}

const RING: Record<string, string> = { blocked: 'blocked', offline: 'offline', revoked: 'offline' };
// Tuned for the dark ground (order 0077). The previous set was mixed for a white page.
//
// SOLVED, NOT PICKED. Each hue was darkened until white initials clear 4.5:1 on it -- the first
// attempt at this list looked right and failed on four of six, which is exactly the kind of thing
// that ships when a palette is chosen by eye. Measured: white contrast 5.69, 4.69, 4.66, 4.68,
// 4.71, 4.65; and every one clears 3:1 against --card so the chip reads as an object.
const AV_BG = ['#6E5AA8', '#2A8171', '#A36635', '#6C757F', '#4575B4', '#9D684C'];

export function Avatar({ agent, small, idx }: { agent: AgentPresence; small?: boolean; idx: number }) {
  return (
    <div
      className={small ? 'av sm' : 'av'}
      data-ring={RING[agent.stale ? 'offline' : agent.status] ?? 'ok'}
      style={{ background: AV_BG[idx % AV_BG.length] }}
      title={`${agent.role_slug} · ${agent.member_label} · ${agent.stale ? 'stale' : agent.status}`}
    >
      {agent.initials}
    </div>
  );
}

/**
 * Collapses past 4 so 10 agents does not push the nav around.
 *
 * FOUR, not five: docs/designs/dashboard.md is the declared source of truth for pixels and its
 * edge-case table says ten agents collapse to `+6`, which is 10 - 4. This comment previously
 * said five and the code agreed with the comment rather than the design — an implementation
 * note that drifted from the spec it was meant to describe. No measurement can settle a visual
 * density choice, so the design wins by rule (order 0041).
 */
export function Presence({ agents }: { agents: AgentPresence[] }) {
  if (agents.length === 0) return <span className="noagents">no agents connected</span>;
  const shown = agents.slice(0, 4);
  const rest = agents.length - shown.length;
  return (
    <div className="avs">
      {shown.map((a, i) => <Avatar key={a.agent_id} agent={a} idx={i} />)}
      {rest > 0 && <span className="more">+{rest}</span>}
    </div>
  );
}

/**
 * The one honest place the two builds differ.
 * poll -> "updated {n}s ago", counting up from generated_at.
 * live -> a steady dot, no counter. Never fake liveness.
 */
export function FreshnessPill({ freshness, generatedAt }: { freshness: Freshness; generatedAt: string }) {
  const [ago, setAgo] = useState(0);
  useEffect(() => {
    if (freshness.mode !== 'poll') return;
    const base = new Date(generatedAt).getTime();
    const tick = () => setAgo(Math.max(0, Math.round((Date.now() - base) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [freshness.mode, generatedAt]);

  return (
    <span className="fresh" data-mode={freshness.mode}>
      <span className="dot" />
      {freshness.mode === 'poll' ? `updated ${ago}s ago` : 'live'}
    </span>
  );
}

export function TopNav({
  snap, freshness, session, onSignOut,
}: {
  snap: Snapshot;
  freshness: Freshness;
  /** Absent only where there is no session to show -- fixtures and the edge harness's older cases. */
  session?: { uid: string; email: string | null; anonymous: boolean };
  onSignOut?: () => void;
}) {
  return (
    <nav className="nav">
      {/*
        Flotilla, decision 0002. The UI BRAND only: the repo, the branches and the project ids
        deliberately keep their old names, because they are live infrastructure and the
        comparison record has to stay readable. Renaming a project id would invalidate every
        measurement that names it.
      */}
      <BrandLockup />
      <div className="sep" />
      <div className="proj">{snap.project_name}</div>
      <div className="repo">{snap.repo_url}</div>
      <span className="grow" />
      <Presence agents={snap.agents} />
      <FreshnessPill freshness={freshness} generatedAt={snap.generated_at} />
      {session && onSignOut && <AccountChip session={session} onSignOut={onSignOut} />}
    </nav>
  );
}

export function TaskCard({
  task, agent, selected, onSelect, contractVersion,
}: {
  task: TaskView; agent?: AgentPresence; selected: boolean;
  onSelect: () => void; contractVersion?: number;
}) {
  const blockedMins = task.blocked_since
    ? Math.round((Date.now() - new Date(task.blocked_since).getTime()) / 60000)
    : null;

  return (
    <button
      className="card" onClick={onSelect}
      data-sel={selected} data-merged={task.status === 'merged'}
    >
      <div className="title">{task.title}</div>
      <div className="row">
        <span className="kind" data-k={task.kind}>{task.kind}</span>
        {contractVersion != null && <span className="verpill">v{contractVersion}</span>}
        {task.blocked_by && (
          <span className="badge" data-t="blocked">
            Blocked{blockedMins != null ? ` ${blockedMins}m` : ''}
          </span>
        )}
        {task.ci === 'failed' && <span className="badge" data-t="ci-failed">CI failed</span>}
        {task.status === 'needs_review' && !task.blocked_by && (
          <span className="badge" data-t="review">Owner review</span>
        )}
        {agent && <div className="who"><Avatar agent={agent} idx={0} small /></div>}
      </div>
      {(task.pr_number != null || task.branch) && (
        <div className="branch">
          {task.pr_number != null ? `#${task.pr_number} · ` : ''}{truncPath(task.branch ?? '')}
        </div>
      )}
    </button>
  );
}

/**
 * The board, before it has any data. Order 0066 point 3.
 *
 * A cold load showed "Connecting…" as bare text on an empty page for up to fifteen seconds. The
 * user read that as a broken app twice, and they were right to — bare text on white is what a
 * crashed SPA looks like.
 *
 * THIS RENDERS THE REAL CHROME, not a picture of it. The same `.nav`, the same `.stage`, the same
 * `.board`, and six real `.col` elements carrying the real column labels. Only the leaf content is
 * a grey block. That is what makes the swap to real data a CONTENT change rather than a BOX
 * change, which is locked pattern 7 in dashboard.md: a refresh must not shift layout, and a
 * skeleton that resizes on arrival would break that rule in a new place.
 *
 * The labels are real rather than blanked because they are known before any data arrives — a
 * skeleton should withhold what it does not know yet, not what it does.
 */
export function BoardSkeleton() {
  // Uneven on purpose. Three identical blocks per column reads as a loading bar; an uneven set
  // reads as cards, which is what is about to be there.
  const blocks: Record<string, ('' | 'tall')[]> = {
    Open: ['', 'tall', ''],
    Claimed: ['tall', ''],
    'In progress': ['', ''],
    'Needs review': [''],
    'PR open': ['tall'],
    Merged: [''],
  };
  return (
    <>
      <nav className="nav">
        <BrandLockup />
        <div className="sep" />
        <span className="sk sk-proj" />
        <span className="sk sk-repo" />
        <span className="grow" />
        <span className="sk sk-line" />
      </nav>
      <div className="stage">
        <div className="board sk-board" aria-busy="true" aria-label="Loading the board">
          {COLUMNS.map(({ status, label }) => (
            <section className="col" key={status}>
              <div className="col-head">
                <h3>{label}</h3><span className="sk sk-count" />
              </div>
              <div className="col-body">
                {(blocks[label] ?? ['']).map((tall, i) => (
                  <div className={`sk sk-card ${tall}`.trim()} key={i} />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </>
  );
}

/** The projects index, before its rows arrive. Same argument, one column instead of six. */
export function ProjectsSkeleton() {
  return (
    <>
      <nav className="nav">
        <BrandLockup />
        <span className="grow" />
        <span className="sk sk-line" />
      </nav>
      <div className="stage">
        <div className="board sk-board" aria-busy="true" aria-label="Loading your projects">
          <section className="col">
            <div className="col-head">
              <h3>Projects</h3><span className="sk sk-count" />
            </div>
            <div className="col-body">
              {['tall', 'tall', ''].map((tall, i) => (
                <div className={`sk sk-card ${tall}`.trim()} key={i} />
              ))}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

export function EmptyColumn({ label }: { label: string }) {
  const copy: Record<string, [string, string]> = {
    Open:            ['Nothing open', 'Every task has been picked up.'],
    Claimed:         ['Nothing claimed', 'Tasks land here the moment an agent calls claim.'],
    'In progress':   ['Nothing in progress', 'Claimed tasks move here on first local edit.'],
    'Needs review':  ['Nothing awaiting review', 'Finished work with no PR yet appears here.'],
    // THE POLL, not a webhook. Order 0043 moved PR and CI state into the bridge's GitHub poll,
    // because Spark has no Cloud Functions and so there is no server to receive a webhook. The
    // checklist was updated at the time and these two strings were not -- so the
    // mechanism-naming rule reached the test and missed the product, surviving in the one place
    // a user actually reads.
    'PR open':       ['No open pull requests', 'Opened PRs appear here when the bridge polls GitHub.'],
    Merged:          ['Nothing merged yet', 'Merged work lands here when the bridge polls GitHub.'],
  };
  const [head, body] = copy[label] ?? ['Empty', ''];
  return <div className="empty"><b>{head}</b>{body}</div>;
}

/**
 * One project on the index. Reuses `.card` and the avatar row rather than inventing chrome.
 *
 * `members` are AgentPresence-shaped so Avatar can render them unchanged — a project member is
 * not an agent, but the avatar is a picture of a person either way, and giving it a second
 * near-identical component is how two drifting implementations of one idea start.
 */
export function ProjectCard({
  project, onOpen, now,
}: {
  project: {
    project_id: string; project_name: string; repo_url: string;
    role: string; members: AgentPresence[];
    rollup?: { counts?: Record<string, number | undefined>; blocked?: number; ci_failed?: number; last_activity?: string };
    agents_live?: number;
  };
  onOpen: () => void;
  /** Injected so a render is deterministic and a server-rendered test can assert the text. */
  now?: number;
}) {
  const r = project.rollup ?? {};
  const counts = r.counts ?? {};
  // Only non-empty columns. Six pills where four read "0" is noise, and the eye has to work to
  // find the one number that matters.
  const shown = COLUMNS
    .map((c) => ({ label: c.label, n: counts[c.status] ?? 0 }))
    .filter((c) => c.n > 0);
  const counted = Object.keys(counts).length > 0;
  const live = project.agents_live ?? 0;

  return (
    <button className="card" onClick={onOpen} data-project={project.project_id}>
      <div className="title">{project.project_name}</div>

      <div className="row">
        <span className="kind" data-k="docs">{project.role}</span>
        {/* The two signals that should pull the eye, in the badge idiom the board already uses. */}
        {(r.blocked ?? 0) > 0 && (
          <span className="badge" data-t="blocked">{r.blocked} blocked</span>
        )}
        {(r.ci_failed ?? 0) > 0 && (
          <span className="badge" data-t="ci-failed">CI failed</span>
        )}
        {project.members.length > 0 && (
          <div className="who"><Presence agents={project.members} /></div>
        )}
      </div>

      {/* Absent counts mean "not counted yet", which is why this renders nothing rather than a
          row of zeroes for a project created before the rollup existed. */}
      {counted && (
        <div className="row" data-counts="true">
          {shown.length === 0
            ? <span className="count">no tasks</span>
            : shown.map((c) => (
                <span className="count" key={c.label}>{c.n} {c.label.toLowerCase()}</span>
              ))}
        </div>
      )}

      <div className="row">
        {live > 0 && (
          <span className="fresh" data-mode="live">
            <span className="dot" />
            {live} working
          </span>
        )}
        {r.last_activity && (
          <span className="branch">{relativeTime(r.last_activity, now ?? Date.now())}</span>
        )}
      </div>

      {project.repo_url && <div className="branch">{truncPath(project.repo_url)}</div>}
    </button>
  );
}

/**
 * "3 minutes ago". Answers "is this alive" in a way a timestamp does not.
 *
 * Coarse on purpose: the index is a glance, not a log. Anything older than a week reads as a
 * date, because "23 days ago" is arithmetic the reader has to do twice.
 */
export function relativeTime(iso: string, now: number): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`;
  const d = Math.round(h / 24);
  if (d <= 7) return `${d} day${d === 1 ? '' : 's'} ago`;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * The empty state TEACHES THE COMMAND rather than offering a button.
 *
 * A "New project" button here could not work: creating a project connects a repo, writes
 * .agentic/ and generates role packs, none of which a browser can do. A button that opens a
 * dialog which then explains it cannot proceed is worse than no button. For a developer tool the
 * command IS the affordance.
 */
export function ProjectsEmpty({ anonymous }: { anonymous?: boolean } = {}) {
  // A DIFFERENT SENTENCE WHEN THE BROWSER IS ANONYMOUS, and this is the whole of order 0064's
  // complaint. The board signed in anonymously, a throwaway uid is a member of nothing, and the
  // page said "No projects yet — run `flotilla new`" to a user who had just run `flotilla new`.
  // The state was reported honestly and the reason for it was invisible.
  if (anonymous) {
    return (
      <div className="empty">
        <b>No projects for this anonymous session</b>
        You are signed in anonymously, so this browser is a member of nothing. Sign in with the
        Google account that owns your projects.
      </div>
    );
  }
  return (
    <div className="empty">
      <b>No projects yet</b>
      Run <code>flotilla new &lt;name&gt;</code> in your repo.
    </div>
  );
}

/**
 * The mark and the wordmark, together, in ONE component.
 *
 * ORDER 0065, AND THE REGRESSION IS MINE. Order 0054 replaced `<div className="mark">FL</div>`
 * with an `<img>` of /brand/flotilla-mark.svg. Consolidating the branches, I kept the product
 * components.tsx because it had ProjectCard and the blockedChain prop — and the brand work came
 * back only as far as TopNav. Three other places went on rendering the literal string "FL" in
 * whatever typeface the browser felt like, and the asset has been serving HTTP 200 to nobody
 * since.
 *
 * One component rather than four call sites, so there is no fourth place to forget.
 *
 * THE TEXT FALLBACK STAYS, because an `<img>` whose source 404s renders as a broken-image glyph,
 * which is worse than two letters. But it is STYLED now — brand serif, mark colour, the mark's
 * own box — rather than raw default type. A missing asset should not also change the typeface.
 */
export function BrandLockup({ size = 'sm' }: { size?: 'sm' | 'lg' }) {
  const [broken, setBroken] = useState(false);
  return (
    <div className="brand-lockup" data-size={size} data-broken={broken} aria-label="Flotilla">
      {broken
        ? <span className="mark mark-text" aria-hidden="true">FL</span>
        : (
          <img
            className="mark" src="/brand/flotilla-mark.svg" alt="" aria-hidden="true"
            onError={() => setBroken(true)}
          />
        )}
      <div className="brand">Flotilla</div>
    </div>
  );
}

/**
 * WHOSE BOARD IS THIS. The nav chip, with a way out.
 *
 * Order 0064, point 4: "a board that cannot tell you which account it is showing is how this bug
 * survived." Someone looking at an empty index had no way to discover that the browser was a
 * throwaway identity -- the page and a genuinely empty account rendered identically.
 *
 * Anonymous is labelled as anonymous rather than shown as a uid. `anon_7f3a…` is not an identity
 * a person recognises, and the actionable fact is not which anonymous session this is, it is THAT
 * it is one.
 */
export function AccountChip({
  session, onSignOut,
}: {
  session: { uid: string; email: string | null; anonymous: boolean };
  onSignOut: () => void;
}) {
  const who = session.anonymous ? 'Anonymous session' : session.email ?? session.uid;
  // The avatar is the first letter of whatever is actually shown, so it always agrees with the
  // label beside it. '?' for an anonymous session, which has no initial worth inventing.
  const initial = session.anonymous ? '?' : (who.trim()[0] ?? '?').toUpperCase();

  return (
    <div className="account" data-anonymous={session.anonymous}>
      <span className="account-av" aria-hidden="true">{initial}</span>
      <span className="who-label" title={session.uid}>{who}</span>
      {/*
        A BUTTON THAT LOOKS LIKE A BUTTON, order 0069. This was `.linkish` -- teal and underlined
        -- which rendered sign-out as a bare anchor floating at the edge of the nav: the one
        destructive control on the page styled as the lightest thing on it.
      */}
      <button className="ghost" onClick={onSignOut}>
        {session.anonymous ? 'Sign in' : 'Sign out'}
      </button>
    </div>
  );
}

/**
 * The board's sign-in screen. Order 0064.
 *
 * ONE WAY IN: GOOGLE. The anonymous escape hatch is gone (order 0073).
 *
 * It existed for the denied-state onboarding path -- sign in, get refused by the rules, read your
 * own uid off the screen, get admitted out of band. That path still works; it just starts from a
 * Google account now, which is strictly better, because the uid an owner admits then belongs to a
 * person they can name instead of to a browser profile that vanishes when the cache is cleared.
 *
 * Every anonymous session was also a member of nothing, so the only screen it could ever reach
 * was an empty index explaining why it was empty.
 *
 * Pure: the page renders from props alone, so both states can be asserted without a browser.
 */
export function SignInView({
  onGoogle, error, busy, staleAnonymous,
}: {
  onGoogle: () => void;
  error?: { code: string; detail: string } | null;
  busy?: boolean;
  /** This browser holds an anonymous session from before order 0073. Say so, do not just refuse. */
  staleAnonymous?: boolean;
}) {
  return (
    // `.centered`, not `.stage`. The stage is the board's scroll area and centres nothing; this
    // page was rendering as content pinned to the top-left of an otherwise empty 1440px viewport.
    // The container is one named thing in tokens.css -- see the note there about why it is not an
    // inline style and not a second set of spacing values.
    <div className="centered">
      <div className="login" data-signin="board">
        {/*
          THE LOCKUP LIVES IN THE CARD, and there is no nav above it. A 60px bar carrying only a
          brand mark, on a page with no navigation to offer, is chrome for its own sake -- and it
          was pushing the one thing this screen exists for off-centre.
        */}
        <BrandLockup size="lg" />
        {/*
          "Sign in", not "Sign in to Flotilla". The lockup directly above it already says
          Flotilla, so the longer heading read the word twice in adjacent lines. The probes that
          used to wait on this string now wait on `.login[data-signin="board"]` instead -- a
          synchronisation point that is a structure rather than a sentence cannot be broken by
          rewording the sentence.
        */}
        <h2>Sign in</h2>
        <p>Your projects are listed by the account that owns them.</p>
        <button className="cta" onClick={onGoogle} disabled={busy}>
          {busy ? 'Taking you to Google…' : 'Continue with Google'}
        </button>
        {staleAnonymous && (
          <p className="note">
            This browser was signed in anonymously. Anonymous sessions are no longer accepted —
            sign in with the Google account that owns your projects.
          </p>
        )}
        {error && (
          <>
            <h2 className="bad">Sign-in failed.</h2>
            <p>{error.detail}</p>
            <p className="note">({error.code})</p>
          </>
        )}
      </div>
    </div>
  );
}

export interface Suggestion {
  seq: number;
  from: string;
  summary: string;
  created_at: string;
  /** Absent while it is still waiting on a human. */
  decision?: 'accepted' | 'declined';
  reason?: string;
}

/**
 * The triage surface. Where a human decides what agents work on.
 *
 * This is the client seat's only route into the system, and the shape of it is the security
 * property made visible: a suggestion is rendered here, on the board, and NOWHERE ELSE. It is a
 * human-layer event, so the file contract keeps it out of every agent's inbox.jsonl without
 * anything having to inspect its text. Prompt injection from this seat is impossible by plumbing
 * rather than caught by a filter — which is why the text below is displayed verbatim and not
 * sanitised. Sanitising it would imply the text is dangerous somewhere, and the point is that it
 * is not reachable from anywhere it could be.
 *
 * Accept turns it into a task, which agents DO see. Decline records a reason, which they do not
 * need to. Both decisions are the human's, and only the accepted one becomes work.
 */
export function TriagePanel({
  suggestions, canTriage, onAccept, onDecline,
}: {
  suggestions: Suggestion[];
  /** Only owner and architect hold the triage capability. */
  canTriage: boolean;
  onAccept: (seq: number) => void;
  onDecline: (seq: number) => void;
}) {
  const pending = suggestions.filter((s) => !s.decision);
  const settled = suggestions.filter((s) => s.decision);

  return (
    <section className="col" key="triage" data-triage="true">
      <div className="col-head">
        <h3>Suggestions</h3><span className="count">{pending.length}</span>
      </div>
      <div className="col-body">
        {suggestions.length === 0 ? (
          <div className="empty">
            <b>Nothing to triage</b>
            Client questions and suggestions land here for a human to turn into tasks.
          </div>
        ) : (
          <>
            {pending.map((s) => (
              <div className="card" key={s.seq} data-suggestion={s.seq}>
                <div className="title">{s.summary}</div>
                <div className="row">
                  <span className="kind" data-k="docs">{s.from}</span>
                  {canTriage && (
                    <span className="who" style={{ display: 'flex', gap: 6 }}>
                      <button className="cta" onClick={() => onAccept(s.seq)}>Make a task</button>
                      <button className="x" onClick={() => onDecline(s.seq)} aria-label="Decline">&times;</button>
                    </span>
                  )}
                </div>
              </div>
            ))}
            {settled.map((s) => (
              <div className="card" key={s.seq} data-suggestion={s.seq} data-merged={s.decision === 'declined'}>
                <div className="title">{s.summary}</div>
                <div className="row">
                  <span className="badge" data-t={s.decision === 'accepted' ? 'review' : 'blocked'}>
                    {s.decision}
                  </span>
                </div>
                {/* A decline without a reason is just a no. The reason is what makes it answerable. */}
                {s.reason && <div className="branch">{s.reason}</div>}
              </div>
            ))}
          </>
        )}
      </div>
    </section>
  );
}

export function DetailPanel({
  task, agent, contract, blockedChain, onClose,
}: {
  task: TaskView; agent?: AgentPresence; contract?: ContractPointer;
  /**
   * The FULL blocked chain, A -> B -> C, nearest blocker first. Walked by the caller.
   *
   * It has to be the caller: `blocked_by` is a TaskId string, and resolving it needs the task
   * index that App holds and this component deliberately does not — data in via props, no
   * lookups in here. App.tsx's blockedChain() does the walk and is cycle-guarded.
   *
   * This replaced a single `blockedByTask?: TaskView` whose loop could only ever render the
   * immediate blocker, so the design's A->B->C case was unbuildable rather than merely unbuilt.
   */
  blockedChain?: TaskView[]; onClose: () => void;
}) {
  const chain = blockedChain ?? [];

  return (
    <aside className="panel">
      <div className="p-head">
        <div className="up">
          <span className="id">{task.task_id}</span>
          <span className="kind" data-k={task.kind}>{task.kind}</span>
          <button className="x" onClick={onClose} aria-label="Close">&times;</button>
        </div>
        <h2>{task.title}</h2>
        {agent && (
          <div className="row">
            <Avatar agent={agent} idx={0} small />
            <span style={{ fontSize: 12, color: 'var(--muted)' }}>
              {agent.role_slug} · {agent.harness}{agent.stale ? ' · stale' : ''}
            </span>
          </div>
        )}
      </div>

      <div className="p-body">
        {task.description && (
          <div className="sect"><div className="lbl">Description</div><p>{task.description}</p></div>
        )}

        {task.file_scope.length > 0 && (
          <div className="sect">
            <div className="lbl">File scope · locked</div>
            {task.file_scope.map((g) => (
              <div className="dep" key={g} title={g}>
                <span className="d" /><span className="nm">{truncPath(g, 30)}</span>
              </div>
            ))}
          </div>
        )}

        {chain.length > 0 && (
          <div className="sect">
            <div className="lbl">Blocked by</div>
            {chain.map((t) => (
              <div className="dep" key={t.task_id}>
                <span className="d" data-blk="true" />
                <span className="nm">{t.task_id}</span>
                <span className="st">{t.status}</span>
              </div>
            ))}
            {task.blocked_reason && <p>{task.blocked_reason}</p>}
          </div>
        )}

        {contract && (
          <div className="sect">
            <div className="lbl">
              Contract <span className="verpill">v{contract.version}</span>
              {contract.supersedes != null && (
                <span style={{ color: 'var(--muted)', fontWeight: 400, marginLeft: 6 }}>
                  supersedes v{contract.supersedes}
                </span>
              )}
            </div>
            {contract.preview
              ? <pre>{contract.preview}</pre>
              : <p style={{ fontFamily: 'var(--mono)', fontSize: 11 }}>
                  {contract.path} @ {contract.commit_sha.slice(0, 7)}
                </p>}
          </div>
        )}
      </div>
    </aside>
  );
}
