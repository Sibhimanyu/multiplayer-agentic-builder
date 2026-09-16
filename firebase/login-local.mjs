// The CLI-SERVED login page, in real browsers. Order 0057.
//
// THE POINT OF THE REDESIGN: there is no https page in the flow, so no engine sees mixed content.
// The previous design had the hosted board (https) POST to http://127.0.0.1, which Chrome allows
// and WEBKIT BLOCKS -- so it could not work in Safari at all. That measurement is in
// firebase/login-webkit.mjs and it is why this file exists.
//
// ENGINES DRIVEN HERE: Chromium (puppeteer) and WebKit (playwright). Both, every section, because
// the whole reason this rewrite happened is that one engine passed and the other did not, and a
// single-engine green run is exactly the signal that misled order 0055.
//
// NOT DRIVEN: Safari.app -- safaridriver needs an administrator password to enable. WebKit is the
// engine Safari is built from, which settles engine-level questions like mixed content, and does
// not settle Safari's own popup default or ITP. firebase/login-safari.mjs runs the moment that
// authorisation is given.
//
//   node firebase/login-local.mjs
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  loadCredential, localLoginUrl, loopbackReady, mintIdToken, saveCredential, startLoopback,
} from '../cli/auth.ts';
import { SDK_BASE, loginPageHtml } from '../cli/loginpage.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, '..', 'client', 'edge', 'shots');
await fs.mkdir(OUT, { recursive: true });

const env = Object.fromEntries(
  (await fs.readFile('client/.env.local', 'utf8')).split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const API_KEY = env.VITE_FIREBASE_API_KEY;
const PROJECT = env.VITE_FIREBASE_PROJECT_ID;

let failed = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed += 1;
};
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const warnings = [];
const log = { ...quiet, warn: (code) => warnings.push(code) };

const pageFor = (anonymous) => (nonce) => loginPageHtml({
  api_key: API_KEY, auth_domain: `${PROJECT}.firebaseapp.com`, project_id: PROJECT,
  nonce, anonymous,
});

console.log('CLI-SERVED LOGIN PAGE -- Chromium and WebKit\n');

// ============================================================ 1. the artifact
//
// Asserted on the HTML STRING the CLI will actually serve, before any browser is involved. The
// properties below are the design; if they are not in the bytes, nothing downstream matters.
console.log('1. the page the CLI serves, as bytes');
{
  const html = loginPageHtml({
    api_key: 'AIza-test-key', auth_domain: 'p.firebaseapp.com', project_id: 'p',
    nonce: 'N'.repeat(43), anonymous: false,
  });
  check(html.includes('N'.repeat(43)), 'the nonce is templated into the page');
  check(html.includes(`from '${SDK_BASE}/firebase-app.js'`), 'the SDK is imported from the CDN');
  check(html.includes('https://www.gstatic.com/firebasejs/'), 'over HTTPS -- an upgrade from an http page');
  check(!/from ['"]http:\/\//.test(html), 'and nothing is imported over plain http');
  check(html.includes("fetch('/callback'"), 'the credential posts to a RELATIVE path -- same origin');
  check(!/fetch\(['"]https?:\/\//.test(html), 'and never to an absolute origin, which is what made it mixed content');
  // ORDER 0059. Popup here, not redirect: signInWithRedirect parks pending state on the
  // authDomain origin and reads it back cross-origin on return, which Safari's ITP blocks. A page
  // on localhost with a random port can never be same-origin with authDomain, so redirect cannot
  // be made to work on THIS page. The hosted board keeps redirect and is same-origin there.
  // Checked as CALLS, not as text: the page's own comments explain why redirect was abandoned, so
  // a substring search matches the explanation and reports the opposite of the truth.
  check(/signInWithPopup\(/.test(html), 'sign-in is a popup');
  check(!/signInWithRedirect\(/.test(html), 'redirect is never CALLED -- it cannot work here');
  check(!/getRedirectResult\(/.test(html), 'nor is a redirect return leg that would never resolve');
  const imports = html.slice(html.indexOf('firebase-auth.js') - 400, html.indexOf('firebase-auth.js'));
  check(!/signInWithRedirect|getRedirectResult/.test(imports),
    'and neither is even imported, so they cannot come back by accident');

  // THE GESTURE, ASSERTED ON THE BYTES.
  //
  // Safari does not refuse popups by policy -- it refuses popups it cannot attribute to a user
  // gesture, and an await before the call spends the attribution. So the click handler must reach
  // signInWithPopup with nothing awaited first. Checked structurally, because this is the kind of
  // property a later edit breaks silently: one `await` added above the call and the popup starts
  // being blocked again, for the reason order 0056 misdiagnosed.
  const handler = html.slice(
    html.indexOf('function onGoogleClick()'),
    html.indexOf('\n}', html.indexOf('function onGoogleClick()')),
  );
  check(handler.length > 0, 'the click handler is identifiable in the page');
  check(!/^\s*async\s+function onGoogleClick/m.test(html),
    'the click handler is NOT async -- it cannot accidentally await');
  const beforeCall = handler.slice(0, handler.indexOf('signInWithPopup'));
  check(handler.includes('signInWithPopup'), 'and it calls signInWithPopup');
  check(!/\bawait\b/.test(beforeCall),
    'with NO await between entering the handler and the call -- the gesture is intact');
  // The control: the same extraction WOULD see an await if one were there. Without this, a
  // mis-sliced handler (empty string) would pass the assertion above by containing nothing.
  const sabotaged = handler.replace('const pending = signInWithPopup', 'await 0; const pending = signInWithPopup');
  check(/\bawait\b/.test(sabotaged.slice(0, sabotaged.indexOf('signInWithPopup'))),
    'and the check FIRES on a handler that does await first (the control)');

  // The other half of the same problem lives inside the SDK: signInWithPopup waits for the Auth
  // instance to initialise before calling window.open, and that wait lands between the gesture and
  // the popup. Forced at load instead, before the button exists.
  check(html.includes('await auth.authStateReady()'), 'the SDK is initialised at page load');
  check(html.indexOf('await auth.authStateReady()') < html.indexOf("getElementById('go').onclick"),
    'BEFORE the button is wired up, so nothing is left to await when it is pressed');

  // Injection: a nonce is generated by the CLI, but the project id and api key come from a config
  // file a user can edit. A quote in either would end the script string and change the program.
  const nasty = loginPageHtml({
    api_key: 'a"</script><script>window.pwned=1</script>', auth_domain: 'p', project_id: 'p',
    nonce: 'M'.repeat(43), anonymous: false,
  });
  // JSON.stringify alone did NOT cover this: it escapes quotes, but `</script>` inside a JSON
  // string still ends the HTML element, because the parser finds that sequence before any
  // JavaScript is parsed. Caught here rather than in review.
  check(!nasty.includes('</script><script>'), 'an injected value cannot close the script element');
  check(!/<script>window\.pwned/.test(nasty), 'and cannot open a new one');
  check(nasty.includes('\\u003c/script>'), 'the "<" is escaped to \\u003c, which HTML does not see');
  // The control: the payload IS still in the page, escaped. Without this, a page that dropped the
  // value entirely -- or produced nothing at all -- would pass both assertions above.
  check(nasty.includes('window.pwned'), 'and the value survives, escaped (the control)');

  // The same treatment for the nonce, which is the value that matters most.
  const hostileNonce = loginPageHtml({
    api_key: 'k', auth_domain: 'p', project_id: 'p', anonymous: false,
    nonce: `</script><script>window.pwned=2</script>`,
  });
  check(!hostileNonce.includes('</script><script>'), 'the nonce is escaped the same way');
}

// ============================================================ 2. the server serves it
console.log('\n2. the CLI listener serves the page at GET /');
{
  const lb = startLoopback({ log, timeout_ms: 10_000, page: pageFor(false) });
  const port = await loopbackReady(lb);
  const url = localLoginUrl(port);
  check(url === `http://localhost:${port}/`, `the URL is localhost, not 127.0.0.1 (${url})`);
  // localhost is what Firebase's authorized-domain check accepts; 127.0.0.1 is refused. Measured
  // with the refusal as the control in firebase/localhost-probe.mjs.
  check(!url.includes('127.0.0.1'), 'and 127.0.0.1 appears nowhere in it');
  check(!url.includes('nonce') && !url.includes('port='),
    'and the URL carries NO nonce and no port parameter -- the page is templated instead');

  const res = await fetch(url);
  const body = await res.text();
  check(res.status === 200, `GET / returns 200 (${res.status})`);
  check(res.headers.get('content-type')?.includes('text/html'), 'as HTML');
  check(res.headers.get('cache-control') === 'no-store', 'and no-store, because it carries a live nonce');
  check(body.includes(lb.nonce), 'the served page carries THIS listener\'s nonce');

  // The page is fetched over the hostname the browser will use, not just the bound address.
  const viaName = await fetch(`http://localhost:${port}/`);
  check(viaName.ok, 'and the socket is reachable as `localhost` (it is bound to 127.0.0.1)');

  const missing = await fetch(`${url}nope`);
  check(missing.status === 404, `an unknown path is 404, not the page again (${missing.status})`);
  lb.close();
  lb.result.catch(() => {});
}

// ============================================================ browsers
const puppeteer = (await import('puppeteer')).default;
const { webkit } = await import('playwright');

const chromium = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const wk = await webkit.launch();

/** One uniform driver over both engines, so the two runs differ only in the engine. */
const engines = [
  {
    name: 'Chromium',
    version: await chromium.version(),
    open: async () => {
      const ctx = await chromium.createBrowserContext();
      const page = await ctx.newPage();
      const logs = [];
      page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
      page.on('requestfailed', (r) => logs.push(`[failed] ${r.url()} ${r.failure()?.errorText}`));
      return {
        page, logs,
        goto: (u) => page.goto(u, { waitUntil: 'networkidle2', timeout: 60_000 }),
        text: () => page.evaluate(() => document.body.innerText),
        step: () => page.evaluate(() => document.getElementById('root')?.dataset.loginStep ?? null),
        shot: (f) => page.screenshot({ path: f }),
        close: () => ctx.close(),
      };
    },
  },
  {
    name: 'WebKit',
    version: wk.version(),
    open: async () => {
      const ctx = await wk.newContext();
      const page = await ctx.newPage();
      const logs = [];
      page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
      page.on('requestfailed', (r) => logs.push(`[failed] ${r.url()} ${r.failure()?.errorText}`));
      return {
        page, logs,
        goto: (u) => page.goto(u, { waitUntil: 'networkidle', timeout: 60_000 }),
        text: () => page.innerText('body'),
        step: () => page.evaluate(() => document.getElementById('root')?.dataset.loginStep ?? null),
        shot: (f) => page.screenshot({ path: f }),
        close: () => ctx.close(),
      };
    },
  },
];

const settle = async (drv, want, ms = 40_000) => {
  const until = Date.now() + ms;
  for (;;) {
    const s = await drv.step().catch(() => null);
    if (want.includes(s)) return s;
    if (Date.now() > until) return s;
    await new Promise((r) => setTimeout(r, 300));
  }
};

for (const engine of engines) {
  console.log(`\n================ ${engine.name} ${engine.version}`);

  // ---------------------------------------------------------- 3. anonymous, end to end
  console.log(`\n3. [${engine.name}] ANONYMOUS, end to end, nothing stubbed`);
  {
    const lb = startLoopback({ log, timeout_ms: 90_000, page: pageFor(true) });
    const port = await loopbackReady(lb);
    const drv = await engine.open();
    await drv.goto(localLoginUrl(port));

    // Assert the ARTIFACT the CLI consumes -- the resolved result -- not the page's own opinion.
    const outcome = await Promise.race([
      lb.result.then((r) => ({ kind: 'delivered', r })),
      new Promise((res) => setTimeout(() => res({ kind: 'timeout' }), 45_000)),
    ]);
    const s = await settle(drv, ['done', 'error'], 10_000);
    const text = await drv.text();
    await drv.shot(path.join(OUT, `local-${engine.name.toLowerCase()}-anonymous.png`));

    if (outcome.kind === 'delivered') {
      check(true, `THE CREDENTIAL CROSSED. uid ${outcome.r.uid}`);
      check(!!outcome.r.refresh_token, 'with a refresh token');
      check(s === 'done', `and the page shows the outcome (${s})`);
      check(/close this tab/i.test(text), 'and says the tab is finished with');

      // Usable, not merely present: exchange it for an ID token and read the claims back.
      const HOME = path.join(os.tmpdir(), `flotilla-local-${Date.now().toString(36)}`);
      await saveCredential({
        refresh_token: outcome.r.refresh_token, uid: outcome.r.uid, project_id: PROJECT,
        obtained_at: new Date().toISOString(),
      }, HOME);
      const stored = await loadCredential(HOME);
      const minted = await mintIdToken(stored, API_KEY);
      const claims = JSON.parse(Buffer.from(minted.id_token.split('.')[1], 'base64url').toString());
      check(claims.user_id === outcome.r.uid || claims.sub === outcome.r.uid,
        'and the credential mints a token whose claims name the same uid');
      await fs.rm(HOME, { recursive: true, force: true });
    } else {
      check(false, `THE CREDENTIAL DID NOT CROSS in ${engine.name}.`);
      console.log(`    state: ${s}`);
      console.log(`    text : ${text.replace(/\n+/g, ' | ')}`);
      for (const l of drv.logs) console.log(`    ${l}`);
    }
    // NO MIXED CONTENT, IN EITHER ENGINE. This is the sentence WebKit printed before; its absence
    // is the whole deliverable, so it is asserted rather than assumed.
    check(!drv.logs.some((l) => /insecure content|mixed content|blocked/i.test(l)),
      'and NOTHING was blocked as insecure content');
    lb.close();
    await drv.close();
  }

  // ---------------------------------------------------------- 4. the Google leg
  console.log(`\n4. [${engine.name}] the Google path -- up to the consent screen`);
  {
    const lb = startLoopback({ log, timeout_ms: 30_000, page: pageFor(false) });
    const port = await loopbackReady(lb);
    const drv = await engine.open();
    await drv.goto(localLoginUrl(port));

    const s = await settle(drv, ['ready', 'error'], 20_000);
    const text = await drv.text();
    check(s === 'ready', `the page offers a sign-in button (${s})`);
    check(/Continue with Google/.test(text), 'saying Continue with Google');
    check(!/unauthorized|not an authorised domain/i.test(text),
      'and localhost is NOT refused as an unauthorised domain');
    await drv.shot(path.join(OUT, `local-${engine.name.toLowerCase()}-google.png`));

    // THE GESTURE, MEASURED IN A RUNNING BROWSER.
    //
    // Neither of these engines enforces Safari's rule, so "a popup opened" proves nothing on its
    // own. What CAN be measured anywhere is the property Safari actually tests: was window.open
    // called while the click was still being handled, or after an async boundary had ended that
    // task? A flag set by a capturing click listener and cleared by a setTimeout(0) separates
    // exactly those two cases -- microtasks (a resolved await) still count as the same task, a
    // real async wait does not.
    //
    // This is the closest a non-Safari engine can get to falsifying the fix, and it is stated as
    // such rather than as a Safari pass.
    await drv.page.evaluate(() => {
      window.__gesture = { opened: false, duringClick: null, gap_ms: null, activation: null };
      let inClick = false;
      let clickAt = 0;
      document.addEventListener('click', () => {
        inClick = true;
        clickAt = performance.now();
        setTimeout(() => { inClick = false; }, 0);
      }, true);
      const realOpen = window.open;
      window.open = function patched(...args) {
        if (!window.__gesture.opened) {
          window.__gesture.opened = true;
          window.__gesture.duringClick = inClick;
          window.__gesture.gap_ms = Math.round(performance.now() - clickAt);
          // Transient activation is the browser-visible form of "this is still the user's doing".
          window.__gesture.activation = navigator.userActivation
            ? navigator.userActivation.isActive : null;
        }
        return realOpen.apply(window, args);
      };
    });

    const before = engine.name === 'Chromium'
      ? (await chromium.pages()).length : drv.page.context().pages().length;
    await drv.page.click('#go');
    await new Promise((r) => setTimeout(r, 6_000));
    const after = engine.name === 'Chromium'
      ? (await chromium.pages()).length : drv.page.context().pages().length;

    const gesture = await drv.page.evaluate(() => window.__gesture);
    console.log(`      window.open: +${gesture.gap_ms}ms after the click, `
      + `sameTask=${gesture.duringClick}, userActivation.isActive=${gesture.activation}`);
    check(gesture.opened, 'window.open WAS called -- it is a popup now, not a redirect');
    // Transient activation, in both engines: the browser still attributes the window to the user.
    check(gesture.activation !== false,
      `and user activation was still live when it opened (isActive=${gesture.activation})`);

    // THE STRONG PROPERTY, ASSERTED ONLY WHERE IT IS THE RIGHT ONE.
    //
    // Safari does not accept "transient activation is live" -- it wants the popup opened while the
    // click is still being handled. The engines measurably differ on this: WebKit opens it in the
    // click's own task (~1ms), Chromium takes a few hundred ms inside the SDK and lands in a later
    // task while keeping activation live, which Chrome allows.
    //
    // So same-task is required of WEBKIT, the engine Safari is built from, and Chromium is held to
    // activation only. Holding Chromium to same-task would fail on behaviour Chrome permits;
    // dropping it for WebKit would stop testing the thing this order is about.
    if (engine.name === 'WebKit') {
      check(gesture.duringClick === true,
        `and in Safari's engine it opened INSIDE the click's own task (+${gesture.gap_ms}ms) -- `
        + 'the attribution Safari requires');
    }
    check(after > before, `a popup window actually appeared (${before} -> ${after})`);

    // The page itself must not have navigated: a popup leaves this document in place, which is
    // what keeps the nonce and the listener relationship intact.
    const url = drv.page.url();
    check(url.startsWith(localLoginUrl(port)),
      `and this page stayed on localhost rather than navigating away (${url.slice(0, 48)}…)`);
    // The consent screen itself needs a human. That is the one stubbed step, in both engines.
    lb.close();
    lb.result.catch(() => {});
    await drv.close();
  }

  // ---------------------------------------------------------- 5. a stale page
  console.log(`\n5. [${engine.name}] a stale page cannot spend a live login`);
  {
    // Two listeners. The page from the FIRST posts its nonce; the second must refuse it, and must
    // keep waiting -- a stray POST must never kill a login in progress.
    const stale = startLoopback({ log, timeout_ms: 20_000, page: pageFor(true) });
    const stalePort = await loopbackReady(stale);
    const live = startLoopback({ log, timeout_ms: 20_000, page: pageFor(true) });
    const livePort = await loopbackReady(live);

    const before = warnings.length;
    const res = await fetch(`http://localhost:${livePort}/callback`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nonce: stale.nonce, refresh_token: 'r', id_token: 'i', uid: 'u' }),
    });
    check(res.status === 403, `the other listener's nonce is refused 403 (${res.status})`);
    check(warnings.slice(before).includes('auth.nonce_mismatch'), 'and the CLI logged the mismatch');

    // Still alive: the legitimate page now completes against the same listener.
    const drv = await engine.open();
    await drv.goto(localLoginUrl(livePort));
    const got = await Promise.race([
      live.result.then((r) => r.uid),
      new Promise((res2) => setTimeout(() => res2(null), 45_000)),
    ]);
    check(!!got, `and the real login still completed afterwards (${got ?? 'timed out'})`);
    stale.close(); live.close();
    stale.result.catch(() => {});
    await drv.close();
  }
}

// ============================================================ 6. the real command, both engines
//
// Everything above drives a listener this script started. This spawns THE ACTUAL
// `flotilla login --anonymous`, scrapes the localhost URL it prints, and points each engine at it.
// Nothing is stubbed: the binary picks its own port and nonce, serves its own page, and the
// assertion is the CREDENTIAL FILE ON DISK, which is what the next command reads.
//
// The WebKit run is the deliverable of order 0057: before this, a WebKit browser could not
// complete `flotilla login` at all.
const { spawn } = await import('node:child_process');
for (const engine of engines) {
  console.log(`\n6. [${engine.name}] \`flotilla login --anonymous\` for real, browser and all`);
  const SANDBOX = path.join(here, '..', '.agentic', `locallogin-${engine.name}-${Date.now().toString(36)}`);
  const HOME = path.join(SANDBOX, 'home');
  await fs.mkdir(HOME, { recursive: true });

  const cenv = { ...process.env, HOME };
  for (const k of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_TOKEN', 'GCLOUD_PROJECT',
    'GOOGLE_CLOUD_PROJECT', 'FLOTILLA_PROJECT', 'FLOTILLA_API_KEY']) delete cenv[k];

  const cliPath = path.join(here, 'flotilla-main.ts');
  const runCli = (args, opts = {}) => new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], { cwd: path.join(here, '..'), env: cenv });
    let out = '';
    const onData = (d) => { out += d; opts.onData?.(out); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const t = setTimeout(() => child.kill('SIGKILL'), opts.timeout ?? 120_000);
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out }); });
  });

  const init = await runCli(['init', '--project', PROJECT]);
  check(init.code === 0, `flotilla init exits 0 (${init.code})`);

  let opened = null;
  let driving = Promise.resolve();
  const login = await runCli(['login', '--anonymous', '--no-browser'], {
    onData: (out) => {
      if (opened) return;
      const m = /http:\/\/localhost:\d+\//.exec(out);
      if (!m) return;
      opened = m[0];
      driving = (async () => {
        const drv = await engine.open();
        await drv.goto(opened);
        const s = await settle(drv, ['done', 'error'], 40_000);
        await drv.shot(path.join(OUT, `local-${engine.name.toLowerCase()}-cli-end-to-end.png`));
        // WHAT THE USER SEES, not only what the CLI received. Without this the suite passed while
        // the page said "Login failed" on a login that had in fact succeeded -- the CLI had the
        // credential and the user was told it had not worked.
        check(s === 'done', `[${engine.name}] the page ends on success, not an error (${s})`);
        if (s !== 'done') console.log(`      page said: ${(await drv.text()).replace(/\n+/g, ' | ')}`);
        // No mixed content, on the real command's own page.
        check(!drv.logs.some((l) => /insecure content|mixed content/i.test(l)),
          `[${engine.name}] nothing blocked as insecure content on the real page`);
        await drv.close();
      })();
    },
  });
  await driving;

  check(!!opened, `the CLI printed a localhost URL and ${engine.name} opened it (${opened ?? 'none'})`);
  check(!!opened && !opened.includes('127.0.0.1'), 'and it is localhost, not 127.0.0.1');
  check(login.code === 0, `flotilla login --anonymous exits 0 (${login.code})`);
  check(/signed in as/.test(login.out), 'and reports the identity it received');

  // THE ARTIFACT, not the exit code.
  const credFile = path.join(HOME, '.flotilla', 'credentials.json');
  const stat = await fs.stat(credFile).catch(() => null);
  check(!!stat, 'the credential file exists in the fresh HOME');
  check(stat && (stat.mode & 0o777) === 0o600, `and is 0600 (${stat ? (stat.mode & 0o777).toString(8) : '-'})`);
  const stored = stat ? JSON.parse(await fs.readFile(credFile, 'utf8')) : {};
  check(!!stored.refresh_token && !!stored.uid, `holding a refresh token for uid ${stored.uid}`);
  check(!!stored.uid && login.out.includes(stored.uid), 'the uid on screen is the uid on disk');

  // And the command it tells people to run next actually agrees with it.
  const who = await runCli(['whoami']);
  check(who.code === 0 && who.out.includes(stored.uid ?? 'x'),
    `flotilla whoami then reports the same identity (exit ${who.code})`);

  await fs.rm(SANDBOX, { recursive: true, force: true });
}

await chromium.close();
await wk.close();

console.log(`\n${failed === 0 ? 'LOCAL LOGIN VERIFIED IN CHROMIUM AND WEBKIT' : `FAILED (${failed})`}`);
console.log('');
console.log('  SAFARI.app WAS NOT RUN, AND WEBKIT DOES NOT SUBSTITUTE FOR IT.');
console.log('  Playwright\'s WebKit does not implement Intelligent Tracking Prevention, so every');
console.log('  ITP defect in this flow is INVISIBLE to it. Two orders of green WebKit runs');
console.log('  preceded the user reporting that Safari sign-in returns to the sign-in screen.');
console.log('  What is green above is everything except ITP.');
console.log('');
console.log('  To make Safari falsifiable here, run once:   sudo safaridriver --enable');
console.log('  then: node firebase/login-safari.mjs   (it exits 2 today, and that exit 2 is the');
console.log('  most important line in this suite -- it means the only engine that can falsify');
console.log('  this was never run.)');
process.exit(failed === 0 ? 0 : 1);
