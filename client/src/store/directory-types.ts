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
