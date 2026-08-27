/// <reference types="vite/client" />
//
// The dashboard's read path for route G. Per territory.md this file is
// per-build; `components.tsx`, `tokens.css`, `index.html`, `tsconfig.json` and
// `types.ts` are frozen and untouched.
//
// The `vite/client` reference is a TRIPLE-SLASH DIRECTIVE INSIDE THIS FILE
// rather than a `types` entry in client/tsconfig.json, so the shared tsconfig
// stays byte-identical across builds -- the shape order 0010 recorded as the
// right footprint.
//
// ONE CONSTRAINT WORTH STATING, because it shapes everything below: a browser
// cannot spawn `git`. The server-side adapter (github/store/github.ts) writes
// through `git push`, which is the atomic primitive and the unmetered half of
// route G's cost model. None of that is available here.
//
// That is fine, and it is fine for a reason rather than by luck: the dashboard
// is READ-ONLY. It renders a folded snapshot and never claims, releases, locks
// or appends. So this file is the REST half only -- which is also the half that
// is free, provided every conditional request keeps its Accept header pinned.
//
// If the dashboard ever needed to write, this file would need a server-side
// endpoint to write through, and that would be a real change to route G's
// "no backend at all" claim. Saying so now so nobody discovers it later.

import type {
  AgentPresence, ContractPointer, CoordinationStore, Freshness, ProjectId,
  ScopeLock, Seq, Snapshot, TaskStatus, TaskView,
} from './types';

const API = 'https://api.github.com';

/**
 * PINNED. The ETag is media-type dependent: an ETag obtained with this header
 * and replayed without it returns 200, not 304 -- and 200 costs a rate-limit
 * unit where 304 costs zero. Measured. A poll loop that loses this header
 * exhausts 5,000/hour in about fifty minutes, silently, with correct-looking
 * data right up to the 403.
 */
const ACCEPT = 'application/vnd.github+json';

export interface GithubStoreConfig {
  /** "owner/repo" holding the coordination refs. */
  repo: string;
  token: string;
  /** Poll interval. Also what `freshness.stale_ms` advertises. */
  poll_ms?: number;
}

interface RefRow { ref: string; object: { sha: string } }

export function createGithubStore(cfg: GithubStoreConfig): CoordinationStore {
  const pollMs = cfg.poll_ms ?? 5_000;
  const headers = (etag?: string): Record<string, string> => ({
    Authorization: `Bearer ${cfg.token}`,
    Accept: ACCEPT,
    'X-GitHub-Api-Version': '2022-11-28',
    ...(etag ? { 'If-None-Match': etag } : {}),
  });

  /** Commit objects are content-addressed, so this cache never invalidates. */
  const commits = new Map<string, { message: string; date: string }>();

  async function listRefs(project: ProjectId, ns: string): Promise<RefRow[]> {
    const res = await fetch(`${API}/repos/${cfg.repo}/git/matching-refs/agentic/${project}/${ns}/`, {
      headers: headers(),
    });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`matching-refs ${ns}: HTTP ${res.status}`);
    // The adapter relies on this endpoint returning the FULL set -- measured at
    // 320 refs with no Link header. If it ever paginates, a partial read would
    // silently understate the board rather than fail.
    if (res.headers.get('link')) {
      throw new Error(`matching-refs ${ns} is paginated; this read is a prefix of the truth`);
    }
    return (await res.json()) as RefRow[];
  }

  async function readCommit(sha: string): Promise<{ message: string; date: string }> {
    const hit = commits.get(sha);
    if (hit) return hit;
    const res = await fetch(`${API}/repos/${cfg.repo}/git/commits/${sha}`, { headers: headers() });
    if (!res.ok) throw new Error(`commit ${sha}: HTTP ${res.status}`);
    const d = (await res.json()) as { message: string; committer: { date: string } };
    const v = { message: d.message, date: d.committer.date };
    commits.set(sha, v);
    return v;
  }

  function tail(ref: string): string { return ref.slice(ref.lastIndexOf('/') + 1); }
  function parent(ref: string): string {
    const p = ref.split('/');
    return p[p.length - 2] ?? '';
  }

  async function fold(project: ProjectId): Promise<Snapshot> {
    const [taskRefs, agentRefs, hbRefs, lockRefs, claimRefs, evRefs] = await Promise.all([
      listRefs(project, 'tasks'), listRefs(project, 'agents'), listRefs(project, 'hb'),
      listRefs(project, 'locks'), listRefs(project, 'claims'), listRefs(project, 'ev'),
    ]);

    const tasks = new Map<string, TaskView>();
    for (const r of taskRefs) {
      const t = JSON.parse((await readCommit(r.object.sha)).message) as {
        task_id: string; title: string; kind: TaskView['kind']; file_scope?: string[];
      };
      tasks.set(t.task_id, {
        task_id: t.task_id, title: t.title, kind: t.kind, status: 'open',
        claimed_by: null, branch: null, pr_url: null, pr_number: null, ci: null,
        depends_on: [], blocked_by: null, blocked_reason: null,
        file_scope: t.file_scope ?? [], updated_at: new Date().toISOString(),
      });
    }

    // Fold events in SEQ order and only seq order. The seq is the ref NAME,
    // zero-padded, so sorting the names numerically is the correct order --
    // never commit order, which a rebase reorders, and never created_at, which
    // a rebase rewrites.
    const evs = evRefs
      .map((r) => ({ seq: Number(tail(r.ref)), sha: r.object.sha }))
      .filter((e) => Number.isFinite(e.seq))
      .sort((a, b) => a.seq - b.seq);

    let maxSeq = 0;
    for (const e of evs) {
      maxSeq = Math.max(maxSeq, e.seq);
      const stored = JSON.parse((await readCommit(e.sha)).message) as {
        kind: string; created_at: string; body: Record<string, unknown>;
      };
      const id = typeof stored.body.task_id === 'string' ? stored.body.task_id : null;
      if (!id) continue;
      const t = tasks.get(id);
      if (!t) continue;
      const set = (s: TaskStatus) => { t.status = s; t.updated_at = stored.created_at; };
      switch (stored.kind) {
        case 'task_claimed': set('claimed'); break;
        case 'task_blocked':
          t.blocked_reason = typeof stored.body.reason === 'string' ? stored.body.reason : null;
          set('blocked'); break;
        case 'branch_pushed':
          t.branch = (stored.body.branch as string) ?? t.branch; set('in_progress'); break;
        case 'pr_opened':
          t.pr_url = (stored.body.pr_url as string) ?? t.pr_url;
          t.pr_number = (stored.body.pr_number as number) ?? t.pr_number;
          set('pr_open'); break;
        case 'ci_passed': t.ci = 'passed'; break;
        case 'ci_failed': t.ci = 'failed'; break;
        case 'merged': set('merged'); break;
        case 'task_completed': set('done'); break;
        default: break;
      }
    }

    // Claims are live state, read directly, so a reaped claim disappears
    // instead of lingering from an old event.
    for (const r of claimRefs) {
      const c = JSON.parse((await readCommit(r.object.sha)).message) as {
        agent_id: string; task_id: string;
      };
      const t = tasks.get(c.task_id);
      if (t) { t.claimed_by = c.agent_id; if (t.status === 'open') t.status = 'claimed'; }
    }

    // Presence: the heartbeat TIMESTAMP IS THE REF NAME, so staleness needs no
    // object read at all.
    const latest = new Map<string, number>();
    for (const r of hbRefs) {
      const ts = Number(tail(r.ref));
      if (!Number.isFinite(ts)) continue;   // unreadable -> absent, never "now"
      const a = parent(r.ref);
      if (!latest.has(a) || ts > latest.get(a)!) latest.set(a, ts);
    }
    const now = Date.now();
    const agents: AgentPresence[] = [];
    for (const r of agentRefs) {
      const a = JSON.parse((await readCommit(r.object.sha)).message) as {
        agent_id: string; role_slug: string; member_label: string;
      };
      const hb = latest.get(a.agent_id);
      const stale = hb === undefined || now - hb > 90_000;
      agents.push({
        agent_id: a.agent_id, role_slug: a.role_slug, member_label: a.member_label,
        initials: initials(a.member_label), harness: 'claude-code',
        status: stale ? 'offline' : 'working',
        current_task: null, branch: null,
        last_heartbeat_at: hb === undefined ? null : new Date(hb).toISOString(),
        stale,
      });
    }

    const locks: ScopeLock[] = [];
    for (const r of lockRefs) {
      const l = JSON.parse((await readCommit(r.object.sha)).message) as ScopeLock;
      // An unreadable globs value becomes a lock on EVERYTHING, so it conflicts
      // loudly rather than silently disabling the check it exists for.
      locks.push({ ...l, globs: Array.isArray(l.globs) ? l.globs : ['**'] });
    }

    const contracts: ContractPointer[] = [];

    return {
      project_id: project, seq: maxSeq, generated_at: new Date().toISOString(),
      project_name: project, repo_url: `https://github.com/${cfg.repo}`,
      tasks: [...tasks.values()], agents, locks, contracts,
    };
  }

  return {
    // Read from this, never hardcoded. Route G is genuinely poll-mode and the
    // dashboard renders "updated Ns ago" because of it.
    freshness: { mode: 'poll', stale_ms: pollMs } as Freshness,

    subscribe(project_id: ProjectId, _from: Seq, onChange: (s: Snapshot) => void): () => void {
      let live = true;
      let inFlight = false;
      const tick = async () => {
        if (!live || inFlight) return;
        inFlight = true;
        try {
          const s = await fold(project_id);
          if (live) onChange(s);
        } catch {
          // A failed poll is not a reason to stop polling. The dashboard keeps
          // showing the last good snapshot and its freshness counter keeps
          // climbing, which is the honest rendering of "we cannot reach it".
        } finally {
          inFlight = false;
        }
      };
      void tick();
      const id = setInterval(() => { void tick(); }, pollMs);
      return () => { live = false; clearInterval(id); };
    },
  };
}

function initials(label: string): string {
  const p = label.trim().split(/\s+/).filter(Boolean);
  if (p.length === 0) return '??';
  if (p.length === 1) return p[0]!.slice(0, 2).toUpperCase();
  return (p[0]![0]! + p[p.length - 1]![0]!).toUpperCase();
}
