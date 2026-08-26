// POST /claim -- atomic task claim.
//
// The only atomic primitive on this platform is a unique-constraint violation,
// verified by probe: an INSERT whose `claim_key` collides returns
// error_code DUPLICATE_VALUE. There is no transaction and no compare-and-set, so
// a read-verify-write here would be racy in exactly the way the protocol forbids.
//
// A LOST CLAIM IS NOT AN ERROR. It returns 200 with {ok:false, owner}. Returning
// 409 would make the CLI treat a normal outcome as a failure and retry it.
//
// NOT WIRED: the Data Store calls are behind ClaimPort. Needs a project ID.

import type { AgentId, ClaimResult, ProjectId, TaskId } from '../../shared/store/types.ts';
import { DuplicateValueError } from '../../catalyst/lib/duplicate.ts';
import { compositeKey } from '../../catalyst/schema/tables.ts';
import type { Logger } from '../../shared/log.ts';
import type { Principal } from '../_lib/auth.ts';
import { requireProject } from '../_lib/auth.ts';
import type { HttpResponse } from '../_lib/http.ts';
import { json, rejectServerOwnedFields, requireString } from '../_lib/http.ts';

export interface ClaimReleasePort extends ClaimPort {
  /** Delete the claim row. Called only after ownership has been confirmed. */
  deleteClaim(claim_key: string): Promise<void>;
}

export interface ClaimPort {
  /** INSERT into task_claims. Throws DuplicateValueError on claim_key collision. */
  insertClaim(row: {
    claim_key: string; project_id: ProjectId; task_id: TaskId;
    agent_id: AgentId; claimed_at: string;
  }): Promise<void>;
  /** SELECT the live claim for a key. Used only to name the winner to a loser. */
  findClaim(claim_key: string): Promise<{ agent_id: AgentId; claimed_at: string } | null>;
}

/** Task ids are lowercased before keying: the unique constraint is case-sensitive (P4). */
export function claimKeyFor(project_id: ProjectId, task_id: TaskId): string {
  return compositeKey(project_id, task_id.toLowerCase());
}

export async function handleClaim(
  port: ClaimPort, principal: Principal, body: unknown, now: () => string,
): Promise<HttpResponse> {
  rejectServerOwnedFields(body);
  const project_id = requireString(body, 'project_id');
  const task_id = requireString(body, 'task_id');
  requireProject(principal, project_id);

  const claim_key = claimKeyFor(project_id, task_id);

  try {
    await port.insertClaim({
      claim_key, project_id, task_id: task_id.toLowerCase(),
      agent_id: principal.agent_id, claimed_at: now(),
    });
    return json(200, { ok: true } satisfies ClaimResult);
  } catch (err) {
    if (!(err instanceof DuplicateValueError)) throw err;
    if (err.column !== 'claim_key') throw err; // not our race; do not answer for it

    const owner = await port.findClaim(claim_key);
    if (!owner) {
      // Lost the race, then the winner released before we could read it. The
      // task is free again; the caller should retry rather than be told a lie.
      throw new DuplicateValueError(err.backend_message, 'claim_key');
    }
    // 200, not 409: losing is a normal outcome.
    return json(200, { ok: false, owner: owner.agent_id, claimed_at: owner.claimed_at } satisfies ClaimResult);
  }
}

/**
 * Release a claim. Idempotent, and releasing a task you do NOT own is a no-op
 * rather than an error -- store-interface.md is explicit about that.
 *
 * The ownership check is a read followed by a delete, which is not atomic. That is
 * acceptable here in a way it is not for acquiring: the only race is with the
 * owner's own concurrent release or with the reaper, and both are trying to reach
 * the same end state. Nothing is lost if they both succeed.
 */
export async function handleReleaseClaim(
  port: ClaimReleasePort, principal: Principal, body: unknown, log: Logger,
): Promise<HttpResponse> {
  rejectServerOwnedFields(body);
  const project_id = requireString(body, 'project_id');
  const task_id = requireString(body, 'task_id');
  requireProject(principal, project_id);

  const claim_key = claimKeyFor(project_id, task_id);
  const existing = await port.findClaim(claim_key);

  if (!existing) {
    // Already gone. Idempotent by design: a retried release must not fail.
    return json(200, { ok: true, released: false, reason: 'no_claim' });
  }
  if (existing.agent_id !== principal.agent_id) {
    // A no-op, NOT an error. An agent that has lost its claim to the reaper and
    // then tries to release it should not see a failure it cannot act on.
    log.info('claim.release_not_owner', 'release ignored, task is owned by another agent', {
      project_id, task_id, requested_by: principal.agent_id, owner: existing.agent_id,
    });
    return json(200, { ok: true, released: false, reason: 'not_owner' });
  }

  await port.deleteClaim(claim_key);
  return json(200, { ok: true, released: true });
}
