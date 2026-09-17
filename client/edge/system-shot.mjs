// THE FIVE THINGS KANBAN CALM SPECIFIED AND NEVER GOT, MEASURED IN A BROWSER. Order 0066.
//
// None of the five is visible to a server render. `client/edge/run.mjs` scored 177/177 on a page
// with an unstyled brand mark and no centring, and it would score 177/177 on a page with no focus
// ring, jittering digits, no loading state and dead cards -- because renderToStaticMarkup has no
// layout engine, no :focus-visible heuristic, no font metrics and no media queries.
//
// So everything here is measured off a live Chromium:
//
//   1. focus ring   tab to a card and read its computed outline; click it with a MOUSE and read
//                   it again. Both halves -- a rule written with :focus instead of :focus-visible
//                   passes the first and fails the second.
//   2. tabular nums two counts with the SAME digit count must measure the same width. See the
//                   note at that test for why "9 then 10" cannot be the literal assertion.
//   3. skeleton     board height and position before data and after data, in px.
//   4. card states  the computed transform at rest, under hover and under :active -- then all of
//                   it again with prefers-reduced-motion forced on.
//   5. balance      computed text-wrap on a title and on panel body copy.
//
// IT BUILDS ITS OWN BOARD. An earlier version pointed at proj_inventory and signed in
// anonymously, which fails for a reason worth recording: a fresh anonymous uid is a member of
// nothing, so the board went to the denied state and there was no `.board` to measure. The
// alternative -- walking the --admit flow -- leaves another anonymous viewer on a real project
// every run, which is the litter this repo has already paid for once.
//
// So the probe creates a throwaway project with a throwaway member, fills it using the port's own
// createTask (order 0063), measures, and deletes everything. Real Firestore, real rules, real
// identity, nothing left behind.
//
//   node client/edge/system-shot.mjs [http://localhost:4173]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';

import { createFirestoreStore } from '../../firebase/store.ts';
import { CapturingLogger } from '../../shared/log.ts';
import { systemClock } from '../../shared/clock.ts';

const BASE = process.argv[2] ?? 'http://localhost:4173';
const SIGNIN_CARD = '.login[data-signin="board"]';
const STAMP = Date.now().toString(36);
const PID = `proj_uiprobe_${STAMP}`;
const UID = `uiprobe_${STAMP}`;

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, 'shots');
await fs.mkdir(OUT, { recursive: true });

let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const CONFIG = await (await fetch(
  `https://${process.env.FB_PROJECT_ID ?? 'multiplayer-agents-eec02'}.web.app/__/firebase/init.json`)).json();
/** Matches client/package.json, so both SDK copies agree on the persisted-session format. */
const SDK = '12.18.0';

const admin = initializeApp(
  { projectId: process.env.FB_PROJECT_ID ?? 'multiplayer-agents-eec02' }, `system-shot-${Date.now()}`);
const db = getFirestore(admin);
const store = createFirestoreStore({ db, log: new CapturingLogger(), clock: systemClock, debounce_ms: 0 });

/**
 * A board with cards on it, owned by a uid this probe controls.
 *
 * The 47-character title is not arbitrary: dashboard.md's edge-case table uses exactly that
 * length, and it is the length at which a two-line wrap drops a single orphaned word -- which is
 * what `text-wrap: balance` exists to prevent. Measuring balance on a short title would prove
 * nothing.
 */
const TITLES = [
  'Wire the items list to the new contract v2',
  // 49 characters. dashboard.md's edge-case table uses a 47-character title for exactly this
  // reason: it is the length at which a two-line wrap drops a single orphaned word.
  'Add pagination and empty states to the items list',
  'Smoke test the claim race under ten agents',
];

async function seed() {
  await db.collection('projects').doc(PID).set({
    project_id: PID, project_name: 'UI Probe', repo_url: 'flotilla/ui-probe',
    created_at: new Date().toISOString(), created_by: UID,
  });
  await db.collection('projects').doc(PID).collection('members').doc(UID).set({
    uid: UID, role: 'owner', label: 'ui probe', revoked: false, added_at: new Date().toISOString(),
  });
  for (const title of TITLES) {
    await store.createTask(
      PID,
      {
        title, kind: 'frontend',
        // EVERY task gets a description, so the detail panel always has body copy to measure
        // `text-wrap: pretty` on. The first version described only one, the board sorts by
        // task_id, and the assertion landed on a panel with no paragraph -- where it passed by
        // way of an `|| element is absent` branch, which is a check that cannot fail.
        description:
          'Replace the hand-rolled fetch with the generated client, and make the empty state say '
          + 'which filter is hiding the rows rather than implying there are none.',
      },
      { actor_type: 'member', actor_id: UID },
    );
  }
}

async function cleanup() {
  const proj = db.collection('projects').doc(PID);
  for (const sub of ['tasks', 'events', 'agents', 'claims', 'locks', 'contracts', 'meta', 'members', 'roles']) {
    const docs = await proj.collection(sub).get();
    await Promise.all(docs.docs.map((d) => d.ref.delete()));
  }
  await proj.delete();
  await getAuth(admin).deleteUser(UID).catch(() => {});
}

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });

/**
 * A page signed in as UID, via a custom token.
 *
 * Same mechanism as client/edge/session-shot.mjs and the same reasoning: a second SDK copy from
 * the CDN writes the session into this origin's IndexedDB, and after a reload THE SHIPPED BUNDLE
 * restores it through its own persistence and its own onAuthStateChanged. The board is not
 * modified for the test.
 */
async function signedInPage({ reducedMotion = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  if (reducedMotion) {
    await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  }
  const token = await getAuth(admin).createCustomToken(UID);
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 60_000 });
  await page.evaluate(async (t, cfg, sdk) => {
    const [{ initializeApp }, auth] = await Promise.all([
      import(`https://www.gstatic.com/firebasejs/${sdk}/firebase-app.js`),
      import(`https://www.gstatic.com/firebasejs/${sdk}/firebase-auth.js`),
    ]);
    const app = initializeApp(cfg, '[DEFAULT]');
    const a = auth.getAuth(app);
    await auth.setPersistence(a, auth.browserLocalPersistence);
    await auth.signInWithCustomToken(a, t);
  }, token, CONFIG, SDK);
  return page;
}

/** Navigate to the board and wait for real cards. */
async function openBoard(page) {
  await page.goto(`${BASE}/p/${PID}`, { waitUntil: 'networkidle2', timeout: 60_000 });
  await page.waitForFunction(() => document.querySelector('.card') !== null, { timeout: 45_000 });
  await new Promise((r) => setTimeout(r, 800));
}

try {
  console.log(`\ndesign system probe -- ${BASE}, real Chromium, throwaway project ${PID}\n`);
  await seed();

  // ============ 3. THE SKELETON, measured across the arrival of real data ============
  {
    console.log('3. loading skeleton');
    const page = await signedInPage();
    // domcontentloaded, not networkidle: the skeleton is what is painted first and the race is
    // won by asking immediately.
    await page.goto(`${BASE}/p/${PID}`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(
      () => document.querySelector('.sk-board') !== null || document.querySelector('.card') !== null,
      { timeout: 45_000 });

    const before = await page.evaluate(() => {
      const b = document.querySelector('.board');
      const r = b?.getBoundingClientRect();
      return {
        isSkeleton: !!document.querySelector('.sk-board'),
        boardH: r?.height ?? null, boardTop: r?.top ?? null,
        cols: document.querySelectorAll('.col').length,
        blocks: document.querySelectorAll('.sk-card').length,
        bareText: /^\s*(Connecting|Loading the board)/.test(document.body.innerText),
      };
    });
    check(before.isSkeleton, 'the cold board renders a skeleton, not bare text');
    check(before.bareText === false, 'and NOT the words the user twice read as a broken app');
    check(before.cols === 6, 'the skeleton has the real board shape: six columns', `${before.cols}`);
    check(before.blocks > 0, 'with card-height blocks in them', `${before.blocks} blocks`);
    if (before.isSkeleton) {
      await page.screenshot({ path: path.join(OUT, '0066-skeleton-1440.png') });
      console.log(`  shot  ${path.join(OUT, '0066-skeleton-1440.png')}`);
    }

    await page.waitForFunction(() => document.querySelector('.card') !== null, { timeout: 45_000 });
    await new Promise((r) => setTimeout(r, 1_000));
    const after = await page.evaluate(() => {
      const b = document.querySelector('.board');
      const r = b?.getBoundingClientRect();
      return { boardH: r?.height ?? null, boardTop: r?.top ?? null,
        cols: document.querySelectorAll('.col').length,
        skeletonGone: document.querySelector('.sk-board') === null };
    });

    const dh = Math.abs((after.boardH ?? -999) - (before.boardH ?? 0));
    const dt = Math.abs((after.boardTop ?? -999) - (before.boardTop ?? 0));
    check(after.skeletonGone, 'the skeleton is replaced, not layered under the board');
    check(dh < 4, 'the board does not resize when real data arrives',
      `${before.boardH?.toFixed(1)}px -> ${after.boardH?.toFixed(1)}px (delta ${dh.toFixed(1)}px)`);
    check(dt < 4, 'and does not move: the chrome above it is the same height either way',
      `top ${before.boardTop?.toFixed(1)} -> ${after.boardTop?.toFixed(1)} (delta ${dt.toFixed(1)}px)`);
    check(after.cols === 6, 'and the loaded board has the same six columns', `${after.cols}`);
    await page.screenshot({ path: path.join(OUT, '0066-loaded-1440.png') });
    console.log(`  shot  ${path.join(OUT, '0066-loaded-1440.png')}`);
    await page.close();
    console.log('');
  }

  const page = await signedInPage();
  await openBoard(page);

  // ============ 1. THE FOCUS RING, both halves ============
  {
    console.log('1. focus ring');
    const byKeyboard = await (async () => {
      for (let i = 0; i < 40; i += 1) {
        await page.keyboard.press('Tab');
        const r = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || !el.classList.contains('card')) return null;
          const cs = getComputedStyle(el);
          return {
            outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth,
            outlineColor: cs.outlineColor, outlineOffset: cs.outlineOffset,
            matchesFocusVisible: el.matches(':focus-visible'),
          };
        });
        if (r) return r;
      }
      return null;
    })();
    check(!!byKeyboard, 'tab reaches a task card');
    check(byKeyboard?.matchesFocusVisible === true, 'and the browser calls that focus-visible');
    check(byKeyboard?.outlineStyle === 'solid' && parseFloat(byKeyboard?.outlineWidth ?? '0') >= 2,
      'a VISIBLE ring is drawn on it',
      `${byKeyboard?.outlineStyle} ${byKeyboard?.outlineWidth}`);
    check(byKeyboard?.outlineColor === 'rgb(15, 118, 110)', 'in --teal', byKeyboard?.outlineColor);
    check(parseFloat(byKeyboard?.outlineOffset ?? '0') > 0,
      'at an offset so it clears the card edge', byKeyboard?.outlineOffset);
    await page.screenshot({ path: path.join(OUT, '0066-focus-ring.png') });

    // THE OTHER HALF, ON A PAGE THAT HAS NEVER SEEN A KEY PRESS.
    //
    // This is the mouse-only user, and the distinction matters: Chrome's focus-visible heuristic
    // is MODAL, so clicking the very element you just tabbed to keeps the ring. Reusing the page
    // above reported a ring after a mouse click and looked like a :focus-vs-:focus-visible bug in
    // the CSS. It was the probe modelling a user who does not exist. Found by running it.
    const mouseOnly = await signedInPage();
    await openBoard(mouseOnly);
    const at = await mouseOnly.evaluate(() => {
      const r = document.querySelector('.card').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await mouseOnly.mouse.click(at.x, at.y);
    await new Promise((r) => setTimeout(r, 250));
    const afterClick = await mouseOnly.evaluate(() => {
      const el = document.activeElement;
      const cs = getComputedStyle(el);
      return {
        isCard: el?.classList.contains('card') ?? false,
        matchesFocusVisible: el?.matches(':focus-visible') ?? null,
        outlineStyle: cs.outlineStyle, outlineWidth: cs.outlineWidth,
      };
    });
    check(afterClick.isCard, 'a mouse click focuses the card (it is a real button)');
    check(afterClick.matchesFocusVisible === false,
      'but the browser does NOT call that focus-visible');
    check(afterClick.outlineStyle === 'none' || parseFloat(afterClick.outlineWidth) === 0,
      'so no ring is left behind -- the other half',
      `${afterClick.outlineStyle} ${afterClick.outlineWidth}`);
    await mouseOnly.close();
    console.log('');
  }

  // ============ 2. TABULAR NUMBERS ============
  //
  // WHAT THE ORDER ASKED FOR, AND WHAT IS ACTUALLY MEASURABLE. The order says "render a count at
  // 9 then 10 and assert the element's width does not change". That cannot hold literally: 10 is
  // one more digit than 9 and is therefore wider under any font, tabular or not. Measured and
  // reported below rather than silently substituted.
  //
  // The invariant tabular figures DO give, and the one the jitter is actually about, is that two
  // numbers with the SAME digit count measure the same. Proportional Inter renders "11" narrower
  // than "18", so a live count ticking 18 -> 11 shifts every pill to its right. That is asserted,
  // with a control that turns the property off and shows the same measurement diverging.
  {
    console.log('2. tabular numbers');
    const m = await page.evaluate(() => {
      // MEASURED ON A SANS ELEMENT. The first version measured `.count`, which is --mono and
      // therefore already fixed-width -- so its control could not fail and reported 11 = 18 = 90
      // with the property switched OFF too. The order says it plainly: "the mono family is
      // already there for ids and branches -- this is for the numbers that live in sans." The
      // freshness pill and the badges are those numbers.
      const probe = document.createElement('span');
      probe.className = 'fresh';
      probe.style.position = 'absolute';
      probe.style.visibility = 'hidden';
      document.body.appendChild(probe);
      const w = (text, tabular) => {
        probe.style.fontVariantNumeric = tabular ? '' : 'normal';
        probe.style.fontFeatureSettings = tabular ? '' : '"tnum" 0';
        probe.textContent = text;
        return probe.getBoundingClientRect().width;
      };
      const out = {
        tnum: { a: w('11', true), b: w('18', true), c: w('90', true) },
        off: { a: w('11', false), b: w('18', false), c: w('90', false) },
        nine: w('9', true), ten: w('10', true),
        family: getComputedStyle(probe).fontFamily,
        applied: getComputedStyle(document.querySelector('.count') ?? probe).fontVariantNumeric,
        fresh: getComputedStyle(document.querySelector('.fresh') ?? probe).fontVariantNumeric,
      };
      probe.remove();
      return out;
    });
    const span = (o) => Math.max(o.a, o.b, o.c) - Math.min(o.a, o.b, o.c);
    check(!/mono/i.test(m.family),
      '(control) measured on a PROPORTIONAL family, where the jitter actually happens', m.family);
    check(span(m.tnum) < 0.5, 'two-digit numbers all measure the same width with tabular figures',
      `11=${m.tnum.a.toFixed(2)} 18=${m.tnum.b.toFixed(2)} 90=${m.tnum.c.toFixed(2)}`);
    check(span(m.off) > 0.5, '(control) and they do NOT without it -- the measurement can fail',
      `11=${m.off.a.toFixed(2)} 18=${m.off.b.toFixed(2)} 90=${m.off.c.toFixed(2)}`);
    check(/tabular-nums/.test(m.applied), 'the live .count element has it applied', m.applied);
    check(/tabular-nums/.test(m.fresh), 'and so does the freshness pill', m.fresh);
    console.log(`  note  9 -> 10 measures ${m.nine.toFixed(2)}px -> ${m.ten.toFixed(2)}px. One extra ` +
      `digit is one extra digit; tabular figures make the step PREDICTABLE, not absent.`);
    console.log('');
  }

  // ============ 4. HOVER AND PRESS ============
  //
  // ON A CARD NOTHING HAS SELECTED. `.card[data-sel="true"]` replaces the box-shadow with the
  // teal selection ring and wins on source order, so measuring a selected card reported "hover
  // does not deepen the shadow" -- true of that card, and nothing to do with hover. The earlier
  // sections click a card, so this uses `.card:not([data-sel="true"])`. Found by running it.
  {
    console.log('4. card hover and press');
    const SEL = '.card:not([data-sel="true"])';
    const at = await page.evaluate((s) => {
      const r = document.querySelector(s).getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }, SEL);
    await page.mouse.move(5, 5);
    await new Promise((r) => setTimeout(r, 300));
    const rest = await page.evaluate((s) => {
      const cs = getComputedStyle(document.querySelector(s));
      return { transform: cs.transform, boxShadow: cs.boxShadow, transition: cs.transitionProperty };
    }, SEL);
    check(rest.transform === 'none', 'at rest a card has no transform', rest.transform);
    check(/transform/.test(rest.transition) && /box-shadow/.test(rest.transition),
      'and transitions transform and box-shadow', rest.transition);
    check(!/\b(width|height|top|left)\b/.test(rest.transition),
      '(control) no layout property is in the transition list', rest.transition);

    await page.mouse.move(at.x, at.y);
    await new Promise((r) => setTimeout(r, 400));
    const hover = await page.evaluate((s) => {
      const cs = getComputedStyle(document.querySelector(s));
      return { transform: cs.transform, boxShadow: cs.boxShadow };
    }, SEL);
    check(hover.transform !== 'none', 'hover lifts the card', hover.transform);
    check(hover.boxShadow !== rest.boxShadow, 'and deepens its shadow',
      `${rest.boxShadow} -> ${hover.boxShadow}`);

    await page.mouse.down();
    await new Promise((r) => setTimeout(r, 300));
    const press = await page.evaluate(
      (s) => getComputedStyle(document.querySelector(s)).transform, SEL);
    await page.mouse.up();
    check(press !== 'none' && press !== hover.transform,
      'press applies a distinct transform', `hover ${hover.transform} vs press ${press}`);
    console.log('');
  }

  // ============ 5. TEXT WRAP ============
  {
    console.log('5. text balance');
    // Open the panel so there is body copy to measure.
    await page.evaluate(() => document.querySelector('.card')?.click());
    await new Promise((r) => setTimeout(r, 600));
    const wrap = await page.evaluate(() => {
      const t = document.querySelector('.card .title');
      const p = document.querySelector('.sect p');
      const cs = (el) => (el ? (getComputedStyle(el).textWrap || getComputedStyle(el).textWrapStyle) : null);
      return {
        title: cs(t), body: cs(p),
        longest: Math.max(...[...document.querySelectorAll('.card .title')]
          .map((e) => (e.textContent ?? '').length), 0),
      };
    });
    check(/balance/.test(wrap.title ?? ''), 'card titles are balanced', wrap.title ?? 'no title');
    // Strict. An `|| the element is absent` branch here would be a check that cannot fail.
    check(/pretty/.test(wrap.body ?? ''),
      'and panel body copy is `pretty`, not `balance`', wrap.body ?? 'no panel body found');
    console.log(`  note  longest title on this board: ${wrap.longest} chars`);
    console.log('');
  }

  await page.close();

  // ============ THE MOTION PREFERENCE, with the run above as its control ============
  //
  // "A motion preference that only covers page transitions is not honoured." The same two states
  // are measured again with prefers-reduced-motion forced on. Section 4 is the control: it proves
  // the transform is PRESENT, which is what makes its absence here mean anything.
  {
    console.log('constraint: prefers-reduced-motion');
    const rm = await signedInPage({ reducedMotion: true });
    await openBoard(rm);
    const at = await rm.evaluate(() => {
      const r = document.querySelector('.card').getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    });
    await rm.mouse.move(at.x, at.y);
    await new Promise((r) => setTimeout(r, 350));
    const hover = await rm.evaluate(() => {
      const cs = getComputedStyle(document.querySelector('.card'));
      return { transform: cs.transform, boxShadow: cs.boxShadow, transition: cs.transitionProperty };
    });
    await rm.mouse.down();
    await new Promise((r) => setTimeout(r, 250));
    const press = await rm.evaluate(() => getComputedStyle(document.querySelector('.card')).transform);
    await rm.mouse.up();

    check(hover.transform === 'none', 'reduced motion suppresses the hover lift', hover.transform);
    check(press === 'none', 'and the press transform', press);
    check(hover.transition === 'none' || hover.transition === 'all',
      'and the transition itself', hover.transition);
    // NOT suppressed, deliberately: reduced motion is a request about movement, not a request to
    // remove feedback. The card must still respond to being pointed at.
    check(hover.boxShadow !== 'none', 'but the card still RESPONDS -- the shadow change stays');

    const sheen = await rm.evaluate(() => {
      const el = document.createElement('div');
      el.className = 'sk sk-card';
      document.body.appendChild(el);
      const cs = getComputedStyle(el);
      const out = { animationName: cs.animationName };
      el.remove();
      return out;
    });
    check(sheen.animationName === 'none',
      'and the skeleton sheen, which is exactly the loop this preference is set for',
      sheen.animationName);
    await rm.close();
  }
} finally {
  await browser.close();
  // Leave nothing behind. A probe that litters a live project is the self-test that accumulated
  // four "self test" cards on the real board.
  await cleanup().catch((e) => console.error(`  cleanup failed: ${e}`));
  await deleteApp(admin);
}

console.log(`\n${failed === 0 ? 'DESIGN SYSTEM PROBE PASSED' : 'DESIGN SYSTEM PROBE FAILED'}\n`);
process.exitCode = failed === 0 ? 0 : 1;
