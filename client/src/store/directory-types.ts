// Browser-side mirror of shared/store/directory.ts, types only.
//
// Mirrored rather than imported for the same reason client/src/store/types.ts mirrors the
// coordination port: the client build does not reach into shared/ at build time, and the two
// branches' clients must compile from their own tree. Types only — no behaviour is duplicated,
// so there is nothing here that can drift in a way a test would not catch.

export type RoleSlug = 'owner' | 'architect' | 'backend' | 'frontend' | 'qa' | 'client';

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
