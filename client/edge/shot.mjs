// The board in a REAL BROWSER, against LIVE data, with a screenshot. Order 0046.
//
// Why this exists when the edge harness already asserts 60/60: SERVER-RENDERING ASSERTS
// PRESENCE, IT NEVER COMPUTES LAYOUT. The harness could confirm a `.sect` element existed and
// could not see that a grid row had stretched a 10.5px label to 82px. Only a browser has a
// layout engine.
//
// It also walks the real denial path rather than pre-admitting a uid: the page signs in
// anonymously, the rules refuse it because it is not a member, the UI prints the uid and the
// exact `--admit` command, this script READS THE UID OFF THE SCREEN, admits it, and reloads.
// That is the affordance built in order 0039 being exercised by a machine that only knows what a
// user would see.
//
//   node client/edge/shot.mjs [http://127.0.0.1:4173] [project_id]
//
// Chromium comes from `npx puppeteer browsers install chrome`; puppeteer is installed with
// --no-save so no manifest changes.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4173';
const PID = process.argv[3] ?? 'proj_inventory';
const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, 'shots');
const repoRoot = path.resolve(here, '..', '..');

await fs.mkdir(OUT, { recursive: true });

const admit = (uid) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, ['firebase/bridge-run.ts', '--admit', uid], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: 124, out }); }, 90_000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? 1, out }); });
  });

let failed = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed += 1;
};

const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1512, height: 950, deviceScaleFactor: 2 });
  // Console errors, EXCEPT the browser's own unprompted /favicon.ico request. index.html
  // declares no icon, so Chrome asks for one anyway and the preview server 404s it. That is the
  // browser's request, not the app's, and counting it would make the check permanently red for a
  // reason no user experiences. Narrowed to that exact URL rather than muting 404s generally --
  // a 404 on a real asset must still fail.
  const consoleErrors = [];
  const ignored = [];
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    const loc = m.location?.()?.url ?? '';
    if (loc.endsWith('/favicon.ico')) { ignored.push(loc); return; }
    consoleErrors.push(text);
  });
  page.on('requestfailed', (r) => {
    if (!r.url().endsWith('/favicon.ico')) consoleErrors.push(`requestfailed ${r.url()}`);
  });

  // ---- 1. the projects index ----
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 60_000 });
  await new Promise((r) => setTimeout(r, 3_000));
  await page.screenshot({ path: path.join(OUT, '1-projects-index.png') });
  const indexText = await page.evaluate(() => document.body.innerText);
  console.log('1. projects index');
  check(/Flotilla/.test(indexText), 'the index renders and is branded Flotilla');

  // ---- 2. the board, denied, naming the uid ----
  await page.goto(`${BASE}/p/${PID}`, { waitUntil: 'networkidle2', timeout: 60_000 });
  // Bounded wait for sign-in + the rules to answer, rather than a fixed sleep.
  await page.waitForFunction(
    () => !/Connecting/.test(document.body.innerText),
    { timeout: 45_000 },
  ).catch(() => {});
  const deniedText = await page.evaluate(() => document.body.innerText);
  await page.screenshot({ path: path.join(OUT, '2-board-denied.png') });
  console.log('\n2. board before admission');

  const uid = /--admit\s+([A-Za-z0-9]+)/.exec(deniedText)?.[1] ?? null;
  if (/Not a member/.test(deniedText)) {
    check(!!uid, `the denied screen NAMES the uid and the command (${uid ?? 'none'})`);
    check(/flotilla|admit/i.test(deniedText), 'and tells the user exactly what to run');
  } else {
    console.log('  (already a member, or a different state)');
  }

  // ---- 3. admit, reload, and render the live board ----
  if (uid) {
    const res = await admit(uid);
    check(res.code === 0, `--admit ${uid.slice(0, 10)}... succeeded`);
  }
  await page.reload({ waitUntil: 'networkidle2', timeout: 60_000 });
  await page.waitForFunction(
    () => document.querySelectorAll('.col').length === 6,
    { timeout: 45_000 },
  ).catch(() => {});
  await new Promise((r) => setTimeout(r, 2_500));

  console.log('\n3. board, live data');
  const cols = await page.$$eval('.col h3', (n) => n.map((x) => x.textContent));
  check(cols.length === 6, `six columns render in a browser (${cols.join(', ')})`);
  const live = await page.$eval('.fresh', (n) => n.getAttribute('data-mode')).catch(() => null);
  check(live === 'live', `the freshness pill reads the store: data-mode="${live}"`);
  await page.screenshot({ path: path.join(OUT, '3-board-live.png') });

  // ---- 4. THE LAYOUT ASSERTION -- the thing SSR cannot do ----
  // Open a task so the detail panel renders, then measure a real .lbl box.
  const opened = await page.evaluate(() => {
    const card = document.querySelector('.card');
    if (!card) return false;
    card.click();
    return true;
  });
  await new Promise((r) => setTimeout(r, 1_200));

  if (opened) {
    const metrics = await page.evaluate(() => {
      const lbl = document.querySelector('.p-body .sect .lbl');
      const body = document.querySelector('.p-body');
      if (!lbl || !body) return null;
      const cs = getComputedStyle(body);
      return {
        lblHeight: Math.round(lbl.getBoundingClientRect().height),
        lblFontSize: getComputedStyle(lbl).fontSize,
        alignContent: cs.alignContent,
        sects: [...document.querySelectorAll('.p-body .sect')].map((s) => Math.round(s.getBoundingClientRect().height)),
      };
    });
    await page.screenshot({ path: path.join(OUT, '4-detail-panel.png') });
    console.log('\n4. detail panel layout (the defect SSR could not see)');
    if (metrics) {
      console.log(`  .p-body align-content  ${metrics.alignContent}`);
      console.log(`  .lbl font-size         ${metrics.lblFontSize}`);
      console.log(`  .lbl measured height   ${metrics.lblHeight}px`);
      console.log(`  .sect heights          ${metrics.sects.join(', ')}px`);
      check(metrics.alignContent === 'start', 'align-content computes to start');
      // The defect was a 10.5px label occupying 82px. A label should be close to its line box.
      check(metrics.lblHeight < 30, `a 10.5px label no longer occupies 82px (now ${metrics.lblHeight}px)`);
    } else {
      console.log('  (no detail panel sections on this task)');
    }
  }

  check(
    consoleErrors.length === 0,
    `no app console errors (${consoleErrors.length})${consoleErrors[0] ? `: ${consoleErrors[0].slice(0, 120)}` : ''}` +
      `${ignored.length ? ` [${ignored.length} favicon 404 ignored, see the handler]` : ''}`,
  );

  const shots = await fs.readdir(OUT);
  console.log(`\nscreenshots in client/edge/shots/: ${shots.join(', ')}`);
} finally {
  await browser.close();
}

console.log(`\n${failed === 0 ? 'BROWSER CHECK PASSED' : `BROWSER CHECK FAILED (${failed})`}`);
process.exit(failed === 0 ? 0 : 1);
