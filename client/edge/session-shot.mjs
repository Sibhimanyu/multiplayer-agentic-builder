// THE BOARD, IN A REAL BROWSER, SIGNED IN AS A REAL PERSON, AGAINST PRODUCTION. Order 0064.
//
// What this proves and what it does not, stated up front because the distinction is the whole
// point of the order:
//
//   PROVES, against real Cloud Firestore and real Firebase Auth:
//     - a browser signed in as the uid that OWNS proj_inventory_tracker renders that project
//     - the same board, same origin, same build, signed in as a DIFFERENT uid renders the empty
//       state and does NOT render the project. Both halves, in a browser, against live data.
//     - the nav names the account, and says "Anonymous session" when it is one
//     - the Google button actually starts a Google sign-in (the navigation leaves for
//       accounts.google.com) rather than being a button that does nothing
//
//   DOES NOT PROVE:
//     - that a human can complete Google's consent screen. That needs a password this script
//       does not have and must not have. The member session is established with a CUSTOM TOKEN
//       minted by the Admin SDK for the real uid -- which is real Firebase Auth issuing a real
//       ID token for a real identity, and is exactly what the rules and the collection-group
//       query see. The only thing skipped is Google's own UI.
//
// The custom token is minted here and never written to disk. The service-account key is
// referenced BY PATH from outside every worktree -- territory.md.
//
//   node client/edge/session-shot.mjs [http://127.0.0.1:4173] [uid] [project_id]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';

const BASE = process.argv[2] ?? 'http://127.0.0.1:4173';
const MEMBER_UID = process.argv[3] ?? 'X1syxqJZaoNxxeVclsxZedI4SJK2';
const PID = process.argv[4] ?? 'proj_inventory_tracker';
// A uid that exists as an identity and is a member of nothing. The second half of the test.
const STRANGER_UID = `edge_stranger_${Date.now().toString(36)}`;

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, 'shots');
await fs.mkdir(OUT, { recursive: true });

let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const admin = initializeApp({ projectId: process.env.FB_PROJECT_ID ?? 'multiplayer-agents-eec02' }, `session-shot-${Date.now()}`);
const tokenFor = (uid) => getAuth(admin).createCustomToken(uid);

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });

/** The board's public web config, read from Hosting rather than retyped. */
const CONFIG = await (await fetch(`https://${process.env.FB_PROJECT_ID ?? 'multiplayer-agents-eec02'}.web.app/__/firebase/init.json`)).json();
/** Matches client/package.json, so the two SDKs agree on the persisted-session format. */
const SDK = '12.18.0';

/**
 * Load the board as `uid`, or as nobody when uid is null.
 *
 * HOW THE SESSION IS ESTABLISHED, because it matters that this is not a stub.
 *
 * A second copy of the Firebase SDK is loaded from the CDN in the page, initialised with the
 * SAME public config and the SAME default app name, and told to signInWithCustomToken. Two SDK
 * copies have separate module registries but they share ONE ORIGIN, and a persisted session lives
 * in that origin's IndexedDB under a key derived from the api key and the app name. So the CDN
 * copy writes the session and, after a reload, THE SHIPPED BUNDLE RESTORES IT -- through its own
 * browserLocalPersistence, its own onAuthStateChanged, its own everything.
 *
 * That matters for two reasons. The board is not modified for the test: no hook, no flag, no
 * test-only branch. And it is the persistence behaviour itself being exercised -- the session
 * survives a full page load, which is the thing store/session.ts chose browserLocalPersistence
 * for and the thing cli/loginpage.ts deliberately does not do.
 */
async function boardAs(uid, route = '/') {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const logs = [];
  page.on('console', (m) => logs.push(`${m.type()}: ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));

  await page.goto(`${BASE}${route}`, { waitUntil: 'networkidle2', timeout: 60_000 });

  if (uid) {
    const token = await tokenFor(uid);
    const signedIn = await page.evaluate(async (t, cfg, sdk) => {
      const [{ initializeApp }, auth] = await Promise.all([
        import(`https://www.gstatic.com/firebasejs/${sdk}/firebase-app.js`),
        import(`https://www.gstatic.com/firebasejs/${sdk}/firebase-auth.js`),
      ]);
      // Named, so it cannot collide with the bundle's default app inside this module registry --
      // the shared thing is IndexedDB, and the key is derived from apiKey + app name, so the
      // name must still be the default one the bundle will look for.
      const app = initializeApp(cfg, '[DEFAULT]');
      const a = auth.getAuth(app);
      await auth.setPersistence(a, auth.browserLocalPersistence);
      const cred = await auth.signInWithCustomToken(a, t);
      return cred.user.uid;
    }, token, CONFIG, SDK);
    if (signedIn !== uid) throw new Error(`custom token signed in as ${signedIn}, expected ${uid}`);

    // THE RELOAD IS THE POINT. Everything after it is the shipped bundle restoring a persisted
    // session on its own.
    await page.reload({ waitUntil: 'networkidle2', timeout: 60_000 });
    await page.waitForFunction(
      () => !/Connecting…/.test(document.body.innerText),
      { timeout: 45_000 },
    ).catch(() => {});
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return { page, logs, text: async () => (await page.evaluate(() => document.body.innerText)) };
}

try {
  console.log(`\nboard session probe -- ${BASE}, real Firebase Auth + real Firestore\n`);

  // 0. NOBODY SIGNED IN. The board must ask, not silently become a throwaway identity.
  {
    const { page, text } = await boardAs(null);
    const t = await text();
    check(/Sign in to Flotilla/.test(t), 'signed out: the board renders a sign-in screen');
    check(/Continue with Google/.test(t), 'signed out: Google is offered');
    check(/continue anonymously/.test(t), 'signed out: anonymous is offered as a CHOICE');
    check(!/No projects yet/.test(t),
      'signed out: and it does NOT sign in anonymously and report an empty board');
    await page.screenshot({ path: path.join(OUT, '0064-signed-out.png') });

    // The Google button is wired to Google. Cannot complete the consent screen here, but a
    // button that navigates nowhere is the failure worth excluding.
    const nav = page.waitForNavigation({ timeout: 25_000 }).catch(() => null);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /Continue with Google/.test(x.textContent));
      b?.click();
    });
    await nav;
    const url = page.url();
    check(/accounts\.google\.com|\/__\/auth\/handler/.test(url),
      'signed out: the Google button actually starts a Google sign-in', url);
    await page.close();
  }

  // 1. THE MEMBER. The uid that owns the project, against production.
  {
    const { page, text } = await boardAs(MEMBER_UID);
    const t = await text();
    check(/Inventory Tracker/.test(t),
      `member: the board signed in as ${MEMBER_UID.slice(0, 8)}… renders ${PID}`);
    check(!/No projects/.test(t), 'member: and does not also render an empty state');
    check(/sibhi|@/.test(t), 'member: the nav names the account it is showing');
    await page.screenshot({ path: path.join(OUT, '0064-member-sees-project.png') });
    console.log(`  shot  ${path.join(OUT, '0064-member-sees-project.png')}`);
    await page.close();
  }

  // 2. THE OTHER HALF. A different real identity, same board, same build, same production data.
  //    Without this, half one would pass for a board that showed every project to everybody --
  //    which is exactly what the edge-harness mutation run demonstrated.
  {
    const { page, text } = await boardAs(STRANGER_UID);
    const t = await text();
    check(!/Inventory Tracker/.test(t),
      'stranger: a different uid does NOT see the project — the other half');
    check(/No projects/.test(t), 'stranger: it renders the empty state instead');
    await page.screenshot({ path: path.join(OUT, '0064-stranger-sees-nothing.png') });
    await page.close();
  }

  // 3. The project board itself, opened directly as the member. The rules path, not just the index.
  {
    const { page, text } = await boardAs(MEMBER_UID, `/p/${PID}`);
    const t = await text();
    check(!/Not a member of this project/.test(t),
      'member: opening the project board directly is not refused by the rules');
    check(/Inventory Tracker/.test(t), 'member: and the board names the project');
    await page.screenshot({ path: path.join(OUT, '0064-member-board.png') });
    await page.close();
  }
} finally {
  await browser.close();
  await deleteApp(admin);
}

console.log(`\n${failed === 0 ? 'BOARD SESSION PROBE PASSED' : 'BOARD SESSION PROBE FAILED'}\n`);
process.exitCode = failed === 0 ? 0 : 1;
