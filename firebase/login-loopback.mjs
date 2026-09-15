// The /login page against the REAL loopback listener. Order 0055.
//
// WHAT IS REAL AND WHAT IS STUBBED, stated up front because that is the whole value of this file:
//
//   REAL   the CLI's own startLoopback() from cli/auth.ts -- a socket on 127.0.0.1, its nonce
//          check, its 400/403/409 paths, its one-shot burn
//   REAL   the page's own parseLoginParams / payloadFor / postCredential from
//          client/src/login-contract.ts -- imported, not transcribed
//   REAL   an anonymous Firebase identity from the LIVE project, signed in through the web SDK
//          exactly as the page does, and the refresh token it returns is exchanged for an ID
//          token afterwards, so the credential handed over is proven usable rather than
//          proven present
//   STUBBED  nothing on the anonymous path.
//   STUBBED  the Google consent screen, on the Google path, which cannot be clicked by a program.
//            Everything either side of it is the same code the anonymous path runs, and the
//            payload shape is asserted against a Google-shaped user.
//
// The browser half -- that a page served over https may POST to http://127.0.0.1 at all -- is not
// decidable here, because node's fetch has no mixed-content policy. It is browser-specific and
// the two answers DISAGREE:
//   Chrome  allows it (firebase/login-browser.mjs)  -- loopback is a potentially trustworthy origin
//   WebKit  BLOCKS it (firebase/login-webkit.mjs)   -- it is treated as plain mixed content
// So everything below passing says nothing about whether a Safari user can log in.
//
//   node firebase/login-loopback.mjs
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { startLoopback, loopbackReady, mintIdToken, saveCredential, loadCredential, loginUrl }
  from '../cli/auth.ts';
import {
  PENDING_KEY, clearPendingLogin, initialLoginState, parseLoginParams, payloadFor, postCredential,
  looksLikeWebKit, readPendingLogin, signInFailure, stashPendingLogin,
} from '../client/src/login-contract.ts';

let failed = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed += 1;
};

const quiet = {
  info: () => {}, warn: () => {}, error: () => {}, debug: () => {},
};
const warnings = [];
const log = { ...quiet, warn: (code, msg) => warnings.push(code) };

const env = Object.fromEntries(
  (await fs.readFile('client/.env.local', 'utf8')).split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const API_KEY = env.VITE_FIREBASE_API_KEY;
const PROJECT = env.VITE_FIREBASE_PROJECT_ID;

console.log('LOGIN LOOPBACK -- the page\'s contract against the CLI\'s real listener\n');

// ============================================================ 1. parsing the CLI's own URL
console.log('1. the page reads the link the CLI actually opens');
{
  // Not a hand-written URL: built by loginUrl() from cli/auth.ts, plus the &provider= that
  // firebase/flotilla-main.ts appends. If either side changes its spelling this fails, which is
  // the point -- the two halves were written months apart and never met.
  const nonce = 'x'.repeat(43);
  const url = new URL(`${loginUrl('https://example.web.app', 51234, nonce)}&provider=google`);
  const parsed = parseLoginParams(url.search);
  check(parsed.ok, 'loginUrl() output parses');
  check(parsed.ok && parsed.params.port === 51234, `port read as ${parsed.ok ? parsed.params.port : '-'}`);
  check(parsed.ok && parsed.params.nonce === nonce, 'nonce read verbatim');
  check(parsed.ok && parsed.params.anonymous === false, 'provider=google is not anonymous');

  const anon = parseLoginParams(new URL(
    `${loginUrl('https://example.web.app', 51234, nonce)}&provider=anonymous`,
  ).search);
  check(anon.ok && anon.params.anonymous === true, 'provider=anonymous is anonymous');
  const anon1 = parseLoginParams(`?port=1&nonce=${nonce}&anonymous=1`);
  check(anon1.ok && anon1.params.anonymous === true, 'anonymous=1 is also honoured');
}

// ============================================================ 2. the refusal to guess a port
console.log('\n2. a link it cannot read becomes an error, never a guessed port');
{
  const nonce = 'y'.repeat(43);
  const bad = [
    ['', 'no query string at all'],
    [`?nonce=${nonce}`, 'nonce but no port'],
    ['?port=51234', 'port but no nonce'],
    [`?port=&nonce=${nonce}`, 'empty port'],
    [`?port=abc&nonce=${nonce}`, 'non-numeric port'],
    [`?port=0&nonce=${nonce}`, 'port 0'],
    [`?port=70000&nonce=${nonce}`, 'port out of range'],
    [`?port=51234.5&nonce=${nonce}`, 'fractional port'],
    ['?port=51234&nonce=short', 'truncated nonce'],
    ['?port=51234&nonce=' + '!'.repeat(43), 'nonce outside the alphabet'],
  ];
  for (const [search, label] of bad) {
    const r = parseLoginParams(search);
    check(!r.ok, `rejected: ${label}`);
    // And the rejection reaches the SCREEN. A parse that returns an error the page then renders
    // as a spinner is the original bug wearing a different hat.
    const state = initialLoginState(search);
    check(
      state.step === 'error' && state.at === 'the login link' && state.detail.length > 0,
      `  → first frame is a named error, not a spinner (${state.step === 'error' ? state.detail : state.step})`,
    );
  }
  // THE CONTROL. Every rejection above is worthless unless the same function accepts a real link.
  const good = initialLoginState(`?port=51234&nonce=${nonce}&provider=google`);
  check(good.step === 'ready', 'and a well-formed link is accepted (the control)');
}

// ============================================================ 3. a real anonymous identity
console.log('\n3. a REAL anonymous identity, signed in the way the page signs in');
const { initializeApp } = await import('../client/node_modules/firebase/app/dist/index.mjs')
  .catch(() => import('firebase/app'));
const authMod = await import('../client/node_modules/firebase/auth/dist/index.mjs')
  .catch(() => import('firebase/auth'));

const app = initializeApp({ apiKey: API_KEY, projectId: PROJECT, appId: env.VITE_FIREBASE_APP_ID,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN }, `login-${Date.now()}`);
const auth = authMod.getAuth(app);
const cred = await authMod.signInAnonymously(auth);
const user = cred.user;
check(!!user.uid, `signed in anonymously as ${user.uid}`);
check(!!user.refreshToken, 'the SDK issued a refresh token');

// ============================================================ 4. end to end, nothing stubbed
console.log('\n4. ANONYMOUS END TO END -- real sign-in → real payload → real listener');
const HOME = path.join(os.tmpdir(), `flotilla-login-${Date.now().toString(36)}`);
{
  const lb = startLoopback({ log, timeout_ms: 30_000 });
  const port = await loopbackReady(lb);
  check(port > 0, `the CLI's listener is up on 127.0.0.1:${port}`);

  // The page's own parse, of the URL the CLI's own builder produced.
  const parsed = parseLoginParams(
    new URL(`${loginUrl('https://example.web.app', port, lb.nonce)}&provider=anonymous`).search,
  );
  check(parsed.ok && parsed.params.anonymous, 'the page parses it as an anonymous login');

  // ---- the negative, BEFORE the real response, so it also proves the listener survives it ----
  const hostile = await postCredential(port, {
    nonce: 'z'.repeat(43), refresh_token: 'attacker', id_token: 'attacker', uid: 'attacker',
  });
  check(!hostile.ok && hostile.status === 403, `a wrong nonce is refused 403 (got ${hostile.status})`);
  check(warnings.includes('auth.nonce_mismatch'), 'and the CLI logged auth.nonce_mismatch');

  // A malformed-but-authentic attempt: right nonce, nothing usable. 400, and the nonce is NOT
  // burned, so the real response still works.
  const empty = await postCredential(port, {
    nonce: lb.nonce, refresh_token: '', id_token: '', uid: '',
  });
  check(!empty.ok && empty.status === 400, `a credential with no uid is refused 400 (got ${empty.status})`);

  // THE CONTROL ON "VERBATIM". Asserting the nonce is copied unchanged means nothing unless a
  // changed one would actually be refused -- so prove the listener is that strict. A nonce
  // differing only by a trailing newline, and one differing only by case, are both rejected.
  for (const [mutant, label] of [
    [`${lb.nonce}\n`, 'a trailing newline'],
    [lb.nonce.replace(/[a-z]/, (c) => c.toUpperCase()), 'one letter re-cased'],
  ]) {
    if (mutant === lb.nonce) continue;
    const r = await postCredential(port, { nonce: mutant, refresh_token: 'r', id_token: 'i', uid: 'u' });
    check(!r.ok && r.status === 403, `a nonce differing by ${label} is refused 403`);
  }

  // ---- the real thing ----
  const payload = await payloadFor(parsed.params.nonce, user);
  check(payload.nonce === lb.nonce, 'the payload echoes the nonce VERBATIM');
  check(payload.uid === user.uid && !!payload.refresh_token && !!payload.id_token,
    'the payload carries uid, refresh_token and id_token');
  check(!('email' in payload), 'and no email key at all for an anonymous user');

  const out = await postCredential(port, payload);
  check(out.ok, `the CLI accepted it (${out.ok ? '200' : `${out.status}: ${out.reason}`})`);

  // THE LISTENER STAYED ALIVE THROUGH TWO REFUSALS. Asserted on the RESULT PROMISE -- what the
  // CLI actually goes on to use -- not on the HTTP status, because a 200 the CLI never acts on
  // would look identical from the outside.
  const got = await Promise.race([
    lb.result,
    new Promise((_, rej) => setTimeout(() => rej(new Error('the CLI never resolved')), 5_000)),
  ]);
  check(got.uid === user.uid, `\`flotilla login\` resolved with the same uid (${got.uid})`);
  check(got.refresh_token === user.refreshToken, 'and with the refresh token the browser held');

  // ---- replay ----
  const replay = await postCredential(port, payload);
  check(!replay.ok && replay.status === 409, `a replay of the SAME valid response is refused 409 (got ${replay.status})`);
  check(warnings.includes('auth.nonce_replayed'), 'and the CLI logged auth.nonce_replayed');
  lb.close();

  // ---- the credential is USABLE, not merely present ----
  //
  // The assertion that would have caught a page posting a placeholder: store what arrived and
  // exchange it at Google's token endpoint. A refresh token that cannot be refreshed is a login
  // that fails an hour later, somewhere else, looking like a permissions bug.
  await saveCredential({
    refresh_token: got.refresh_token, uid: got.uid, project_id: PROJECT,
    obtained_at: new Date().toISOString(),
  }, HOME);
  const stored = await loadCredential(HOME);
  check(stored?.uid === user.uid, 'the CLI stored the identity it was handed');
  const minted = await mintIdToken(stored, API_KEY);
  check(!!minted.id_token, 'and minted a fresh ID token from it against securetoken.googleapis.com');
  const claims = JSON.parse(Buffer.from(minted.id_token.split('.')[1], 'base64url').toString());
  check(claims.user_id === user.uid || claims.sub === user.uid,
    `the minted token's own claims name the same uid (${claims.user_id ?? claims.sub})`);
  check(claims.aud === PROJECT, `and the right project (${claims.aud})`);
}

// ============================================================ 5. the Google path, either side
console.log('\n5. the GOOGLE path -- everything except the consent screen');
{
  const lb = startLoopback({ log, timeout_ms: 30_000 });
  const port = await loopbackReady(lb);
  const parsed = parseLoginParams(
    new URL(`${loginUrl('https://example.web.app', port, lb.nonce)}&provider=google`).search,
  );
  check(parsed.ok && !parsed.params.anonymous, 'parsed as a Google login');

  // The one stubbed step. Shaped like what signInWithPopup returns: a user WITH an email, which
  // the anonymous path never exercises.
  const googleUser = {
    uid: 'google_uid_fixture', email: 'someone@example.com', refreshToken: 'AMf-fixture-refresh',
    getIdToken: async () => 'header.eyJzdWIiOiJnb29nbGUifQ.sig',
  };
  const payload = await payloadFor(parsed.params.nonce, googleUser);
  check(payload.email === 'someone@example.com', 'the email is carried through for a Google user');
  check(payload.nonce === lb.nonce, 'the nonce is echoed verbatim on this path too');

  const out = await postCredential(port, payload);
  check(out.ok, 'the REAL listener accepts a Google-shaped payload');
  const got = await lb.result;
  check(got.email === 'someone@example.com' && got.uid === 'google_uid_fixture',
    'and the CLI receives the email and uid');
  lb.close();
}

// ============================================================ 6. the CLI is gone
console.log('\n6. when the CLI has stopped waiting, the page says so');
{
  const lb = startLoopback({ log, timeout_ms: 1_000 });
  const port = await loopbackReady(lb);
  lb.close();
  await new Promise((r) => setTimeout(r, 100));
  const out = await postCredential(port, {
    nonce: 'q'.repeat(43), refresh_token: 'r', id_token: 'i', uid: 'u',
  });
  check(!out.ok && out.status === null, 'a dead listener is a transport failure, not a silent success');
  check(/stopped waiting/.test(out.reason), 'and names the CLI having stopped as a cause');
  // BOTH causes, always. The fetch failure is identical whether the CLI exited or WebKit blocked
  // the request as mixed content, and printing only one sends half of all users to re-run a
  // command that cannot work in their browser.
  check(/Chrome/.test(out.reason) && /https page to http:\/\/127\.0\.0\.1/.test(out.reason),
    'and names the browser blocking it as the other, with what to do about it');

  // Which explanation comes FIRST follows the user agent. It only reorders; nothing is hidden.
  const safariUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 '
    + '(KHTML, like Gecko) Version/18.5 Safari/605.1.15';
  const chromeUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
    + '(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';
  check(looksLikeWebKit(safariUA), 'Safari is detected as WebKit');
  check(!looksLikeWebKit(chromeUA),
    'and Chrome on macOS is NOT, despite carrying "Safari" and "AppleWebKit" in its UA');
  const inSafari = await postCredential(port, { nonce: 'q'.repeat(43), refresh_token: 'r', id_token: 'i', uid: 'u' }, fetch, safariUA);
  const inChrome = await postCredential(port, { nonce: 'q'.repeat(43), refresh_token: 'r', id_token: 'i', uid: 'u' }, fetch, chromeUA);
  check(inSafari.reason.indexOf('blocked') < inSafari.reason.indexOf('stopped waiting'),
    'in Safari the browser-blocked explanation comes first');
  check(inChrome.reason.indexOf('stopped waiting') < inChrome.reason.indexOf('blocked'),
    'in Chrome the CLI-stopped explanation comes first');
  // The command to re-run is no longer in this string. It belongs to the RENDER, which shows it
  // only on failures a retry cannot fix -- putting it here as well would have printed "run
  // flotilla login" next to a Try again button on recoverable failures too.
  check(out.recoverable === false, 'and is marked unrecoverable, so the page names the command instead');
  lb.result.catch(() => {});
}

// ============================================================ 7. failure messages exist
console.log('\n7. every sign-in failure has words, and says whether a retry would help');
for (const [code, expect, recoverable] of [
  ['auth/popup-closed-by-user', /closed/i, true],
  ['auth/popup-blocked', /redirect/i, true],
  ['auth/network-request-failed', /network/i, true],
  ['auth/operation-not-allowed', /not enabled/i, false],
  ['auth/unauthorized-domain', /authorised domains/i, false],
]) {
  const f = signInFailure({ code });
  check(expect.test(f.detail), `${code} → "${f.detail}"`);
  check(f.recoverable === recoverable,
    `  → ${recoverable ? 'offers a retry' : 'does NOT offer a retry (a button could not fix it)'}`);
}
{
  const f = signInFailure(new Error('network fell over'));
  check(f.detail.length > 0, 'an unknown failure still says something');
  // Unknown failures lean toward offering the button: a click that may not help costs little,
  // stranding the user is the bug being fixed.
  check(f.recoverable === true, 'and still offers a way forward');
}

// ============================================================ 8. surviving the redirect
//
// ORDER 0056'S CENTRAL RISK. signInWithRedirect unloads this page; Google brings the browser back
// to /login with ITS OWN query string, so the CLI's port and nonce are gone from the URL. If they
// do not survive, a working login returns as "malformed nonce" -- a worse bug than the blocked
// popup, because it reads as the CLI's fault.
//
// Simulated exactly that way: stash, then throw the URL away and replace it with Google's.
console.log('\n8. the port and nonce survive the round trip to Google');
{
  // A real sessionStorage, minus the browser: the same three methods the page uses.
  const makeStore = () => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      _map: m,
    };
  };

  const store = makeStore();
  const lb = startLoopback({ log, timeout_ms: 10_000 });
  const port = await loopbackReady(lb);

  // --- outbound leg: the CLI's URL ---
  const outbound = new URL(`${loginUrl('https://example.web.app', port, lb.nonce)}&provider=google`).search;
  const before = initialLoginState(outbound, store);
  check(before.step === 'ready', 'outbound: the CLI\'s link renders the sign-in button');
  stashPendingLogin(store, before.params);
  check(!!store.getItem(PENDING_KEY), 'the port and nonce are stashed BEFORE the navigation');

  // --- Google's return leg. The CLI's query string is GONE. ---
  //
  // This is what Firebase's redirect handler actually comes back with.
  const googles = '?state=AMbdmDl7&code=4/0AeanS0abc&scope=email%20profile&authuser=0&prompt=consent';
  check(!parseLoginParams(googles).ok, 'Google\'s own query string does NOT parse as a login link');

  const after = initialLoginState(googles, store);
  check(after.step === 'returning', `the page knows it is a return leg, not a bad link (${after.step})`);
  check(after.params.port === port, `the port survived (${after.params.port})`);
  check(after.params.nonce === lb.nonce, 'and the nonce survived VERBATIM');
  check(after.params.anonymous === false && after.params.popup === false, 'along with the provider choice');

  // THE POINT OF ALL OF IT: the restored nonce is one the REAL CLI accepts. Asserted against the
  // listener rather than against the string it was stashed from -- comparing the value to itself
  // would pass even if both halves were wrong.
  const out = await postCredential(after.params.port, {
    nonce: after.params.nonce, refresh_token: 'r_after_redirect', id_token: 'i', uid: 'u_after_redirect',
  });
  check(out.ok, `the CLI accepts the restored nonce (${out.ok ? '200' : out.status})`);
  const got = await lb.result;
  check(got.uid === 'u_after_redirect', 'and resolves the login the redirect started');
  lb.close();

  clearPendingLogin(store);
  check(store.getItem(PENDING_KEY) === null, 'the stash is cleared once the credential is delivered');

  // THE CONTROL. All of the above is vacuous unless a MISSING stash actually fails -- otherwise
  // the "returning" state could be arriving from somewhere else entirely.
  const cold = initialLoginState(googles, makeStore());
  check(cold.step === 'error', 'with nothing stashed, Google\'s query string IS an error (the control)');
  check(!cold.params, 'and that error offers no retry, because there is no nonce to retry with');

  // A stash that is corrupt must fail like a bad URL, not be trusted. sessionStorage is writable
  // by anything on this origin.
  for (const [bad, label] of [
    ['not json at all', 'unparseable'],
    ['{"port":0,"nonce":"' + 'n'.repeat(43) + '"}', 'port 0'],
    ['{"port":51234,"nonce":"short"}', 'truncated nonce'],
    ['{"port":"../../etc","nonce":"' + 'n'.repeat(43) + '"}', 'a non-numeric port'],
  ]) {
    const s = makeStore();
    s.setItem(PENDING_KEY, bad);
    check(readPendingLogin(s) === null, `a corrupt stash is refused: ${label}`);
  }
  // Control: the same reader accepts a good one.
  const good = makeStore();
  stashPendingLogin(good, { port: 51234, nonce: 'n'.repeat(43), anonymous: false, popup: false });
  check(readPendingLogin(good)?.port === 51234, 'and a well-formed stash is read back (the control)');
}

// ============================================================ 9. the dead end is gone
//
// Order 0056 in one assertion: the failure that stranded the user now carries what a retry needs,
// and the failures a retry cannot fix still do not pretend otherwise.
console.log('\n9. every failure either offers a retry or explains why it cannot');
{
  const params = { port: 51234, nonce: 'p'.repeat(43), anonymous: false, popup: false };
  const blocked = signInFailure({ code: 'auth/popup-blocked' });
  check(blocked.recoverable, 'a blocked popup is recoverable IN THE PAGE (it was a dead end)');
  check(/redirect/i.test(blocked.detail) && !/allow popups/i.test(blocked.detail),
    'and no longer tells the user to go and change a browser setting');

  const lb = startLoopback({ log, timeout_ms: 10_000 });
  const p = await loopbackReady(lb);
  const spent = await postCredential(p, { nonce: 'w'.repeat(43), refresh_token: 'r', id_token: 'i', uid: 'u' });
  check(spent.status === 403 && spent.recoverable === false,
    'a rejected nonce is NOT recoverable -- a retry button there could never work');
  const unusable = await postCredential(p, { nonce: lb.nonce, refresh_token: '', id_token: '', uid: '' });
  check(unusable.status === 400 && unusable.recoverable === true,
    'a 400 IS recoverable -- the CLI deliberately does not burn the nonce on that path');
  lb.close();
  lb.result.catch(() => {});

  const dead = await postCredential(p, { nonce: lb.nonce, refresh_token: 'r', id_token: 'i', uid: 'u' });
  check(dead.status === null && dead.recoverable === false,
    'a CLI that has stopped waiting is NOT recoverable in the browser');
  void params;
}

await fs.rm(HOME, { recursive: true, force: true });
await authMod.signOut(auth).catch(() => {});
console.log(`\n${failed === 0 ? 'LOOPBACK VERIFIED' : `FAILED (${failed})`}`);
process.exit(failed === 0 ? 0 : 1);
