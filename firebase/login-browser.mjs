// Does the POST actually cross, in a real browser, from https to http://127.0.0.1? Order 0055.
//
// This is the one question the loopback test cannot answer. Node's fetch has no mixed-content
// policy, no CORS, and no Private Network Access rules, so a POST that sails through
// firebase/login-loopback.mjs could still be refused by every browser a user owns. Two browser
// policies are in the way and neither is decidable by reading:
//
//   MIXED CONTENT. The board is https. http://127.0.0.1 is a "potentially trustworthy origin"
//   under the Secure Contexts spec, so it is expected NOT to count as insecure content -- but
//   that is a claim about browser behaviour, and this project has already shipped one page whose
//   existence was assumed.
//
//   PRIVATE NETWORK ACCESS. A request from a public origin to a loopback address is preflighted
//   with `Access-Control-Request-Private-Network: true`, and Chrome may require
//   `Access-Control-Allow-Private-Network: true` in the response. cli/auth.ts answers OPTIONS
//   with a bare 204. If this is enforced, the login is blocked in the browser and it is a CLI
//   change, not a page change.
//
// So: a REAL Chrome, on the REAL hosted https board, with the REAL CLI listener waiting, driving
// the anonymous path end to end. Console and network failures are captured and printed, because
// "the assertion failed" would not say which of the two policies did it.
//
//   node firebase/login-browser.mjs [https://<project>.web.app]
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

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

console.log(`LOGIN IN A REAL BROWSER -- ${BASE}\n`);
check(BASE.startsWith('https://'), 'the board under test is served over https (or the mixed-content question is not being asked)');

// ============================================================ 0. is the page under test CURRENT?
//
// This suite spent a whole run asserting things about a page built three orders earlier. The
// deploy was fine; /login is a REWRITE to /index.html, and the no-cache header rule matched only
// the literal "/index.html", so the rewritten path was served with max-age=3600 and every edge
// held an hour-old login page. A suite that tests whatever the CDN feels like returning is not
// testing this repo.
//
// So: compare the DOWNLOADED page against the REPO's build, the same way the project-id check
// greps the built bundle rather than the source.
console.log('\n0. the deployed page is the one this repo builds');
{
  const local = await fs.readFile(path.join(here, '..', 'client', 'dist', 'index.html'), 'utf8')
    .catch(() => '');
  const wantedAsset = /assets\/[A-Za-z0-9._-]+\.js/.exec(local)?.[0] ?? null;
  check(!!wantedAsset, `client/dist/index.html references ${wantedAsset ?? 'NOTHING -- run the client build'}`);

  const res = await fetch(`${BASE}/login`, { cache: 'no-store' });
  const served = await res.text();
  check(res.headers.get('cache-control') === 'no-cache',
    `/login is served no-cache (${res.headers.get('cache-control')}) -- a rewritten path needs its `
    + 'own rule; "/index.html" does not match "/login"');
  check(!!wantedAsset && served.includes(wantedAsset),
    `and it serves the bundle this repo just built (${wantedAsset})`);

  // The control: this comparison must be able to FAIL. A bundle name that is not there proves the
  // check looks at the served bytes rather than agreeing with itself.
  check(!served.includes('assets/index-thisIsNotARealBundle.js'),
    'and the comparison is against the served bytes, not itself (the control)');
}

const browser = await puppeteer.launch({
  headless: 'new',
  // No --allow-running-insecure-content and no --disable-web-security. Relaxing the policy under
  // test would make this harness answer a question no user's browser is asking.
  args: ['--no-sandbox'],
});

/**
 * `fresh` gives the page its own browser context — a separate profile, so no persisted Firebase
 * session carries over.
 *
 * Found by reading the output rather than the code: sections 3 and 4 reported the SAME anonymous
 * uid. Firebase persists the session in IndexedDB, so the second signInAnonymously() returned the
 * first section's user and section 4 was riding on a sign-in section 3 had already done. Real
 * behaviour for a returning user, and the wrong thing for a test claiming a first-time login.
 */
const newPage = async ({ fresh = false } = {}) => {
  const ctx = fresh ? await browser.createBrowserContext() : browser;
  const page = await ctx.newPage();
  const console_lines = [];
  const failures = [];
  page.on('console', (m) => console_lines.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => console_lines.push(`[pageerror] ${e.message}`));
  page.on('requestfailed', (r) => failures.push(`${r.method()} ${r.url()} -- ${r.failure()?.errorText}`));
  return { page, console_lines, failures };
};

// ============================================================ 1. the route exists at all
console.log('\n1. /login is a page, not the projects index');
{
  const { page } = await newPage();
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle2', timeout: 60_000 });
  const step = await page.$eval('[data-login-step]', (el) => el.dataset.loginStep).catch(() => null);
  check(step !== null, `the login page rendered (data-login-step=${step})`);
  // THE ORIGINAL BUG. Before this order, exactly this URL rendered the projects board.
  const body = await page.evaluate(() => document.body.innerText);
  check(!/Projects\b/.test(body) || /Login failed/.test(body),
    'a bare /login does NOT render the projects index');
  check(step === 'error' && /Login failed at the login link/.test(body),
    'it renders a NAMED error instead, because no CLI started this login');
  check(/flotilla login/.test(body), 'and tells the user the command that does start one');
  await page.screenshot({ path: path.join(OUT, 'login-no-params.png') });
  await page.close();
}

// ============================================================ 2. the Google link renders
console.log('\n2. a Google login link renders something to click');
{
  const { page } = await newPage();
  await page.goto(
    `${loginUrl(BASE, 51234, 'g'.repeat(43))}&provider=google`,
    { waitUntil: 'networkidle2', timeout: 60_000 },
  );
  const body = await page.evaluate(() => document.body.innerText);
  check(/Continue with Google/.test(body), 'the button is on the page');
  // Not clicked: a Google consent screen needs a human. That is the stubbed step, and it is the
  // only one.
  await page.screenshot({ path: path.join(OUT, 'login-google.png') });
  await page.close();
}

// ============================================================ 3. THE QUESTION
console.log('\n3. does the https page reach the http://127.0.0.1 listener?');
let priorUid = null;
{
  const lb = startLoopback({ log: quiet, timeout_ms: 90_000 });
  const port = await loopbackReady(lb);
  const { page, console_lines, failures } = await newPage();

  const url = `${loginUrl(BASE, port, lb.nonce)}&provider=anonymous`;
  console.log(`  listener on 127.0.0.1:${port}; opening the real page`);
  await page.goto(url, { waitUntil: 'networkidle2', timeout: 60_000 });

  // Assert the ARTIFACT the CLI consumes -- the resolved result promise -- not the page's own
  // opinion of how it went. A page that said "signed in" while the CLI waited forever is exactly
  // the failure this is looking for.
  const outcome = await Promise.race([
    lb.result.then((r) => ({ kind: 'delivered', r })),
    new Promise((res) => setTimeout(() => res({ kind: 'timeout' }), 45_000)),
  ]);

  // The CLI resolves the instant the POST lands, which is BEFORE the browser has processed the
  // response and re-rendered. Reading the page in that window caught it mid-flight and failed on
  // text that appeared milliseconds later -- a race in this harness, not in the page. Wait for a
  // terminal state, bounded, so a page that genuinely never resolves still fails.
  await page.waitForFunction(
    () => ['done', 'error'].includes(document.querySelector('[data-login-step]')?.dataset.loginStep),
    { timeout: 15_000 },
  ).catch(() => {});
  const body = await page.evaluate(() => document.body.innerText);
  const step = await page.$eval('[data-login-step]', (el) => el.dataset.loginStep).catch(() => null);
  await page.screenshot({ path: path.join(OUT, 'login-anonymous.png') });

  if (outcome.kind === 'delivered') {
    priorUid = outcome.r.uid;
    check(true, `THE POST CROSSED. The CLI received uid ${outcome.r.uid}`);
    check(!!outcome.r.refresh_token, 'with a refresh token');
    check(step === 'done', `and the page shows the outcome (data-login-step=${step})`);
    check(/You can close this tab/.test(body), 'telling the user the tab is finished with');
  } else {
    // Say so plainly. Do not work around it: a page that cannot reach the listener from an https
    // origin is a DESIGN problem -- the handoff needs a different channel -- and dressing it up
    // as a passing test would hide that.
    check(false, 'THE POST DID NOT CROSS. The CLI never received a credential.');
    console.log(`\n  page state : ${step}`);
    console.log(`  page text  : ${body.replace(/\n+/g, ' | ')}`);
    console.log('  console    :');
    for (const l of console_lines) console.log(`    ${l}`);
    console.log('  failed requests:');
    for (const f of failures) console.log(`    ${f}`);
  }
  lb.close();

  // Whatever happened, the page must have SAID so. A blank page is the bug being fixed.
  check(step === 'done' || step === 'error', `the page reached a terminal state, not a spinner (${step})`);
  check(body.trim().length > 20, 'and it is not blank');
}

// ============================================================ 4. the real command, end to end
//
// Sections 1-3 drive the page with a listener this script started. This one runs THE ACTUAL
// `flotilla login --anonymous` as a child process, scrapes the URL it prints, and points Chrome
// at it -- Chrome standing in for the browser the CLI tried to `open`. Nothing is stubbed: the
// binary picks its own port and nonce, the hosted page signs in and POSTs, and the assertion is
// the CREDENTIAL FILE ON DISK, which is what the next command reads.
console.log('\n4. `flotilla login --anonymous` for real, browser and all');
{
  const SANDBOX = path.join(here, '..', '.agentic', `loginbrowser-${Date.now().toString(36)}`);
  const HOME = path.join(SANDBOX, 'home');
  await fs.mkdir(HOME, { recursive: true });

  // Scrubbed by DELETION, and a fresh HOME rather than a redirected one: an ambient credential
  // is how this project has repeatedly got a true signal about the wrong subject.
  const cenv = { ...process.env, HOME };
  for (const k of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_TOKEN', 'GCLOUD_PROJECT',
    'GOOGLE_CLOUD_PROJECT', 'FLOTILLA_PROJECT', 'FLOTILLA_API_KEY']) delete cenv[k];

  const cli = path.join(here, 'flotilla-main.ts');
  const run = (args, opts = {}) => new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: path.join(here, '..'), env: cenv });
    let out = '';
    child.stdout.on('data', (d) => { out += d; opts.onData?.(out, child); });
    child.stderr.on('data', (d) => { out += d; opts.onData?.(out, child); });
    const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeout ?? 120_000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });

  const init = await run(['init', '--project', env.VITE_FIREBASE_PROJECT_ID]);
  check(init.code === 0, `flotilla init exits 0 (${init.code})`);

  // Drive the browser the moment the CLI prints its URL. The URL is the CLI's own -- its port,
  // its nonce -- so nothing here can accidentally test a login this script invented.
  let opened = null;
  // Held, and awaited below. The CLI exits the moment the credential lands -- before the page has
  // finished settling -- so leaving this detached meant closing Chrome out from under a live
  // navigation. The assertions had already passed; the harness was tearing down mid-flight.
  let driving = Promise.resolve();
  // --hosted, because THIS suite is about the hosted board page. Since order 0057 the default is
  // the CLI-served local page, covered by firebase/login-local.mjs in both engines.
  //
  // --no-browser, because without it the CLI opens the SYSTEM default browser, which completes
  // the login first and leaves the browser under test getting a 409 -- a suite passing on a
  // credential delivered by a browser it does not name.
  const login = await run(['login', '--anonymous', '--hosted', '--no-browser'], {
    onData: (out) => {
      if (opened) return;
      const m = /https:\/\/\S+\/login\?\S+/.exec(out);
      if (!m) return;
      opened = m[0];
      driving = (async () => {
        const { page } = await newPage({ fresh: true });
        await page.goto(opened, { waitUntil: 'networkidle2', timeout: 60_000 });
        await page.waitForFunction(
          () => ['done', 'error'].includes(document.querySelector('[data-login-step]')?.dataset.loginStep),
          { timeout: 30_000 },
        ).catch(() => {});
        await page.screenshot({ path: path.join(OUT, 'login-cli-end-to-end.png') });
        await page.close();
      })();
    },
  });
  await driving;

  check(!!opened, `the CLI printed a login URL and Chrome opened it`);
  check(opened?.includes('provider=anonymous'), '--anonymous reaches the page as provider=anonymous');
  check(login.code === 0, `flotilla login --anonymous exits 0 (${login.code})`);
  check(/signed in as/.test(login.out), 'and reports the identity it received');

  // THE ARTIFACT, not the exit code. A command that printed "signed in" and wrote nothing would
  // leave every later command unauthenticated.
  const credFile = path.join(HOME, '.flotilla', 'credentials.json');
  const stat = await fs.stat(credFile).catch(() => null);
  check(!!stat, 'the credential file exists in the fresh HOME');
  check(stat && (stat.mode & 0o777) === 0o600, `and is 0600 (${stat ? (stat.mode & 0o777).toString(8) : '-'})`);
  const stored = stat ? JSON.parse(await fs.readFile(credFile, 'utf8')) : {};
  check(!!stored.refresh_token && !!stored.uid, `holding a refresh token for uid ${stored.uid}`);
  // And it is a login of its own, not the persisted session from section 3. Without the fresh
  // context these two uids were identical, which made this section a weaker claim than it read as.
  check(!!stored.uid && stored.uid !== priorUid,
    `a NEW identity, not section 3's (${stored.uid} vs ${priorUid})`);
  check(!!stored.uid && login.out.includes(stored.uid), 'the uid on screen is the uid on disk');

  await fs.rm(SANDBOX, { recursive: true, force: true });
}

await browser.close();
console.log(`\n${failed === 0 ? 'BROWSER VERIFIED' : `FAILED (${failed})`}`);
process.exit(failed === 0 ? 0 : 1);
