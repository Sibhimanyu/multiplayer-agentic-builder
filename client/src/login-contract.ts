// The wire half of `flotilla login`: parse the CLI's link, shape the credential, hand it over.
//
// SEPARATE FROM Login.tsx ON PURPOSE. Node strips TypeScript types in place but does not compile
// JSX, so nothing under node --test can import a .tsx file. Keeping the contract here means the
// loopback test drives THE PAGE'S OWN CODE, not a transcription of it -- which is the difference
// between testing the product and testing a second implementation that agrees with it.
//
// THE CONTRACT, from cli/auth.ts, which is the authority:
//
//   POST http://127.0.0.1:<port>/
//   { nonce, refresh_token, id_token, uid, email }     required: nonce, refresh_token, uid
//
//   wrong nonce      -> 403, and the listener KEEPS WAITING (a stray POST must not kill a login)
//   nonce ok, no uid -> 400, nonce not burned
//   second valid     -> 409
//
// MIXED CONTENT: the board is https and the listener is http://127.0.0.1. Browsers permit this --
// loopback is a "potentially trustworthy origin" under the Secure Contexts spec, so it is not
// treated as insecure content -- and the CLI answers the preflight with 204. That is a browser
// behaviour this design rests on, so it is verified in a real browser by firebase/login-browser.mjs
// rather than assumed here.

export interface LoginParams {
  port: number;
  nonce: string;
  anonymous: boolean;
}

export type ParseResult =
  | { ok: true; params: LoginParams }
  | { ok: false; error: string };

/**
 * Parse the query string the CLI opened.
 *
 * NEVER GUESSES A PORT. The alternative to an error here is POSTing a live credential at whatever
 * happens to be listening on some default -- so a link this function cannot read becomes an error
 * the user sees, never a value it invents.
 */
export function parseLoginParams(search: string): ParseResult {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  const raw_port = q.get('port');
  const nonce = q.get('nonce');

  if (!raw_port && !nonce) {
    return { ok: false, error: 'This page has no login request attached to it.' };
  }
  if (!nonce) return { ok: false, error: 'The login link has no nonce.' };
  if (!raw_port) return { ok: false, error: 'The login link has no local port.' };

  // Number('') is 0 and Number('8080abc') is NaN; both must fail, and so must a port outside the
  // range, because the failure mode is "credential posted somewhere else" rather than "error".
  const port = Number(raw_port);
  if (!/^\d+$/.test(raw_port) || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, error: `"${raw_port}" is not a valid port number.` };
  }
  // The CLI's nonce is 32 random bytes base64url-encoded -- 43 characters. Anything short or
  // outside that alphabet did not come from `flotilla login`, and accepting it would mean
  // handing a credential to a listener on the strength of a guess about who is waiting.
  if (!/^[A-Za-z0-9_-]{32,}$/.test(nonce)) {
    return { ok: false, error: 'The login nonce is malformed.' };
  }

  // The CLI sends `provider=anonymous` (firebase/flotilla-main.ts); order 0055 specified
  // `anonymous=1`. Both are read, because the CLI is what actually opens this page and a flag
  // understood only one way works until someone compares it with the spec.
  const anonymous = q.get('provider') === 'anonymous' || q.get('anonymous') === '1';
  return { ok: true, params: { port, nonce, anonymous } };
}

export interface CredentialPayload {
  nonce: string;
  refresh_token: string;
  id_token: string;
  uid: string;
  email?: string;
}

/** The fields Firebase's UserCredential actually carries, named rather than cast at the call site. */
export interface SignedInUser {
  uid: string;
  email?: string | null;
  refreshToken: string;
  getIdToken: () => Promise<string>;
}

/**
 * Build the POST body from a Firebase user.
 *
 * The nonce is copied VERBATIM -- not trimmed, not re-encoded. The CLI compares with `!==`, and
 * any normalisation here would surface to the user as a login that silently did nothing.
 */
export async function payloadFor(nonce: string, user: SignedInUser): Promise<CredentialPayload> {
  const id_token = await user.getIdToken();
  return {
    nonce,
    refresh_token: user.refreshToken,
    id_token,
    uid: user.uid,
    ...(user.email ? { email: user.email } : {}),
  };
}

export type PostOutcome = { ok: true } | { ok: false; status: number | null; reason: string };

/** Hand the credential to the waiting CLI. */
export async function postCredential(
  port: number,
  payload: CredentialPayload,
  fetchImpl: typeof fetch = fetch,
): Promise<PostOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // Much the commonest real cause: the CLI stopped waiting, so nothing is listening.
    return {
      ok: false,
      status: null,
      reason:
        `Could not reach the flotilla CLI on port ${port}. ` +
        `Is \`flotilla login\` still running in your terminal? (${(err as Error).message})`,
    };
  }
  if (res.status === 403) {
    return { ok: false, status: 403, reason: 'The CLI rejected the nonce. Run `flotilla login` again.' };
  }
  if (res.status === 409) {
    return { ok: false, status: 409, reason: 'That login was already completed. You can close this tab.' };
  }
  if (res.status === 400) {
    return { ok: false, status: 400, reason: 'The CLI could not read the credential this page sent.' };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, reason: `The CLI refused the credential (HTTP ${res.status}).` };
  }
  return { ok: true };
}

/**
 * What the page is showing.
 *
 * Exported so the render can be asserted state by state. The bug this page fixes was a route that
 * showed nothing actionable; a spinner with no terminal state, or an unhandled state falling
 * through to an empty div, would be the same bug made quieter.
 */
export type LoginState =
  | { step: 'ready'; params: LoginParams }
  | { step: 'signing-in'; params: LoginParams }
  | { step: 'posting'; params: LoginParams }
  | { step: 'done'; uid: string; email?: string }
  | { step: 'error'; at: string; detail: string };

/**
 * The first frame, computed synchronously from the URL.
 *
 * Deliberately not an effect: rendering "checking…" and then an error one tick later means the
 * server-rendered assertions could only ever see the placeholder, and a user on a bad link would
 * watch a spinner before being told the link was unreadable from the start.
 */
export function initialLoginState(search: string): LoginState {
  const parsed = parseLoginParams(search);
  if (!parsed.ok) return { step: 'error', at: 'the login link', detail: parsed.error };
  return { step: 'ready', params: parsed.params };
}

/** Sign-in failures the user can act on, separated from the ones they can only report. */
export function signInFailure(err: unknown): string {
  const code = (err as { code?: string } | undefined)?.code ?? '';
  if (code === 'auth/popup-closed-by-user') return 'The sign-in window was closed before it finished.';
  if (code === 'auth/cancelled-popup-request') return 'The sign-in window was replaced by another one.';
  if (code === 'auth/popup-blocked') {
    return 'Your browser blocked the sign-in popup. Allow popups for this site, then try again.';
  }
  if (code === 'auth/operation-not-allowed') {
    return 'This sign-in method is not enabled on the Firebase project.';
  }
  return code || (err as Error)?.message || String(err);
}
