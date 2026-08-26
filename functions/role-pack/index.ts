// GET /role-pack -- the calling agent's role pack.
//
// Returns POINTERS, never prompt bodies. A `text` column caps at 10,000
// characters and a role prompt can exceed that, so the prompt lives in the git
// blackboard and this returns `prompt_path` plus the commit that pins it. Same
// rule as contracts: content in git, pointers in the ledger.
//
// NOT WIRED: the lookup is behind RolePackPort. Needs a project ID.

import type { ProjectId } from '../../shared/store/types.ts';
import { StoreError } from '../../shared/store/errors.ts';
import type { Principal } from '../_lib/auth.ts';
import { requireProject } from '../_lib/auth.ts';
import type { HttpResponse } from '../_lib/http.ts';
import { json } from '../_lib/http.ts';

export interface RolePackPort {
  findRole(project_id: ProjectId, role_slug: string): Promise<{
    role_slug: string; label: string; can_merge: unknown; prompt_path?: string | null;
  } | null>;
  /** Head commit of the blackboard branch, so the prompt path is sha-pinned. */
  blackboardHead(project_id: ProjectId): Promise<string | null>;
}

export async function handleRolePack(
  port: RolePackPort, principal: Principal, project_id: ProjectId,
): Promise<HttpResponse> {
  requireProject(principal, project_id);

  const role = await port.findRole(project_id, principal.role_slug);
  if (!role) throw new StoreError(`role not found: ${principal.role_slug}`);

  const commit_sha = await port.blackboardHead(project_id);

  return json(200, {
    role_slug: role.role_slug,
    label: role.label,
    // Already resolved through readBool during authentication -- not re-read
    // from the row, where it would be the string "false".
    can_merge: principal.can_merge,
    prompt_path: role.prompt_path ?? null,
    commit_sha,
  });
}
