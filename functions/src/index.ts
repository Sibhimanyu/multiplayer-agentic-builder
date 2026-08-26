// Cloud Functions entry points. Thin adapters only — the logic lives in api.ts, webhook.ts
// and reaper.ts so it can be tested without a deploy.
//
// Three functions, deliberately not more:
//   githubWebhook  HTTP, unauthenticated, HMAC-verified
//   api            HTTP, agent-token authenticated
//   reapClaims     scheduled
//
// No Firestore-triggered snapshot folder. The build order listed one as optional; it is not
// needed, because appendEvent folds into the task documents inside the same transaction as the
// append. A trigger would be a second writer of the same state, running after the fact, with
// its own retry semantics and its own bill — all to produce state that is already correct.

import { setGlobalOptions } from 'firebase-functions/v2';
import { onRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { defineSecret } from 'firebase-functions/params';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { createFirestoreStore } from '../../firebase/store.ts';
import { handleApi, statusFor } from './api.ts';
import { mapDelivery, repoKey, verifySignature } from './webhook.ts';
import { reapAll } from './reaper.ts';
import { consoleLogger } from '../../shared/log.ts';

// Region pinned: an unpinned function defaults to us-central1 and a later change silently
// creates a SECOND function rather than moving the first.
setGlobalOptions({ region: 'us-central1', maxInstances: 10 });

const GITHUB_WEBHOOK_SECRET = defineSecret('GITHUB_WEBHOOK_SECRET');

initializeApp();
const db = getFirestore();
const log = consoleLogger;
const store = createFirestoreStore({ db, log });

// ---- githubWebhook ---------------------------------------------------------------------

/**
 * GitHub webhook receiver.
 *
 * Two things here are easy to get wrong and expensive to debug:
 *
 * 1. `req.rawBody`. Firebase parses JSON bodies before your handler runs, and the HMAC is over
 *    the bytes GitHub sent. Re-serialising the parsed object produces different bytes for key
 *    order and unicode escaping, so verification fails intermittently — which reads like a
 *    flaky secret. Firebase exposes the original buffer as req.rawBody; use only that.
 *
 * 2. The status code on a rejected delivery. An unmappable payload gets 200, not 500. GitHub
 *    retries 5xx, and after enough consecutive failures it disables the webhook — so a 500 on
 *    an event we will never accept eventually breaks the events we do (D6).
 *    A BAD SIGNATURE is different: that gets 401, because it is not a delivery we should
 *    acknowledge.
 */
export const githubWebhook = onRequest(
  { secrets: [GITHUB_WEBHOOK_SECRET], cors: false },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }

    const raw = (req as typeof req & { rawBody?: Buffer }).rawBody;
    if (!raw) {
      // Fail closed. Without the raw bytes there is no way to verify, and verifying a
      // re-serialised body would be security theatre.
      log.warn('fn.webhook_rejected_no_rawbody', 'webhook rejected: no rawBody available', {});
      res.status(400).json({ error: 'raw_body_unavailable' });
      return;
    }

    const verdict = verifySignature(
      raw,
      req.header('x-hub-signature-256'),
      GITHUB_WEBHOOK_SECRET.value(),
    );
    if (!verdict.ok) {
      log.warn('fn.webhook_signature_rejected', 'webhook signature rejected', { reason: verdict.reason });
      res.status(401).json({ error: verdict.reason });
      return;
    }

    const delivery_id = req.header('x-github-delivery');
    const event_name = req.header('x-github-event');
    if (!delivery_id) {
      // No delivery id means no idempotency key, and a replay would double-append.
      res.status(400).json({ error: 'missing_delivery_id' });
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      // Signature verified but the body is not JSON. Acknowledge and drop: retrying will not
      // make it parse.
      log.warn('fn.webhook_body_verified_but', 'webhook body verified but unparseable', { delivery_id, event_name });
      res.status(200).json({ ok: true, dropped: 'unparseable_json' });
      return;
    }

    const full_name = (payload as { repository?: { full_name?: string } })?.repository?.full_name;
    if (!full_name) {
      log.warn('fn.webhook_has_no_repository', 'webhook has no repository.full_name', { delivery_id, event_name });
      res.status(200).json({ ok: true, dropped: 'no_repository' });
      return;
    }

    // Repo -> project. An unmappable repo is logged and dropped, never a 500 (D6).
    const mapping = await db.collection('repos').doc(repoKey(full_name)).get();
    const project_id = mapping.exists ? (mapping.get('project_id') as string) : null;
    if (!project_id) {
      log.warn('fn.webhook_for_unmapped_repo', 'webhook for unmapped repo, dropped', { delivery_id, event_name, repo: full_name });
      res.status(200).json({ ok: true, dropped: 'unmapped_repo', repo: full_name });
      return;
    }

    const mapped = mapDelivery(event_name, payload, { project_id, delivery_id });
    if (mapped.kind === 'drop') {
      log.info('fn.webhook_delivery_dropped', 'webhook delivery dropped', {
        delivery_id,
        event_name,
        project_id,
        reason: mapped.reason,
      });
      res.status(200).json({ ok: true, dropped: mapped.reason });
      return;
    }

    try {
      const r = await store.appendEvent(project_id, mapped.event, mapped.idempotency_key);
      // A duplicate is a success. GitHub retries deliveries, and the whole point of keying on
      // the delivery id is that a retry is free (D4).
      res.status(200).json({ ok: true, seq: r.seq, duplicate: r.duplicate });
    } catch (err) {
      const mappedErr = statusFor(err);
      // Here a 5xx IS correct: the delivery was valid and we failed to record it, so we want
      // GitHub to retry.
      log.warn('fn.webhook_append_failed', 'webhook append failed', { delivery_id, project_id, error: String(err) });
      res.status(mappedErr.status >= 500 ? 503 : mappedErr.status).json(mappedErr.body);
    }
  },
);

// ---- api -------------------------------------------------------------------------------

/**
 * The write API. All ten operations except the two reads the dashboard does directly.
 *
 * CORS is set here and ONLY here. Setting it in both the function config and a middleware
 * produces two Access-Control-Allow-Origin headers, which every browser rejects as invalid —
 * a failure that looks like a CORS misconfiguration but is actually a duplication.
 */
export const api = onRequest({ cors: true }, async (req, res) => {
  // Strip the function name prefix that Firebase Hosting rewrites leave behind, so the router
  // sees "/claim" whether it was reached at /api/claim or /claim.
  const path = req.path.replace(/^\/api/, '') || '/';

  const headers: Record<string, string | undefined> = {
    // Both are forwarded: x-agent-token is what auth reads, and authorization is forwarded
    // only so the router can tell a stale client it is using the wrong header.
    'x-agent-token': req.header('x-agent-token'),
    authorization: req.header('authorization'),
    'if-none-match': req.header('if-none-match'),
  };

  const result = await handleApi(
    {
      method: req.method,
      path,
      headers,
      // GET carries its parameters in the query string; the router reads both from one place.
      body: req.method === 'GET' ? { ...req.query } : req.body,
    },
    { db, store, log, now: () => Date.now() },
  );

  if (result.status === 304) {
    res.status(304).end();
    return;
  }
  if (typeof result.body.etag === 'string') res.setHeader('ETag', result.body.etag);
  res.status(result.status).json(result.body);
});

// ---- reapClaims ------------------------------------------------------------------------

/**
 * Release claims held by agents that have gone silent.
 *
 * Every 5 minutes, giving a worst case of 15 + 5 = 20 minutes from laptop-death to release.
 * F11 asks for "within 15 min", so the schedule is tighter than the timeout rather than equal
 * to it — a 15-minute schedule against a 15-minute timeout would miss by up to 30.
 *
 * Cost: one query over claims plus one over agents per run, 288 runs a day. That is ~576 reads
 * a day against a 50,000/day free tier, or about 1%.
 */
export const reapClaims = onSchedule('every 5 minutes', async () => {
  const results = await reapAll(db, store, log, { claim_timeout_ms: 15 * 60_000 });
  const released = results.reduce((n, r) => n + r.released.length, 0);
  log.info('fn.reaper_run_complete', 'reaper run complete', { projects: results.length, released });
});
