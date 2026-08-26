// Token -> agent_id -> project -> role -> permissions. Resolved on EVERY request.
//
// This file is the answer to two non-negotiables:
//
//   "agent_id is never accepted from the client. Verified by forging one."
//   "Agents cannot merge. Verified by attempting it."
//
// Both are enforced here and nowhere else. There is deliberately no second implementation in
// the security rules, because the client cannot write at all — a per-field client write rule
// would be a weaker duplicate of this logic, and the weaker one is the one that gets attacked.
//
// The shape that matters: resolveAgent() takes the bearer token and returns the identity. It
// never takes an agent_id, project_id or role parameter, so there is no argument a caller
// could pass to influence who they are. If you find yourself adding one, stop.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Firestore } from 'firebase-admin/firestore';

import { StoreAuthError } from '../../shared/store/errors.ts';
import type { AgentId, ProjectId } from '../../shared/store/types.ts';

/** What an agent is allowed to do. Derived from the role, never sent by the client. */
export interface Permissions {
  push_branches: boolean;
  open_prs: boolean;
  /** Only an integrator may hold this, and only when the owner grants it. */
  merge: boolean;
  publish_contracts: boolean;
}

export interface Identity {
  agent_id: AgentId;
  project_id: ProjectId;
  role_slug: string;
  member_label: string;
  permissions: Permissions;
}

/**
 * Role packs. `merge: false` for every agent role without exception.
 *
 * The integrator role exists in the protocol but is not in this table: granting merge is an
 * owner action that writes an explicit override onto the agent document, so the default for
 * every role a `connect` can produce is "cannot merge". A typo in a role slug therefore fails
 * closed rather than granting merge.
 */
export const ROLE_PACKS: Record<string, Permissions> = {
  architect: { push_branches: true, open_prs: true, merge: false, publish_contracts: true },
  'backend-builder': { push_branches: true, open_prs: true, merge: false, publish_contracts: true },
  'frontend-builder': { push_branches: true, open_prs: true, merge: false, publish_contracts: false },
  'qa-verifier': { push_branches: true, open_prs: true, merge: false, publish_contracts: false },
  'docs-writer': { push_branches: true, open_prs: true, merge: false, publish_contracts: false },
};

const DENY_ALL: Permissions = {
  push_branches: false,
  open_prs: false,
  merge: false,
  publish_contracts: false,
};

/**
 * Hash an agent token for storage.
 *
 * The plaintext token is returned to the CLI once, at connect, and never stored. A database
 * dump therefore does not yield working credentials. sha256 with no salt is deliberate here
 * and would be wrong for a password: the token is 32 bytes of CSPRNG output, so there is no
 * dictionary to attack and a per-token salt would only prevent the O(1) lookup this needs.
 */
export const hashToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

/** 32 bytes, base64url. The only time the plaintext exists. */
export const mintToken = (): string => randomBytes(32).toString('base64url');

/** Constant-time string compare for fixed-length hex digests. */
function sameDigest(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** "Bearer <token>" -> "<token>". Returns null for anything else. */
export function bearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return m ? m[1]! : null;
}

/**
 * Resolve a bearer token to a full identity, or throw StoreAuthError.
 *
 * Note the absent parameters: no agent_id, no project_id, no role. The caller cannot assert
 * who it is. Everything comes from the token document.
 *
 * Costs one indexed query per request. That is the price of immediate revocation — caching it
 * for even 60 seconds means a revoked agent keeps writing for 60 seconds.
 */
export async function resolveAgent(db: Firestore, authorization: string | undefined): Promise<Identity> {
  const token = bearerToken(authorization);
  if (!token) throw new StoreAuthError('missing or malformed Authorization header');

  const digest = hashToken(token);
  // Collection-group query: one lookup regardless of how many projects exist. The token hash
  // is the document id, so this is a point read, not a scan.
  const matches = await db.collectionGroup('agents').where('token_sha256', '==', digest).limit(2).get();

  if (matches.empty) throw new StoreAuthError('unknown agent token');
  if (matches.size > 1) {
    // Two agents sharing a token hash means either a sha256 collision or a bug in connect.
    // Both are refusals, not something to pick a winner from.
    throw new StoreAuthError('ambiguous agent token');
  }

  const doc = matches.docs[0]!;
  const data = doc.data() as {
    agent_id?: string;
    role_slug?: string;
    member_label?: string;
    token_sha256?: string;
    revoked?: boolean;
    grant_merge?: boolean;
  };

  // Re-verify in constant time. The query already matched, but comparing again means a future
  // change to the query (a range, a prefix) cannot silently loosen authentication.
  if (!data.token_sha256 || !sameDigest(data.token_sha256, digest)) {
    throw new StoreAuthError('token digest mismatch');
  }
  if (data.revoked === true) throw new StoreAuthError('agent token revoked');

  // projects/{pid}/agents/{agent_id} -> the parent of the parent is the project document.
  const project_id = doc.ref.parent.parent?.id;
  if (!project_id) throw new StoreAuthError('agent document is not under a project');

  const role_slug = data.role_slug ?? '';
  const pack = ROLE_PACKS[role_slug];
  if (!pack) {
    // Fail closed. An unknown role gets no permissions rather than a default set.
    return {
      agent_id: doc.id,
      project_id,
      role_slug,
      member_label: data.member_label ?? doc.id,
      permissions: { ...DENY_ALL },
    };
  }

  return {
    agent_id: doc.id,
    project_id,
    role_slug,
    member_label: data.member_label ?? doc.id,
    permissions: {
      ...pack,
      // The ONLY way merge becomes true: an explicit per-agent grant written by the owner.
      // Never from the role pack, never from the request.
      merge: data.grant_merge === true,
    },
  };
}

export class PermissionError extends Error {
  readonly permission: keyof Permissions;
  constructor(permission: keyof Permissions, agent_id: AgentId) {
    super(`agent ${agent_id} is not permitted to ${permission}`);
    this.name = 'PermissionError';
    this.permission = permission;
  }
}

export function require_(id: Identity, permission: keyof Permissions): void {
  if (!id.permissions[permission]) throw new PermissionError(permission, id.agent_id);
}

/**
 * Event kinds an agent may append, keyed by the permission they need.
 *
 * Anything not listed is refused. This is an allowlist on purpose: a new event kind added to
 * the protocol is not appendable by an agent until someone decides which permission it needs.
 *
 * `merged` is absent from every agent path — it originates only from the webhook, with
 * actor_type 'github'. That is the mechanism behind "agents cannot merge": there is no code
 * path from an agent token to a `merged` event, so the check cannot be bypassed by forging a
 * field. Enforced by test in api.test.ts.
 */
export const AGENT_APPENDABLE: Record<string, keyof Permissions | 'always'> = {
  task_progress: 'always',
  task_blocked: 'always',
  task_completed: 'always',
  agent_heartbeat: 'always',
  scope_locked: 'always',
  scope_released: 'always',
  schema_published: 'publish_contracts',
  contract_published: 'publish_contracts',
  contract_superseded: 'publish_contracts',
  decision_recorded: 'publish_contracts',
  // NOT appendable by an agent, deliberately:
  //   merged, pr_opened, ci_passed, ci_failed, branch_pushed -> webhook only, actor github
  //   task_claimed -> written by the claim transaction, not by a free-form append
  //   task_unblocked -> written by the reaper or a release, not asserted by an agent
};

export function assertAppendable(id: Identity, kind: string): void {
  const need = AGENT_APPENDABLE[kind];
  if (!need) {
    throw new PermissionError(
      'publish_contracts',
      `${id.agent_id} (event kind "${kind}" is not agent-appendable)`,
    );
  }
  if (need !== 'always') require_(id, need);
}
