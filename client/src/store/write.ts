/// <reference types="vite/client" />
// The board's write path.
//
// THE SAME ENDPOINT THE CLI ALREADY USES, and deliberately not a second one. `functions/src/
// write-api.ts` has handled create_task, claim, release and the rest since order 0063; only
// `cli/auth.ts` ever called it. A browser calling it needs nothing new on the server: the caller
// is a verified uid either way, and `agent_id` falls back to that uid when a browser does not
// supply one (write-api.ts:225), so a claim made from the board is attributed to the person.
//
// A second write path would mean two places that decide what a claim is. There is one.

import { boardAuth } from './session';

/** Every op the board is allowed to perform. Narrower than WriteRequest['op'] on purpose. */
export type BoardOp =
  | 'create_task' | 'claim' | 'release'
  | 'raise_suggestion' | 'accept_suggestion' | 'decline_suggestion';

export class NotSignedIn extends Error {
  constructor() {
    super('Sign in before writing.');
    this.name = 'NotSignedIn';
  }
}

/**
 * What the server said, kept as data rather than thrown.
 *
 * `ok:false` is NOT an error and must not be rendered as one. A lost claim race and a duplicate
 * task are both normal outcomes of two people doing the right thing at the same time, and
 * write-api.ts returns 200 for exactly that reason -- "an existing task is 200 with ok:false, NOT
 * 409 ... a 4xx would make every HTTP client log it red". Callers branch on `ok`; only transport
 * and permission failures throw.
 */
export interface WriteOutcome {
  ok: boolean;
  /** Present on create_task. */
  task_id?: string;
  /** Whatever the op returned, for callers that need the detail. */
  result?: Record<string, unknown>;
  /** Set when the server refused with a reason worth showing a person. */
  error?: string;
}

const writeUrl = (): string => {
  const env = import.meta.env as unknown as Record<string, string | undefined>;
  const project = env.VITE_FIREBASE_PROJECT_ID;
  const region = env.VITE_FUNCTIONS_REGION ?? 'us-central1';
  return `https://${region}-${project}.cloudfunctions.net/write`;
};

/**
 * One POST, with the caller's Firebase ID token.
 *
 * `getIdToken()` rather than a cached string: the token expires after an hour and a board left
 * open overnight would otherwise fail its first click of the morning with a 401 that looks like a
 * permission problem rather than an expiry.
 */
export async function boardWrite(
  project_id: string,
  op: BoardOp,
  body: Record<string, unknown>,
): Promise<WriteOutcome> {
  const user = boardAuth().currentUser;
  if (!user) throw new NotSignedIn();
  const token = await user.getIdToken();

  const res = await fetch(writeUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ project_id, op, body }),
  });

  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;

  // 403 is the rules working, not an outage -- the same distinction StoreStatus draws. Surfaced
  // with the server's own sentence so the reason reaches the person who can act on it.
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: String(payload.error ?? 'You do not have permission to do that.') };
  }
  if (!res.ok) {
    return { ok: false, error: String(payload.error ?? `The server refused (${res.status}).`) };
  }

  return {
    ok: payload.ok !== false,
    // accept/decline return their result flat (ok, task_id, resolved_by), not under `result`.
    ...(payload.ok === false && !payload.result ? { result: payload } : {}),
    ...(typeof payload.task_id === 'string' ? { task_id: payload.task_id } : {}),
    ...(payload.result && typeof payload.result === 'object'
      ? { result: payload.result as Record<string, unknown> }
      : {}),
    ...(typeof payload.error === 'string' ? { error: payload.error } : {}),
  };
}

/** Create a task. `kind` is required by the server and never defaulted -- see write-api.ts. */
export const createTask = (
  project_id: string,
  task: { title: string; kind: string; description?: string; file_scope?: string[] },
): Promise<WriteOutcome> => boardWrite(project_id, 'create_task', { ...task });

/**
 * Claim a task and, with it, its file scope.
 *
 * RESERVING IS ALL A BROWSER CAN DO. The agent runs on the claimer's own machine, so this does
 * exactly what `flotilla claim` does -- an atomic claim plus the scope acquisition -- and the
 * local agent picks the work up on its next poll. The UI must say so rather than implying the
 * click started anything.
 */
export const claimTask = (project_id: string, task_id: string): Promise<WriteOutcome> =>
  boardWrite(project_id, 'claim', { task_id });

export const releaseTask = (project_id: string, task_id: string): Promise<WriteOutcome> =>
  boardWrite(project_id, 'release', { task_id });

/** Raise a suggestion. The raiser is the verified uid on the server; nothing here can name another. */
export const raiseSuggestion = (
  project_id: string,
  s: { title: string; report: string; body: string },
): Promise<WriteOutcome> => boardWrite(project_id, 'raise_suggestion', { ...s });

/** Make it a ticket. Atomic on the server: of two people accepting at once, one wins. */
export const acceptSuggestion = (
  project_id: string,
  a: { suggestion_id: string; title: string; kind: string; file_scope: string[] },
): Promise<WriteOutcome> => boardWrite(project_id, 'accept_suggestion', { ...a });

/** Turn it down. The reason is required, and the person who raised it reads it. */
export const declineSuggestion = (project_id: string, suggestion_id: string, reason: string): Promise<WriteOutcome> =>
  boardWrite(project_id, 'decline_suggestion', { suggestion_id, reason });
