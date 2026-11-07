// Shared sessions: asking for more, and talking. docs/designs/shared-sessions.md, pieces 2 and 3.
//
// Pure functions only. The write path (functions/src/write-api.ts), the agent API
// (functions/src/api.ts), the store's lock gate (firebase/store.ts) and the CLI's edit guard all
// call these, so the rules for "is this grant still live" and "who does @priya mean" are written
// once. A second copy of a permission rule is the copy that drifts; roles.ts says the same thing
// about globContains, and this file follows it.

import { globContains } from './roles.ts';

// ---- scope requests ---------------------------------------------------------------------------

export type ScopeRequestStatus = 'open' | 'granted' | 'denied';

/**
 * How long a grant lasts. `task` (the default) ends when the ticket stops being this agent's;
 * `seat` widens the seat's file_scope for good. "Fix one typo on slide 2" must not quietly become
 * "owns slide 2 forever", so the narrow one is the default.
 */
export type GrantDuration = 'task' | 'seat';

export interface ScopeRequest {
  request_id: string;
  /** The agent that asked, from its token. Never from the body. */
  agent_id: string;
  label: string;
  role_slug: string;
  globs: string[];
  reason: string;
  /** The ticket the agent was working when it asked. A `task` grant needs one. */
  task_id: string | null;
  status: ScopeRequestStatus;
  grant: GrantDuration | null;
  /**
   * The claim's `claimed_at` at the moment of the grant. A task grant is live only while that SAME
   * claim stands, which is what makes it end on ship, release, handoff, cancel or reap without any
   * of those paths having to know grants exist: each of them ends the claim, and a re-claim has a
   * new claimed_at.
   */
  claimed_at: string | null;
  decided_by: string | null;
  decided_at_ms: number | null;
  denied_reason: string | null;
  created_at_ms: number;
}

const MAX_GLOBS = 20;

/** The fence rules validateRoleScope applies, for globs an agent asks for. */
export function cleanGlobs(globs: unknown): { ok: true; globs: string[] } | { ok: false; error: string } {
  if (!Array.isArray(globs) || globs.length === 0) return { ok: false, error: 'name at least one glob' };
  if (globs.length > MAX_GLOBS) return { ok: false, error: `at most ${MAX_GLOBS} globs` };
  const out: string[] = [];
  for (const g of globs) {
    if (typeof g !== 'string' || !g.trim()) return { ok: false, error: 'every glob must be a non-empty string' };
    const t = g.trim();
    if (t.startsWith('!') || t.startsWith('/') || t.split('/').includes('..')) {
      return { ok: false, error: `refusing "${t}": no negations, absolute paths or ..` };
    }
    if (!out.includes(t)) out.push(t);
  }
  return { ok: true, globs: out };
}

/** Validate what an agent sends to ask for more. A reason is required: the host has to decide on something. */
export function validateScopeRequest(
  body: { globs?: unknown; reason?: unknown; task_id?: unknown },
): { ok: true; globs: string[]; reason: string; task_id: string | null } | { ok: false; error: string } {
  const g = cleanGlobs(body.globs);
  if (!g.ok) return g;
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) return { ok: false, error: 'say why: the host decides on the reason' };
  const task_id = typeof body.task_id === 'string' && body.task_id.trim() ? body.task_id.trim() : null;
  return { ok: true, globs: g.globs, reason: reason.slice(0, 500), task_id };
}

/**
 * May this decision be made? Pure, so every branch is testable without Firestore.
 *
 * A decided request is a VALUE (ok:false with who decided), exactly like a lost claim: two hosts
 * tapping "grant" at once is normal, and the second one is told rather than erroring.
 */
export function validateDecision(
  req: Pick<ScopeRequest, 'status' | 'decided_by' | 'task_id' | 'agent_id'> | null,
  decision: { grant: boolean; duration?: unknown; reason?: unknown },
  claim: { agent_id: string; claimed_at: string } | null,
):
  | { ok: true; grant: true; duration: GrantDuration; claimed_at: string | null }
  | { ok: true; grant: false; reason: string }
  | { ok: false; status: number; error: string; decided_by?: string | null } {
  if (!req) return { ok: false, status: 404, error: 'no such request' };
  if (req.status !== 'open') {
    return { ok: false, status: 200, error: `already ${req.status}`, decided_by: req.decided_by };
  }
  if (!decision.grant) {
    const reason = typeof decision.reason === 'string' ? decision.reason.trim() : '';
    // A refusal with no reason is an ignore with paperwork -- declineSuggestion's rule.
    if (!reason) return { ok: false, status: 400, error: 'denying needs a reason' };
    return { ok: true, grant: false, reason: reason.slice(0, 500) };
  }
  const duration = decision.duration ?? 'task';
  if (duration !== 'task' && duration !== 'seat') {
    return { ok: false, status: 400, error: 'grant is --for task or --for seat' };
  }
  if (duration === 'seat') return { ok: true, grant: true, duration, claimed_at: null };
  // A task grant needs a live claim by the agent that asked, or it would have nothing to end with.
  if (!req.task_id) {
    return { ok: false, status: 409, error: 'the request names no ticket; grant it --for seat, or ask them to claim one first' };
  }
  if (!claim || claim.agent_id !== req.agent_id) {
    return { ok: false, status: 409, error: `${req.task_id} is no longer claimed by the agent that asked; grant it --for seat or deny it` };
  }
  return { ok: true, grant: true, duration, claimed_at: claim.claimed_at };
}

/**
 * The extra globs an agent may lock for a ticket, from its granted requests.
 *
 * Live only while the claim that was standing at grant time still stands. Every path that ends a
 * claim therefore ends the grant, and none of them had to change.
 */
export function activeGrantGlobs(
  requests: readonly Pick<ScopeRequest, 'agent_id' | 'task_id' | 'status' | 'grant' | 'claimed_at' | 'globs'>[],
  agent_id: string,
  task_id: string,
  claim: { agent_id: string; claimed_at: string } | null,
): string[] {
  if (!claim || claim.agent_id !== agent_id) return [];
  const out: string[] = [];
  for (const r of requests) {
    if (r.status !== 'granted' || r.grant !== 'task') continue;
    if (r.agent_id !== agent_id || r.task_id !== task_id) continue;
    if (r.claimed_at !== claim.claimed_at) continue;
    for (const g of r.globs) if (!out.includes(g)) out.push(g);
  }
  return out;
}

// ---- the local edit guard ---------------------------------------------------------------------

/**
 * May the agent write this path? For the Claude Code PreToolUse hook `flotilla guard`.
 *
 * NOT the security boundary -- the user owns the laptop the hook runs on. The server's lock gate
 * and `ship` still refuse; this refuses EARLIER, at the moment of editing, so an agent learns it
 * needs to ask before it has done the work rather than after.
 *
 * `rel` is relative to the repo root. Anything outside the repo is not Flotilla's to fence, and
 * `.agentic/` is the agent's own mailbox: refusing it would stop the agent reporting at all.
 */
export function guardDecision(
  rel: string,
  fence: readonly string[],
  granted: readonly string[],
): { allow: true } | { allow: false; reason: string } {
  const p = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  if (p === '' || p.startsWith('../') || p === '..' || p.startsWith('/')) return { allow: true };
  if (p === '.agentic' || p.startsWith('.agentic/')) return { allow: true };
  const ok = (globs: readonly string[]) => globs.some((g) => globContains(g, p));
  if (ok(fence) || ok(granted)) return { allow: true };
  return {
    allow: false,
    reason:
      `${p} is outside your seat (${fence.length ? fence.join(', ') : 'no files'}). ` +
      `Ask the host for it: call the request_scope tool, or run ` +
      `flotilla request --scope "${p}" --reason "<why>". Carry on with work inside your seat meanwhile.`,
  };
}

// ---- messages ---------------------------------------------------------------------------------

export interface Message {
  message_id: string;
  from_id: string;
  from_kind: 'agent' | 'member';
  from_label: string;
  /** An agent id, a member uid, or '*' for everyone with a seat. */
  to: string;
  to_label: string;
  body: string;
  in_reply_to: string | null;
  sent_at_ms: number;
}

export const MESSAGE_MAX = 2000;

export function cleanMessageBody(body: unknown): { ok: true; body: string } | { ok: false; error: string } {
  const b = typeof body === 'string' ? body.trim() : '';
  if (!b) return { ok: false, error: 'a message needs a body' };
  if (b.length > MESSAGE_MAX) return { ok: false, error: `a message is at most ${MESSAGE_MAX} characters` };
  return { ok: true, body: b };
}

/** Someone a message can reach: a connected agent, or a member (the host) by uid. */
export interface Addressee {
  id: string;
  kind: 'agent' | 'member';
  label: string;
  role_slug: string;
}

/**
 * Who `@priya` means. Tried in order, first unique hit wins:
 *   '*' / 'all' / 'everyone'  -> everyone
 *   an exact id               -> that one
 *   a role slug               -> the one holding it (a personal seat has exactly one)
 *   a label, or its first word, case-insensitive
 *
 * Ambiguous is an ERROR naming the candidates, never a guess: a message meant for one person
 * delivered to another is worse than one not sent.
 */
export function resolveRecipient(
  to: string,
  roster: readonly Addressee[],
): { ok: true; to: string; to_label: string } | { ok: false; error: string } {
  const t = to.trim().replace(/^@/, '');
  if (!t) return { ok: false, error: 'say who: @name, or --all' };
  if (['*', 'all', 'everyone'].includes(t.toLowerCase())) return { ok: true, to: '*', to_label: 'everyone' };
  const lower = t.toLowerCase();
  const tries: ((a: Addressee) => boolean)[] = [
    (a) => a.id === t,
    (a) => a.role_slug === lower,
    (a) => a.label.toLowerCase() === lower,
    (a) => (a.label.toLowerCase().split(/[^a-z0-9]+/).find(Boolean) ?? '') === lower,
  ];
  for (const match of tries) {
    const hits = roster.filter(match);
    if (hits.length === 1) return { ok: true, to: hits[0]!.id, to_label: hits[0]!.label };
    if (hits.length > 1) {
      return { ok: false, error: `"${t}" matches ${hits.length}: ${hits.map((h) => `${h.label} (${h.id})`).join(', ')}. Use the id.` };
    }
  }
  return { ok: false, error: `nobody called "${t}". Try one of: ${roster.map((a) => a.role_slug === 'owner' ? a.label : `@${a.role_slug}`).join(', ') || '(no one yet)'}` };
}

/** Is this message for this reader? Their own sent messages count, so a thread reads whole. */
export function isFor(m: Pick<Message, 'to' | 'from_id'>, reader_ids: readonly string[]): boolean {
  return m.to === '*' || reader_ids.includes(m.to) || reader_ids.includes(m.from_id);
}
