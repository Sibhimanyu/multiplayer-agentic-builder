// POST /github/webhook
//
// THE RAW BODY IS LOAD-BEARING. The signature is computed over the exact bytes
// GitHub sent. No JSON middleware may touch the body before verification --
// JSON.parse then JSON.stringify does not round-trip, and the signature stops
// matching for reasons that look like a bad secret. This is the single reason
// the stack uses Advanced I/O functions.
//
// Order of operations, which is not negotiable:
//   1. read raw bytes
//   2. verify HMAC, timing-safe
//   3. ONLY THEN parse JSON
//
// NOT WIRED: append and repo lookup are behind WebhookPort. Needs a project ID.

import type { ProjectId } from '../../shared/store/types.ts';
import type { Logger } from '../../shared/log.ts';
import {
  DELIVERY_HEADER, EVENT_HEADER, SIGNATURE_HEADER, deliveryIdempotencyKey,
  mapGithubEvent, verifyGithubSignature,
} from '../../catalyst/lib/webhook.ts';
import type { HttpRequest, HttpResponse } from '../_lib/http.ts';
import { header, json } from '../_lib/http.ts';

export interface WebhookPort {
  /** SELECT ... FROM github_links WHERE repo_full_name = ?. Null when unknown. */
  findProjectForRepo(repo_full_name: string): Promise<{ project_id: ProjectId } | null>;
  /** The webhook secret, from a Catalyst environment variable -- never a column. */
  secretFor(project_id: ProjectId): Promise<string | null>;
  appendEvent(project_id: ProjectId, event: unknown, idempotency_key: string): Promise<void>;
}

export async function handleWebhook(
  port: WebhookPort, req: HttpRequest, log: Logger,
): Promise<HttpResponse> {
  const delivery_id = header(req, DELIVERY_HEADER);
  const event_name = header(req, EVENT_HEADER);
  const signature = header(req, SIGNATURE_HEADER);

  if (!req.raw) {
    // A programming error, not a client error: the route was registered without
    // a raw body parser. Loud, because silently verifying a re-serialised body
    // would fail intermittently and look like anything but this.
    log.error('webhook.no_raw_body', 'route did not capture the raw body; HMAC cannot be verified', {
      path: req.path, delivery_id,
    });
    return json(500, { error: 'internal', code: 'NO_RAW_BODY' });
  }
  if (!delivery_id || !event_name) {
    return json(400, { error: 'bad_request', code: 'MISSING_GITHUB_HEADERS' });
  }

  // The repo is needed to pick a secret, but it is inside the body we have not
  // verified yet. Parse a COPY for routing only; the verified parse happens
  // after the signature check and is the one that reaches the ledger.
  let untrusted: Record<string, any>;
  try {
    untrusted = JSON.parse(req.raw.toString('utf8'));
  } catch {
    return json(400, { error: 'bad_request', code: 'MALFORMED_JSON' });
  }

  const repo = typeof untrusted?.repository?.full_name === 'string'
    ? untrusted.repository.full_name : null;
  if (!repo) {
    log.warn('webhook.dropped', 'payload has no repository, dropped', { delivery_id, event: event_name });
    return json(204, null); // D6: logged and dropped, never a 500
  }

  const link = await port.findProjectForRepo(repo);
  if (!link) {
    // D6: an unmapped repo is normal traffic, not a failure. A 5xx here would
    // make GitHub retry and eventually disable the hook.
    log.warn('webhook.unmapped_repo', 'no project for repo, dropped', { repo, delivery_id, event: event_name });
    return json(204, null);
  }

  const secret = await port.secretFor(link.project_id);
  if (!secret) {
    log.error('webhook.no_secret', 'project has no webhook secret configured', { repo, project_id: link.project_id });
    return json(500, { error: 'internal', code: 'NO_SECRET' });
  }

  const verified = verifyGithubSignature(req.raw, signature, secret);
  if (!verified.ok) {
    // 401 and nothing else. Never reveal which check failed.
    log.warn('webhook.signature_rejected', 'signature did not verify', {
      repo, delivery_id, reason: verified.reason,
    });
    return json(401, { error: 'unauthorized', code: 'BAD_SIGNATURE' });
  }

  const mapped = mapGithubEvent({ event: event_name, payload: untrusted });
  if (!mapped.ok) {
    log.info('webhook.unmapped_event', 'delivery did not map to an event, dropped', {
      repo, delivery_id, event: event_name, reason: mapped.reason,
    });
    return json(204, null);
  }

  // D4: GitHub reuses the delivery id on retry, so a replay is absorbed by the
  // same idempotency path as any other duplicate append.
  await port.appendEvent(link.project_id, mapped.event, deliveryIdempotencyKey(delivery_id));
  return json(202, { ok: true, kind: mapped.event.kind, task_id: mapped.task_id });
}
