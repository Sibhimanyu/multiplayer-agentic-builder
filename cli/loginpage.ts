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
// just http://localhost:<port>/. It survives the Google round trip for free -- the redirect
// returns to that same URL and the server templates the same nonce again -- with no
// sessionStorage and nothing to lose in transit. It is now belt-and-braces rather than the only
// defence, because same-origin is doing the work the nonce used to do alone.

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
  :root{--paper:#FAF9F7;--card:#FFF;--ink:#1A1917;--ink2:#4A4741;--muted:#8A857C;
        --line:#E8E4DD;--line2:#D9D4CA;--teal:#0F766E;--red:#B91C1C;
        --sans:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
        --mono:ui-monospace,SFMono-Regular,Menlo,monospace;}
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--paper);color:var(--ink);font:14px/1.5 var(--sans);-webkit-font-smoothing:antialiased}
  .nav{background:var(--card);border-bottom:1px solid var(--line);padding:0 28px;height:60px;
       display:flex;align-items:center;gap:18px}
  .mark{width:26px;height:26px;border-radius:7px;background:var(--teal);color:#fff;
        display:grid;place-items:center;font-family:var(--mono);font-size:11px}
  .brand{font-size:16px;font-weight:600;letter-spacing:-.01em}
  .login{max-width:520px;padding:40px 28px;display:grid;gap:12px;justify-items:start}
  h2{font-size:20px;font-weight:600;letter-spacing:-.015em}
  h2.bad{color:var(--red)}
  p{color:var(--ink2);line-height:1.6}
  p.note{font-size:12.5px;color:var(--muted)}
  p.uid{font-family:var(--mono);font-size:11.5px;color:var(--muted)}
  code{font-family:var(--mono);font-size:12px;background:var(--paper);border:1px solid var(--line);
       border-radius:5px;padding:1px 5px}
  button{background:var(--teal);color:#fff;border:0;border-radius:8px;padding:9px 16px;
         font:500 13px var(--sans);cursor:pointer;margin-top:6px}
</style>
</head>
<body>
<nav class="nav"><div class="mark">FL</div><div class="brand">Flotilla</div></nav>
<div class="login" id="root" data-login-step="loading">
  <h2>Starting sign-in…</h2>
</div>
<script type="module">
import { initializeApp } from '${SDK_BASE}/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, getRedirectResult, signInAnonymously, signInWithRedirect,
} from '${SDK_BASE}/firebase-auth.js';

// Templated by the CLI that served this page. The nonce never travels in the URL, so there is
// nothing to lose across the redirect to Google and back.
const NONCE = ${js(opts.nonce)};
const ANONYMOUS = ${opts.anonymous ? 'true' : 'false'};
const app = initializeApp(${cfg});
const auth = getAuth(app);

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
  return [code || (e && e.message) || String(e), true];
}

async function start() {
  render('signing-in', ANONYMOUS
    ? '<h2>Signing in anonymously…</h2><p>No account needed.</p>'
    : '<h2>Taking you to Google…</h2><p>This page will come back on its own.</p>');
  try {
    if (ANONYMOUS) {
      await deliver((await signInAnonymously(auth)).user);
      return;
    }
    // REDIRECT, NOT POPUP. Safari blocks popups by default, which made the previous page a dead
    // end on first run. A top-level navigation is not blocked anywhere.
    await signInWithRedirect(auth, new GoogleAuthProvider());
  } catch (e) {
    const [detail, retry] = describe(e);
    fail('sign-in', detail, retry ? start : null);
  }
}

// The return leg. getRedirectResult is called on EVERY load -- it is what consumes a pending
// credential, and it resolves to null when there is nothing to consume.
try {
  const cred = await getRedirectResult(auth);
  if (cred && cred.user) {
    await deliver(cred.user);
  } else if (ANONYMOUS) {
    await start();
  } else {
    render('ready',
      '<h2>Sign in to Flotilla</h2>' +
      '<p>This connects the <code>flotilla</code> CLI waiting in your terminal. It is the only ' +
      'thing that will receive your credential.</p>' +
      '<button id="go">Continue with Google</button>' +
      '<p class="note">You will be sent to Google and brought back here.</p>');
    document.getElementById('go').onclick = start;
  }
} catch (e) {
  const [detail, retry] = describe(e);
  fail('coming back from Google', detail, retry ? start : null);
}
</script>
</body>
</html>
`;
}
