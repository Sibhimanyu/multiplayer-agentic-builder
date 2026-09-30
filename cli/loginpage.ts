// The login page the CLI serves itself, on http://localhost:<port>/. Order 0057.
//
// WHY THE CLI SERVES THIS AT ALL. The hosted board is https, and the credential handoff it made
// was a POST to http://127.0.0.1 -- mixed content. Chrome permits that because loopback is a
// potentially trustworthy origin under Secure Contexts; WEBKIT DOES NOT IMPLEMENT THAT CARVE-OUT
// and blocks it outright, measured in firebase/login-webkit.mjs. So the handoff could not work in
// Safari, the default browser on macOS.
//
// There is no mixed content if there is no https page in the flow:
//
//   - the page is served over http, by the CLI, on its own random port
//   - the Firebase Web SDK is fetched from the CDN over https, which is an UPGRADE rather than a
//     downgrade and is permitted in every engine
//   - the credential is POSTed back SAME-ORIGIN, http to http, so no engine has an opinion about it
//
// This is the shape `firebase login` and `gh auth login` use, for this reason.
//
// localhost, NOT 127.0.0.1. Firebase Auth's authorized-domain list holds `localhost`, and the
// check compares HOSTNAMES -- `127.0.0.1` is a different string to it and is rejected with
// auth/unauthorized-domain. Measured both ways, with the rejection as the control, in
// firebase/localhost-probe.mjs. The port is not part of the comparison, which is what makes a
// random port per run safe.
//
// THE NONCE IS NOT IN THE URL. The server templates it into the page it serves, so the URL is
// just http://localhost:<port>/. It is belt-and-braces now rather than the only defence, because
// same-origin is doing the work the nonce used to do alone.
//
// POPUP, NOT REDIRECT -- order 0059, and it reverses order 0056 for a measured reason.
// signInWithRedirect stores its pending state on the authDomain origin and reads it back
// cross-origin on return; Safari's ITP blocks that read, so getRedirectResult came back with no
// user and this page quietly returned to its own sign-in screen. A page on localhost with a random
// port can never be same-origin with authDomain, so redirect cannot be fixed here. See the click
// handler for the gesture rules popup brings with it.

/** Pinned. A floating version would change the page under a user without the CLI changing. */
export const SDK_VERSION = '11.0.2';
export const SDK_BASE = `https://www.gstatic.com/firebasejs/${SDK_VERSION}`;

export interface LoginPageOptions {
  api_key: string;
  auth_domain: string;
  project_id: string;
  app_id?: string;
  /** Echoed back by the page, exactly as given. */
  nonce: string;
  anonymous: boolean;
}

/**
 * Serialise a value for embedding inside a <script> element.
 *
 * JSON.stringify IS NOT ENOUGH, which a test caught rather than a review. It escapes quotes, so
 * the value cannot break out of the JS string -- but `</script>` inside a JSON string still ends
 * the HTML element, because the parser looks for that sequence before JavaScript is ever parsed.
 * A project id of `a"</script><script>…` therefore ran as script.
 *
 * These values come from ~/.flotilla/config.json, so today the only person who can exploit it is
 * the person running the CLI. That is an argument for the severity, not for leaving it: this page
 * grows, and the next value templated in may not be self-supplied.
 *
 * Escaping `<` covers it, and U+2028/U+2029 are escaped too -- valid in JSON, line terminators in
 * JavaScript.
 */
// Built from char codes rather than written as a regex literal. Writing U+2028 literally in a
// regex literal is itself a syntax error -- it IS a line terminator, so it ends the literal.
const LINE_SEPARATORS = new RegExp(`[${String.fromCharCode(0x2028, 0x2029)}]`, 'g');

function js(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(LINE_SEPARATORS, (c) => `\\u${c.charCodeAt(0).toString(16)}`);
}

/** The page, as a string. Pure, so the ARTIFACT can be asserted rather than the intent. */
export function loginPageHtml(opts: LoginPageOptions): string {
  const cfg = js({
    apiKey: opts.api_key,
    authDomain: opts.auth_domain,
    projectId: opts.project_id,
    ...(opts.app_id ? { appId: opts.app_id } : {}),
  });

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in to Flotilla</title>
<style>
  /* DESIGN.md "Graphite", the same values as client/src/tokens.css. This page used to be the last
     surface still in the retired cream-and-teal light theme -- a third look, one click from a
     dark board and a dark chat page, which DESIGN.md counts as a bug.
     THE ONE KNOWN DIVERGENCE: the loopback server that serves this page serves nothing else, so
     Plex is named but not shipped here and the page falls back to the system sans unless Plex is
     installed. Serving the two font files is a change to the server, not to this page. */
  :root{--paper:#121212;--card:#1A1A1A;--raise:#232323;
        --ink:#EDEDED;--ink2:#B8B8B8;--muted:#8C8C8C;
        --line:#262626;--line2:#363636;--line3:#4A4A4A;
        --inverse:#EDEDED;--on-inverse:#121212;--inverse-hover:#FFFFFF;--red:#E5877E;
        --sans:'IBM Plex Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
        --mono:'IBM Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
        --t-0:11px;--t-1:12px;--t-2:14px;--t-4:18px;--t-5:21px;
        --sp-1:2px;--sp-2:4px;--sp-3:6px;--sp-4:8px;--sp-5:12px;--sp-6:16px;--sp-7:24px;--sp-9:48px;
        --r-ctl:8px;--r-tag:5px;color-scheme:dark}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--paper);color:var(--ink);font:var(--t-2)/1.5 var(--sans);-webkit-font-smoothing:antialiased}
  ::selection{background:rgba(237,237,237,.22);color:var(--ink)}
  :where(a,button):focus-visible{outline:2px solid var(--ink);outline-offset:2px}
  .nav{background:var(--card);border-bottom:1px solid var(--line);padding:0 var(--sp-7);height:60px;
       display:flex;align-items:center;gap:var(--sp-4)}
  /* The real mark, in ink, with its viewBox padding cancelled (DESIGN.md "Logo spacing"). It was a
     teal rounded square with "FL" in it -- a logo that exists nowhere else. */
  .mark{--mark-w:36px;width:var(--mark-w);height:29px;flex:none;color:var(--ink);
        margin-left:calc(var(--mark-w) * -.091);margin-right:calc(var(--mark-w) * -.18)}
  .brand{font-size:var(--t-4);font-weight:600;letter-spacing:-.015em;line-height:1}
  .login{max-width:560px;padding:var(--sp-9) var(--sp-7);display:grid;gap:var(--sp-5);justify-items:start}
  h2{font-size:var(--t-5);font-weight:600;letter-spacing:-.015em;line-height:1.2}
  h2.bad{color:var(--red)}
  p{color:var(--ink2);line-height:1.6}
  p strong{color:var(--ink);font-weight:600}
  p.note{font-size:var(--t-1);color:var(--muted)}
  p.uid{font-family:var(--mono);font-size:var(--t-0);color:var(--muted)}
  code{font-family:var(--mono);font-size:var(--t-1);color:var(--ink);background:var(--raise);
       border:1px solid var(--line2);border-radius:var(--r-tag);padding:var(--sp-1) var(--sp-2)}
  /* The primary is the inversion: near-white, ground-coloured label, 16.00:1. */
  button{background:var(--inverse);color:var(--on-inverse);border:0;border-radius:var(--r-ctl);
         padding:var(--sp-4) var(--sp-6);font:600 var(--t-2) var(--sans);cursor:pointer;
         margin-top:var(--sp-3);transition:background 160ms cubic-bezier(.2,0,.2,1)}
  button:hover{background:var(--inverse-hover)}
</style>
</head>
<body>
<nav class="nav"><svg class="mark" viewBox="0 0 520 420" aria-hidden="true"><g fill="currentColor" transform="rotate(-7 260 210)"><path transform="translate(0 -12)" d="M184 39C245 46 346 75 429 112C442 118 444 128 430 135C376 164 311 185 249 199C235 202 231 193 239 181C259 151 266 121 256 94C246 68 220 50 184 39Z"/><path transform="translate(-4 6)" d="M86 143C132 151 198 173 239 193C250 198 250 207 239 213C192 238 139 261 54 281C41 284 37 275 46 264C75 235 98 211 101 188C103 170 98 155 86 143Z"/><path transform="translate(0 12)" d="M190 245C233 253 290 274 326 293C337 299 337 307 326 313C287 336 243 353 176 369C163 372 159 363 168 352C192 326 210 304 212 284C213 268 207 254 190 245Z"/></g></svg><div class="brand">Flotilla</div></nav>
<div class="login" id="root" data-login-step="loading">
  <h2>Starting sign-in…</h2>
</div>
<script type="module">
import { initializeApp } from '${SDK_BASE}/firebase-app.js';
import {
  GoogleAuthProvider, browserPopupRedirectResolver, inMemoryPersistence, initializeAuth,
  signInAnonymously, signInWithPopup,
} from '${SDK_BASE}/firebase-auth.js';

// Templated by the CLI that served this page. The nonce never travels in the URL.
const NONCE = ${js(opts.nonce)};
const ANONYMOUS = ${opts.anonymous ? 'true' : 'false'};
const app = initializeApp(${cfg});

// initializeAuth, NOT getAuth, and the arguments are the point.
//
// popupRedirectResolver EAGERLY: getAuth resolves it lazily, on the first signInWithPopup call --
// which is to say, between the user's click and window.open. Measured: with the lazy resolver,
// Chromium opened the window in a LATER TASK than the click (duringClick=false). Safari attributes
// a popup to a gesture only while the click is still being handled, so that gap is the whole
// defect this order is about. Initialising here moves the work to page load, where nothing is
// waiting on a gesture.
//
// inMemoryPersistence: this page signs in once and hands the credential to the CLI. Persisting
// would add an IndexedDB round trip to the same critical path, and would leave a signed-in Firebase
// session in the browser of someone who was only authorising a terminal.
const auth = initializeAuth(app, {
  persistence: inMemoryPersistence,
  popupRedirectResolver: browserPopupRedirectResolver,
});

const root = document.getElementById('root');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function render(step, html) {
  root.dataset.loginStep = step;
  root.innerHTML = html;
}
// Every failure says WHICH STEP, and whether the page itself can do anything about it. A retry
// button that cannot work is the dead end order 0056 removed; so is telling someone to go to a
// terminal when a button would have done.
function fail(at, detail, retry) {
  render('error',
    '<h2 class="bad">Login failed at ' + esc(at) + '.</h2><p>' + esc(detail) + '</p>' +
    (retry
      ? '<button id="retry">Try again</button>'
      : '<p>This one cannot be retried from here. Start a new login in your terminal with ' +
        '<code>flotilla login</code>.</p>'));
  if (retry) document.getElementById('retry').onclick = retry;
}

async function deliver(user) {
  render('posting', '<h2>Handing the credential to the CLI…</h2>' +
    '<p>Posting to this same page\\u2019s own address.</p>');
  let id_token = '';
  try { id_token = await user.getIdToken(); } catch (e) { /* reported below if it matters */ }
  if (!user.refreshToken || !user.uid) {
    fail('sign-in', 'Signed in, but no refresh token was issued.', start);
    return;
  }
  // SAME ORIGIN. http -> http, to the very server that served this page. This is the whole point
  // of order 0057: no engine has a mixed-content opinion about it.
  let res;
  try {
    res = await fetch('/callback', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        nonce: NONCE, refresh_token: user.refreshToken, id_token,
        uid: user.uid, ...(user.email ? { email: user.email } : {}),
      }),
    });
  } catch (e) {
    fail('handing the credential to the CLI',
      'Could not reach the CLI on this page\\u2019s own address. It has probably stopped waiting. ('
      + (e && e.message ? e.message : e) + ')', null);
    return;
  }
  if (res.status === 409) {
    fail('handing the credential to the CLI', 'That login was already completed. You can close this tab.', null);
    return;
  }
  if (res.status === 403) {
    fail('handing the credential to the CLI', 'The CLI rejected the nonce. This page is stale — start a new login.', null);
    return;
  }
  if (!res.ok) {
    // 400 leaves the nonce unburned by design, so a retry genuinely can work.
    fail('handing the credential to the CLI', 'The CLI refused the credential (HTTP ' + res.status + ').', start);
    return;
  }
  render('done',
    '<h2>Signed in' + (user.email ? ' as ' + esc(user.email) : '') + '.</h2>' +
    '<p>Your CLI has the credential. <strong>You can close this tab.</strong></p>' +
    '<p class="uid"><code>' + esc(user.uid) + '</code></p>');
}

function describe(e) {
  const code = (e && e.code) || '';
  if (code === 'auth/unauthorized-domain') {
    return ['This page\\u2019s address is not an authorised domain on the Firebase project. '
      + 'It must be reached as localhost, not 127.0.0.1.', false];
  }
  if (code === 'auth/operation-not-allowed') {
    return ['This sign-in method is not enabled on the Firebase project.', false];
  }
  if (code === 'auth/network-request-failed') return ['The network request to Firebase failed.', true];
  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
    return ['The Google window was closed before sign-in finished.', true];
  }
  if (code === 'auth/popup-blocked') {
    // A retry IS worth offering: the retry click is itself a fresh gesture, and a browser that
    // refused the first popup often allows one it can attribute to a deliberate second click.
    // The escape is named too, because "allow popups and try again" alone is the dead end order
    // 0056 removed -- and --hosted is a path that has actually been verified.
    return ['Your browser blocked the sign-in window. Try again, or run '
      + 'flotilla login --hosted, which signs in on the Flotilla board instead.', true];
  }
  return [code || (e && e.message) || String(e), true];
}

// Built ONCE, at load. Constructing it inside the click handler would be one more statement
// between the gesture and the popup for no reason.
const provider = new GoogleAuthProvider();

async function startAnonymous() {
  render('signing-in', '<h2>Signing in anonymously…</h2><p>No account needed.</p>');
  try {
    await deliver((await signInAnonymously(auth)).user);
  } catch (e) {
    const [detail, retry] = describe(e);
    fail('sign-in', detail, retry ? startAnonymous : null);
  }
}

/**
 * THE CLICK HANDLER. NOT async, AND signInWithPopup IS THE FIRST STATEMENT.
 *
 * Safari does not block popups by policy -- it blocks popups that are not tied to a user gesture.
 * A click IS a gesture, but the browser only credits it while the click is still being handled, so
 * ANY await before the call spends it and the popup is refused for having lost its cause.
 *
 * That is why this function is not async and never awaits: it starts the popup, and only then
 * touches the DOM and attaches continuations. Written this way so the property is structural
 * rather than remembered -- firebase/login-local.mjs asserts both that nothing is awaited before
 * this call, and, in a real browser, that window.open happens in the click's own task.
 *
 * The other half of the same problem is inside the SDK: signInWithPopup waits for the Auth
 * instance to finish initialising before it opens the window, and if that has not happened yet the
 * wait lands between the gesture and window.open. So initialisation is forced at page load, below,
 * BEFORE this button exists to be pressed.
 */
function onGoogleClick() {
  const pending = signInWithPopup(auth, provider); // nothing above this line, deliberately
  render('signing-in', '<h2>Waiting for Google…</h2>'
    + '<p>Finish in the window that just opened. This page will take it from there.</p>');
  pending
    .then((cred) => deliver(cred.user))
    .catch((e) => {
      const [detail, retry] = describe(e);
      fail('sign-in', detail, retry ? onGoogleClick : null);
    });
}

// POPUP HERE, REDIRECT ON THE HOSTED PAGE, and the difference is not a preference.
//
// signInWithRedirect parks its pending state on the authDomain origin and must read it back
// cross-origin on return. Safari's ITP blocks that read, so getRedirectResult resolves with no
// user and the page returns to its own sign-in screen having apparently done nothing. A page
// served from localhost on a random port can NEVER be same-origin with authDomain, so redirect
// cannot be made to work here -- it is the wrong primitive for this page, exactly as popup was
// the wrong primitive for the hosted one.
//
// The hosted board at /login IS same-origin with authDomain, so it keeps redirect.
try {
  // Forces the Auth instance to finish initialising while nobody is waiting on a gesture. The
  // button is rendered only after this resolves, so by the time it can be pressed the SDK has
  // nothing left to await before opening the window.
  await auth.authStateReady();

  if (ANONYMOUS) {
    await startAnonymous();
  } else {
    render('ready',
      '<h2>Sign in to Flotilla</h2>' +
      '<p>This connects the <code>flotilla</code> CLI waiting in your terminal. It is the only ' +
      'thing that will receive your credential.</p>' +
      '<button id="go">Continue with Google</button>' +
      '<p class="note">A Google window will open. This page stays open behind it.</p>');
    document.getElementById('go').onclick = onGoogleClick;
  }
} catch (e) {
  const [detail, retry] = describe(e);
  fail('starting sign-in', detail, retry ? onGoogleClick : null);
}
</script>
</body>
</html>
`;
}
