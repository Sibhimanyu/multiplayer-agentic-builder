// The stale-claim reaper. Without this, a dead laptop holds a task forever (F11).
//
// Runs on a schedule. Releases claims whose owning agent has been silent past claim_timeout
// (default 15 minutes) and appends task_unblocked so the board and every agent's inbox learn
// about it.
//
// The reaper is the one place in the system that takes something away from an agent, so it is
// deliberately conservative: it acts on a claim only when the agent's own heartbeat says it is
// gone, it never touches a claim younger than the timeout regardless of heartbeat, and it
// reports every claim it examined and declined.

import { CLAIM_TIMEOUT_MS, type Logger, type ProjectId } from '../../shared/store/types.ts';
import type { FirestoreStore } from '../../shared/store/firestore.ts';
import type { Firestore } from 'firebase-admin/firestore';

export interface ReapResult {
  project_id: ProjectId;
  examined: number;
  released: { task_id: string; agent_id: string; silent_ms: number }[];
  /** Claims left alone, with the reason. Not silent — H. */
  kept: { task_id: string; agent_id: string; reason: string }[];
}

export interface ReapOptions {
  claim_timeout_ms?: number;
  now?: () => number;
}

/**
 * Reap one project.
 *
 * Reads the claim table and the agent table, then releases sequentially rather than in
 * parallel. Sequential on purpose: each release is a transaction against the shared seq
 * counter, and firing twenty at once would make them all contend and retry, turning a tidy
 * twenty writes into sixty.
 */
export async function reapProject(
  db: Firestore,
  store: FirestoreStore,
  project_id: ProjectId,
  log: Logger,
  opts: ReapOptions = {},
): Promise<ReapResult> {
  const timeout = opts.claim_timeout_ms ?? CLAIM_TIMEOUT_MS;
  const now = opts.now ?? (() => Date.now());

  const [claimsSnap, agentsSnap] = await Promise.all([
    db.collection('projects').doc(project_id).collection('claims').get(),
    db.collection('projects').doc(project_id).collection('agents').get(),
  ]);

  const heartbeats = new Map<string, number | null>();
  const revoked = new Set<string>();
  for (const d of agentsSnap.docs) {
    heartbeats.set(d.id, (d.get('last_heartbeat_ms') as number | undefined) ?? null);
    if (d.get('revoked') === true) revoked.add(d.id);
  }

  const result: ReapResult = { project_id, examined: claimsSnap.size, released: [], kept: [] };

  for (const claim of claimsSnap.docs) {
    const task_id = (claim.get('task_id') as string) ?? claim.id;
    const agent_id = claim.get('agent_id') as string;
    const claimed_at_ms = Date.parse((claim.get('claimed_at') as string) ?? '');
    const heartbeat = heartbeats.get(agent_id) ?? null;

    // A revoked agent's claim goes immediately: the token is dead, the work is not resuming,
    // and waiting out the timeout just leaves the task parked.
    if (revoked.has(agent_id)) {
      await release(store, project_id, task_id, agent_id, 0, result, log, 'owner revoked');
      continue;
    }

    if (!heartbeats.has(agent_id)) {
      // A claim by an agent with no presence document at all. This is not a stale agent, it is
      // an inconsistency, and guessing is worse than reporting it.
      result.kept.push({ task_id, agent_id, reason: 'no presence document for the owning agent' });
      log.warn('claim held by unknown agent', { project_id, task_id, agent_id });
      continue;
    }

    if (heartbeat === null) {
      // Registered but never heartbeated. Fall back to the claim's own age, so a CLI that
      // claimed and died before its first heartbeat still gets reaped.
      const age = Number.isFinite(claimed_at_ms) ? now() - claimed_at_ms : Infinity;
      if (age > timeout) {
        await release(store, project_id, task_id, agent_id, age, result, log, 'never heartbeated');
      } else {
        result.kept.push({ task_id, agent_id, reason: `never heartbeated but claim is only ${age}ms old` });
      }
      continue;
    }

    const silent = now() - heartbeat;
    if (silent > timeout) {
      await release(store, project_id, task_id, agent_id, silent, result, log, 'heartbeat stale');
    } else {
      result.kept.push({ task_id, agent_id, reason: `heartbeat ${silent}ms ago, within ${timeout}ms` });
    }
  }

  log.info('reap complete', {
    project_id,
    examined: result.examined,
    released: result.released.length,
    kept: result.kept.length,
  });
  return result;
}

async function release(
  store: FirestoreStore,
  project_id: ProjectId,
  task_id: string,
  agent_id: string,
  silent_ms: number,
  result: ReapResult,
  log: Logger,
  reason: string,
): Promise<void> {
  try {
    // reapClaim, NOT releaseTask. The reaper acts with system authority, not as the owning
    // agent, and routing it through releaseTask broke in two ways: releaseTask appends its own
    // agent-attributed task_unblocked (so the ledger got two events for one release), and it
    // refuses a revoked agent (so exactly the claims that most need reaping could not be).
    // Both were caught by the tests in reaper.test.ts.
    const r = await store.reapClaim(project_id, task_id, agent_id, reason);
    if (!r.released) {
      // The claim moved between the survey and the release. Not a failure, but not a reap
      // either, and the counts still have to add up.
      result.kept.push({ task_id, agent_id, reason: 'claim changed hands during the sweep' });
      return;
    }
    result.released.push({ task_id, agent_id, silent_ms });
    log.info('claim reaped', { project_id, task_id, agent_id, silent_ms, reason });
  } catch (err) {
    // One failed release must not abandon the rest of the table. Named, logged, and recorded
    // as kept so the count still adds up.
    result.kept.push({ task_id, agent_id, reason: `release failed: ${String(err)}` });
    log.warn('reap failed for one claim', { project_id, task_id, agent_id, error: String(err) });
  }
}

/** Reap every project. Returns one result per project; never throws for a single failure. */
export async function reapAll(
  db: Firestore,
  store: FirestoreStore,
  log: Logger,
  opts: ReapOptions = {},
): Promise<ReapResult[]> {
  const projects = await db.collection('projects').get();
  const out: ReapResult[] = [];
  for (const p of projects.docs) {
    try {
      out.push(await reapProject(db, store, p.id, log, opts));
    } catch (err) {
      log.warn('reap failed for one project', { project_id: p.id, error: String(err) });
    }
  }
  return out;
}
