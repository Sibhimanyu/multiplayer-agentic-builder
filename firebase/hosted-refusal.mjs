// Does the hosted page refuse BEFORE the button, in the browser that cannot finish? Order 0061.
//
// The user signed in with Google on the hosted page and was only then told the handoff could not
// work. Every input to that verdict was available on load: the page is https, the engine is
// WebKit, the target is http://127.0.0.1. Nothing about it depended on the sign-in succeeding.
//
// THE CONTROL IS THE POINT OF THIS FILE. "Refuses in WebKit" would also be true of a page that
// refuses everywhere, or of a page that failed to render at all. So the SAME URL is loaded in
// Chromium and the button must BE there. Two engines, opposite expectations, one page.
//
// SAFARI.app IS NOT DRIVEN HERE. safaridriver needs an administrator password; firebase/
// login-safari.mjs exits 2, and that exit 2 means the only engine that implements ITP and Safari's
// own popup rules was never asked. WebKit answers the mixed-content question, which is the one
// this gate turns on.
//
//   node firebase/hosted-refusal.mjs [https://<project>.web.app]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loginUrl, loopbackReady, startLoopback } from '../cli/auth.ts';

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

console.log(`THE HOSTED PAGE'S UP-FRONT REFUSAL -- ${BASE}\n`);

// The page under test must be the one this repo just built, or the suite is asserting about
// whatever the CDN last kept. This caught an hour-stale /login in order 0059.
{
  const local = await fs.readFile(path.join(here, '..', 'client', 'dist', 'index.html'), 'utf8');
  const wanted = /assets\/index-[A-Za-z0-9._-]+\.js/.exec(local)?.[0];
  const served = await (await fetch(`${BASE}/login`, { cache: 'no-store' })).text();
  check(!!wanted && served.includes(wanted), `the deployed page is this repo's build (${wanted})`);
}

// A LIVE listener, so "no button" cannot be explained away as a stale link. The refusal under test
// is about the BROWSER, and this removes the other reason the page could refuse.
const lb = startLoopback({ log: quiet, timeout_ms: 120_000 });
const port = await loopbackReady(lb);
const url = `${loginUrl(BASE, port, lb.nonce)}&provider=google`;
console.log(`  live listener on 127.0.0.1:${port}\n`);

const puppeteer = (await import('puppeteer')).default;
const { webkit } = await import('playwright');
const chromium = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const wk = await webkit.launch();

const settle = async (read, want, ms = 25_000) => {
  const until = Date.now() + ms;
  for (;;) {
    const s = await read().catch(() => null);
    if (want.includes(s)) return s;
    if (Date.now() > until) return s;
    await new Promise((r) => setTimeout(r, 250));
  }
};

// ============================================================ WebKit: must refuse
console.log('1. WEBKIT -- the engine that cannot finish this handoff');
{
  const ctx = await wk.newContext();
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60_000 });
  const read = () => page.evaluate(
    () => document.querySelector('[data-login-step]')?.dataset.loginStep ?? null,
  );
  const step = await settle(read, ['refused', 'ready', 'stale', 'error'], 25_000);
  const text = await page.innerText('body');
  await page.screenshot({ path: path.join(OUT, 'hosted-refused-webkit.png') });

  check(step === 'refused', `the page refuses on load (data-login-step=${step})`);
  // THE ASSERTION THE ORDER IS ABOUT.
  check(!/Continue with Google/.test(text),
    'and NO "Continue with Google" button is rendered -- the refusal comes before Google');
  check(await page.$('button') === null, 'in fact no button at all, so nothing can start the flow');
  // Both escapes, named.
  check(/flotilla login/.test(text), 'it names `flotilla login` — the local page, which works here');
  check(/Chrome/.test(text), 'and names opening this same link in Chrome');
  check(/127\.0\.0\.1/.test(text), 'and says why, rather than refusing without a reason');
  // The user must be able to tell which page they are on.
  check(/Hosted sign-in/.test(text) && /fallback/i.test(text),
    'and the page says on its face that it is the hosted fallback');
  await ctx.close();
}

// ============================================================ Chromium: must NOT refuse
console.log('\n2. CHROMIUM -- THE CONTROL. Without this, "refuses in WebKit" could mean');
console.log('   "refuses in every browser", or "the page is broken".');
{
  const ctx = await chromium.createBrowserContext();
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60_000 });
  const read = () => page.evaluate(
    () => document.querySelector('[data-login-step]')?.dataset.loginStep ?? null,
  );
  const step = await settle(read, ['ready', 'refused', 'stale', 'error'], 25_000);
  const text = await page.evaluate(() => document.body.innerText);
  await page.screenshot({ path: path.join(OUT, 'hosted-ready-chromium.png') });

  check(step === 'ready', `the SAME url is actionable in Chromium (data-login-step=${step})`);
  check(/Continue with Google/.test(text), 'and the sign-in button IS rendered');
  check(!/cannot finish a hosted sign-in/i.test(text), 'with no refusal, because Chrome can finish it');
  // The banner is not a WebKit-only scold: it identifies the page everywhere.
  check(/Hosted sign-in/.test(text), 'and it still identifies itself as the hosted fallback');
  await ctx.close();
}

// ============================================================ the stale tab
console.log('\n3. A RESTORED TAB -- a link whose CLI exited, in Chromium');
{
  const dead = startLoopback({ log: quiet, timeout_ms: 2_000 });
  const deadPort = await loopbackReady(dead);
  dead.close();
  dead.result.catch(() => {});
  await new Promise((r) => setTimeout(r, 200));

  const ctx = await chromium.createBrowserContext();
  const page = await ctx.newPage();
  await page.goto(`${loginUrl(BASE, deadPort, dead.nonce)}&provider=google`,
    { waitUntil: 'networkidle2', timeout: 60_000 });
  const read = () => page.evaluate(
    () => document.querySelector('[data-login-step]')?.dataset.loginStep ?? null,
  );
  const step = await settle(read, ['stale', 'ready', 'refused', 'error'], 25_000);
  const text = await page.evaluate(() => document.body.innerText);
  await page.screenshot({ path: path.join(OUT, 'hosted-stale-chromium.png') });

  // `flotilla login` opens the browser itself now, so nobody reaches this page deliberately --
  // arriving here means a tab restored from a session whose CLI is long gone.
  check(step === 'stale', `a dead listener is caught BEFORE Google (data-login-step=${step})`);
  check(/expired/i.test(text), 'and reads as an expired link');
  check(!/Continue with Google/.test(text), 'with no sign-in button to spend a Google round trip on');
  check(/Sign in anyway/.test(text), 'but an escape, because the probe cannot be certain');
  await ctx.close();
}

lb.close();
lb.result.catch(() => {});
await chromium.close();
await wk.close();

console.log(`\n${failed === 0 ? 'HOSTED REFUSAL VERIFIED' : `FAILED (${failed})`}`);
console.log('');
console.log('  SAFARI.app WAS NOT DRIVEN. safaridriver needs an administrator password, so');
console.log('  firebase/login-safari.mjs exits 2 -- meaning the only engine implementing ITP and');
console.log('  Safari\'s own popup rules was never asked. WebKit answers the mixed-content');
console.log('  question this gate turns on, and nothing more.   sudo safaridriver --enable');
process.exit(failed === 0 ? 0 : 1);
