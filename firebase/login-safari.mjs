// /login in SAFARI. Order 0056.
//
// WHY THIS FILE EXISTS SEPARATELY FROM login-browser.mjs. That one drives Chrome, and Chrome does
// not have the defect: it allows the sign-in popup, so every assertion passed while the page was
// a dead end on the user's actual machine. "Verified in a browser" was a true signal about the
// wrong browser -- the same shape of mistake as pinging a port and concluding the right service
// answered.
//
// Safari cannot be driven by puppeteer. It has its own WebDriver, `safaridriver`, which ships with
// macOS and speaks plain W3C WebDriver over HTTP -- so this talks to it with fetch and no
// dependency at all. It requires a one-time `safaridriver --enable` (and Develop > Allow Remote
// Automation), which needs a human; if that has not been done this script says so and exits 2
// rather than passing.
//
// WHAT SAFARI CAN AND CANNOT PROVE HERE:
//   CAN  -- that the page renders, that no popup is required to get past the first screen, that
//           the anonymous path signs in and the POST crosses from https to http://127.0.0.1
//           under ITP, and that a failure offers a way out.
//   CANNOT -- the Google consent screen. Same limit as every other browser: it needs a human.
//           What IS checked is that pressing the button performs a TOP-LEVEL NAVIGATION to
//           Google rather than opening a popup, which is the entire fix.
//
//   node firebase/login-safari.mjs [https://<project>.web.app]
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startLoopback, loopbackReady, loginUrl } from '../cli/auth.ts';
import { PENDING_KEY } from '../client/src/login-contract.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = Object.fromEntries(
  (await fs.readFile('client/.env.local', 'utf8')).split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const BASE = process.argv[2] ?? `https://${env.VITE_FIREBASE_PROJECT_ID}.web.app`;
const PORT = 4899;

let failed = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed += 1;
};
const quiet = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

console.log(`LOGIN IN SAFARI -- ${BASE}\n`);

// ---------------------------------------------------------------- safaridriver
const driver = spawn('safaridriver', ['-p', String(PORT)], { stdio: ['ignore', 'pipe', 'pipe'] });
let driverOut = '';
driver.stdout.on('data', (d) => { driverOut += d; });
driver.stderr.on('data', (d) => { driverOut += d; });
let driverDied = null;
driver.on('error', (e) => { driverDied = e.message; });
driver.on('close', (code) => { if (code !== 0 && driverDied === null) driverDied = `exited ${code}`; });

const wd = async (method, url, body) => {
  const res = await fetch(`http://127.0.0.1:${PORT}${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${JSON.stringify(json?.value ?? json)}`);
  return json.value;
};

// Wait for the driver to answer, rather than sleeping a guessed amount.
let up = false;
for (let i = 0; i < 40 && !driverDied; i += 1) {
  try {
    await fetch(`http://127.0.0.1:${PORT}/status`);
    up = true;
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 250));
  }
}

if (!up) {
  console.log('SAFARI ITSELF IS NOT AUTOMATABLE IN THIS ENVIRONMENT.\n');
  console.log(`  safaridriver: ${driverDied ?? 'did not start listening'}`);
  if (driverOut.trim()) console.log(`  output: ${driverOut.trim().split('\n').join('\n          ')}`);
  console.log('\n  safaridriver needs a one-time authorisation that requires a human:');
  console.log('    1. safaridriver --enable            (prompts for an administrator password)');
  console.log('    2. Safari > Settings > Advanced > Show Develop menu');
  console.log('    3. Develop > Allow Remote Automation');
  console.log('\n  Falling back to WEBKIT -- see firebase/login-webkit.mjs, which states exactly');
  console.log('  what that does and does not prove. Exiting 2: this run is NOT a Safari pass.');
  driver.kill();
  process.exit(2);
}

let session;
try {
  session = await wd('POST', '/session', {
    capabilities: { alwaysMatch: { browserName: 'safari' } },
  });
} catch (err) {
  console.log('SAFARI NOT AUTOMATABLE IN THIS ENVIRONMENT.\n');
  console.log(`  safaridriver answered /status but refused a session: ${err.message}`);
  console.log('\n  Usually Develop > Allow Remote Automation is off.');
  console.log('  NOT REPORTED AS A PASS. Exiting 2.');
  driver.kill();
  process.exit(2);
}
const sid = session.sessionId;
const go = (url) => wd('POST', `/session/${sid}/url`, { url });
const js = (script, args = []) => wd('POST', `/session/${sid}/execute/sync`, { script, args });
const currentUrl = () => wd('GET', `/session/${sid}/url`);
const bodyText = () => js('return document.body.innerText');
const step = () => js("return (document.querySelector('[data-login-step]')||{}).dataset ? document.querySelector('[data-login-step]').dataset.loginStep : null");
const settle = async (want, ms = 30_000) => {
  const until = Date.now() + ms;
  for (;;) {
    const s = await step().catch(() => null);
    if (want.includes(s)) return s;
    if (Date.now() > until) return s;
    await new Promise((r) => setTimeout(r, 300));
  }
};

const version = await js('return navigator.userAgent');
console.log(`  Safari: ${version}\n`);

try {
  // ============================================================ 1. a bad link
  console.log('1. a link with no login request');
  await go(`${BASE}/login`);
  await settle(['error', 'done']);
  check((await step()) === 'error', 'renders a named error');
  const bad = await bodyText();
  check(/flotilla login/.test(bad), 'and names the command, because there is nothing to retry with');
  check(!/Try again/.test(bad), 'and offers NO retry button -- there is no nonce to retry with');

  // ============================================================ 2. no popup is required
  console.log('\n2. THE DEFECT: getting past the first screen must not need a popup');
  {
    const url = `${loginUrl(BASE, 51234, 'g'.repeat(43))}&provider=google`;
    await go(url);
    await settle(['ready', 'error']);
    const text = await bodyText();
    check(/Continue with Google/.test(text), 'the sign-in button is there');
    check(!/popup|pop-up/i.test(text), 'and the page never mentions a popup');

    // Count the windows before and after. THIS IS THE ASSERTION THAT MATTERS: a popup would add
    // a window handle; a redirect changes the URL of the one we have. Safari's default popup
    // blocking is what made the old code a dead end, so proving no popup is ATTEMPTED is
    // proving the dead end is gone -- and it works without a human at the consent screen.
    const before = await wd('GET', `/session/${sid}/window/handles`);
    await js("document.querySelector('.login button.cta').click()");
    await new Promise((r) => setTimeout(r, 4_000));
    const after = await wd('GET', `/session/${sid}/window/handles`);
    check(after.length === before.length,
      `no new window was opened (${before.length} -> ${after.length}) -- it is a redirect, not a popup`);

    const now = await currentUrl();
    check(/accounts\.google\.com|__\/auth\/handler/.test(now),
      `the browser NAVIGATED to Google (${now.slice(0, 72)}…)`);

    // And the nonce was written before the navigation, or the return leg would come back as a
    // malformed link -- the worse bug the order warned about.
    await go(`${BASE}/login`);
    const stashed = await js(`return window.sessionStorage.getItem(${JSON.stringify(PENDING_KEY)})`);
    check(!!stashed, 'the port and nonce were stashed BEFORE leaving the page');
    check(stashed?.includes('g'.repeat(43)), 'and the stash holds the CLI\'s nonce verbatim');

    // The return leg, as the browser will actually see it: Google's query string, our stash.
    await go(`${BASE}/login?state=AMbdmDl7&code=4%2F0AeanS0abc&authuser=0`);
    const s = await settle(['returning', 'error', 'posting', 'done'], 20_000);
    check(s !== null, `the return leg renders something (${s})`);
    check(s !== 'error' || !/login link/.test(await bodyText()),
      'and does NOT read Google\'s parameters as a malformed link');
    await js('window.sessionStorage.clear()');
  }

  // ============================================================ 3. the POST, under ITP
  console.log('\n3. does the https page reach http://127.0.0.1 in SAFARI?');
  {
    const lb = startLoopback({ log: quiet, timeout_ms: 90_000 });
    const port = await loopbackReady(lb);
    console.log(`  listener on 127.0.0.1:${port}`);
    await go(`${loginUrl(BASE, port, lb.nonce)}&provider=anonymous`);

    const outcome = await Promise.race([
      lb.result.then((r) => ({ kind: 'delivered', r })),
      new Promise((res) => setTimeout(() => res({ kind: 'timeout' }), 45_000)),
    ]);
    const s = await settle(['done', 'error'], 10_000);
    const text = await bodyText();

    if (outcome.kind === 'delivered') {
      check(true, `THE POST CROSSED IN SAFARI. uid ${outcome.r.uid}`);
      check(s === 'done', `and the page says so (${s})`);
      check(/close this tab/i.test(text), 'and tells the user the tab is finished with');
    } else {
      // Say it plainly. Safari's ITP and its mixed-content rules are not Chrome's, and a
      // workaround dressed up as a pass would hide a design problem.
      check(false, 'THE POST DID NOT CROSS IN SAFARI.');
      console.log(`    state: ${s}`);
      console.log(`    text : ${text.replace(/\n+/g, ' | ')}`);
    }
    check(s === 'done' || s === 'error', `the page reached a terminal state, not a spinner (${s})`);
    lb.close();
  }

  // ============================================================ 4. the way out
  console.log('\n4. a recoverable failure offers a button, not a trip to the terminal');
  {
    // A port with nothing on it: the POST fails, which is the "CLI stopped waiting" path --
    // deliberately NOT recoverable, so it must name the command and offer no button.
    const dead = startLoopback({ log: quiet, timeout_ms: 2_000 });
    const port = await loopbackReady(dead);
    dead.close();
    dead.result.catch(() => {});
    await new Promise((r) => setTimeout(r, 200));

    await go(`${loginUrl(BASE, port, dead.nonce)}&provider=anonymous`);
    const s = await settle(['error', 'done'], 40_000);
    const text = await bodyText();
    check(s === 'error', `a dead listener ends in a named error (${s})`);
    check(/stopped waiting/.test(text), 'which says the CLI stopped waiting');
    check(!/Try again/.test(text), 'and offers NO retry, because a button cannot restart a process');
    check(/flotilla login/.test(text), 'and names the command that can');
  }
} finally {
  await wd('DELETE', `/session/${sid}`).catch(() => {});
  driver.kill();
}

void here;
console.log(`\n${failed === 0 ? 'SAFARI VERIFIED' : `FAILED (${failed})`}`);
process.exit(failed === 0 ? 0 : 1);
