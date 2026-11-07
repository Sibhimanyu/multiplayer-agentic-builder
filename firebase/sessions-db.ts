// Shared sessions, on Firestore. docs/designs/shared-sessions.md.
//
// The Firestore half of shared/store/sessions.ts. Every RULE lives there and is tested there
// without an emulator; this file only reads and writes documents and calls those rules. It is
// shared by the three places that need it -- the write path (members, user token), the agent API
// (agents, agent token) and the store's own lock gate -- so none of them grows a private copy.
//
//   projects/{pid}/scope_requests/{rid}   an agent asking for files outside its seat
//   projects/{pid}/messages/{mid}         a line from one person or agent to another, or to all
//
// Both collections are server-only in firestore.rules (`allow read, write: if false`). A message
// addressed to one person is not the whole project's business, and a rule that filtered by
// recipient would force every client query into one exact shape forever.

import type { Firestore, Query } from 'firebase-admin/firestore';

import type { RolePolicy } from '../shared/store/directory.ts';
import {
  activeGrantGlobs,
  validateDecision,
  type Addressee,
  type GrantDuration,
  type Message,
  type ScopeRequest,
  isFor,
} from '../shared/store/sessions.ts';

const proj = (db: Firestore, pid: string) => db.collection('projects').doc(pid);

/** The project's role document, or null. What roleFor() needs to know a seat drawn by `share`. */
export async function rolePolicy(db: Firestore, pid: string, role_slug: string): Promise<RolePolicy | null> {
  const d = await proj(db, pid).collection('roles').doc(role_slug).get();
  return d.exists ? (d.data() as RolePolicy) : null;
}

/**
 * Extra globs the host granted this agent for this ticket, live only while the same claim stands.
 *
 * One point read and one single-field query. The query is on agent_id alone, deliberately: a
 * composite index would be one more thing a fresh project has to deploy before grants work.
 */
export async function grantedGlobs(db: Firestore, pid: string, agent_id: string, task_id: string): Promise<string[]> {
  if (!task_id) return [];
  const [claim, reqs] = await Promise.all([
    proj(db, pid).collection('claims').doc(task_id).get(),
    proj(db, pid).collection('scope_requests').where('agent_id', '==', agent_id).limit(200).get(),
  ]);
  const c = claim.exists
    ? { agent_id: String(claim.get('agent_id') ?? ''), claimed_at: String(claim.get('claimed_at') ?? '') }
    : null;
  return activeGrantGlobs(reqs.docs.map((d) => d.data() as ScopeRequest), agent_id, task_id, c);
}

export async function createScopeRequest(
  db: Firestore,
  pid: string,
  input: Pick<ScopeRequest, 'agent_id' | 'label' | 'role_slug' | 'globs' | 'reason' | 'task_id'>,
  now: number,
): Promise<ScopeRequest> {
  const ref = proj(db, pid).collection('scope_requests').doc();
  const req: ScopeRequest = {
    request_id: ref.id,
    ...input,
    status: 'open',
    grant: null,
    claimed_at: null,
    decided_by: null,
    decided_at_ms: null,
    denied_reason: null,
    created_at_ms: now,
  };
  await ref.set(req);
  return req;
}

/** Newest first. `status` narrows to open ones for the host; `agent_id` to one agent's own. */
export async function listScopeRequests(
  db: Firestore,
  pid: string,
  filter: { status?: ScopeRequest['status']; agent_id?: string } = {},
): Promise<ScopeRequest[]> {
  let q = proj(db, pid).collection('scope_requests') as Query;
  // ONE equality filter at most, and the rest in memory: two would need a composite index.
  if (filter.agent_id) q = q.where('agent_id', '==', filter.agent_id);
  else if (filter.status) q = q.where('status', '==', filter.status);
  const snap = await q.limit(200).get();
  return snap.docs
    .map((d) => d.data() as ScopeRequest)
    .filter((r) => !filter.status || r.status === filter.status)
    .sort((a, b) => b.created_at_ms - a.created_at_ms);
}

export type DecideResult =
  | { ok: true; request: ScopeRequest }
  | { ok: false; status: number; error: string; decided_by?: string | null };

/**
 * Grant or deny, ATOMICALLY. Two hosts tapping at once produce one decision and one ok:false
 * naming who decided -- the claim's rule, for the same reason.
 *
 * A `seat` grant widens the seat's file_scope in the same transaction, so there is no moment when
 * the request reads granted and the fence does not.
 */
export async function decideScopeRequest(
  db: Firestore,
  pid: string,
  request_id: string,
  by: string,
  decision: { grant: boolean; duration?: unknown; reason?: unknown },
  now: number,
): Promise<DecideResult> {
  const ref = proj(db, pid).collection('scope_requests').doc(request_id);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const req = snap.exists ? (snap.data() as ScopeRequest) : null;
    const claimSnap = req?.task_id ? await tx.get(proj(db, pid).collection('claims').doc(req.task_id)) : null;
    const claim = claimSnap?.exists
      ? { agent_id: String(claimSnap.get('agent_id') ?? ''), claimed_at: String(claimSnap.get('claimed_at') ?? '') }
      : null;
    const roleRef = req ? proj(db, pid).collection('roles').doc(req.role_slug) : null;
    const roleSnap = roleRef ? await tx.get(roleRef) : null;

    const v = validateDecision(req, decision, claim);
    if (!v.ok) return v;
    const r = req!;

    if (!v.grant) {
      const next: ScopeRequest = { ...r, status: 'denied', decided_by: by, decided_at_ms: now, denied_reason: v.reason };
      tx.set(ref, next);
      return { ok: true, request: next };
    }
    if (v.duration === 'seat') {
      if (!roleSnap?.exists) return { ok: false, status: 409, error: `the seat "${r.role_slug}" no longer exists` };
      if (r.role_slug === 'owner' || r.role_slug === 'user') {
        return { ok: false, status: 409, error: `the ${r.role_slug} seat is fixed; grant it --for task instead` };
      }
      const had = (roleSnap.get('file_scope') as string[] | undefined) ?? [];
      tx.update(roleRef!, { file_scope: [...had, ...r.globs.filter((g) => !had.includes(g))] });
    }
    const next: ScopeRequest = {
      ...r,
      status: 'granted',
      grant: v.duration as GrantDuration,
      claimed_at: v.claimed_at,
      decided_by: by,
      decided_at_ms: now,
    };
    tx.set(ref, next);
    return { ok: true, request: next };
  });
}

/**
 * Everyone a message can reach: connected agents and members, revoked ones excluded.
 *
 * An agent's label is the label its invite carried ("Priya, second speaker"), and its role_slug is
 * the seat `share` drew ("priya") -- which is what makes `@priya` resolve to one agent.
 */
export async function roster(db: Firestore, pid: string): Promise<Addressee[]> {
  const [agents, members] = await Promise.all([
    proj(db, pid).collection('agents').get(),
    proj(db, pid).collection('members').get(),
  ]);
  const out: Addressee[] = [];
  for (const d of agents.docs) {
    if (d.get('revoked') === true) continue;
    out.push({ id: d.id, kind: 'agent', label: String(d.get('member_label') ?? d.id), role_slug: String(d.get('role_slug') ?? '') });
  }
  for (const d of members.docs) {
    if (d.get('revoked') === true) continue;
    // The user seat cannot be messaged for the same reason it cannot message: it has no agent,
    // and the people in it are the app's users, not the session's crew.
    if (d.get('role') === 'user') continue;
    out.push({ id: d.id, kind: 'member', label: String(d.get('label') ?? d.id), role_slug: String(d.get('role') ?? '') });
  }
  return out;
}

export async function sendMessage(
  db: Firestore,
  pid: string,
  m: Omit<Message, 'message_id' | 'sent_at_ms'>,
  now: number,
): Promise<Message> {
  const ref = proj(db, pid).collection('messages').doc();
  const msg: Message = { ...m, message_id: ref.id, sent_at_ms: now };
  await ref.set(msg);
  return msg;
}

/**
 * Messages for this reader since a time, oldest first. Bounded: 200 newest past `since_ms`.
 *
 * Filtered in memory by isFor(), because Firestore cannot OR "to me" with "to everyone" with "from
 * me" without three queries; at session sizes the whole recent window is small.
 */
export async function readMessages(
  db: Firestore,
  pid: string,
  reader_ids: readonly string[],
  since_ms: number,
): Promise<Message[]> {
  const snap = await proj(db, pid)
    .collection('messages')
    .where('sent_at_ms', '>', since_ms)
    .orderBy('sent_at_ms', 'asc')
    .limit(200)
    .get();
  return snap.docs.map((d) => d.data() as Message).filter((m) => isFor(m, reader_ids));
}
