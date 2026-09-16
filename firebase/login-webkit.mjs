// The HOSTED /login page in WEBKIT. Orders 0056 and 0057.
//
// THIS IS NO LONGER THE PRIMARY PATH. Order 0057 moved the login page into the CLI, served on
// http://localhost:<port>, because the measurement below showed the hosted page cannot deliver a
// credential in this engine at all. The primary path lives in firebase/login-local.mjs and is
// driven in BOTH Chromium and WebKit.
//
// Since order 0061 this file covers exactly two things, and no longer drives a sign-in flow that
// the hosted page deliberately refuses to offer in this engine:
//
//   1. the hosted page refuses ON LOAD here, with a live listener, naming both ways out
//   2. THE ENGINE FACT, PINNED: WebKit still blocks https -> http://127.0.0.1 as mixed content
//
// The two-engine proof -- refuses in WebKit, renders the button in Chromium -- lives in
// firebase/hosted-refusal.mjs, where the Chromium control sits next to it.
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

// ============================================================ 1. the page refuses on load
//
// ORDER 0061. This file used to drive the hosted page's whole sign-in flow in WebKit. That flow no
// longer exists here BY DESIGN: the page now refuses up front, because https + WebKit + a loopback
// handoff cannot complete, and every input to that was knowable before the user clicked anything.
// The two-engine proof (refuses in WebKit, renders the button in Chromium) lives in
// firebase/hosted-refusal.mjs, where the Chromium control sits beside it.
//
// What remains here is the one thing this file is uniquely for: PINNING THE ENGINE FACT.
console.log('1. the hosted page refuses, rather than walking the user into Google');
{
  const lb = startLoopback({ log: quiet, timeout_ms: 30_000 });
  const port = await loopbackReady(lb);
  const { ctx, page } = await fresh();
  // A LIVE listener, so "refused" cannot be confused with "expired link".
  await page.goto(`${loginUrl(BASE, port, lb.nonce)}&provider=google`,
    { waitUntil: 'networkidle', timeout: 60_000 });
  const s = await settle(page, ['refused', 'ready', 'stale', 'error'], 25_000);
  const text = await page.innerText('body');
  check(s === 'refused', `refused on load with a live listener (${s})`);
  check(!/Continue with Google/.test(text), 'and no sign-in button was offered');
  check(/flotilla login/.test(text) && /Chrome/.test(text), 'naming both ways out');
  await page.screenshot({ path: path.join(OUT, 'webkit-login-refused.png') });
  lb.close();
  lb.result.catch(() => {});
  await ctx.close();
}

// ============================================================ 2. THE ENGINE FACT, PINNED
//
// WebKit blocks a fetch from an https page to http://127.0.0.1 as mixed content; Chrome permits it
// because loopback is potentially trustworthy under Secure Contexts. That disagreement is the
// reason the CLI serves its own page, and it is the reason the gate above exists.
//
// Asserted DIRECTLY now rather than through the login page, because the page no longer attempts
// the request -- so observing it that way would only prove the gate fired. This runs the fetch
// from a document on the real https origin and reads the outcome.
//
// If WebKit ever adopts the carve-out, this fails and tells us the gate can be relaxed.
console.log('\n2. PINNED: WebKit still blocks https -> http://127.0.0.1 as mixed content');
{
  const lb = startLoopback({ log: quiet, timeout_ms: 30_000 });
  const port = await loopbackReady(lb);
  const { ctx, page, logs } = await fresh();
  await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  const outcome = await page.evaluate(async (p) => {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/`, { method: 'GET' });
      return { reached: true, status: r.status };
    } catch (e) {
      return { reached: false, error: String(e && e.message ? e.message : e) };
    }
  }, port);

  check(outcome.reached === false,
    `the request did not leave the page (${outcome.reached ? `status ${outcome.status}` : outcome.error})`);
  check(logs.some((l) => /insecure content|blocked/i.test(l)),
    'and the engine says why: it was blocked as insecure content');
  if (outcome.reached) {
    console.log('    NOTE: WebKit reached loopback this time. If that is stable, the hosted page');
    console.log('          no longer needs to refuse and the gate can be relaxed.');
  }
  lb.close();
  lb.result.catch(() => {});
  await ctx.close();
}

// ============================================================ 3. a probe, not a test
//
// Section 2 pins that WebKit BLOCKS the fetch to http://127.0.0.1 as mixed content. That is a
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
console.log('\n3. PROBE (not a test): would a top-level navigation be allowed instead?');
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
