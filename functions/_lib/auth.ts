// Token -> agent -> project -> role -> permissions, resolved on EVERY request.
//
// Non-negotiable H4: `agent_id` is never accepted from the client. The protocol
// spells out the chain -- "The server resolves token -> agent_id -> project_id ->
// role -> permissions on every request" -- and this is the only implementation
// of it. A handler that learns the caller any other way is a bug.
//
// The token itself is never stored. `agents.token_hash` holds SHA-256 of it, and
// lookup is by hash, so a database dump does not yield working credentials.

import { createHash, timingSafeEqual } from 'node:crypto';

import type { AgentId, ProjectId } from '../../shared/store/types.ts';
import { StoreAuthError } from '../../shared/store/errors.ts';
import { readBool } from '../../shared/sanitize.ts';

export interface AgentRow {
  agent_id: AgentId;
  project_id: ProjectId;
  member_id: string;
  role_slug: string;
  member_label: string;
  harness: string;
  token_hash: string;
  /** Comes back from Data Store as a STRING. Never read directly. */
  revoked: unknown;
}

export interface RoleRow {
  role_key: string;
  project_id: ProjectId;
  role_slug: string;
  label: string;
  /** Comes back from Data Store as a STRING. Never read directly. */
  can_merge: unknown;
  prompt_path?: string | null;
}

export interface Principal {
  agent_id: AgentId;
  project_id: ProjectId;
  role_slug: string;
  member_id: string;
  member_label: string;
  /** Resolved through readBool. A truthy "false" here is an agent merging. */
  can_merge: boolean;
}

export interface AuthPort {
  /** SELECT ... FROM agents WHERE token_hash = ?. Null when unknown. */
  findAgentByTokenHash(token_hash: string): Promise<AgentRow | null>;
  /** SELECT ... FROM roles WHERE role_key = ?. Null when unknown. */
  findRole(project_id: ProjectId, role_slug: string): Promise<RoleRow | null>;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/**
 * Constant-time hash comparison.
 *
 * Lookup is already by hash so this is belt-and-braces, but a `===` here would
 * reintroduce the same prefix-timing leak the webhook verifier avoids.
 */
export function tokenHashMatches(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Resolve a bearer token to a principal.
 *
 * Throws StoreAuthError for every failure mode -- unknown, revoked, role missing
 * -- so the caller answers 401 and the CLI stops rather than retrying. The
 * distinctions are logged, never returned: telling a caller "this token exists
 * but is revoked" is more than an unauthenticated caller needs to know.
 */
export async function resolvePrincipal(port: AuthPort, token: string | null): Promise<Principal> {
  if (!token) throw new StoreAuthError('missing bearer token');

  const agent = await port.findAgentByTokenHash(hashToken(token));
  if (!agent) throw new StoreAuthError('agent token is revoked or invalid');

  // Defence in depth: the lookup was by hash, but never trust a row that does
  // not actually match the presented credential.
  if (!tokenHashMatches(agent.token_hash, hashToken(token))) {
    throw new StoreAuthError('agent token is revoked or invalid');
  }

  // "false" is truthy in JS and Data Store returns booleans as strings, so a
  // direct read here would treat every non-revoked agent as revoked -- or worse,
  // every revoked one as live.
  if (readBool(agent.revoked)) {
    throw new StoreAuthError('agent token is revoked or invalid');
  }

  const role = await port.findRole(agent.project_id, agent.role_slug);
  if (!role) {
    // A token whose role vanished has no permissions to evaluate. Fail closed.
    throw new StoreAuthError('agent role is no longer defined');
  }

  return {
    agent_id: agent.agent_id,
    project_id: agent.project_id,
    role_slug: agent.role_slug,
    member_id: agent.member_id,
    member_label: agent.member_label,
    can_merge: readBool(role.can_merge),
  };
}

/**
 * Confirm the principal may act on this project.
 *
 * A token is project-scoped, so a request naming a different project is a
 * cross-project attempt and is refused rather than silently retargeted.
 */
export function requireProject(principal: Principal, project_id: ProjectId): void {
  if (principal.project_id !== project_id) {
    throw new StoreAuthError('token is not scoped to that project');
  }
}

/**
 * Agents may push branches and open PRs. Agents may NOT merge. Only the
 * integrator role may hold merge permission, and only when the owner grants it.
 * Non-negotiable H3, verified by attempting it.
 */
export function requireMergePermission(principal: Principal): void {
  if (!principal.can_merge) {
    throw new StoreAuthError(`role ${principal.role_slug} may not merge`);
  }
}
