// The write path. One HTTPS function, and the only way a teammate's CLI writes anything.
//
// WHY THIS EXISTS AT ALL, since order 0043 moved the reaper and the webhook OUT of functions and
// into the local bridge, and that was right:
//
//   LOCAL-FIRST WORKS FOR COORDINATION. IT CANNOT WORK FOR AUTHORIZATION.
//
// Coordination state is data, and a local process can produce data safely -- a claim is atomic
// because Firestore makes it atomic, wherever the caller runs. But deciding "is this person
// allowed to do that" requires something THE PERSON BEING CHECKED CANNOT MODIFY, and a local
// process is by construction under the control of the user it is meant to constrain. A teammate
// holding a valid token and a text editor can delete a client-side check in ten seconds.
//
// So firestore.rules stays `allow write: if false` on every collection -- NOT weakened, because
// the strength of this design is that there is no path to the data except through here. Glob
// containment is not practically expressible in security rules, so "loosen the rules a bit" has
// no middle: either roles are enforced somewhere the user cannot reach, or they are advisory.
//
// The enforcement itself is NOT reimplemented here. shared/store/roles.ts is reused verbatim,
// including globContains -- containment is not intersection, and `**` intersects `functions/**`,
// so a second implementation written in a hurry is exactly how that hole gets reopened.

import type { Auth } from 'firebase-admin/auth';
import type { Firestore } from 'firebase-admin/firestore';

import {
  RoleDeniedError,
  hasCapability,
  type Capability,
} from '../../shared/store/directory.ts';
import { assertDeployAllowed, assertScopeAllowed } from '../../shared/store/roles.ts';
import type { Logger } from '../../shared/log.ts';

export interface WriteRequest {
  project_id: string;
  op: 'claim' | 'release' | 'acquire_scope' | 'release_scope' | 'append_event' | 'heartbeat' | 'deploy';
  /** Operation payload. Shape depends on `op`. */
  body: Record<string, unknown>;
}

export interface WriteResult {
  status: number;
  body: Record<string, unknown>;
}

export interface WriteDeps {
  auth: Auth;
  db: Firestore;
  log: Logger;
  /** The ten-operation port, admin-privileged. Called only after authorization passes. */
  store: {
    claimTask(pid: string, task_id: string, agent_id: string): Promise<unknown>;
    releaseTask(pid: string, task_id: string, agent_id: string): Promise<void>;
    acquireScope(pid: string, agent_id: string, task_id: string, globs: string[]): Promise<unknown>;
    releaseScope(pid: string, agent_id: string): Promise<void>;
    appendEvent(pid: string, event: Record<string, unknown>, key: string): Promise<unknown>;
    heartbeat(pid: string, agent_id: string, status: string, task?: string | null, branch?: string | null): Promise<void>;
  };
}

/** Which capability each operation requires. Explicit, so adding an op forces the decision. */
const REQUIRES: Record<WriteRequest['op'], Capability> = {
  claim: 'claim',
  release: 'claim',
  acquire_scope: 'acquire_scope',
  release_scope: 'acquire_scope',
  append_event: 'suggest',
  heartbeat: 'suggest',
  deploy: 'deploy',
};

export class Unauthorized extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'Unauthorized';
    this.status = status;
  }
}

/**
 * Establish WHO is calling, from the bearer token alone.
 *
 * verifyIdToken checks the signature against Google's rotating public keys, the audience, the
 * issuer and the expiry. A forged or expired token cannot pass it, and nothing the caller sends
 * in the BODY is trusted for identity -- the uid comes from the verified token, never from a
 * field the client could set. That is the forged-agent_id hole, closed by construction.
 */
export async function identify(deps: WriteDeps, authorization: string | undefined): Promise<{ uid: string; email?: string }> {
  const raw = (authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!raw) throw new Unauthorized(401, 'no bearer token');
  try {
    const decoded = await deps.auth.verifyIdToken(raw, true);
    return { uid: decoded.uid, email: decoded.email };
  } catch (err) {
    // Deliberately does not echo the token or the library's message: both can carry token
    // fragments into logs.
    throw new Unauthorized(401, `token verification failed (${(err as Error).name})`);
  }
}

/**
 * What this uid is allowed to do IN THIS PROJECT.
 *
 * Two documents, both server-side: the membership (is this person in the project, and not
 * revoked) and the project's own role policy (what does that role permit HERE). The policy is
 * per-project because file scope depends on repo layout -- `functions/**` is this repo's, not a
 * universal constant.
 */
export async function authorize(
  deps: WriteDeps,
  uid: string,
  project_id: string,
): Promise<{ role: string; file_scope: string[]; deploy_scope: string[] }> {
  const member = await deps.db.collection('projects').doc(project_id).collection('members').doc(uid).get();
  if (!member.exists) throw new Unauthorized(403, 'not a member of this project');
  // Revoked is a STATE, not an absence -- the row is retained so the ledger's references to this
  // uid stay resolvable, which means the check has to be explicit rather than existence-based.
  if (member.get('revoked') === true) throw new Unauthorized(403, 'membership revoked');

  const role = (member.get('role') as string) ?? 'client';
  const policy = await deps.db.collection('projects').doc(project_id).collection('roles').doc(role).get();
  if (!policy.exists) {
    // FAIL CLOSED. An unconfigured project is not an unrestricted one: that is precisely the
    // default-open shape this function exists to remove.
    throw new Unauthorized(403, `project has no role policy for "${role}"; refusing rather than allowing`);
  }
  return {
    role,
    file_scope: (policy.get('file_scope') as string[]) ?? [],
    deploy_scope: (policy.get('deploy_scope') as string[]) ?? [],
  };
}

/**
 * The whole write path: identify, authorize, enforce, then act.
 *
 * Order matters and is the point. Nothing touches the store until every check has passed, so a
 * refused request leaves no partial state behind.
 */
export async function handleWrite(
  deps: WriteDeps,
  authorization: string | undefined,
  req: WriteRequest,
): Promise<WriteResult> {
  let caller: { uid: string; email?: string };
  let grant: { role: string; file_scope: string[]; deploy_scope: string[] };
  try {
    caller = await identify(deps, authorization);
    grant = await authorize(deps, caller.uid, req.project_id);
  } catch (err) {
    if (err instanceof Unauthorized) return { status: err.status, body: { error: err.message } };
    throw err;
  }

  const needed = REQUIRES[req.op];
  if (!needed) return { status: 400, body: { error: `unknown op "${req.op}"` } };

  try {
    if (!hasCapability(grant.role, needed)) {
      throw new RoleDeniedError(grant.role, needed.replace(/_/g, ' '), [needed], []);
    }

    // The agent acts AS the member. A body-supplied agent_id is ignored for authorization; it
    // only names which of the caller's own agents is acting.
    const agent_id = typeof req.body.agent_id === 'string' ? req.body.agent_id : caller.uid;

    switch (req.op) {
      case 'acquire_scope': {
        const globs = Array.isArray(req.body.globs) ? (req.body.globs as string[]) : [];
        // THE GATE, using the project's policy rather than the default template.
        assertScopeAllowed(grant.role, globs, grant.file_scope);
        const r = await deps.store.acquireScope(req.project_id, agent_id, String(req.body.task_id ?? ''), globs);
        return { status: 200, body: { ok: true, result: r as Record<string, unknown> } };
      }
      case 'deploy': {
        const targets = Array.isArray(req.body.targets) ? (req.body.targets as string[]) : [];
        assertDeployAllowed(grant.role, targets);
        // No deployer exists yet. The GATE lands first deliberately: a gate with no caller is a
        // gate, a caller with no gate is a hole.
        return { status: 501, body: { ok: false, error: 'deploy is authorized but not implemented', targets } };
      }
      case 'claim': {
        const r = await deps.store.claimTask(req.project_id, String(req.body.task_id ?? ''), agent_id);
        return { status: 200, body: { ok: true, result: r as Record<string, unknown> } };
      }
      case 'release':
        await deps.store.releaseTask(req.project_id, String(req.body.task_id ?? ''), agent_id);
        return { status: 200, body: { ok: true } };
      case 'release_scope':
        await deps.store.releaseScope(req.project_id, agent_id);
        return { status: 200, body: { ok: true } };
      case 'heartbeat':
        await deps.store.heartbeat(
          req.project_id, agent_id, String(req.body.status ?? 'connected'),
          (req.body.current_task as string) ?? null, (req.body.branch as string) ?? null,
        );
        return { status: 200, body: { ok: true } };
      case 'append_event': {
        const event = (req.body.event as Record<string, unknown>) ?? {};
        // actor_id comes from the VERIFIED token, never from the body. A client that sets
        // actor_id to someone else is writing its own uid regardless.
        const r = await deps.store.appendEvent(
          req.project_id,
          { ...event, actor_type: 'member', actor_id: caller.uid },
          String(req.body.idempotency_key ?? ''),
        );
        return { status: 200, body: { ok: true, result: r as Record<string, unknown> } };
      }
    }
  } catch (err) {
    if (err instanceof RoleDeniedError) {
      deps.log.warn('api.role_denied', 'write refused by role policy', {
        project_id: req.project_id, uid: caller.uid, role: grant.role, op: req.op,
        requested: err.requested, allowed: err.allowed,
      });
      return {
        status: 403,
        body: { error: err.message, role: err.role, requested: err.requested, allowed: err.allowed },
      };
    }
    throw err;
  }

  return { status: 400, body: { error: 'unhandled op' } };
}
