// GitHub webhook: signature verification and payload mapping.
//
// Everything here is a pure function over (headers, raw body). The Cloud Function in index.ts
// is a thin shell around it, so checklist D1-D6 are unit tests that need no emulator, no
// network and no deploy — which matters, because the failure modes being tested (a tampered
// body, a replayed delivery) are exactly the ones that are miserable to reproduce against a
// live endpoint.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { EventInput, TaskId } from '../../shared/store/types.ts';

export interface WebhookHeaders {
  'x-hub-signature-256'?: string;
  'x-github-event'?: string;
  'x-github-delivery'?: string;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: 'missing_signature' | 'malformed_signature' | 'bad_signature' };

/**
 * Verify the GitHub HMAC over the RAW body bytes.
 *
 * Raw bytes, not a re-serialised object: GitHub signs what it sent, and
 * JSON.stringify(JSON.parse(body)) differs from the original for key order, unicode escapes
 * and float formatting. Any framework that hands you a parsed body has already destroyed the
 * thing you need to verify — see the `rawBody` note in index.ts.
 */
export function verifySignature(
  raw: Buffer,
  header: string | undefined,
  secret: string,
): VerifyResult {
  if (!header) return { ok: false, reason: 'missing_signature' };

  const expected = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');

  // Both are fixed-length ASCII ("sha256=" + 64 hex chars). A length mismatch means the
  // header is malformed, which is not secret-dependent, so returning early leaks nothing —
  // and timingSafeEqual throws on unequal lengths, so the check has to happen somewhere.
  const a = Buffer.from(header, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return { ok: false, reason: 'malformed_signature' };

  // timingSafeEqual, never ===. A byte-by-byte early-exit comparison leaks the length of the
  // matching prefix, which is enough to forge a signature one byte at a time (D3).
  if (!timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };
  return { ok: true };
}

/**
 * Recover a task id from a branch name.
 *
 * The CLI pushes to `agent/<role>/<task-slug>` (see the generated AGENTS.md in
 * agentic-file-contract.md), so the branch is the only link between a GitHub event and a task.
 * Returns null rather than guessing when the branch does not follow the convention — a wrong
 * task id would move somebody else's card.
 */
export function taskIdFromBranch(branch: string | null | undefined): TaskId | null {
  if (!branch) return null;
  const m = /^agent\/[^/]+\/(.+)$/.exec(branch);
  if (!m) return null;
  const slug = m[1]!.trim();
  if (slug === '') return null;
  // "task-items-crud" -> "task_items_crud"; a slug that already starts with task_ is left be.
  const normalised = slug.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (normalised === '') return null;
  return normalised.startsWith('task_') ? normalised : `task_${normalised.replace(/^task_?/, '')}`;
}

/**
 * The normative check_suite conclusion map (Order 0010, acceptance-checklist.md D5a).
 *
 * A Map rather than a conditional chain on purpose: the checklist pins a TABLE, so the code
 * that implements it should be a table too. Adding a conclusion is a one-line data change and
 * anything absent drops by construction, which is the safe default for an append-only ledger.
 */
const CONCLUSIVE = new Map<string, 'ci_passed' | 'ci_failed'>([
  ['success', 'ci_passed'],
  ['failure', 'ci_failed'],
  // Conclusive, not inconclusive. GitHub renders a timeout with a red X.
  ['timed_out', 'ci_failed'],
]);

/** Every conclusion GitHub can send, for an exhaustive test rather than a sampled one. */
export const CHECK_SUITE_CONCLUSIONS = [
  'success', 'failure', 'timed_out',
  'neutral', 'cancelled', 'skipped', 'stale', 'action_required', null,
] as const;

export interface MapContext {
  /** Resolved from the repo full_name before mapping is attempted. */
  project_id: string;
  delivery_id: string;
}

export type MapResult =
  | { kind: 'event'; event: EventInput; idempotency_key: string }
  | { kind: 'drop'; reason: string };

interface RepoPayload {
  action?: string;
  ref?: string;
  after?: string;
  head_commit?: { id?: string } | null;
  pull_request?: {
    number?: number;
    html_url?: string;
    merged?: boolean;
    merge_commit_sha?: string | null;
    head?: { ref?: string };
  };
  check_suite?: {
    conclusion?: string;
    head_branch?: string | null;
    app?: { name?: string };
    pull_requests?: { number?: number }[];
    details_url?: string;
  };
  repository?: { full_name?: string };
}

/**
 * Map one GitHub delivery onto at most one ledger event.
 *
 * Deliberately at most ONE: a delivery that produced two events would need two idempotency
 * keys derived from one delivery id, and a partial replay would then double-append. Where
 * GitHub bundles information (a `closed` PR carries both the merge and the branch), the
 * meaningful transition wins.
 *
 * Every unmapped case returns a `drop` with a reason. The caller logs it and answers 200 —
 * a 500 makes GitHub retry a delivery we will never accept, and after enough failures it
 * disables the webhook (D6).
 */
export function mapDelivery(
  event_name: string | undefined,
  payload: unknown,
  ctx: MapContext,
): MapResult {
  const p = (payload ?? {}) as RepoPayload;
  // One key per delivery. A replay of the same delivery therefore hits the store's dedupe and
  // appends nothing (D4).
  const idempotency_key = `gh:${ctx.project_id}:${ctx.delivery_id}`;
  const base = { actor_type: 'github' as const, actor_id: 'github' };

  switch (event_name) {
    case 'push': {
      const branch = refToBranch(p.ref);
      const task_id = taskIdFromBranch(branch);
      if (!task_id) {
        return { kind: 'drop', reason: `push to non-agent branch ${branch ?? '(no ref)'}` };
      }
      const commit = p.after ?? p.head_commit?.id ?? null;
      return {
        kind: 'event',
        idempotency_key,
        event: {
          ...base,
          layer: 'coordination',
          kind: 'branch_pushed',
          body: { branch, commit, task_id },
        },
      };
    }

    case 'pull_request': {
      const branch = p.pull_request?.head?.ref ?? null;
      const task_id = taskIdFromBranch(branch);
      if (!task_id) {
        return { kind: 'drop', reason: `pull_request on non-agent branch ${branch ?? '(none)'}` };
      }
      const pr_number = p.pull_request?.number ?? null;
      const pr_url = p.pull_request?.html_url ?? null;

      switch (p.action) {
        case 'opened':
        case 'reopened':
          return {
            kind: 'event',
            idempotency_key,
            event: {
              ...base,
              layer: 'coordination',
              kind: 'pr_opened',
              body: { task_id, pr_number, pr_url, branch },
            },
          };

        case 'synchronize':
          // New commits on an open PR. This is a push, not a re-open: mapping it to pr_opened
          // would reset the CI badge on every force-push.
          return {
            kind: 'event',
            idempotency_key,
            event: {
              ...base,
              layer: 'coordination',
              kind: 'branch_pushed',
              body: { branch, commit: p.pull_request?.merge_commit_sha ?? null, task_id },
            },
          };

        case 'closed':
          if (p.pull_request?.merged === true) {
            return {
              kind: 'event',
              idempotency_key,
              event: {
                ...base,
                layer: 'coordination',
                kind: 'merged',
                body: { task_id, pr_number, commit: p.pull_request?.merge_commit_sha ?? null },
              },
            };
          }
          // Closed without merging. There is no protocol event for "abandoned", and inventing
          // one would put a state on the board the state machine does not have. Dropped with
          // a reason so it is visible in logs rather than mysteriously absent.
          return {
            kind: 'drop',
            reason: `pull_request #${pr_number} closed unmerged; no protocol event for abandon`,
          };

        default:
          return { kind: 'drop', reason: `pull_request action ${p.action} is not mapped` };
      }
    }

    case 'check_suite': {
      if (p.action !== 'completed') {
        return { kind: 'drop', reason: `check_suite action ${p.action} is not terminal` };
      }
      const branch = p.check_suite?.head_branch ?? null;
      const task_id = taskIdFromBranch(branch);
      if (!task_id) {
        return { kind: 'drop', reason: `check_suite on non-agent branch ${branch ?? '(none)'}` };
      }
      const conclusion = p.check_suite?.conclusion ?? null;
      // The normative table, ruled by Order 0010 and pinned in acceptance-checklist.md.
      // BOTH BUILDS MUST IMPLEMENT EXACTLY THIS — a divergence here is worse than a missing
      // badge, because a divergence is far harder to notice than an absence.
      //
      //   success     -> ci_passed
      //   failure     -> ci_failed
      //   timed_out   -> ci_failed   conclusive terminal failure, rendered red by GitHub
      //   neutral | cancelled | skipped | stale | action_required | null/absent -> drop
      //
      // The rule is "conclusive failures map, everything else drops" — not "only pass/fail
      // maps". A timeout is conclusive: dropping it leaves the board silent while the agent
      // believes CI is still pending, which is worse than a slightly generous label. Order
      // 0006's "inconclusive" wording was imprecise and 0010 corrected it.
      if (!CONCLUSIVE.has(conclusion as string)) {
        return { kind: 'drop', reason: `check_suite conclusion ${conclusion} is not conclusive` };
      }
      return {
        kind: 'event',
        idempotency_key,
        event: {
          ...base,
          layer: 'coordination',
          kind: CONCLUSIVE.get(conclusion as string)!,
          body: {
            task_id,
            pr_number: p.check_suite?.pull_requests?.[0]?.number ?? null,
            check_name: p.check_suite?.app?.name ?? 'check_suite',
            details_url: p.check_suite?.details_url ?? null,
          },
        },
      };
    }

    case 'ping':
      return { kind: 'drop', reason: 'ping: signature verified, nothing to append' };

    default:
      return { kind: 'drop', reason: `event ${event_name ?? '(none)'} is not subscribed` };
  }
}

/** "refs/heads/agent/backend/task-items-crud" -> "agent/backend/task-items-crud" */
export function refToBranch(ref: string | undefined): string | null {
  if (!ref) return null;
  const m = /^refs\/heads\/(.+)$/.exec(ref);
  return m ? m[1]! : null;
}

/**
 * Document id for the repo -> project lookup.
 * Firestore ids cannot contain '/', which every repo full_name does.
 */
export const repoKey = (full_name: string): string =>
  full_name.trim().toLowerCase().replace(/\//g, '__');

/**
 * Which project a delivery belongs to.
 *
 * The `repos/{repoKey}` mapping first, then the project's own `repo_url`. NOTHING EVER WROTE THE
 * MAPPING -- `flotilla new` stores repo_url on the project and stops -- so a mapping-only lookup
 * dropped every delivery as unmapped_repo. The fallback is what makes an existing project work
 * without a backfill. Ambiguity (two projects on one repo) resolves to none rather than a guess:
 * a wrong project would move somebody else's cards.
 */
export async function resolveProject(
  full_name: string,
  lookup: {
    mapped: (key: string) => Promise<string | null>;
    byRepoUrl: (full_name: string) => Promise<string[]>;
  },
): Promise<string | null> {
  const mapped = await lookup.mapped(repoKey(full_name));
  if (mapped) return mapped;
  const matches = await lookup.byRepoUrl(full_name);
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * After a merge, free the file lock the task was holding. Returns whose lock it was, or null.
 *
 * The merged event moves the card, but a lock is a separate document, so without this a merged
 * task kept its files locked until the reaper noticed the agent had gone quiet -- which, for an
 * agent still running, is never. "Merged, lock freed" is one step on the board, not two.
 */
export async function releaseAfterMerge(
  store: {
    readSnapshot: (pid: string) => Promise<{ snapshot: { locks: { agent_id: string; task_id: string }[] } } | null>;
    releaseScope: (pid: string, agent_id: string) => Promise<void>;
  },
  project_id: string,
  task_id: string,
): Promise<string | null> {
  const read = await store.readSnapshot(project_id);
  const lock = read?.snapshot.locks.find((l) => l.task_id === task_id);
  if (!lock) return null;
  await store.releaseScope(project_id, lock.agent_id);
  return lock.agent_id;
}
