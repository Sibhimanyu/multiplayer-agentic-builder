// The write API. Every mutation in the system arrives here.
//
// Shaped as one pure-ish function over a request-like object so the security assertions can be
// tested without a deploy. The Cloud Function in index.ts adapts Express onto it.
//
// The two non-negotiables this file exists to enforce:
//
//   agent_id is never accepted from the client.
//     Every handler below derives agent_id from resolveAgent(token). Where a request body
//     contains an agent_id field it is IGNORED, and the mismatch is logged. There is no code
//     path from a request field to the agent_id used in a write.
//
//   Agents cannot merge.
//     `merged` is not in AGENT_APPENDABLE, so an agent append of kind 'merged' is refused
//     before it reaches the store. The only producer of `merged` is the webhook, with
//     actor_type 'github'.

import {
  AGENT_TOKEN_HEADER,
  assertAppendable,
  hashToken,
  mintToken,
  resolveAgent,
  type Identity,
  PermissionError,
} from './authority.ts';
import { StoreAuthError, StoreBusyError, StoreError, StoreOfflineError } from '../../shared/store/errors.ts';
import { RoleDeniedError } from '../../shared/store/directory.ts';
import { LAYER_OF, type EventKind } from '../../shared/store/types.ts';
import type { Logger } from '../../shared/log.ts';
import type { FirestoreStore } from '../../firebase/store.ts';
import type { Firestore } from 'firebase-admin/firestore';

export interface ApiRequest {
  method: string;
  /** Path with the function prefix already stripped, e.g. "/claim". */
  path: string;
  headers: Record<string, string | undefined>;
  body: unknown;
}

export interface ApiResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface ApiDeps {
  db: Firestore;
  store: FirestoreStore;
  log: Logger;
  now(): number;
}

const json = (status: number, body: Record<string, unknown>): ApiResponse => ({ status, body });

/**
 * A malformed request, as distinct from a backend failure.
 *
 * Its own type rather than a StoreError, because the shared taxonomy is deliberately about
 * BACKEND conditions and a bad glob from a client is not one of those. Mapping it to a
 * StoreError would make it look retryable to anything reading the seam.
 */
export class RequestError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Reject glob syntax the shared intersection engine does not understand.
 *
 * ORDER REQUEST for the coordinator: `shared/globs.ts` `normalizeGlob` currently NORMALISES an
 * unsupported pattern rather than refusing it, so a lock on `!(vendor)/**` is treated as a
 * literal directory named `!(vendor)`. That lock protects nothing and `acquireScope` returns
 * ok:true — a silent failure, which non-negotiable H forbids. Validating here keeps the
 * Firebase API safe without editing frozen shared code, but the two builds will DIVERGE on
 * this input until the check moves into `shared/globs.ts`. Flagging rather than working around
 * it silently, per the orders protocol.
 */
const UNSUPPORTED_GLOB = /[{}!()+@|]/;

function validateGlobs(globs: string[]): void {
  for (const g of globs) {
    if (g.trim() === '') throw new RequestError(400, 'invalid_glob', 'a glob may not be empty');
    if (UNSUPPORTED_GLOB.test(g)) {
      throw new RequestError(
        400,
        'invalid_glob',
        `unsupported glob "${g}": brace expansion, negation and extglob are not supported`,
      );
    }
    if (g.includes('..')) {
      throw new RequestError(400, 'invalid_glob', `unsafe glob "${g}": must not contain ".."`);
    }
  }
}

/** Body field readers that never throw on a malformed body. */
const obj = (b: unknown): Record<string, unknown> =>
  b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
const str = (b: unknown, k: string): string | null => {
  const v = obj(b)[k];
  return typeof v === 'string' && v !== '' ? v : null;
};
const strArray = (b: unknown, k: string): string[] => {
  const v = obj(b)[k];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
};

/**
 * Reject any client-supplied identity field, loudly.
 *
 * Returning 400 rather than silently ignoring it: a CLI that sends agent_id is either an old
 * version or an attempt, and both deserve to know. Silently ignoring would let a forged field
 * sit in a request for months looking like it worked.
 */
function rejectForgedIdentity(body: unknown, id: Identity, log: Logger): ApiResponse | null {
  const b = obj(body);
  for (const field of ['agent_id', 'actor_id', 'project_id', 'role_slug', 'permissions', 'seq', 'event_id']) {
    if (b[field] === undefined) continue;
    // An echo of the caller's own agent_id is still refused. Accepting it "because it matches"
    // is how the field becomes load-bearing, and then trusted.
    log.warn('fn.client_supplied_identity_field', 'client-supplied identity field refused', {
      field,
      sent: String(b[field]),
      resolved_agent: id.agent_id,
      project_id: id.project_id,
    });
    return json(400, {
      error: 'client_supplied_identity',
      field,
      detail: `${field} is derived from the token and must not be sent by a client`,
    });
  }
  return null;
}

/** Map a thrown error onto a status. Every branch named; no catch-all 500 for known cases. */
export function statusFor(err: unknown): ApiResponse {
  if (err instanceof StoreAuthError) return json(401, { error: 'unauthorised', detail: err.message });
  if (err instanceof PermissionError) {
    return json(403, { error: 'forbidden', permission: err.permission, detail: err.message });
  }
  if (err instanceof RequestError) return json(err.status, { error: err.code, detail: err.message });
  // A role refusing a glob is the fence working, not a crash. It fell through to 500 "internal",
  // so an agent asking for server/** as backend was told the server broke, and never why.
  if (err instanceof RoleDeniedError) {
    return json(403, { error: 'role_denied', detail: err.message, role: err.role, requested: err.requested, allowed: err.allowed });
  }
  if (err instanceof StoreBusyError) {
    return json(429, { error: 'busy', retry_after_ms: err.retry_after_ms, detail: err.message });
  }
  if (err instanceof StoreOfflineError) {
    return json(503, { error: 'offline', detail: err.message });
  }
  if (err instanceof StoreError) return json(502, { error: 'backend', detail: err.message });
  // Genuinely unexpected. Rethrow-shaped: 500 with no internals leaked, and the caller logs it.
  return json(500, { error: 'internal' });
}

export async function handleApi(req: ApiRequest, deps: ApiDeps): Promise<ApiResponse> {
  const { store, log } = deps;
  const route = `${req.method.toUpperCase()} ${req.path.replace(/\/+$/, '') || '/'}`;

  try {
    // /connect is the only unauthenticated route: it trades an invite code for a token.
    if (route === 'POST /connect') return await connect(req, deps);

    // A stale client still sending Authorization gets a specific message rather than a bare
    // 401, because "your token is wrong" and "your header is wrong" need different fixes.
    if (!req.headers[AGENT_TOKEN_HEADER] && req.headers.authorization) {
      return json(401, {
        error: 'wrong_auth_header',
        detail: `use ${AGENT_TOKEN_HEADER} with the raw token; Authorization is not read`,
      });
    }
    const id = await resolveAgent(deps.db, req.headers[AGENT_TOKEN_HEADER]);
    const forged = rejectForgedIdentity(req.body, id, log);
    if (forged) return forged;

    switch (route) {
      case 'POST /events': {
        const kind = str(req.body, 'kind') as EventKind | null;
        if (!kind) return json(400, { error: 'missing_kind' });
        // Allowlist check BEFORE touching the store: 'merged' dies here.
        assertAppendable(id, kind);
        const idempotency_key = str(req.body, 'idempotency_key');
        if (!idempotency_key) return json(400, { error: 'missing_idempotency_key' });

        const body = obj(obj(req.body).body);
        const r = await store.appendEvent(
          id.project_id,
          {
            layer: LAYER_OF[kind],
            kind,
            actor_type: 'agent',
            // Derived. Not from the request.
            actor_id: id.agent_id,
            body,
          },
          idempotency_key,
        );
        return json(r.duplicate ? 200 : 201, { ...r });
      }

      case 'POST /claim': {
        const task_id = str(req.body, 'task_id');
        if (!task_id) return json(400, { error: 'missing_task_id' });
        const r = await store.claimTask(id.project_id, task_id, id.agent_id);
        // A lost claim is 200 with ok:false, NOT 409. It is a normal outcome of a race, and a
        // 4xx would make every HTTP client library log it as an error.
        return json(200, { ...r });
      }

      case 'POST /release': {
        const task_id = str(req.body, 'task_id');
        if (!task_id) return json(400, { error: 'missing_task_id' });
        await store.releaseTask(id.project_id, task_id, id.agent_id);
        return json(200, { ok: true });
      }

      case 'POST /scope': {
        const task_id = str(req.body, 'task_id');
        const globs = strArray(req.body, 'globs');
        if (!task_id) return json(400, { error: 'missing_task_id' });
        if (globs.length === 0) return json(400, { error: 'missing_globs' });
        validateGlobs(globs);
        const r = await store.acquireScope(id.project_id, id.agent_id, task_id, globs);
        return json(200, { ...r });
      }

      case 'DELETE /scope': {
        await store.releaseScope(id.project_id, id.agent_id);
        return json(200, { ok: true });
      }

      case 'POST /heartbeat': {
        const status = str(req.body, 'status') ?? 'working';
        const allowed = ['connected', 'idle', 'working', 'blocked', 'reviewing', 'offline'];
        if (!allowed.includes(status)) return json(400, { error: 'bad_status', status });
        // 'revoked' is deliberately absent from `allowed`: an agent cannot declare itself
        // revoked, and more importantly cannot declare itself NOT revoked.
        await store.heartbeat(
          id.project_id,
          id.agent_id,
          status as 'working',
          str(req.body, 'current_task'),
          str(req.body, 'branch'),
        );
        return json(200, { ok: true });
      }

      case 'GET /snapshot': {
        const etag = req.headers['if-none-match'];
        const r = await store.readSnapshot(id.project_id, etag);
        if (!r) return json(304, {});
        return { status: 200, body: { snapshot: r.snapshot, etag: r.etag } };
      }

      case 'GET /events': {
        const since = Number(obj(req.body).since_seq ?? 0);
        const r = await store.readEvents(id.project_id, Number.isFinite(since) ? since : 0);
        // The human layer never leaves this endpoint. The CLI writes what it receives into
        // inbox.jsonl, so filtering here rather than there means a CLI bug cannot leak
        // heartbeats into an agent's context (B8).
        const events = r.events.filter((e) => LAYER_OF[e.kind] !== 'human');
        const dropped = r.events.length - events.length;
        if (dropped > 0) {
          log.info('fn.human_layer_events_withheld', 'human-layer events withheld from agent feed', {
            project_id: id.project_id,
            agent_id: id.agent_id,
            dropped,
          });
        }
        return json(200, { events, next_cursor: r.next_cursor, has_more: r.has_more });
      }

      case 'GET /whoami': {
        // Useful for `status`, and the cheapest possible proof that agent_id comes from the
        // token: there is no request field that can change this answer.
        //
        // file_scope is THIS PROJECT'S policy for the role, not the template. `flotilla role` and
        // `flotilla new` redraw it, and a CLI reading the template would tell the agent the old
        // fence in AGENTS.md and hand it tickets it can never lock. Absent when the project has no
        // policy doc, so the CLI can fall back rather than be told "nothing".
        //
        // role_scopes is EVERY role's fence, because AGENTS.md's "may not edit" line is the other
        // roles' scopes; built from the template, it told backend not to touch client/** in a repo
        // whose frontend lives in web/**. Six small documents, read once per whoami.
        const roleDocs = await deps.db.collection('projects').doc(id.project_id).collection('roles').get();
        const role_scopes: Record<string, string[]> = {};
        for (const d of roleDocs.docs) {
          const g = d.get('file_scope') as unknown;
          if (Array.isArray(g)) role_scopes[d.id] = g as string[];
        }
        const file_scope = role_scopes[id.role_slug];
        return json(200, {
          agent_id: id.agent_id,
          project_id: id.project_id,
          role_slug: id.role_slug,
          permissions: id.permissions,
          freshness: store.freshness,
          ...(Array.isArray(file_scope) ? { file_scope } : {}),
          ...(Object.keys(role_scopes).length > 0 ? { role_scopes } : {}),
        });
      }

      default:
        return json(404, { error: 'no_such_route', route });
    }
  } catch (err) {
    const res = statusFor(err);
    if (res.status >= 500) {
      // Only the genuinely unexpected is logged as an error. A lost claim, a scope conflict
      // and a revoked token are all normal and must not pollute the error log.
      log.warn('fn.api_error', 'api error', { route, error: String(err) });
    }
    return res;
  }
}

/**
 * Trade an invite code for an agent token.
 *
 * The invite document is consumed inside a transaction, so one code cannot mint two agents.
 * The plaintext token is returned here and never stored — only its sha256 goes to Firestore.
 */
async function connect(req: ApiRequest, deps: ApiDeps): Promise<ApiResponse> {
  const code = str(req.body, 'invite');
  if (!code) return json(400, { error: 'missing_invite' });
  const harness = str(req.body, 'harness') ?? 'manual';

  const inviteQuery = await deps.db
    .collectionGroup('invites')
    .where('code_sha256', '==', hashToken(code))
    .limit(2)
    .get();

  if (inviteQuery.empty) return json(401, { error: 'unknown_invite' });
  if (inviteQuery.size > 1) return json(401, { error: 'ambiguous_invite' });

  const inviteRef = inviteQuery.docs[0]!.ref;
  const project_id = inviteRef.parent.parent?.id;
  if (!project_id) return json(500, { error: 'invite_not_under_project' });

  const token = mintToken();

  try {
    const result = await deps.db.runTransaction(async (tx) => {
      const invite = await tx.get(inviteRef);
      if (!invite.exists) throw new StoreAuthError('invite already consumed');
      const data = invite.data() as {
        role_slug?: string;
        member_label?: string;
        expires_at_ms?: number;
        consumed?: boolean;
      };
      if (data.consumed === true) throw new StoreAuthError('invite already consumed');
      if (typeof data.expires_at_ms === 'number' && data.expires_at_ms < deps.now()) {
        throw new StoreAuthError('invite expired');
      }
      const role_slug = data.role_slug ?? '';
      const member_label = data.member_label ?? 'unknown';

      // agent_id is minted here, server-side, from the invite. The client has no say in it.
      const agent_id = `agent_${hashToken(`${project_id}:${role_slug}:${token}`).slice(0, 8)}`;
      const agentRef = deps.db
        .collection('projects')
        .doc(project_id)
        .collection('agents')
        .doc(agent_id);

      tx.set(agentRef, {
        agent_id,
        role_slug,
        member_label,
        initials: role_slug.slice(0, 2).toUpperCase(),
        harness,
        status: 'connected',
        current_task: null,
        branch: null,
        last_heartbeat_ms: deps.now(),
        revoked: false,
        grant_merge: false, // never from an invite; only an explicit owner grant
        token_sha256: hashToken(token),
      });
      // Single-use. Marked rather than deleted so a replayed connect gets "already consumed"
      // instead of "unknown invite", which is a materially better error message.
      tx.set(inviteRef, { consumed: true, consumed_at_ms: deps.now(), agent_id }, { merge: true });
      return { agent_id, project_id, role_slug, member_label };
    });

    return json(201, { ...result, token });
  } catch (err) {
    return statusFor(err);
  }
}
