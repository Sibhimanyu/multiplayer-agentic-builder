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
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { createFirestoreStore } from '../../firebase/store.ts';
import { handleApi, statusFor } from './api.ts';
import { handleWrite, type WriteRequest } from './write-api.ts';
import { createFirestoreDirectory } from '../../firebase/directory.ts';
import { mapDelivery, releaseAfterMerge, resolveProject, verifySignature } from './webhook.ts';
import { reapAll } from '../../firebase/reaper.ts';
import { consoleLogger } from '../../shared/log.ts';

// Region pinned: an unpinned function defaults to us-central1 and a later change silently
// creates a SECOND function rather than moving the first.
setGlobalOptions({ region: 'us-central1', maxInstances: 10 });

/**
 * NOT DECLARED, and not an oversight.
 *
 * `defineSecret` runs at module scope, so firebase-tools resolves it while ANALYSING the
 * codebase -- before, and regardless of, `--only functions:write`. That made deploying the write
 * path require the Secret Manager API, which is disabled on this project and which the service
 * account is denied permission to enable. One dead function was blocking a live one.
 *
 * So the webhook secret is NOT a declared secret. It is GITHUB_WEBHOOK_SECRET in functions/.env
 * (gitignored), which firebase-tools deploys as a plain environment variable. That is visible to
 * anyone with admin on the Cloud project -- who could read Secret Manager too -- and needs no API
 * this project cannot enable. Move it to defineSecret if Secret Manager is ever turned on.
 *
 * THE WEBHOOK IS LIVE AGAIN. Order 0043 retired it in favour of a GitHub poll in the bridge;
 * the poll was never built, so for weeks nothing read GitHub at all and no ticket could reach
 * pr_open or merged. The receiver below was kept compiling and is what is exported now.
 */
void defineSecret;

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
  { cors: false },
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
      // From functions/.env, not a declared secret -- see the note above. Unset means every
      // delivery fails verification, which is the right way to fail.
      process.env.GITHUB_WEBHOOK_SECRET ?? '',
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
    const project_id = await resolveProject(full_name, {
      mapped: async (key) => {
        const doc = await db.collection('repos').doc(key).get();
        return doc.exists ? ((doc.get('project_id') as string) ?? null) : null;
      },
      byRepoUrl: async (name) =>
        (await db.collection('projects').where('repo_url', '==', name).limit(2).get()).docs.map((d) => d.id),
    });
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
      // A merge frees the task's files. After the append, so a failed release leaves the card
      // merged and the lock for the reaper -- never a freed lock on a task that is not merged.
      const task_id = (mapped.event.body as { task_id?: unknown }).task_id;
      if (mapped.event.kind === 'merged' && typeof task_id === 'string') {
        try {
          const released = await releaseAfterMerge(store, project_id, task_id);
          log.info('fn.webhook_merge_released', 'merge released the task lock', { project_id, task_id, released });
        } catch (err) {
          log.warn('fn.webhook_merge_release_failed', 'merged, but could not release the lock', { project_id, task_id, error: String(err) });
        }
      }
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

// ---- write ------------------------------------------------------------------------------

/**
 * THE WRITE PATH for a teammate's CLI. Order 0049.
 *
 * firestore.rules is `allow write: if false` on every collection and STAYS that way. This is the
 * only door, and it is on a server because authorization has to live somewhere the person being
 * authorized cannot edit — a local process is, by construction, under the control of the user it
 * is meant to constrain.
 *
 * Identity comes from a verified Firebase ID token and NEVER from the request body. The uid a
 * caller claims is ignored, which closes the forged-actor_id hole by construction rather than by
 * validating a field.
 */
export const write = onRequest({ cors: true }, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  const out = await handleWrite(
    {
      auth: getAuth(), db, log, store,
      // The directory is constructed per request rather than at module scope: it is only needed
      // by create_project, and a cold start should not pay for it.
      createProject: (input) => createFirestoreDirectory({ db, log }).createProject(input),
    },
    req.headers.authorization,
    req.body as WriteRequest,
  );
  res.status(out.status).json(out.body);
});
