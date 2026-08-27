// GitHub payload -> ledger event.
//
// ROUTE G DELIVERS THESE BY POLLING, NOT BY RECEIVING A WEBHOOK. The brief
// permits it -- "you may not need one: poll instead" -- and route G has no
// hosted endpoint to receive a delivery at, which is the same fact that makes
// its provisioning cost zero.
//
// So why is the HMAC verifier here at all? Because the two things are separable
// and only one of them is transport:
//
//   - The MAPPING (D5, D5a, D5b, D6) is required on both paths. Polling
//     /pulls and /check-runs returns the same `conclusion` and `merged` fields a
//     webhook body carries, so the allowlist and the strict-boolean rule apply
//     identically. Sharing one mapper is what keeps route G's board semantics
//     identical to the other two.
//   - The HMAC (D1, D2, D3) only applies to a received delivery. It is
//     implemented and tested because route G CAN be run with a hosted endpoint
//     via GitHub Actions, and because a verifier that exists but was never
//     tested is the untested-error-path problem A17 taught me.
//
// Everything here is a pure function over a payload, so all of section D is
// testable with zero quota and no hosting.

import { createHmac, timingSafeEqual } from 'node:crypto';

import type { CoordinationEventKind, EventInput } from '../../shared/store/types.ts';
import type { Logger } from '../../shared/log.ts';
import { nullLogger } from '../../shared/log.ts';

// ---- signature -------------------------------------------------------------

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'malformed' | 'mismatch' };

/**
 * Verify `X-Hub-Signature-256` over the RAW body bytes.
 *
 * Two traps, both already paid for elsewhere in this project:
 *
 * 1. `crypto.timingSafeEqual` THROWS on a length mismatch. A header of
 *    `sha256=ab` would turn a verifier into a 500 rather than a rejection, so
 *    the header shape is checked BEFORE anything is decoded. Order 0006.
 * 2. The comparison is timing-safe, never `===`. A byte-by-byte early return
 *    leaks the signature one character at a time to anyone who can time it.
 */
export function verifySignature(
  rawBody: Buffer | string, header: string | undefined, secret: string,
): VerifyResult {
  if (header === undefined || header === '') return { ok: false, reason: 'missing' };

  // Shape-check first. 'sha256=' plus exactly 64 lowercase hex characters.
  const m = /^sha256=([0-9a-f]{64})$/.exec(header);
  if (!m) return { ok: false, reason: 'malformed' };

  const provided = Buffer.from(m[1]!, 'hex');
  const expected = createHmac('sha256', secret)
    .update(typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody)
    .digest();

  // Lengths are now guaranteed equal by the regex, so this cannot throw -- but
  // the guard stays, because "guaranteed by a regex two lines up" is exactly
  // the kind of invariant a refactor breaks.
  if (provided.length !== expected.length) return { ok: false, reason: 'malformed' };
  return timingSafeEqual(provided, expected) ? { ok: true } : { ok: false, reason: 'mismatch' };
}

/**
 * Idempotency key for a delivery.
 *
 * `gh_<delivery_id>`, NOT `gh:<delivery_id>` -- order 0008 caught the colon
 * form, because a separator inside a composite part is what a composite-key
 * builder must reject. Route G hashes its key parts rather than joining with a
 * separator, so the colon would not actually collide here; the underscore form
 * is kept anyway so the wire-level key is identical across all three routes and
 * a replay is deduped the same way everywhere.
 */
export function deliveryIdempotencyKey(delivery_id: string): string {
  return `gh_${delivery_id}`;
}

// ---- check_suite conclusion allowlist ---------------------------------------

/**
 * NORMATIVE table from acceptance-checklist.md. A TABLE, not a chain of ifs, so
 * the whole allowlist is visible at once (order 0011).
 *
 * `timed_out` maps to `ci_failed` because it is a CONCLUSIVE terminal failure,
 * not an inconclusive one -- GitHub renders it with a red X. Dropping it leaves
 * the board silent while the agent believes CI is still pending, and to an agent
 * SILENCE READS AS "NOT FINISHED YET". Dropping a terminal failure does not
 * merely lose information, it installs the wrong belief. Order 0010.
 */
export const CHECK_SUITE_CONCLUSIONS: Readonly<Record<string, CoordinationEventKind | null>> =
  Object.freeze({
    success: 'ci_passed',
    failure: 'ci_failed',
    timed_out: 'ci_failed',
    neutral: null,          // explicitly neutral by definition
    cancelled: null,        // a human stopped it; not a code failure
    skipped: null,          // did not run
    stale: null,            // superseded by a newer run
    action_required: null,  // needs a human, not a failure signal
  });

/**
 * Absent from the table means DROP.
 *
 * A permissive default is invisible until it misfires, and it is not covered by
 * testing the values that exist today: a conclusion GitHub has not invented yet
 * must not default into a red badge on a task whose CI never reported one.
 */
export function mapCheckConclusion(conclusion: unknown): CoordinationEventKind | null {
  if (typeof conclusion !== 'string') return null; // null / absent / non-string
  return Object.prototype.hasOwnProperty.call(CHECK_SUITE_CONCLUSIONS, conclusion)
    ? CHECK_SUITE_CONCLUSIONS[conclusion]!
    : null;
}

// ---- payload mapping --------------------------------------------------------

export interface MapContext {
  /** repo full_name -> project_id. An unknown repo is dropped, never guessed. */
  resolveProject(repo_full_name: string): string | null;
  /** branch -> task_id, from the agent branch prefix convention. */
  resolveTask(branch: string): string | null;
  log?: Logger;
}

export interface Mapped {
  project_id: string;
  event: EventInput;
  idempotency_key: string;
}

/**
 * Map one delivery to at most one event.
 *
 * Returns null for anything unmappable. An AMBIGUOUS payload is DROPPED, never
 * guessed: a PR closed without `merged: true` is not `merged`, and an
 * inconclusive check_suite is not `ci_failed`. Silent misclassification in an
 * append-only ledger is unfixable later.
 */
export function mapDelivery(
  event_name: string, payload: unknown, delivery_id: string, ctx: MapContext,
): Mapped | null {
  const log = ctx.log ?? nullLogger;
  const p = payload as Record<string, unknown>;
  const repo = (p?.repository as { full_name?: unknown } | undefined)?.full_name;

  if (typeof repo !== 'string') {
    log.warn('webhook.dropped', 'delivery has no repository.full_name', { event_name, delivery_id });
    return null;
  }
  const project_id = ctx.resolveProject(repo);
  if (project_id === null) {
    // D6: logged and dropped, never a 500. An unmappable repo is somebody
    // else's webhook, not our bug.
    log.warn('webhook.unknownRepo', 'no project for this repository, dropping', {
      event_name, delivery_id, repo,
    });
    return null;
  }

  const idempotency_key = deliveryIdempotencyKey(delivery_id);
  const mk = (kind: CoordinationEventKind, body: Record<string, unknown>): Mapped => ({
    project_id,
    event: { layer: 'coordination', kind, actor_type: 'github', actor_id: repo, body },
    idempotency_key,
  });

  switch (event_name) {
    case 'push': {
      const ref = typeof p.ref === 'string' ? p.ref : '';
      const branch = ref.replace(/^refs\/heads\//, '');
      const task_id = ctx.resolveTask(branch);
      if (!task_id) {
        log.info('webhook.dropped', 'push on a branch with no task', { delivery_id, branch });
        return null;
      }
      const after = typeof p.after === 'string' ? p.after : null;
      // A branch DELETE arrives as a push whose `after` is all zeroes. It is not
      // a branch_pushed.
      if (after === null || /^0{40}$/.test(after)) {
        log.info('webhook.dropped', 'branch deletion is not a push event', { delivery_id, branch });
        return null;
      }
      return mk('branch_pushed', { branch, commit: after, task_id });
    }

    case 'pull_request': {
      const action = typeof p.action === 'string' ? p.action : '';
      const pr = p.pull_request as Record<string, unknown> | undefined;
      if (!pr) return null;
      const branch = ((pr.head as { ref?: unknown } | undefined)?.ref as string) ?? '';
      const task_id = ctx.resolveTask(branch);
      if (!task_id) {
        log.info('webhook.dropped', 'pull_request on a branch with no task', { delivery_id, branch });
        return null;
      }
      const pr_number = typeof pr.number === 'number' ? pr.number : null;
      const pr_url = typeof pr.html_url === 'string' ? pr.html_url : null;

      if (action === 'opened' || action === 'synchronize' || action === 'reopened') {
        return mk('pr_opened', { task_id, pr_number, pr_url, branch });
      }
      if (action === 'closed') {
        // D5b: STRICT boolean. `"true"` is the shape a JSON quirk actually
        // takes, and on a store where booleans round-trip as strings `"false"`
        // is truthy in JS. Anything that is not literally `true` is a close,
        // not a merge -- and a close is not an event we claim to map.
        if (pr.merged === true) {
          const sha = typeof pr.merge_commit_sha === 'string' ? pr.merge_commit_sha : null;
          return mk('merged', { task_id, pr_number, commit: sha });
        }
        log.info('webhook.dropped', 'pull_request closed without merged === true', {
          delivery_id, pr_number, merged: String(pr.merged),
        });
        return null;
      }
      return null;
    }

    case 'check_suite': {
      const action = typeof p.action === 'string' ? p.action : '';
      if (action !== 'completed') return null;
      const cs = p.check_suite as Record<string, unknown> | undefined;
      if (!cs) return null;

      const kind = mapCheckConclusion(cs.conclusion);
      if (kind === null) {
        log.info('webhook.dropped', 'check_suite conclusion is not a conclusive result', {
          delivery_id, conclusion: String(cs.conclusion),
        });
        return null;
      }
      const branches = Array.isArray(cs.pull_requests) ? cs.pull_requests : [];
      const first = branches[0] as { number?: unknown; head?: { ref?: unknown } } | undefined;
      const branch = (first?.head?.ref as string) ?? (typeof cs.head_branch === 'string' ? cs.head_branch : '');
      const task_id = ctx.resolveTask(branch);
      if (!task_id) {
        log.info('webhook.dropped', 'check_suite on a branch with no task', { delivery_id, branch });
        return null;
      }
      return mk(kind, {
        task_id,
        pr_number: typeof first?.number === 'number' ? first.number : null,
        check_name: typeof cs.app === 'object' && cs.app !== null
          ? String((cs.app as { name?: unknown }).name ?? 'check_suite')
          : 'check_suite',
        details_url: typeof cs.url === 'string' ? cs.url : null,
      });
    }

    default:
      log.debug('webhook.ignored', 'event type not mapped', { event_name, delivery_id });
      return null;
  }
}

/** `agent/<role>/<task-slug>` -> `task_<slug>`. */
export function taskFromBranch(branch: string): string | null {
  const m = /^agent\/[a-z]+\/(.+)$/.exec(branch);
  if (!m) return null;
  const slug = m[1]!.replace(/[^A-Za-z0-9_-]/g, '_');
  return slug === '' ? null : `task_${slug}`;
}
