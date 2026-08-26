// The stale-claim reaper. Build order step 6.
//
// Without this, a dead laptop holds a task forever: the claim row is durable, the
// agent that owns it is gone, and nothing in the system ever notices. The
// protocol gives it a 15 minute timeout and requires a `task_unblocked` event so
// the release is visible in the ledger rather than only in the table.
//
// LIVENESS COMES FROM CACHE, WHICH IS WHY IT WORKS AT ALL. Presence is a Cache
// key with a TTL and no durable row, so "when did this agent last speak" is
// answerable without a single Data Store UPDATE. An agent that never heartbeated
// has no key, and its claim is aged from `claimed_at` instead -- otherwise a
// claim made by an agent that died immediately would never become reapable,
// because there would be no timestamp to age.
//
// IDEMPOTENCE MATTERS MORE HERE THAN ANYWHERE ELSE. A cron function can be
// retried, can overlap a previous run, and can be killed mid-batch. So the
// `task_unblocked` append uses a DETERMINISTIC idempotency key derived from what
// is being reaped, not a fresh uuid. Two runs that both decide to reap the same
// claim produce one event, because the second append is absorbed as a duplicate.

import type { AgentId, ProjectId, TaskId } from '../../shared/store/types.ts';
import { CLAIM_TIMEOUT_MS } from '../../shared/store/types.ts';
import type { Logger } from '../../shared/log.ts';
import { readBool } from '../../shared/sanitize.ts';
import { compositeKey } from '../schema/tables.ts';

export interface ReapableClaim {
  rowid: string;
  claim_key: string;
  project_id: ProjectId;
  task_id: TaskId;
  agent_id: AgentId;
  /** RFC3339. */
  claimed_at: string;
}

export interface AgentLiveness {
  agent_id: AgentId;
  /** Epoch ms of the last heartbeat, or null when Cache has nothing. */
  last_seen_ms: number | null;
  /** Raw from Data Store, so it may be the STRING "false". */
  revoked: unknown;
}

export type ReapReason = 'stale' | 'revoked' | 'never_seen';

export interface ReapDecision {
  claim: ReapableClaim;
  reason: ReapReason;
  /** How long the owner has been silent, in ms. */
  silent_ms: number;
}

export interface DecideInput {
  claims: ReapableClaim[];
  liveness: AgentLiveness[];
  now_ms: number;
  claim_timeout_ms?: number;
  log?: Logger;
}

/**
 * Decide what to reap. Pure, so every rule is testable without a cron schedule
 * or a clock that has to actually pass.
 */
export function decideReaps(input: DecideInput): ReapDecision[] {
  const timeout = input.claim_timeout_ms ?? CLAIM_TIMEOUT_MS;
  const byAgent = new Map(input.liveness.map((l) => [l.agent_id, l]));
  const out: ReapDecision[] = [];

  for (const claim of input.claims) {
    const live = byAgent.get(claim.agent_id);

    // An agent row that no longer exists cannot heartbeat again. Treat it like a
    // revocation rather than waiting out a timeout that can never be met.
    if (live === undefined) {
      out.push({ claim, reason: 'revoked', silent_ms: ageOf(claim, input.now_ms) });
      continue;
    }

    // A revoked token can never produce another heartbeat, so waiting 15 minutes
    // serves no purpose. Reaped immediately, and labelled distinctly so the log
    // does not claim the agent went quiet when it was actually cut off.
    if (readBool(live.revoked)) {
      out.push({ claim, reason: 'revoked', silent_ms: ageOf(claim, input.now_ms) });
      continue;
    }

    if (live.last_seen_ms === null) {
      // Claimed, then never spoke. Aged from the claim itself, because there is
      // no heartbeat to age from and the claim would otherwise be immortal.
      const age = ageOf(claim, input.now_ms);
      if (age > timeout) out.push({ claim, reason: 'never_seen', silent_ms: age });
      continue;
    }

    const silent = input.now_ms - live.last_seen_ms;
    if (silent > timeout) out.push({ claim, reason: 'stale', silent_ms: silent });
  }

  return out;
}

function ageOf(claim: ReapableClaim, now_ms: number): number {
  const at = Date.parse(claim.claimed_at);
  // An unparseable claimed_at must NOT read as "brand new" -- that would make the
  // claim permanently unreapable, which is the exact failure this exists to stop.
  // Treated as infinitely old so it gets released and logged.
  return Number.isNaN(at) ? Number.POSITIVE_INFINITY : now_ms - at;
}

/**
 * The idempotency key for a reap. Deterministic, derived from the claim being
 * released, so two overlapping cron runs produce ONE `task_unblocked` event.
 *
 * `claimed_at` is included so that a task claimed again later and re-reaped gets
 * its own event rather than being absorbed as a duplicate of the first reap.
 */
export function reapIdempotencyKey(claim: ReapableClaim): string {
  // Separator-free parts, because this becomes one part of the composite dedupe
  // key and a colon inside a part is what compositeKey rejects.
  const stamp = claim.claimed_at.replace(/[^0-9]/g, '');
  return `reap_${claim.task_id.toLowerCase()}_${stamp}`;
}

/** The event body for a reap. `was_blocked_by` is null: nothing blocked it, its owner left. */
export function reapEventBody(decision: ReapDecision): Record<string, unknown> {
  return {
    task_id: decision.claim.task_id,
    was_blocked_by: null,
    reason_resolved: `claim released by the reaper: ${decision.reason}`,
    released_agent_id: decision.claim.agent_id,
    silent_ms: Number.isFinite(decision.silent_ms) ? decision.silent_ms : null,
  };
}

export interface ReaperPort {
  /** Live claims across every project, capped. */
  listClaims(limit: number): Promise<ReapableClaim[]>;
  /** Agent rows plus their Cache liveness. */
  listLiveness(project_ids: ProjectId[]): Promise<AgentLiveness[]>;
  /** Delete the claim row by ROWID. */
  deleteClaim(rowid: string): Promise<void>;
  /** Append task_unblocked with the given idempotency key. */
  appendUnblocked(
    project_id: ProjectId, body: Record<string, unknown>, idempotency_key: string,
  ): Promise<void>;
}

export interface ReapResult {
  scanned: number;
  reaped: number;
  failed: number;
  by_reason: Record<ReapReason, number>;
  /**
   * Detail for the first few failures, carried in the RESULT rather than only
   * the log. A deployed function's console output is not retrievable here, so a
   * failure that exists only in a log line is a failure nobody can diagnose.
   * Capped so one broken row cannot produce an unbounded payload.
   */
  failures: { task_id: string; error: string; message: string; code?: string; column?: string }[];
}

/** ZCQL caps a read at 300 rows, so a run reaps at most that many claims. */
export const REAP_BATCH = 300;

/**
 * Run one reaper pass.
 *
 * Order is deliberate: APPEND FIRST, then delete. A crash between them leaves a
 * `task_unblocked` event for a claim that still exists, and the next run reaps it
 * again with the same idempotency key -- so the event is not duplicated and the
 * claim does get released. The reverse order would delete the claim and lose the
 * event, leaving the release invisible in the ledger with nothing to retry from.
 */
export async function runReaper(
  port: ReaperPort, now_ms: number, log: Logger, claim_timeout_ms = CLAIM_TIMEOUT_MS,
): Promise<ReapResult> {
  // Cron and event functions are SILENTLY TERMINATED on timeout, with no log
  // line to say so. A heartbeat at both ends is the only way to tell a silent
  // kill from a clean run that found nothing.
  log.info('reaper.start', 'reaper pass starting', { now_ms, claim_timeout_ms });

  const result: ReapResult = {
    scanned: 0, reaped: 0, failed: 0,
    by_reason: { stale: 0, revoked: 0, never_seen: 0 },
    failures: [],
  };

  try {
    const claims = await port.listClaims(REAP_BATCH);
    result.scanned = claims.length;
    if (claims.length === REAP_BATCH) {
      // Not silent: a full batch means there may be more to do than one pass can
      // reach, and the next scheduled run will continue.
      log.warn('reaper.batch_full', 'claim scan filled its batch; more may remain', {
        batch: REAP_BATCH,
      });
    }
    if (claims.length === 0) {
      log.info('reaper.end', 'reaper pass complete', { ...result });
      return result;
    }

    const project_ids = [...new Set(claims.map((c) => c.project_id))];
    const liveness = await port.listLiveness(project_ids);
    const decisions = decideReaps({ claims, liveness, now_ms, claim_timeout_ms, log });

    for (const decision of decisions) {
      const { claim, reason } = decision;
      try {
        // Append first. See the note above on ordering.
        await port.appendUnblocked(
          claim.project_id, reapEventBody(decision), reapIdempotencyKey(claim),
        );
        await port.deleteClaim(claim.rowid);
        result.reaped += 1;
        result.by_reason[reason] += 1;
        log.warn('reaper.released', 'released a claim whose owner is gone', {
          project_id: claim.project_id, task_id: claim.task_id,
          agent_id: claim.agent_id, reason, silent_ms: decision.silent_ms,
        });
      } catch (err) {
        // One bad claim must not abort the pass: the remaining claims are still
        // holding up other agents. Counted and named, never swallowed.
        result.failed += 1;
        const detail = {
          task_id: claim.task_id,
          error: err instanceof Error ? err.name : typeof err,
          message: err instanceof Error ? err.message : String(err),
          // The SDK rejects with a plain object, so `message` alone is often bare.
          ...(typeof (err as { code?: string })?.code === 'string'
            ? { code: (err as { code: string }).code } : {}),
          ...(typeof (err as { column?: string })?.column === 'string'
            ? { column: (err as { column: string }).column } : {}),
          ...(typeof (err as { backend_message?: string })?.backend_message === 'string'
            ? { message: (err as { backend_message: string }).backend_message } : {}),
        };
        if (result.failures.length < 3) result.failures.push(detail);
        log.error('reaper.release_failed', 'could not release a claim, continuing', {
          project_id: claim.project_id, ...detail,
        });
      }
    }
  } finally {
    log.info('reaper.end', 'reaper pass complete', { ...result });
  }

  return result;
}

/** Claim key, exported so the cron function and the tests agree on the shape. */
export function claimKeyOf(project_id: ProjectId, task_id: TaskId): string {
  return compositeKey(project_id, task_id.toLowerCase());
}
