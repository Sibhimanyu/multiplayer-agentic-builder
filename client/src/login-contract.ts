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
  /** `?popup=1` opts into signInWithPopup. Redirect is the default; see Login.tsx. */
  popup: boolean;
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
  return { ok: true, params: { port, nonce, anonymous, popup: q.get('popup') === '1' } };
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

/**
 * `recoverable` means RECOVERABLE IN THIS PAGE, with what it already has.
 *
 * It is the difference between offering a retry button and telling the user to go back to their
 * terminal, and it has to be decided per failure rather than guessed from severity. Telling
 * someone to retry when the nonce is burned is a loop they cannot leave; telling them to re-run a
 * command when a button would have worked sends them to a terminal for nothing.
 */
export type PostOutcome =
  | { ok: true }
  | { ok: false; status: number | null; reason: string; recoverable: boolean };

/**
 * Is this a WebKit browser that is not Chrome?
 *
 * Used ONLY to decide which explanation to put first when the POST fails, never to decide what
 * the page does. A wrong guess reorders two sentences and hides nothing.
 *
 * Chrome and Edge on macOS both carry "Safari" and "AppleWebKit" in their user agent, so they
 * have to be excluded by name or every Chrome user is told to switch to Chrome.
 */
export function looksLikeWebKit(ua: string): boolean {
  return /AppleWebKit/.test(ua) && !/Chrome|Chromium|Edg\//.test(ua);
}

/** Hand the credential to the waiting CLI. */
export async function postCredential(
  port: number,
  payload: CredentialPayload,
  fetchImpl: typeof fetch = fetch,
  ua: string = typeof navigator === 'undefined' ? '' : navigator.userAgent,
): Promise<PostOutcome> {
  let res: Response;
  try {
    res = await fetchImpl(`http://127.0.0.1:${port}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // TWO CAUSES, INDISTINGUISHABLE FROM HERE. The fetch throws the same opaque "Load failed"
    // whether the CLI has exited or the browser refused to make the request at all:
    //
    //   - the CLI stopped waiting, so nothing is listening; or
    //   - the BROWSER BLOCKED IT. WebKit treats http://127.0.0.1 from an https page as mixed
    //     content and blocks it outright. Chrome does not -- it follows the Secure Contexts spec,
    //     under which loopback is potentially trustworthy. Measured, in both engines:
    //     firebase/login-webkit.mjs section 4 and firebase/login-browser.mjs section 3.
    //
    // Both are named, because guessing wrong and printing only one leaves the user re-running a
    // command that cannot work. Neither is recoverable by a retry button in this page, so the
    // page must say what WOULD work instead -- which, in the blocked case, is another browser.
    const webkit = looksLikeWebKit(ua);
    const blocked = 'This browser may have blocked the request: Safari refuses connections from '
      + 'an https page to http://127.0.0.1. Opening this same link in Chrome will work.';
    const gone = `The CLI may have stopped waiting — check the terminal running \`flotilla login\`.`;
    return {
      ok: false,
      status: null,
      recoverable: false,
      reason: `Could not reach the flotilla CLI on port ${port}. `
        + (webkit ? `${blocked} ${gone}` : `${gone} ${blocked}`)
        + ` (${(err as Error).message})`,
    };
  }
  if (res.status === 403) {
    // The nonce is wrong or spent. The CLI will never accept it, so a retry button here would be
    // a button that cannot work.
    return {
      ok: false, status: 403, recoverable: false,
      reason: 'The CLI rejected the nonce. This login link can no longer be used.',
    };
  }
  if (res.status === 409) {
    return {
      ok: false, status: 409, recoverable: false,
      reason: 'That login was already completed. You can close this tab.',
    };
  }
  if (res.status === 400) {
    // The nonce was right and the credential was not usable. The CLI deliberately does NOT burn
    // the nonce on this path, so signing in again and re-posting genuinely can succeed.
    return {
      ok: false, status: 400, recoverable: true,
      reason: 'The CLI could not read the credential this page sent.',
    };
  }
  if (!res.ok) {
    return {
      ok: false, status: res.status, recoverable: true,
      reason: `The CLI refused the credential (HTTP ${res.status}).`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------------------------
// Surviving the redirect
//
// signInWithRedirect is a TOP-LEVEL NAVIGATION: this page is unloaded, Google takes over, and the
// browser comes back to /login carrying Google's query parameters rather than the CLI's. The port
// and nonce have to be waiting when it returns.
//
// sessionStorage, not localStorage: the value is scoped to this tab and dies with it. A nonce
// left in localStorage would outlive the login it belongs to and be found by the next one.
// ---------------------------------------------------------------------------------------------

export const PENDING_KEY = 'flotilla.login.pending';

/** Just enough of the Storage interface to be handed a fake one in a test. */
export interface KeyValueStore {
  getItem: (k: string) => string | null;
  setItem: (k: string, v: string) => void;
  removeItem: (k: string) => void;
}

/**
 * Remember the CLI's port and nonce BEFORE navigating away.
 *
 * Called before signInWithRedirect, never after: once the navigation starts this code is gone,
 * and a nonce that was not written by then is a login that comes back as "malformed nonce" --
 * a worse failure than the blocked popup being fixed, because it looks like the CLI's fault.
 */
export function stashPendingLogin(store: KeyValueStore, params: LoginParams): void {
  store.setItem(PENDING_KEY, JSON.stringify({ ...params, stashed_at: new Date().toISOString() }));
}

/**
 * Recover them on the way back.
 *
 * Re-validated rather than trusted: sessionStorage is writable by any script on this origin, and
 * a value that arrives malformed must fail the same way a malformed URL does instead of being
 * posted at a port it made up.
 */
export function readPendingLogin(store: KeyValueStore | null | undefined): LoginParams | null {
  if (!store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(PENDING_KEY);
  } catch {
    return null; // Safari throws on storage access in some privacy modes rather than returning null
  }
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    const check = parseLoginParams(
      `?port=${encodeURIComponent(String(v.port))}&nonce=${encodeURIComponent(String(v.nonce))}` +
        `${v.anonymous ? '&anonymous=1' : ''}${v.popup ? '&popup=1' : ''}`,
    );
    return check.ok ? check.params : null;
  } catch {
    return null;
  }
}

export function clearPendingLogin(store: KeyValueStore | null | undefined): void {
  try {
    store?.removeItem(PENDING_KEY);
  } catch { /* see readPendingLogin */ }
}

/**
 * What the page is showing.
 *
 * Exported so the render can be asserted state by state. The bug this page fixes was a route that
 * showed nothing actionable; a spinner with no terminal state, or an unhandled state falling
 * through to an empty div, would be the same bug made quieter.
 */
export type LoginState =
  /**
   * The handoff cannot work in this browser, and we knew before the user touched anything.
   * No params: nothing on this page can proceed, so it must not offer a button that cannot work.
   */
  | { step: 'refused'; reason: string }
  /** The CLI that issued this link is not listening any more — almost always a restored tab. */
  | { step: 'stale'; params: LoginParams }
  | { step: 'checking'; params: LoginParams }
  | { step: 'ready'; params: LoginParams }
  | { step: 'signing-in'; params: LoginParams }
  /** Back from Google, resolving the redirect result. The URL now carries Google's parameters. */
  | { step: 'returning'; params: LoginParams }
  | { step: 'posting'; params: LoginParams }
  | { step: 'done'; uid: string; email?: string }
  /**
   * `params` is present exactly when the page can try again itself. Carrying the port and nonce
   * on the error state is what makes the retry button possible: the thing needed to retry is
   * already in hand, so there is nothing to go back to the terminal for.
   */
  | { step: 'error'; at: string; detail: string; params?: LoginParams };

/**
 * The first frame, computed synchronously from the URL and whatever a redirect left behind.
 *
 * Not an effect: a server render could only ever see the placeholder, and a user on a bad link
 * would watch a spinner before being told the link was unreadable from the start.
 *
 * THE ORDER OF THESE TWO CHECKS IS THE WHOLE REDIRECT FLOW. On the way out the URL has the CLI's
 * parameters; on the way back it has Google's, and the CLI's are in sessionStorage. Reading the
 * URL first and the stash second covers both without either knowing about the other.
 */
/** What the page can see about its own surroundings, injected so it can be asserted. */
export interface PageEnvironment {
  /** `window.location.protocol` — "https:" or "http:". */
  protocol: string;
  /** `navigator.userAgent`. */
  ua: string;
}

/**
 * Can this page's credential handoff work here AT ALL?
 *
 * WebKit treats http://127.0.0.1 from an https page as mixed content and blocks it outright;
 * Chrome permits it because loopback is potentially trustworthy under Secure Contexts. Measured
 * in both engines (firebase/login-webkit.mjs, firebase/login-browser.mjs).
 *
 * THIS IS KNOWABLE ON LOAD. Nothing about it depends on sign-in succeeding: the page is https, the
 * engine is WebKit, the handoff is loopback. The user who reported this had already been through
 * Google before being told it could not work.
 *
 * Only for a page served over https. The CLI-served page is http and same-origin, which is the
 * whole point of it, and must never be refused by this.
 */
export function handoffBlocked(env: PageEnvironment): boolean {
  return env.protocol === 'https:' && looksLikeWebKit(env.ua);
}

export const REFUSAL_REASON =
  'Safari will not let this page reach the flotilla CLI. It refuses connections from an https '
  + 'page to http://127.0.0.1, so signing in here cannot finish — whatever you do next.';

/**
 * The first frame, computed synchronously from the URL and whatever a redirect left behind.
 *
 * Not an effect: a server render could only ever see the placeholder, and a user on a bad link
 * would watch a spinner before being told the link was unreadable from the start.
 *
 * THE BROWSER GATE COMES FIRST, before the URL is even considered. A link that parses perfectly
 * still cannot complete in this browser, so offering the button would be offering a dead end with
 * a Google sign-in in the middle of it.
 *
 * Then: on the way out the URL has the CLI's parameters; on the way back it has Google's, and the
 * CLI's are in sessionStorage. Reading the URL first and the stash second covers both.
 */
export function initialLoginState(
  search: string,
  store?: KeyValueStore | null,
  env?: PageEnvironment | null,
): LoginState {
  if (env && handoffBlocked(env)) return { step: 'refused', reason: REFUSAL_REASON };

  const parsed = parseLoginParams(search);
  // `checking` rather than `ready`: a restored tab carries parameters that look perfect and point
  // at a CLI that exited hours ago. Whether the listener is still there is a question with an
  // answer, so it is asked before anything actionable is drawn.
  if (parsed.ok) return { step: 'checking', params: parsed.params };

  const pending = readPendingLogin(store);
  if (pending) return { step: 'returning', params: pending };

  // No usable link and nothing pending. Not recoverable in the page -- there is no port to post
  // to and no nonce to echo -- so no `params`, and the render names the command instead.
  return { step: 'error', at: 'the login link', detail: parsed.error };
}

/**
 * Is the CLI that issued this link still listening?
 *
 * A plain GET. The loopback listener answers non-POST with 405 and sets
 * `access-control-allow-origin: *` on every response, so ANY status coming back proves something
 * is there. A thrown fetch means nothing is.
 *
 * Deliberately NOT a POST with a junk nonce: that would prove liveness too, and would write an
 * `auth.nonce_mismatch` warning into the user's terminal on every page load -- a login-CSRF alarm
 * raised by our own page.
 *
 * This cannot tell "dead" from "blocked by the browser", which is exactly why the WebKit gate runs
 * first and this never runs there.
 */
export async function probeListener(
  port: number,
  fetchImpl: typeof fetch = fetch,
): Promise<'alive' | 'unreachable'> {
  try {
    await fetchImpl(`http://127.0.0.1:${port}/`, { method: 'GET' });
    return 'alive';
  } catch {
    return 'unreachable';
  }
}

export interface SignInFailure {
  detail: string;
  /** Can the page itself do anything about it? Drives the retry button. */
  recoverable: boolean;
}

/**
 * Sign-in failures, and whether a retry button would do anything.
 *
 * The popup codes are kept even though redirect is now the default: `?popup=1` still reaches
 * signInWithPopup, and a stale tab can still be mid-popup when this ships.
 */
export function signInFailure(err: unknown): SignInFailure {
  const code = (err as { code?: string } | undefined)?.code ?? '';
  switch (code) {
    case 'auth/popup-closed-by-user':
      return { detail: 'The sign-in window was closed before it finished.', recoverable: true };
    case 'auth/cancelled-popup-request':
      return { detail: 'The sign-in window was replaced by another one.', recoverable: true };
    case 'auth/popup-blocked':
      // THE BUG FROM ORDER 0056. Still reachable via ?popup=1, and now it says the thing that is
      // actually true: press the button, this page will use a redirect instead. It does not ask
      // the user to go and change a browser setting.
      return {
        detail: 'Your browser blocked the sign-in popup. Trying again will use a full-page ' +
          'redirect instead, which browsers do not block.',
        recoverable: true,
      };
    case 'auth/network-request-failed':
      return { detail: 'The network request to Firebase failed.', recoverable: true };
    case 'auth/operation-not-allowed':
      // A project configuration problem. Retrying cannot enable a sign-in provider.
      return { detail: 'This sign-in method is not enabled on the Firebase project.', recoverable: false };
    case 'auth/unauthorized-domain':
      return {
        detail: 'This domain is not in the Firebase project\'s authorised domains.',
        recoverable: false,
      };
    default:
      // Unknown failures are treated as recoverable ON PURPOSE. Offering a button that might not
      // help costs a click; withholding one that would have helped strands the user, which is
      // exactly the dead end being fixed.
      return { detail: code || (err as Error)?.message || String(err), recoverable: true };
  }
}
