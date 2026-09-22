// Browser-side mirror of shared/store/directory.ts, types only.
//
// Mirrored rather than imported for the same reason client/src/store/types.ts mirrors the
// coordination port: the client build does not reach into shared/ at build time, and the two
// branches' clients must compile from their own tree. Types only — no behaviour is duplicated,
// so there is nothing here that can drift in a way a test would not catch.

export type RoleSlug = 'owner' | 'architect' | 'backend' | 'frontend' | 'qa' | 'user';

export interface ProjectRecord {
  project_id: string;
  project_name: string;
  repo_url: string;
  created_at: string;
  created_by: string;
}

export interface MemberRecord {
  uid: string;
  role: RoleSlug;
  label: string;
  revoked: boolean;
  added_at: string;
}

/**
 * The counters the index reads off the project document, maintained by the append transaction
 * (shared/store/rollup.ts). Mirrored here for the same reason the rest of this file is.
 *
 * Every field is optional because a project created before the rollup existed has none of them,
 * and an index that renders "0 open" for a project it simply has not counted is worse than one
 * that renders nothing. Absent means unknown; zero means counted and empty.
 */
export interface ProjectRollup {
  counts?: Partial<Record<string, number>>;
  blocked?: number;
  ci_failed?: number;
  last_activity?: string;
  last_seq?: number;
}

/**
 * What a role may do, mirrored from `shared/store/directory.ts`.
 *
 * COSMETIC, AND THAT IS THE POINT. This decides whether a button is rendered enabled; it does not
 * decide anything. `functions/src/write-api.ts` maps each op to a required capability and refuses
 * the request against the caller's server-side grant, so a wrong answer here shows a button that
 * is then refused with a sentence — degraded, never unsafe.
 *
 * Mirrored rather than imported because the client build does not reach into `shared/` (see the
 * note at the top of this file and in store/types.ts). Drift is therefore possible, which is
 * exactly why the client's copy is not allowed to be the authority.
 */
export type Capability =
  | 'claim' | 'acquire_scope' | 'publish_contract' | 'open_pr' | 'deploy' | 'triage'
  | 'invite' | 'suggest';

const CAPABILITIES: Record<RoleSlug, readonly Capability[]> = {
  owner: ['claim', 'acquire_scope', 'publish_contract', 'open_pr', 'deploy', 'triage', 'invite', 'suggest'],
  architect: ['claim', 'acquire_scope', 'publish_contract', 'triage', 'suggest'],
  backend: ['claim', 'acquire_scope', 'publish_contract', 'open_pr', 'deploy', 'triage', 'suggest'],
  frontend: ['claim', 'acquire_scope', 'publish_contract', 'open_pr', 'deploy', 'triage', 'suggest'],
  qa: ['claim', 'acquire_scope', 'open_pr', 'triage', 'suggest'],
  // The `user` seat holds `suggest` and nothing else: it can raise a suggestion and that is
  // all. It cannot claim and cannot accept one, because accepting IS creating the task.
  user: ['suggest'],
};

/** Unknown roles fall back to `user`, the least-privileged seat, exactly as the server does. */
export function hasCapability(slug: string, cap: Capability): boolean {
  return (CAPABILITIES[slug as RoleSlug] ?? CAPABILITIES.user).includes(cap);
}
