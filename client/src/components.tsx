// Presentational only. Data in via props, no fetching, no backend SDK imports.
// If a backend SDK appears in this file, the store seam has leaked.

import { useEffect, useState } from 'react';
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
const AV_BG = ['#7C6A9C', '#2E7D6F', '#B5714A', '#B9B4AB', '#4A6E9C', '#8C6A3F'];

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

export function TopNav({ snap, freshness }: { snap: Snapshot; freshness: Freshness }) {
  return (
    <nav className="nav">
      {/*
        Drydock, decision 0002. The UI BRAND only: the repo, the branches and the project ids
        deliberately keep their old names, because they are live infrastructure and the
        comparison record has to stay readable. Renaming a project id would invalidate every
        measurement that names it.
      */}
      <div className="mark">DD</div>
      <div className="brand">Drydock</div>
      <div className="sep" />
      <div className="proj">{snap.project_name}</div>
      <div className="repo">{snap.repo_url}</div>
      <span className="grow" />
      <Presence agents={snap.agents} />
      <FreshnessPill freshness={freshness} generatedAt={snap.generated_at} />
      <button className="cta">Invite teammate</button>
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

export function EmptyColumn({ label }: { label: string }) {
  const copy: Record<string, [string, string]> = {
    Open:            ['Nothing open', 'Every task has been picked up.'],
    Claimed:         ['Nothing claimed', 'Tasks land here the moment an agent calls claim.'],
    'In progress':   ['Nothing in progress', 'Claimed tasks move here on first local edit.'],
    'Needs review':  ['Nothing awaiting review', 'Finished work with no PR yet appears here.'],
    'PR open':       ['No open pull requests', 'Opened PRs appear here via the GitHub webhook.'],
    Merged:          ['Nothing merged yet', 'Merged work lands here from the webhook.'],
  };
  const [head, body] = copy[label] ?? ['Empty', ''];
  return <div className="empty"><b>{head}</b>{body}</div>;
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
