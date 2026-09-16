// THE SIGNED-OUT PAGE, MEASURED IN A BROWSER AT TWO WIDTHS. Order 0065.
//
// WHY THIS FILE EXISTS RATHER THAN MORE EDGE CASES. client/edge/run.mjs server-renders the real
// components and scored 177/177 on the exact build the user called horrible -- because
// renderToStaticMarkup has no layout engine. It can confirm a heading exists; it cannot see that
// the heading is pinned to the top-left of an empty 1440px viewport, and it cannot see that
// `.mark` is a div containing the letters "FL" instead of the brand SVG. Presence is not layout.
//
// So everything here is a MEASUREMENT taken from a real Chromium: box geometry read back off the
// page, and an image asserted to have actually decoded.
//
// TWO WIDTHS, NOT ONE. A layout that centres at 1440 and breaks at 768 is the bug being fixed,
// not evidence against it, so every geometry assertion runs at both.
//
//   node client/edge/layout-shot.mjs [http://localhost:4173]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const BASE = process.argv[2] ?? 'http://localhost:4173';
const WIDTHS = [
  { w: 1440, h: 900, label: '1440x900' },
  { w: 768, h: 1024, label: '768x1024' },
];
/** How far off centre is acceptable. Sub-pixel rounding and a scrollbar, not a layout opinion. */
const CENTRE_TOLERANCE_PX = 4;

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(here, 'shots');
await fs.mkdir(OUT, { recursive: true });

let failed = 0;
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` -- ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });

/**
 * Open the signed-out page at one viewport size.
 *
 * `breakMark` makes the brand SVG 404 so the text fallback can be asserted as BEHAVIOUR rather
 * than as a branch someone read in the source. Interception is on the request, so the app is
 * unmodified -- it meets a missing asset exactly as it would if the file were deleted.
 */
async function openSignedOut({ w, h }, { breakMark = false } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h });
  const markResponses = [];

  if (breakMark) {
    await page.setRequestInterception(true);
    page.on('request', (r) => {
      if (r.url().includes('flotilla-mark.svg')) {
        void r.respond({ status: 404, contentType: 'text/plain', body: 'gone' });
        return;
      }
      void r.continue();
    });
  }
  page.on('response', (r) => {
    if (r.url().includes('flotilla-mark.svg')) markResponses.push(r.status());
  });

  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 60_000 });
  // The card, not its heading. Order 0066 shortened that heading to "Sign in"; synchronising on
  // a selector rather than on copy means the next wording change does not break four probes.
  await page.waitForFunction(
    () => document.querySelector('.login[data-signin="board"]') !== null,
    { timeout: 45_000 },
  );
  // One frame for the onError swap to commit.
  await new Promise((r) => setTimeout(r, 400));
  return { page, markResponses };
}

/** Geometry, read off the live page. Nothing here is computed from the source. */
const geometry = () => ({
  card: (() => {
    const el = document.querySelector('.login[data-signin="board"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height };
  })(),
  viewport: { w: window.innerWidth, h: window.innerHeight },
  navCount: document.querySelectorAll('nav.nav').length,
  lockupInCard: !!document.querySelector('.login[data-signin="board"] .brand-lockup'),
  mark: (() => {
    const el = document.querySelector('.brand-lockup .mark');
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      tag: el.tagName,
      text: (el.textContent ?? '').trim(),
      complete: el.tagName === 'IMG' ? el.complete : null,
      naturalWidth: el.tagName === 'IMG' ? el.naturalWidth : null,
      currentSrc: el.tagName === 'IMG' ? el.currentSrc : null,
      fontFamily: cs.fontFamily,
      color: cs.color,
      w: r.width, h: r.height,
    };
  })(),
  // How many lines the secondary path occupies. Three was the complaint.
  noteHeight: (() => {
    const p = document.querySelector('.login[data-signin="board"] p.note');
    return p ? p.getBoundingClientRect().height : null;
  })(),
  ctaWidth: (() => {
    const b = document.querySelector('.login[data-signin="board"] .cta');
    return b ? b.getBoundingClientRect().width : null;
  })(),
});

try {
  console.log(`\nsigned-out layout probe -- ${BASE}, real Chromium\n`);

  for (const size of WIDTHS) {
    console.log(`${size.label}`);
    const { page, markResponses } = await openSignedOut(size);
    const g = await page.evaluate(geometry);

    // ---- 1. CENTRED. The measurement the order asked for. ----
    const cardCentre = g.card ? (g.card.left + g.card.right) / 2 : NaN;
    const viewCentre = g.viewport.w / 2;
    const dx = Math.abs(cardCentre - viewCentre);
    check(!!g.card, `${size.label}: the sign-in card renders`);
    check(dx <= CENTRE_TOLERANCE_PX,
      `${size.label}: horizontally centred within ${CENTRE_TOLERANCE_PX}px`,
      `card centre ${cardCentre.toFixed(1)} vs viewport centre ${viewCentre} (off by ${dx.toFixed(1)}px)`);

    const cardMidY = g.card ? (g.card.top + g.card.bottom) / 2 : NaN;
    const dy = Math.abs(cardMidY - g.viewport.h / 2);
    check(dy <= CENTRE_TOLERANCE_PX,
      `${size.label}: vertically centred within ${CENTRE_TOLERANCE_PX}px`,
      `card mid ${cardMidY.toFixed(1)} vs ${g.viewport.h / 2} (off by ${dy.toFixed(1)}px)`);

    // The card must not run to the edges at the narrow width -- centred and full-bleed measure
    // the same distance from centre, so "centred" alone would pass for an unstyled page.
    check(g.card.left >= 12 && g.card.w < g.viewport.w,
      `${size.label}: (control) it is a card with margin, not a full-bleed block`,
      `left ${g.card.left.toFixed(1)}, width ${g.card.w.toFixed(1)} of ${g.viewport.w}`);

    // ---- 2. NO NAV, AND THE LOCKUP IS IN THE CARD ----
    check(g.navCount === 0,
      `${size.label}: no nav strip on a page with no navigation to offer`, `nav count ${g.navCount}`);
    check(g.lockupInCard, `${size.label}: the lockup is inside the card`);

    // ---- 3. THE MARK IS A LOADED SVG, not the letters "FL" ----
    check(g.mark?.tag === 'IMG', `${size.label}: .mark is an <img>, not a div of text`, g.mark?.tag);
    // 200 or 304. The second viewport reuses the browser cache and legitimately gets a 304, which
    // an `=== 200` assertion failed on -- found by running this, not by reading it. What must
    // never appear is a 4xx or 5xx, which is the condition the fallback exists for.
    check(markResponses.length > 0 && markResponses.every((s) => s < 400),
      `${size.label}: /brand/flotilla-mark.svg served`, `status ${markResponses.join(',') || 'never requested'}`);
    // decode() is the definitive answer to "did it load": naturalWidth is unreliable for an SVG
    // with a viewBox and no width attribute, which is exactly what this asset is.
    const decoded = await page.evaluate(async () => {
      const img = document.querySelector('.brand-lockup img.mark');
      if (!img) return 'no img';
      try { await img.decode(); return 'ok'; } catch (e) { return String(e); }
    });
    check(decoded === 'ok', `${size.label}: and the browser actually decoded it`, decoded);
    check((g.mark?.w ?? 0) > 20 && (g.mark?.h ?? 0) > 20,
      `${size.label}: it occupies a real box`, `${g.mark?.w?.toFixed(0)}x${g.mark?.h?.toFixed(0)}`);

    // ---- 4. THE SECONDARY PATH IS ONE LINE, AND THE PRIMARY IS WIDER ----
    check((g.noteHeight ?? 99) < 30,
      `${size.label}: the anonymous line is one line, not a paragraph`,
      `${g.noteHeight?.toFixed(0)}px tall`);
    check((g.ctaWidth ?? 0) > (g.card.w * 0.7),
      `${size.label}: the primary action is the widest thing in the card`,
      `cta ${g.ctaWidth?.toFixed(0)}px of card ${g.card.w.toFixed(0)}px`);

    const shot = path.join(OUT, `0065-signed-out-${size.w}.png`);
    await page.screenshot({ path: shot });
    console.log(`  shot  ${shot}`);
    await page.close();
    console.log('');
  }

  // ---- 5. THE OTHER HALF OF THE MARK: the asset 404s ----
  //
  // Without this, "the mark is an img" would pass for a component with no fallback at all, and
  // the first person whose CDN hiccuped would get a broken-image glyph where the brand goes.
  {
    console.log('brand mark fallback (asset forced to 404)');
    const { page } = await openSignedOut(WIDTHS[0], { breakMark: true });
    const g = await page.evaluate(geometry);
    check(g.mark?.tag === 'SPAN', 'fallback: .mark becomes a text element', g.mark?.tag);
    check(g.mark?.text === 'FL', 'fallback: and it reads FL', JSON.stringify(g.mark?.text));
    // STYLED, not raw default type. That was the explicit constraint.
    check(/Fraunces/i.test(g.mark?.fontFamily ?? ''),
      'fallback: in the brand serif, not the browser default', g.mark?.fontFamily);
    check(g.mark?.color === 'rgb(15, 118, 110)',
      'fallback: at the mark colour', g.mark?.color);
    check((g.mark?.w ?? 0) > 20 && (g.mark?.h ?? 0) > 20,
      'fallback: occupying the same box the mark did', `${g.mark?.w?.toFixed(0)}x${g.mark?.h?.toFixed(0)}`);
    // The page still centres with the fallback in it -- the swap must not move the card.
    const dx = Math.abs((g.card.left + g.card.right) / 2 - g.viewport.w / 2);
    check(dx <= CENTRE_TOLERANCE_PX, 'fallback: and the card is still centred', `off by ${dx.toFixed(1)}px`);
    await page.screenshot({ path: path.join(OUT, '0065-signed-out-mark-404.png') });
    await page.close();
  }

  // ---- 6. THE CONTROL: a page that DOES have navigation still has its nav, with the lockup ----
  //
  // "No nav strip" would pass for a change that deleted the nav everywhere, and "the mark is an
  // img" was only ever asserted on the signed-out card. So: sign in (the anonymous choice, which
  // needs no password), land on the projects index -- which does render a nav -- and measure it
  // there. This is the assertion that would have caught the original regression, because the
  // index nav is one of the three places that went on rendering the letters "FL".
  {
    console.log('\nsigned-IN nav (control)');
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 60_000 });
    await page.waitForFunction(
      () => document.querySelector('.login[data-signin="board"]') !== null, { timeout: 45_000 });
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button')]
        .find((x) => /continue anonymously/i.test(x.textContent ?? ''));
      b?.click();
    });
    await page.waitForFunction(
      () => document.querySelector('nav.nav') !== null,
      { timeout: 45_000 },
    );
    await new Promise((r) => setTimeout(r, 1_200));

    const nav = await page.evaluate(() => {
      const n = document.querySelectorAll('nav.nav');
      const mark = document.querySelector('nav.nav .brand-lockup .mark');
      const r = mark?.getBoundingClientRect();
      return {
        count: n.length,
        lockups: document.querySelectorAll('nav.nav .brand-lockup').length,
        markTag: mark?.tagName ?? null,
        markW: r?.width ?? 0,
        markH: r?.height ?? 0,
        // The regression, in the exact shape it shipped in.
        bareFl: [...document.querySelectorAll('.mark')].some(
          (e) => e.tagName === 'DIV' && (e.textContent ?? '').trim() === 'FL'),
      };
    });
    check(nav.count === 1, 'control: the signed-in index still has its nav', `navs ${nav.count}`);
    check(nav.lockups === nav.count, 'control: and that nav carries the lockup', `lockups ${nav.lockups}`);
    check(nav.markTag === 'IMG', 'control: whose mark is the SVG, not a text div', nav.markTag ?? 'absent');
    check(nav.markW > 20 && nav.markH > 20, 'control: at the nav size',
      `${nav.markW.toFixed(0)}x${nav.markH.toFixed(0)}`);
    check(nav.bareFl === false,
      'control: and NO `<div class="mark">FL</div>` survives anywhere on the page');
    await page.screenshot({ path: path.join(OUT, '0065-signed-in-nav.png') });
    await page.close();
  }
} finally {
  await browser.close();
}

console.log(`\n${failed === 0 ? 'LAYOUT PROBE PASSED' : 'LAYOUT PROBE FAILED'}\n`);
process.exitCode = failed === 0 ? 0 : 1;
