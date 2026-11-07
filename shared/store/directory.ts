// ProjectDirectory: the tier ABOVE CoordinationStore. Order 0045.
//
// WHY THIS IS A SECOND PORT AND NOT A BIGGER ONE.
//
// CoordinationStore is 10 operations with a passing conformance suite and a claim primitive
// verified contended at 20 racers x 50 rounds and at 256 concurrent single-document writers.
// Growing it to 15 would put unproven surface behind a proven gate -- a suite that is green
// because ten of its operations are green tells you nothing about the five that were bolted on.
//
// It would also force every future backend to implement multi-project before it could implement
// coordination at all. A local SQLite build that only ever has one project should be able to
// implement the ten operations and stub this interface; that is only possible if they are
// separate contracts.
//
// Two ports, two conformance suites. The port is the contract, the suite is its gate.
//
// WHAT IS DELIBERATELY NOT HERE: nothing about roles-as-capabilities. `role` is a label on a
// membership, and this port stores and returns it. What a role is ALLOWED to do -- file_scope,
// deploy_scope, capabilities -- is the next order's work and belongs with the enforcement
// points, not with the directory that records who holds which label.

import type { ProjectId } from './types.ts';

/**
 * A member's role. A LABEL at this tier.
 *
 * `owner` is the only one this port treats specially, and only to the extent that removing the
 * last owner would leave a project nobody can administer -- see revokeMember.
 */
export type RoleSlug = string;

/**
 * The six roles of the `web` template. NOT the set of roles a project may have.
 *
 * Shared sessions (docs/designs/shared-sessions.md): a role is a project document, and a host can
 * draw a seat for one person with `flotilla share` -- `priya`, `speaker-2`. This list is what
 * `flotilla new --template web` writes, and what the board and AGENTS.md fall back to when a
 * project has no policy of its own.
 */
export type WebRoleSlug = 'owner' | 'architect' | 'backend' | 'frontend' | 'qa' | 'user';
export const ROLE_SLUGS: readonly WebRoleSlug[] = ['owner', 'architect', 'backend', 'frontend', 'qa', 'user'];

/**
 * The two roles nobody can redefine. `owner` is unscoped so a lock it cannot take is a lock
 * nobody can break; `user` can only suggest, so a user's words never reach an agent. A host
 * typing `flotilla share --label owner` must not be able to mint a second, narrower owner.
 */
export const RESERVED_ROLES: readonly RoleSlug[] = ['owner', 'user'];

/** A role slug a project may define: lowercase, starts with a letter, 2-32 chars. */
export function isRoleSlug(s: unknown): s is RoleSlug {
  return typeof s === 'string' && /^[a-z][a-z0-9-]{1,31}$/.test(s);
}

/** A browser identity. Firebase anonymous uid, or whatever a backend calls a signed-in subject. */
export type MemberUid = string;

/**
 * What a role may DO, as opposed to what it is called.
 *
 * Order 0047: a role used to be a slug plus prose in role.md, which constrains an agent only by
 * asking it nicely in a prompt. That is not a permission. These are checked.
 */
export type Capability =
  | 'claim'            // take a task
  | 'acquire_scope'    // hold a file-scope lock
  | 'publish_contract' // write to the git blackboard
  | 'open_pr'
  | 'deploy'
  // Turn a suggestion into a ticket, or decline it.
  //
  // ORDER 0089 WIDENED WHO HOLDS THIS, and it is a real reversal of decision 0005, which
  // reserved it to owner and architect. The ask was "anyone should be able to pick it up and
  // work on it", and picking a suggestion up IS this act: accepting creates the ticket.
  // Reserving it to two roles would mean a suggestion sits untouched until an owner is looking,
  // which is the opposite of what a queue is for.
  //
  // What decision 0005 was actually protecting is kept: there is still exactly ONE way work
  // appears (triage), a suggestion still never becomes a ticket by itself, and declining is
  // still possible. Only the size of the group holding the gate changed. `user` does not hold
  // it, so the emptiest seat still cannot put work on anybody's board.
  | 'triage'
  | 'invite'           // add members and set roles
  | 'suggest';         // raise a suggestion: the one thing the `user` seat can do

export interface RoleDefinition {
  slug: RoleSlug;
  /** What the board calls it. Absent on the template roles, whose slug is already a name. */
  label?: string;
  /** Globs this role may hold a scope lock on. Empty means: may not hold any scope. */
  file_scope: string[];
  /** Deployable targets this role may deploy. Empty means: may not deploy. */
  deploy_scope: string[];
  capabilities: Capability[];
}

/**
 * The six default roles.
 *
 * `user` is the one whose emptiness is the point: no file scope, no deploy targets, and only
 * `suggest`. It cannot claim, cannot lock a path, cannot publish a contract, and has no agent.
 * It is the seat for the people who USE the delivered app -- they sign in on the board, raise a
 * suggestion, and that is the whole of their power. Their words never become work on their own:
 * somebody with `triage` picks a suggestion up, and picking it up is what creates the ticket.
 *
 * Renamed from `client` in order 0089. "Client" read as the person paying for the project;
 * the seat is actually for whoever is using the thing, which is usually a different person and
 * usually a lot more of them.
 *
 * A suggestion is NOT a ledger event and has its own collection. That is what keeps a user's
 * words out of every agent's inbox.jsonl structurally, rather than by a filter that has to stay
 * correct -- the property the old client-seat note in docs/designs/project-tier.md described.
 */
export const DEFAULT_ROLES: Record<WebRoleSlug, RoleDefinition> = {
  owner: {
    slug: 'owner',
    // The owner is not scoped: they are the human who decides, and a lock they cannot take is a
    // lock nobody can break.
    file_scope: ['**'],
    deploy_scope: ['*'],
    capabilities: ['claim', 'acquire_scope', 'publish_contract', 'open_pr', 'deploy', 'triage', 'invite', 'suggest'],
  },
  architect: {
    slug: 'architect',
    // Publishes contracts; does not implement them. That separation is the reason the role
    // exists, so its file scope deliberately excludes functions/ and client/.
    file_scope: ['contracts/**', 'schema/**', 'decisions/**'],
    deploy_scope: [],
    capabilities: ['claim', 'acquire_scope', 'publish_contract', 'triage', 'suggest'],
  },
  backend: {
    slug: 'backend',
    file_scope: ['functions/**', 'schema/**'],
    deploy_scope: ['functions'],
    capabilities: ['claim', 'acquire_scope', 'publish_contract', 'open_pr', 'deploy', 'triage', 'suggest'],
  },
  frontend: {
    slug: 'frontend',
    file_scope: ['client/**'],
    deploy_scope: ['hosting'],
    capabilities: ['claim', 'acquire_scope', 'publish_contract', 'open_pr', 'deploy', 'triage', 'suggest'],
  },
  qa: {
    slug: 'qa',
    file_scope: ['test/**', 'e2e/**'],
    deploy_scope: [],
    capabilities: ['claim', 'acquire_scope', 'open_pr', 'triage', 'suggest'],
  },
  user: {
    slug: 'user',
    file_scope: [],
    deploy_scope: [],
    capabilities: ['suggest'],
  },
};

export const CAPABILITIES: readonly Capability[] = [
  'claim', 'acquire_scope', 'publish_contract', 'open_pr', 'deploy', 'triage', 'invite', 'suggest',
];

/** What a project's role document holds. Every field optional: documents written before shared sessions lack some. */
export interface RolePolicy {
  file_scope?: unknown;
  deploy_scope?: unknown;
  capabilities?: unknown;
  label?: unknown;
}

const strings = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : null;

/**
 * The role a slug names, in a project.
 *
 * `policy` is the project's own role document (projects/{pid}/roles/{slug}) when the caller has
 * read it. Shared sessions made that document the whole role: a seat drawn by `flotilla share`
 * exists nowhere else, so a gate that consulted only the template would refuse every guest.
 *
 * Rules, in order:
 *   1. `owner` and `user` are FIXED. No document can widen the user seat or narrow the owner.
 *   2. A TEMPLATE role (architect, backend, frontend, qa) keeps the template's capabilities, and
 *      takes only its scopes from the policy. Its documents were copied at project birth, some
 *      before order 0089 widened `triage`; reading capabilities from them would quietly take
 *      triage away from every older project. Nothing edits a template role's capabilities, so
 *      the template is the truth.
 *   3. Any other slug is a seat a host drew, and its policy IS the role. Unknown capability
 *      strings are dropped, never kept: a typo must not become a permission.
 *   4. An unknown slug with no policy gets the LEAST privilege, not a default of convenience. A
 *      typo in a role name must not silently grant backend rights.
 */
export function roleFor(slug: string, policy?: RolePolicy | null): RoleDefinition {
  if (slug === 'owner' || slug === 'user') return DEFAULT_ROLES[slug];
  const template = (DEFAULT_ROLES as Record<string, RoleDefinition | undefined>)[slug];
  if (!policy) return template ?? DEFAULT_ROLES.user;
  const caps = template ? null : strings(policy.capabilities);
  const base: RoleDefinition = caps
    ? {
        slug,
        file_scope: [],
        deploy_scope: [],
        capabilities: caps.filter((c): c is Capability => (CAPABILITIES as readonly string[]).includes(c)),
      }
    : { ...(template ?? DEFAULT_ROLES.user), slug: template ? slug : 'user' };
  return {
    ...base,
    file_scope: strings(policy.file_scope) ?? (caps ? [] : base.file_scope),
    deploy_scope: strings(policy.deploy_scope) ?? (caps ? [] : base.deploy_scope),
    ...(typeof policy.label === 'string' && policy.label ? { label: policy.label } : {}),
  };
}

export function hasCapability(slug: string, cap: Capability, policy?: RolePolicy | null): boolean {
  return roleFor(slug, policy).capabilities.includes(cap);
}

/** Thrown when a role attempts something outside its scope or capability set. */
export class RoleDeniedError extends Error {
  readonly role: string;
  readonly requested: string[];
  readonly allowed: string[];
  constructor(role: string, what: string, requested: string[], allowed: string[]) {
    super(
      `role "${role}" may not ${what}: requested ${JSON.stringify(requested)}, ` +
        `allowed ${allowed.length ? JSON.stringify(allowed) : '(nothing)'}`,
    );
    this.name = 'RoleDeniedError';
    this.role = role;
    this.requested = requested;
    this.allowed = allowed;
  }
}

export interface ProjectRecord {
  project_id: ProjectId;
  project_name: string;
  /** `owner/repo`. The durable half lives here; a project without a repo has no blackboard. */
  repo_url: string;
  created_at: string;
  created_by: MemberUid;
}

export interface MemberRecord {
  uid: MemberUid;
  role: RoleSlug;
  /** Human-readable, for the board. Never an identity. */
  label: string;
  /**
   * Revoked members are RETAINED, not deleted.
   *
   * Deleting the document would make `isMember()` false, which is the same outcome -- but it
   * would also erase the record that this person was ever a member, and the ledger references
   * them. Revocation is a state, not an absence.
   */
  revoked: boolean;
  added_at: string;
}

/** Thrown when an operation would leave a project with no one able to administer it. */
export class LastOwnerError extends Error {
  readonly project_id: ProjectId;
  readonly uid: MemberUid;
  constructor(project_id: ProjectId, uid: MemberUid) {
    super(`refusing to remove the last owner of ${project_id}`);
    this.name = 'LastOwnerError';
    this.project_id = project_id;
    this.uid = uid;
  }
}

/** Thrown when a project id is already taken. Creation is not idempotent on name. */
export class ProjectExistsError extends Error {
  readonly project_id: ProjectId;
  constructor(project_id: ProjectId) {
    super(`project ${project_id} already exists`);
    this.name = 'ProjectExistsError';
    this.project_id = project_id;
  }
}

export interface CreateProjectInput {
  project_id: ProjectId;
  project_name: string;
  repo_url: string;
  /** Becomes the first member, with role `owner`. A project always has an owner from birth. */
  owner_uid: MemberUid;
  owner_label: string;
  /**
   * Which roles the project is born with: 'web' (the six, and the default), 'deck' or 'blank'.
   * See shared/store/templates.ts. Absent means 'web', so every existing caller is unchanged.
   */
  template?: 'web' | 'deck' | 'blank';
}

export interface ProjectDirectory {
  /**
   * Create a project and its first owner, atomically.
   *
   * ATOMIC ON PURPOSE: a project that exists with no members is invisible to its own creator,
   * because `isMember()` gates every read. A partial create is therefore worse than a failed
   * one -- it produces a project nobody can see, list, or delete.
   *
   * Throws ProjectExistsError rather than overwriting. Creation is not idempotent: two people
   * running `flotilla new` in two clones of the same repo must not silently share a project.
   */
  createProject(input: CreateProjectInput): Promise<ProjectRecord>;

  /**
   * Projects this uid is a NON-REVOKED member of. Never a global list.
   *
   * The scoping is the point: the browser calls this, and the security rules enforce the same
   * restriction independently. An adapter that returned everything would still be denied by the
   * rules, which is defence in depth rather than redundancy.
   */
  listProjects(uid: MemberUid): Promise<(ProjectRecord & { role: RoleSlug })[]>;

  /** Null when it does not exist. Absence is not an error. */
  getProject(project_id: ProjectId): Promise<ProjectRecord | null>;

  /** Idempotent on uid: adding an existing member updates their label and un-revokes them. */
  addMember(project_id: ProjectId, uid: MemberUid, role: RoleSlug, label: string): Promise<void>;

  /** Includes revoked members. The caller decides whether to show them. */
  listMembers(project_id: ProjectId): Promise<MemberRecord[]>;

  /** Throws LastOwnerError if it would demote the only remaining owner. */
  setRole(project_id: ProjectId, uid: MemberUid, role: RoleSlug): Promise<void>;

  /**
   * Revoke, do not delete. Throws LastOwnerError if it would revoke the only owner.
   *
   * Idempotent: revoking an already-revoked member is a no-op, not an error.
   */
  revokeMember(project_id: ProjectId, uid: MemberUid): Promise<void>;
}
