// /login in WEBKIT. Order 0056.
//
// READ THIS BEFORE READING THE PASSES. WEBKIT IS NOT SAFARI.
//
// Safari.app cannot be automated here: safaridriver requires `safaridriver --enable`, which
// prompts for an administrator password, and no program can supply that. firebase/login-safari.mjs
// is the real-Safari harness and it exits 2 rather than passing when it cannot run.
//
// This is Playwright's WebKit -- the same rendering and networking engine Safari is built on,
// built from the same source, WITHOUT Safari's shell. So:
//
//   WHAT THIS DOES PROVE, because it is engine-level and shared with Safari:
//     - whether WebKit lets an https page POST to http://127.0.0.1 at all. This is the question
//       Chrome already answered yes to, and Chrome's answer says nothing about WebKit: the two
//       engines implement mixed content and private-network rules independently.
//     - that the redirect flow's sessionStorage round trip works in WebKit.
//     - that every screen renders, in an engine with different CSS and layout behaviour.
//
//   WHAT IT DOES NOT PROVE, and must not be reported as proving:
//     - SAFARI'S POPUP BLOCKING. That is a Safari.app default, not a WebKit one, and it is the
//       defect order 0056 is about. Playwright's WebKit does not block popups, so a popup test
//       here would pass and mean nothing.
//     - SAFARI'S ITP. Intelligent Tracking Prevention is Safari's, with its own storage
//       partitioning. The same-origin authDomain change is aimed at it and is NOT verified here.
//
//   Both of those are addressed by design rather than by test: the page no longer opens a popup
//   at all, and the auth handler is same-origin so there is no partitioned third-party storage
//   for ITP to block. That is a reasoned argument, not a measurement, and it is labelled as one.
//
//   node firebase/login-webkit.mjs [https://<project>.web.app]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { webkit } from 'playwright';

import { startLoopback, loopbackReady, loginUrl } from '../cli/auth.ts';
import { PENDING_KEY } from '../client/src/login-contract.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, '..', 'client', 'edge', 'shots');
await fs.mkdir(OUT, { recursive: true });

const env = Object.fromEntries(
  (await fs.readFile('client/.env.local', 'utf8')).split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const BASE = process.argv[2] ?? `https://${env.VITE_FIREBASE_PROJECT_ID}.web.app`;

let failed = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed += 1;
};
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

const browser = await webkit.launch();
const version = browser.version();
console.log(`LOGIN IN WEBKIT ${version} -- ${BASE}`);
console.log('NOT SAFARI. See the header of this file for what that changes.\n');

const fresh = async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => logs.push(`[failed] ${r.method()} ${r.url()} -- ${r.failure()?.errorText}`));
  return { ctx, page, logs };
};
const step = (page) =>
  page.evaluate(() => document.querySelector('[data-login-step]')?.dataset.loginStep ?? null);
const settle = async (page, want, timeout = 30_000) => {
  await page.waitForFunction(
    (w) => w.includes(document.querySelector('[data-login-step]')?.dataset.loginStep),
    want, { timeout },
  ).catch(() => {});
  return step(page);
};

// ============================================================ 1. it renders at all
console.log('1. the page renders in WebKit');
{
  const { ctx, page } = await fresh();
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 60_000 });
  check((await step(page)) === 'error', 'a link with no login request is a named error');
  const text = await page.innerText('body');
  check(/flotilla login/.test(text), 'which names the command, having nothing to retry with');
  check(!/Try again/.test(text), 'and offers no retry button it could not honour');
  await page.screenshot({ path: path.join(OUT, 'webkit-login-no-params.png') });
  await ctx.close();
}

// ============================================================ 2. no popup is attempted
console.log('\n2. the sign-in button navigates -- it does not open a window');
{
  const { ctx, page } = await fresh();
  // Count popups. Playwright's WebKit does NOT block them, which is what makes this meaningful:
  // if the page still tried to open one, this would see it. Safari would have blocked it, and
  // the user would be back at the dead end.
  const popups = [];
  ctx.on('page', (p) => popups.push(p));

  await page.goto(`${loginUrl(BASE, 51234, 'g'.repeat(43))}&provider=google`,
    { waitUntil: 'networkidle', timeout: 60_000 });
  check((await step(page)) === 'ready', 'the Google link renders the sign-in screen');
  const text = await page.innerText('body');
  check(!/popup|pop-up/i.test(text), 'and never mentions a popup');
  await page.screenshot({ path: path.join(OUT, 'webkit-login-google.png') });

  await page.click('.login button.cta');
  await page.waitForTimeout(5_000);

  check(popups.length === 0,
    `NO POPUP WAS OPENED (${popups.length}) -- this is the fix, in an engine that would have allowed one`);
  const url = page.url();
  check(/accounts\.google\.com|__\/auth\/handler/.test(url),
    `the tab NAVIGATED to Google instead (${url.slice(0, 70)}…)`);

  // And the nonce was written BEFORE the navigation. If it were not, the return leg would come
  // back as "malformed nonce" -- the worse bug the order warned against.
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  const stash = await page.evaluate((k) => window.sessionStorage.getItem(k), PENDING_KEY);
  check(!!stash, 'the port and nonce were stashed before leaving the page');
  check(!!stash && stash.includes('g'.repeat(43)), 'and the stash holds the CLI nonce verbatim');
  check(!!stash && JSON.parse(stash).port === 51234, 'and the CLI port');
  await ctx.close();
}

// ============================================================ 3. the return leg
console.log('\n3. coming back with GOOGLE\'S query string, not the CLI\'s');
{
  const { ctx, page } = await fresh();
  const lb = startLoopback({ log: quiet, timeout_ms: 60_000 });
  const port = await loopbackReady(lb);

  // Seed the stash the way the outbound leg would have, then arrive on the URL Google sends the
  // browser to. The CLI's parameters are NOT in this URL.
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(
    ([k, v]) => window.sessionStorage.setItem(k, v),
    [PENDING_KEY, JSON.stringify({ port, nonce: lb.nonce, anonymous: false, popup: false })],
  );
  await page.goto(`${BASE}/login?state=AMbdmDl7&code=4%2F0AeanS0abc&authuser=0&prompt=consent`,
    { waitUntil: 'networkidle', timeout: 60_000 });

  const s = await settle(page, ['returning', 'posting', 'done', 'error'], 25_000);
  const text = await page.innerText('body');
  check(s !== null, `the return leg renders (${s})`);
  check(!/login link/i.test(text), 'and does NOT read Google\'s parameters as a malformed link');
  // getRedirectResult finds nothing, because no real redirect happened -- so the honest outcome
  // is "Google did not return a sign-in", WITH a retry, since the nonce is still good.
  check(/did not return a sign-in/i.test(text) || s === 'posting' || s === 'done',
    'it resolves the redirect rather than blaming the URL');
  if (/did not return a sign-in/i.test(text)) {
    check(/Try again/.test(text), 'and offers a RETRY, because the stashed nonce is still usable');
  }
  await page.screenshot({ path: path.join(OUT, 'webkit-login-return.png') });
  lb.close();
  lb.result.catch(() => {});
  await ctx.close();
}

// ============================================================ 4. THE ENGINE QUESTION
console.log('\n4. does WebKit let an https page POST to http://127.0.0.1?');
{
  const { ctx, page, logs } = await fresh();
  const lb = startLoopback({ log: quiet, timeout_ms: 90_000 });
  const port = await loopbackReady(lb);
  console.log(`  listener on 127.0.0.1:${port}`);

  await page.goto(`${loginUrl(BASE, port, lb.nonce)}&provider=anonymous`,
    { waitUntil: 'networkidle', timeout: 60_000 });

  // Assert the ARTIFACT the CLI consumes, not the page's opinion of how it went.
  const outcome = await Promise.race([
    lb.result.then((r) => ({ kind: 'delivered', r })),
    new Promise((res) => setTimeout(() => res({ kind: 'timeout' }), 45_000)),
  ]);
  const s = await settle(page, ['done', 'error'], 10_000);
  const text = await page.innerText('body');
  await page.screenshot({ path: path.join(OUT, 'webkit-login-anonymous.png') });

  if (outcome.kind === 'delivered') {
    check(true, `THE POST CROSSED IN WEBKIT. The CLI received uid ${outcome.r.uid}`);
    check(!!outcome.r.refresh_token, 'with a refresh token');
    check(s === 'done', `and the page says so (${s})`);
    check(/close this tab/i.test(text), 'and tells the user the tab is finished with');
  } else {
    // Plainly. WebKit refusing this would mean the loopback handoff cannot work in Safari
    // either, and that is a DESIGN problem -- a different channel, not a patch.
    check(false, 'THE POST DID NOT CROSS IN WEBKIT. Safari would not work either.');
    console.log(`    state: ${s}`);
    console.log(`    text : ${text.replace(/\n+/g, ' | ')}`);
    for (const l of logs) console.log(`    ${l}`);
  }
  check(s === 'done' || s === 'error', `terminal state, not a spinner (${s})`);
  lb.close();
  await ctx.close();
}

// ============================================================ 5. the way out
console.log('\n5. failures offer a way out, or say why they cannot');
{
  const { ctx, page } = await fresh();
  const dead = startLoopback({ log: quiet, timeout_ms: 2_000 });
  const port = await loopbackReady(dead);
  dead.close();
  dead.result.catch(() => {});
  await new Promise((r) => setTimeout(r, 200));

  await page.goto(`${loginUrl(BASE, port, dead.nonce)}&provider=anonymous`,
    { waitUntil: 'networkidle', timeout: 60_000 });
  const s = await settle(page, ['error', 'done'], 40_000);
  const text = await page.innerText('body');
  check(s === 'error', `a CLI that stopped waiting ends in a named error (${s})`);
  check(/stopped waiting/.test(text), 'that says so');
  check(!/Try again/.test(text), 'and offers NO retry -- a button cannot restart a dead process');
  check(/flotilla login/.test(text), 'and names the command that can');
  await page.screenshot({ path: path.join(OUT, 'webkit-login-unrecoverable.png') });
  await ctx.close();
}

// ============================================================ 6. a probe, not a test
//
// Section 4 found that WebKit BLOCKS the fetch to http://127.0.0.1 as mixed content. That is a
// design problem, not an implementation one, so it is reported rather than worked around. This
// section exists so the report carries a MEASUREMENT instead of a suggestion: it asks whether the
// one obvious alternative channel is actually permitted by the same engine.
//
// Mixed-content blocking applies to SUBRESOURCES. A top-level navigation from an https page to an
// http URL is not a subresource and is not blocked -- that is how every http link on an https
// page still works. If that holds, the handoff can be a navigation rather than a fetch.
//
// Probed against a PLAIN NODE SERVER, not the CLI's listener: the CLI's contract is POST-only and
// this is deliberately not changing it. Nothing here asserts shipped behaviour.
console.log('\n6. PROBE (not a test): would a top-level navigation be allowed instead?');
{
  const { createServer } = await import('node:http');
  let arrived = null;
  const probe = createServer((req, res) => {
    arrived = req.url;
    res.writeHead(200, { 'content-type': 'text/html' }).end('<h1 id="ok">received</h1>');
  });
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  const pport = probe.address().port;

  const { ctx, page } = await fresh();
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  // A real top-level navigation, started from the https document.
  await page.evaluate((u) => { window.location.href = u; }, `http://127.0.0.1:${pport}/handoff?probe=1`);
  await page.waitForTimeout(3_000);

  console.log(`  ${arrived ? 'YES' : 'NO '}  a top-level navigation from the https page ` +
    `${arrived ? `reached the loopback server (${arrived})` : 'was also blocked'}`);
  console.log('        (probe only -- the CLI contract is unchanged and nothing above depends on this)');
  probe.close();
  await ctx.close();
}

await browser.close();
console.log(`\n${failed === 0 ? 'WEBKIT VERIFIED' : `FAILED (${failed})`}`);
console.log('This is WebKit, not Safari. Safari\'s popup default and ITP remain unmeasured;');
console.log('firebase/login-safari.mjs runs them the moment safaridriver is enabled.');
process.exit(failed === 0 ? 0 : 1);
