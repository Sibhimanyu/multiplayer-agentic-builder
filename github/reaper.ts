// The stale-claim reaper.
//
// Without it a dead laptop holds a task forever. With it, F11 and F12 work:
// kill an agent, its claim is released within claim_timeout, and another agent
// can take the task.
//
// Route G runs this as a scheduled GitHub Action (.github/workflows/reaper.yml)
// rather than as a cron function, because it has no serverless runtime -- which
// is the same fact that makes its provisioning cost zero. The reaping LOGIC is
// this file and is identical either way; only the thing that calls it differs.
//
// Two decisions worth stating, because order 0020 asks which races were left
// open deliberately:
//
// 1. The reaper's delete is pinned to the claim sha it read. So if the owner
//    returns and re-claims between the read and the delete, the sha has moved,
//    the lease fails, and the reaper does NOT steal a live claim. That race is
//    closed rather than tolerated.
//
// 2. releaseTask's own read-then-delete is NOT atomic, deliberately. The only
//    racers are the owner's own release and this reaper, and BOTH are heading
//    for the same end state, so nothing is lost if both succeed. Unlike scope
//    acquisition there is no correctness window to narrow.

import type { AgentPresence, CoordinationStore, ProjectId, TaskId } from './../shared/store/types.ts';
import { CLAIM_TIMEOUT_MS } from './../shared/store/types.ts';
import { PROTOCOL_VERSION } from './../shared/store/types.ts';
import type { Clock } from './../shared/clock.ts';
import { systemClock } from './../shared/clock.ts';
import type { Logger } from './../shared/log.ts';
import { nullLogger } from './../shared/log.ts';

export interface ReapedClaim {
  task_id: TaskId;
  agent_id: string;
  /** How long the owner had been silent when the claim was taken back. */
  stale_for_ms: number;
}

export interface ReapResult {
  checked: number;
  reaped: ReapedClaim[];
  /** Claims whose owner was stale but whose release LOST a race. Not an error. */
  contested: TaskId[];
  /**
   * Present when the pass could not complete. Rides in the result rather than
   * only in a log line, because a failure that exists only in an unreadable log
   * is a failure nobody can diagnose (order 0019).
   */
  error?: string;
}

export interface ReaperDeps {
  store: CoordinationStore & {
    listClaims(project_id: ProjectId): Promise<{ task_id: TaskId; agent_id: string; sha: string }[]>;
    forceReleaseClaim(project_id: ProjectId, task_id: TaskId, expect_sha: string): Promise<boolean>;
  };
  project_id: ProjectId;
  clock?: Clock;
  log?: Logger;
  claim_timeout_ms?: number;
}

export async function reapStaleClaims(deps: ReaperDeps): Promise<ReapResult> {
  const clock = deps.clock ?? systemClock;
  const log = deps.log ?? nullLogger;
  const timeout = deps.claim_timeout_ms ?? CLAIM_TIMEOUT_MS;
  const result: ReapResult = { checked: 0, reaped: [], contested: [] };

  let presence: AgentPresence[];
  let claims: { task_id: TaskId; agent_id: string; sha: string }[];
  try {
    presence = await deps.store.listPresence(deps.project_id);
    claims = await deps.store.listClaims(deps.project_id);
  } catch (err) {
    result.error = (err as Error).message;
    log.error('reaper.readFailed', 'could not read state, reaping nothing this pass', {
      project_id: deps.project_id, error: result.error,
    });
    return result;
  }

  const lastSeen = new Map<string, number | null>();
  for (const a of presence) {
    lastSeen.set(a.agent_id, a.last_heartbeat_at ? Date.parse(a.last_heartbeat_at) : null);
  }

  const now = clock.now();
  result.checked = claims.length;

  for (const c of claims) {
    const seen = lastSeen.get(c.agent_id);

    // An agent that has NEVER been seen is not automatically dead. It may have
    // claimed a task moments ago and not yet heartbeaten, and reaping it would
    // take a task away from an agent that is starting up. Absent-but-unknown is
    // treated as "not yet reapable" rather than as offline -- the opposite
    // direction from presence, where absent means stale, because here the
    // dangerous mistake is stealing a live claim.
    if (seen === undefined || seen === null) {
      log.debug('reaper.skipped', 'claim owner has no heartbeat yet, not reaping', {
        project_id: deps.project_id, task_id: c.task_id, agent_id: c.agent_id,
      });
      continue;
    }

    const idle = now - seen;
    if (idle <= timeout) continue;

    // Pinned to the sha we read. If the owner came back and re-claimed in
    // between, the sha moved, the lease fails, and we do not steal a live claim.
    let released: boolean;
    try {
      released = await deps.store.forceReleaseClaim(deps.project_id, c.task_id, c.sha);
    } catch (err) {
      log.warn('reaper.releaseFailed', 'could not release a stale claim, will retry next pass', {
        project_id: deps.project_id, task_id: c.task_id, error: (err as Error).message,
      });
      result.contested.push(c.task_id);
      continue;
    }

    if (!released) {
      log.info('reaper.contested', 'claim moved while reaping, leaving it alone', {
        project_id: deps.project_id, task_id: c.task_id, agent_id: c.agent_id,
      });
      result.contested.push(c.task_id);
      continue;
    }

    result.reaped.push({ task_id: c.task_id, agent_id: c.agent_id, stale_for_ms: idle });
    log.warn('reaper.reaped', 'released a claim whose owner went stale', {
      project_id: deps.project_id, task_id: c.task_id, agent_id: c.agent_id, stale_for_ms: idle,
    });

    // Announce it, so a waiting agent learns the task is free without polling
    // the claim namespace itself.
    try {
      await deps.store.appendEvent(deps.project_id, {
        layer: 'contract', kind: 'task_unblocked', actor_type: 'system', actor_id: 'reaper',
        body: {
          task_id: c.task_id,
          was_blocked_by: c.agent_id,
          reason_resolved: `owner stale for ${Math.round(idle / 1000)}s`,
          v: PROTOCOL_VERSION,
        },
      }, `reap_${c.task_id}_${c.sha.slice(0, 12)}`);
    } catch (err) {
      // The claim IS released -- that is the part that matters. A missing
      // announcement is recoverable by the next snapshot read; a held claim is
      // not. Log and carry on rather than unwinding.
      log.warn('reaper.announceFailed', 'claim released but task_unblocked not appended', {
        project_id: deps.project_id, task_id: c.task_id, error: (err as Error).message,
      });
    }
  }

  return result;
}
