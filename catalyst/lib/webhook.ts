// GitHub webhook: signature verification and event mapping.
//
// This is the one place in the system where bytes from the public internet turn
// into ledger events, so three rules are absolute.
//
// 1. HMAC OVER THE RAW BODY BYTES. Not over a re-serialised object. JSON.parse
//    followed by JSON.stringify does not round-trip: key order, unicode escapes
//    and number formatting all shift, and the signature stops matching for
//    reasons that look random. This is why the stack picked Advanced I/O
//    functions -- they are the only Catalyst function type that can hand you the
//    raw body. The handler must not let any JSON middleware touch it first.
//
// 2. TIMING-SAFE COMPARISON. `===` on a hex digest leaks the length of the
//    matching prefix, which is enough to forge a signature one byte at a time.
//    crypto.timingSafeEqual, always.
//
// 3. AN UNMAPPABLE DELIVERY IS LOGGED AND DROPPED, NEVER A 500. GitHub retries
//    5xx and disables a hook that keeps failing. A repo we do not know about is
//    a normal event, not an error (D6).

import { createHmac, timingSafeEqual } from 'node:crypto';

import type { EventInput } from '../../shared/store/types.ts';

export const SIGNATURE_HEADER = 'x-hub-signature-256';
export const EVENT_HEADER = 'x-github-event';
export const DELIVERY_HEADER = 'x-github-delivery';

const SIGNATURE_PREFIX = 'sha256=';

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing' | 'malformed' | 'mismatch' };

/**
 * Verify `X-Hub-Signature-256` over the raw request body.
 *
 * `raw` MUST be the exact bytes GitHub sent. Passing a re-serialised object here
 * produces a mismatch that will look like a configuration problem for a day.
 */
export function verifyGithubSignature(
  raw: Buffer | Uint8Array, header: string | undefined | null, secret: string,
): VerifyResult {
  if (!header) return { ok: false, reason: 'missing' };
  if (!secret) return { ok: false, reason: 'missing' };
  if (!header.startsWith(SIGNATURE_PREFIX)) return { ok: false, reason: 'malformed' };

  const provided = header.slice(SIGNATURE_PREFIX.length);
  // A hex digest of SHA-256 is exactly 64 characters. Checking shape before
  // decoding keeps Buffer.from from silently truncating garbage into something
  // that happens to be the right length.
  if (!/^[0-9a-f]{64}$/i.test(provided)) return { ok: false, reason: 'malformed' };

  const expected = createHmac('sha256', secret).update(raw).digest();
  const providedBytes = Buffer.from(provided, 'hex');

  // Lengths are fixed by the algorithm, so this guard leaks nothing; it exists
  // because timingSafeEqual throws on a length mismatch.
  if (providedBytes.length !== expected.length) return { ok: false, reason: 'malformed' };

  return timingSafeEqual(providedBytes, expected) ? { ok: true } : { ok: false, reason: 'mismatch' };
}

/** Sign a body the way GitHub does. Used by the tests, and by nothing else. */
export function signGithubBody(raw: Buffer | Uint8Array | string, secret: string): string {
  return SIGNATURE_PREFIX + createHmac('sha256', secret).update(raw).digest('hex');
}

/**
 * Branch naming: `<branch_prefix>/<task_id>`, e.g. `agent/backend/task_items_api`.
 *
 * `branch_prefix` is per-role (coordination-api.md `roles.branch_prefix`), so the
 * task id is the LAST segment. The docs require the webhook to "map the
 * repository and branch to a project/task" without fixing the format, so this
 * pins it in one place rather than leaving each call site to guess.
 *
 * Returns null when the branch does not encode a task. That is not an error --
 * a human pushing to `main` is normal traffic.
 */
export function taskIdFromBranch(branch: string | null | undefined): string | null {
  if (!branch) return null;
  const last = branch.split('/').filter(Boolean).pop();
  if (!last) return null;
  return /^task_[a-z0-9][a-z0-9_-]*$/.test(last) ? last : null;
}

/** A ref like `refs/heads/agent/backend/task_items_api` -> the branch name. */
export function branchFromRef(ref: string | null | undefined): string | null {
  if (!ref) return null;
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : null;
}

export type MapResult =
  | { ok: true; event: EventInput; repo: string; task_id: string }
  | { ok: false; reason: string; repo: string | null };

export interface GithubDelivery {
  /** The X-GitHub-Event header value. */
  event: string;
  /** The parsed body. Parsed AFTER the signature was verified over the raw bytes. */
  payload: Record<string, any>;
}

/**
 * Map a verified delivery to exactly one ledger event.
 *
 * Every unmapped case returns `{ok: false, reason}` so the caller can log it and
 * answer 204. Nothing here throws: a thrown error becomes a 500, and a 500
 * teaches GitHub to retry and eventually disable the hook.
 */
export function mapGithubEvent(delivery: GithubDelivery): MapResult {
  const { event, payload } = delivery;
  const repo = typeof payload?.repository?.full_name === 'string'
    ? payload.repository.full_name
    : null;

  if (!repo) return { ok: false, reason: 'payload has no repository.full_name', repo: null };

  const actor = (payload?.sender?.login && typeof payload.sender.login === 'string')
    ? `github:${payload.sender.login}`
    : 'github';

  const mapped = mapKind(event, payload);
  if (!mapped) return { ok: false, reason: `unmapped github event: ${event}`, repo };

  const { kind, branch, body } = mapped;
  const task_id = taskIdFromBranch(branch);
  if (!task_id) {
    return { ok: false, reason: `branch does not encode a task: ${branch ?? '(none)'}`, repo };
  }

  return {
    ok: true,
    repo,
    task_id,
    event: {
      layer: 'coordination',
      kind,
      actor_type: 'github',
      actor_id: actor,
      body: { task_id, ...body },
    },
  };
}

interface MappedKind {
  kind: EventInput['kind'];
  branch: string | null;
  body: Record<string, unknown>;
}

/** The five mappings D5 asserts, and nothing else. */
function mapKind(event: string, payload: Record<string, any>): MappedKind | null {
  switch (event) {
    case 'push': {
      const branch = branchFromRef(payload.ref);
      return {
        kind: 'branch_pushed',
        branch,
        body: { branch, commit: payload.after ?? payload.head_commit?.id ?? null },
      };
    }

    case 'pull_request': {
      const pr = payload.pull_request ?? {};
      const branch = typeof pr.head?.ref === 'string' ? pr.head.ref : null;
      const common = {
        branch,
        pr_number: typeof pr.number === 'number' ? pr.number : null,
        pr_url: typeof pr.html_url === 'string' ? pr.html_url : null,
      };

      if (payload.action === 'opened' || payload.action === 'reopened') {
        return { kind: 'pr_opened', branch, body: common };
      }
      if (payload.action === 'synchronize') {
        // New commits on an open PR. Same fact as a push, so the same kind --
        // inventing a `pr_updated` kind would be a protocol change.
        return { kind: 'branch_pushed', branch, body: { ...common, commit: pr.head?.sha ?? null } };
      }
      if (payload.action === 'closed') {
        // merged is the ONLY thing that distinguishes a merge from an abandon,
        // and it arrives as a real boolean here (GitHub JSON, not Data Store).
        if (pr.merged === true) {
          return { kind: 'merged', branch, body: { ...common, commit: pr.merge_commit_sha ?? null } };
        }
        // Closed without merging. Not a merge, and not a failure either -- the
        // owner decided. Dropped rather than mapped to a kind that means
        // something else.
        return null;
      }
      return null;
    }

    case 'check_suite': {
      if (payload.action !== 'completed') return null;
      const suite = payload.check_suite ?? {};
      const branch = typeof suite.head_branch === 'string' ? suite.head_branch : null;
      const conclusion = suite.conclusion;
      // Only these two conclusions are a verdict. neutral, cancelled, skipped,
      // stale and timed_out are not "CI failed" and must not show a red badge.
      if (conclusion !== 'success' && conclusion !== 'failure') return null;
      return {
        kind: conclusion === 'success' ? 'ci_passed' : 'ci_failed',
        branch,
        body: {
          pr_number: Array.isArray(suite.pull_requests) && suite.pull_requests.length > 0
            ? suite.pull_requests[0]?.number ?? null
            : null,
          check_name: suite.app?.name ?? 'check_suite',
          details_url: suite.url ?? null,
        },
      };
    }

    default:
      return null;
  }
}

/**
 * The idempotency key for a delivery. GitHub retries with the SAME delivery id,
 * so keying on it makes a replay append nothing (D4).
 */
export function deliveryIdempotencyKey(delivery_id: string): string {
  return `gh:${delivery_id}`;
}
