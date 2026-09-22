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
  ROLE_SLUGS,
  RoleDeniedError,
  hasCapability,
  type Capability,
  type RoleSlug,
} from '../../shared/store/directory.ts';
import { hashToken, mintToken } from './authority.ts';
import { assertDeployAllowed, assertScopeAllowed } from '../../shared/store/roles.ts';
import { TASK_KINDS, isTaskKind, deriveTaskId } from '../../shared/store/tasks.ts';
import { REPORT_TYPES, isReportType, type ReportType } from '../../shared/store/types.ts';
import type { NewTask } from '../../shared/store/tasks.ts';
import type { CreateTaskResult, TaskActor, TaskKind } from '../../shared/store/types.ts';
import type { Logger } from '../../shared/log.ts';

export interface WriteRequest {
  project_id: string;
  op:
    | 'claim' | 'release' | 'acquire_scope' | 'release_scope' | 'append_event' | 'heartbeat'
    | 'deploy' | 'create_project' | 'create_task' | 'create_invite'
    | 'raise_suggestion' | 'accept_suggestion' | 'decline_suggestion';
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
    createTask(pid: string, task: NewTask, actor: TaskActor): Promise<CreateTaskResult>;
    // Optional on the port (see shared/store/types.ts): an adapter without suggestions is
    // still a valid CoordinationStore, and the API answers 501 rather than crashing.
    raiseSuggestion?(pid: string, input: { title: string; body: string; report: ReportType; raised_by: string; raised_by_label: string }): Promise<{ suggestion_id: string }>;
    acceptSuggestion?(pid: string, suggestion_id: string, by: string, task: { task_id: string; title: string; kind: TaskKind; file_scope: string[] }): Promise<{ ok: true; task_id: string } | { ok: false; resolved_by: string; status: string }>;
    declineSuggestion?(pid: string, suggestion_id: string, by: string, reason: string): Promise<{ ok: true } | { ok: false; resolved_by: string; status: string }>;
  };
  /** The directory's createProject. Separate port, so the write path does not grow a second one. */
  createProject: (input: {
    project_id: string; project_name: string; repo_url: string;
    owner_uid: string; owner_label: string;
  }) => Promise<unknown>;
}

/** Which capability each operation requires. Explicit, so adding an op forces the decision. */
const REQUIRES: Partial<Record<WriteRequest["op"], Capability>> = {
  // `triage` is already defined as "turn a suggestion into a task, or decline it" -- so creating
  // a task IS the triage act, and the capability that gates one gates the other. Owner and
  // architect hold it; the client seat does not, which is the whole point of that seat. See
  // docs/decisions/0005-work-appears-by-triage.md.
  create_task: 'triage',
  // ---- suggestions, order 0089 ----
  // RAISING is gated on `suggest`, which the `user` seat holds and which is the ONLY thing it
  // holds. That is the whole seat: sign in on the board, say what is wrong, and nothing else.
  raise_suggestion: 'suggest',
  // ACCEPTING AND DECLINING ARE BOTH `triage`, because accepting IS creating the task and
  // declining is the other half of the same decision. Order 0089 widened who holds `triage` to
  // every working role, so "anyone can pick it up" is true -- but `user` still does not hold it,
  // so the emptiest seat cannot put work on anybody's board. No new capability was invented:
  // decision 0005 warns that a second gate is a second thing to keep in agreement forever.
  accept_suggestion: 'triage',
  decline_suggestion: 'triage',
  // Minting an invite is how a project gains a member, so it is gated by the capability that
  // already means exactly that. Only the owner holds it.
  create_invite: 'invite',
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
): Promise<{ role: string; label: string; file_scope: string[]; deploy_scope: string[] }> {
  const member = await deps.db.collection('projects').doc(project_id).collection('members').doc(uid).get();
  if (!member.exists) throw new Unauthorized(403, 'not a member of this project');
  // Revoked is a STATE, not an absence -- the row is retained so the ledger's references to this
  // uid stay resolvable, which means the check has to be explicit rather than existence-based.
  if (member.get('revoked') === true) throw new Unauthorized(403, 'membership revoked');

  const role = (member.get('role') as string) ?? 'user';
  const policy = await deps.db.collection('projects').doc(project_id).collection('roles').doc(role).get();
  if (!policy.exists) {
    // FAIL CLOSED. An unconfigured project is not an unrestricted one: that is precisely the
    // default-open shape this function exists to remove.
    throw new Unauthorized(403, `project has no role policy for "${role}"; refusing rather than allowing`);
  }
  return {
    role,
    // The board shows WHO raised a suggestion, and it must be the stored label rather than
    // anything the caller sends: a display name is the one field a stranger would most like to
    // choose for themselves.
    label: (member.get('label') as string) ?? '',
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
  try {
    caller = await identify(deps, authorization);
  } catch (err) {
    if (err instanceof Unauthorized) return { status: err.status, body: { error: err.message } };
    throw err;
  }

  // CREATE_PROJECT IS AUTHORIZED DIFFERENTLY, and it has to be: every other operation checks
  // membership of the project, and a project that does not exist yet has no members. Requiring
  // membership here would make it impossible for anyone to create their first project.
  //
  // So the check is only that the caller is a REAL, verified identity — and the owner uid comes
  // from the TOKEN, never from the body, so a caller cannot create a project owned by someone
  // else. This is also why `flotilla new` cannot use the Admin SDK: a stranger has a user token
  // and no service-account key, and the first thing they run would fail with "could not load the
  // default credentials". Found by running the flow as a stranger, which is the only way to see
  // it — every previous test had admin credentials in the environment.
  if (req.op === 'create_project') {
    const b = req.body;
    if (typeof b.project_name !== 'string' || typeof b.repo_url !== 'string') {
      return { status: 400, body: { error: 'create_project needs project_name and repo_url' } };
    }
    try {
      const rec = await deps.createProject({
        project_id: req.project_id,
        project_name: b.project_name,
        repo_url: b.repo_url,
        owner_uid: caller.uid,
        owner_label: typeof b.owner_label === 'string' ? b.owner_label : (caller.email ?? caller.uid),
      });
      deps.log.info('api.project_created', 'project created through the write path', {
        project_id: req.project_id, owner_uid: caller.uid,
      });
      return { status: 200, body: { ok: true, project: rec as unknown as Record<string, unknown> } };
    } catch (err) {
      // An id collision is the intended outcome for two clones of one repo, so it reads as a
      // conflict rather than a crash.
      if ((err as Error).name === 'ProjectExistsError') {
        return { status: 409, body: { error: (err as Error).message } };
      }
      throw err;
    }
  }

  // Inferred from authorize rather than restated: a hand-written copy of this shape is how
  // `label` went missing from it in the first place.
  let grant: Awaited<ReturnType<typeof authorize>>;
  try {
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
      case 'create_task': {
        const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
        if (!title) return { status: 400, body: { error: 'create_task needs a title' } };
        if (!isTaskKind(req.body.kind)) {
          // Named rather than defaulted. A task quietly filed as 'backend' because the kind was
          // misspelled is a card in the wrong swimlane that nobody can explain a week later.
          return {
            status: 400,
            body: { error: `kind must be one of ${TASK_KINDS.join(', ')}`, kinds: [...TASK_KINDS] },
          };
        }
        const strings = (v: unknown): string[] =>
          Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
        const task: NewTask = {
          title,
          kind: req.body.kind,
          ...(typeof req.body.task_id === 'string' && req.body.task_id ? { task_id: req.body.task_id } : {}),
          ...(typeof req.body.description === 'string' ? { description: req.body.description } : {}),
          depends_on: strings(req.body.depends_on),
          file_scope: strings(req.body.file_scope),
        };
        // The creator is the VERIFIED uid, exactly as append_event does it. A body-supplied
        // actor is ignored, so the ledger cannot be made to say someone else filed this work.
        const r = await deps.store.createTask(req.project_id, task, {
          actor_type: 'member', actor_id: caller.uid,
        });
        deps.log.info('api.task_created', 'task created through the write path', {
          project_id: req.project_id, uid: caller.uid, role: grant.role,
          task_id: r.task_id, created: r.ok,
        });
        // An existing task is 200 with ok:false, NOT 409 -- same reasoning as a lost claim. It
        // is the normal outcome of a retry and a 4xx would make every HTTP client log it red.
        return { status: 200, body: { ...r } as Record<string, unknown> };
      }
      // ---- suggestions, order 0089 ------------------------------------------------------
      case 'raise_suggestion': {
        if (!deps.store.raiseSuggestion) {
          return { status: 501, body: { error: 'this backend does not support suggestions' } };
        }
        const title = typeof req.body.title === 'string' ? req.body.title.trim() : '';
        if (!title) return { status: 400, body: { error: 'a suggestion needs a title' } };
        if (!isReportType(req.body.report)) {
          // Named, never defaulted. Silently filing everything as `improvement` would make the
          // one field the reporter actually answers meaningless, and the board sorts on it.
          return {
            status: 400,
            body: { error: `report must be one of ${REPORT_TYPES.join(', ')}`, reports: [...REPORT_TYPES] },
          };
        }
        // The raiser is the VERIFIED uid. A body-supplied one is ignored, so nobody can file a
        // complaint under another person's name -- and the person who raised it is who gets told
        // when it is declined.
        const r = await deps.store.raiseSuggestion(req.project_id, {
          title,
          body: typeof req.body.body === 'string' ? req.body.body : '',
          report: req.body.report,
          raised_by: caller.uid,
          raised_by_label: grant.label || caller.uid,
        });
        deps.log.info('api.suggestion_raised', 'suggestion raised', {
          project_id: req.project_id, uid: caller.uid, role: grant.role,
          report: req.body.report, suggestion_id: r.suggestion_id,
        });
        return { status: 200, body: { ok: true, ...r } };
      }
      case 'accept_suggestion': {
        if (!deps.store.acceptSuggestion) {
          return { status: 501, body: { error: 'this backend does not support suggestions' } };
        }
        const suggestion_id = typeof req.body.suggestion_id === 'string' ? req.body.suggestion_id : '';
        if (!suggestion_id) return { status: 400, body: { error: 'accept needs a suggestion_id' } };
        if (!isTaskKind(req.body.kind)) {
          return {
            status: 400,
            body: { error: `kind must be one of ${TASK_KINDS.join(', ')}`, kinds: [...TASK_KINDS] },
          };
        }
        const globs = Array.isArray(req.body.file_scope)
          ? (req.body.file_scope as unknown[]).filter((x): x is string => typeof x === 'string')
          : [];
        // THE SAME GATE A CLAIM GETS. Accepting writes a task whose file_scope the accepter will
        // then lock, so a frontend member must not be able to accept a suggestion as
        // `functions/**` work and hand themselves the server. Checked against the project's own
        // policy, not the default template.
        if (globs.length > 0) assertScopeAllowed(grant.role, globs, grant.file_scope);

        const title = typeof req.body.title === 'string' && req.body.title.trim()
          ? req.body.title.trim()
          : '';
        const task_id = typeof req.body.task_id === 'string' && req.body.task_id
          ? req.body.task_id
          : deriveTaskId(title || suggestion_id);

        const r = await deps.store.acceptSuggestion(req.project_id, suggestion_id, caller.uid, {
          task_id, title: title || suggestion_id, kind: req.body.kind, file_scope: globs,
        });
        deps.log.info('api.suggestion_accepted', 'suggestion triaged into a task', {
          project_id: req.project_id, uid: caller.uid, role: grant.role,
          suggestion_id, ok: r.ok,
        });
        // A LOST RACE IS 200 WITH ok:false, like a lost claim. Two people reading the same board
        // will pick the same suggestion up seconds apart; the loser is told who won, and a 4xx
        // would make every HTTP client log a normal outcome as an error.
        return { status: 200, body: { ...r } as Record<string, unknown> };
      }
      case 'decline_suggestion': {
        if (!deps.store.declineSuggestion) {
          return { status: 501, body: { error: 'this backend does not support suggestions' } };
        }
        const suggestion_id = typeof req.body.suggestion_id === 'string' ? req.body.suggestion_id : '';
        if (!suggestion_id) return { status: 400, body: { error: 'decline needs a suggestion_id' } };
        const reason = typeof req.body.reason === 'string' ? req.body.reason.trim() : '';
        // REQUIRED. The person who raised it reads this, and a refusal with no reason is an
        // ignore with paperwork.
        if (!reason) return { status: 400, body: { error: 'declining needs a reason' } };
        const r = await deps.store.declineSuggestion(req.project_id, suggestion_id, caller.uid, reason);
        deps.log.info('api.suggestion_declined', 'suggestion declined', {
          project_id: req.project_id, uid: caller.uid, role: grant.role, suggestion_id, ok: r.ok,
        });
        return { status: 200, body: { ...r } as Record<string, unknown> };
      }
      case 'create_invite': {
        const role_slug = typeof req.body.role_slug === 'string' ? req.body.role_slug : '';
        if (!ROLE_SLUGS.includes(role_slug as RoleSlug)) {
          return {
            status: 400,
            body: { error: `role_slug must be one of ${ROLE_SLUGS.join(', ')}`, roles: [...ROLE_SLUGS] },
          };
        }
        const member_label = typeof req.body.member_label === 'string' && req.body.member_label.trim()
          ? req.body.member_label.trim()
          : role_slug;
        // Seven days. Long enough to send a teammate a code and have them act on it, short
        // enough that a code left in a chat log stops working.
        const ttl_ms = 7 * 24 * 60 * 60 * 1000;

        // The plaintext code is returned ONCE and never stored: Firestore holds only its
        // sha256, exactly as the agent token does. A code that can be read back out of the
        // database is a credential the database now owns.
        const code = mintToken();
        await deps.db
          .collection('projects').doc(req.project_id)
          .collection('invites').doc()
          .set({
            code_sha256: hashToken(code),
            role_slug,
            member_label,
            expires_at_ms: Date.now() + ttl_ms,
            consumed: false,
            created_by: caller.uid,
            created_at_ms: Date.now(),
          });

        deps.log.info('api.invite_created', 'invite minted', {
          project_id: req.project_id, uid: caller.uid, role_slug,
        });
        return { status: 200, body: { ok: true, invite: code, role_slug, member_label, expires_at_ms: Date.now() + ttl_ms } };
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
