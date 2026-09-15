// PROBE, RUN BEFORE BUILDING ANYTHING. Order 0057.
//
// THE QUESTION: does `localhost` on a RANDOM PORT satisfy Firebase Auth's authorized-domain check?
//
// The whole of order 0057's design rests on it. Firebase's authorized-domain list holds `localhost`
// with no port; if the check turns out to be port-sensitive, a CLI that picks a random port every
// run cannot serve the login page and the design fails. Better to learn that here than after
// building it.
//
// THREE LEVELS, because the cheap one alone would not settle it:
//
//   1. What the project actually lists, read from the live identitytoolkit endpoint. Says what is
//      configured, NOT how it is matched.
//   2. A REAL BROWSER on http://localhost:<random port>, running the real Firebase Web SDK from
//      the CDN, calling signInWithRedirect and reporting the error code -- which is where
//      auth/unauthorized-domain would come from if the check rejected us.
//   3. THE CONTROL: the identical page on http://127.0.0.1:<random port>. Same code, same port
//      strategy, different hostname -- and 127.0.0.1 is NOT in the list. If that is also accepted
//      then the check never fires and level 2 proved nothing.
//
//   node firebase/localhost-probe.mjs
import { createServer } from 'node:http';
import fs from 'node:fs/promises';

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

console.log('PROBE -- is localhost:<random port> an authorized domain?\n');

// ============================================================ 1. what is configured
console.log('1. the list, from the live project');
const res = await fetch(`https://identitytoolkit.googleapis.com/v1/projects?key=${API_KEY}`);
const cfg = await res.json();
const domains = cfg.authorizedDomains ?? [];
console.log(`   authorizedDomains: ${JSON.stringify(domains)}`);
check(res.ok, `identitytoolkit answered ${res.status}`);
check(domains.includes('localhost'), 'the list contains "localhost"');
check(!domains.some((d) => /^localhost:/.test(d)), 'and no port-qualified localhost entry exists');
// The control for THIS level: 127.0.0.1 must be absent, or the comparison below is not a contrast.
check(!domains.includes('127.0.0.1'), '127.0.0.1 is NOT in the list (so it is a usable control)');

// ============================================================ the page under test
//
// The real SDK from the CDN over https, on an http page. That combination is itself part of what
// is being probed: an http page loading an https subresource is an upgrade and is permitted.
const page = (port, host) => `<!doctype html>
<html><head><meta charset="utf-8"><title>probe</title></head>
<body><div id="out">starting</div>
<script type="module">
  import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-app.js';
  import { getAuth, GoogleAuthProvider, signInWithRedirect }
    from 'https://www.gstatic.com/firebasejs/11.0.2/firebase-auth.js';
  const out = document.getElementById('out');
  try {
    const app = initializeApp({
      apiKey: ${JSON.stringify(API_KEY)},
      authDomain: ${JSON.stringify(`${PROJECT}.firebaseapp.com`)},
      projectId: ${JSON.stringify(PROJECT)},
      appId: ${JSON.stringify(env.VITE_FIREBASE_APP_ID)},
    });
    out.textContent = 'sdk-loaded';
    window.__sdk = true;
    // Recorded on the SERVER, not just on window. The successful run navigates away to Google
    // before anything can read this document, so a flag on window is only observable when the
    // probe FAILS -- which is exactly backwards. This beacon is also same-origin http -> http,
    // the very request shape the whole design depends on.
    await fetch('/sdk-ok', { method: 'POST' }).catch(() => {});
    await signInWithRedirect(getAuth(app), new GoogleAuthProvider());
    // Reached only if the navigation has not happened yet.
    out.textContent = 'redirect-started';
  } catch (e) {
    out.textContent = 'ERR:' + (e.code || e.message);
    window.__err = e.code || e.message;
  }
</script></body></html>`;

const serveOn = async (host) => {
  const seen = { sdk: false, beacon_origin: null };
  const srv = createServer((req, res) => {
    if (req.url === '/sdk-ok') {
      seen.sdk = true;
      seen.beacon_origin = req.headers.origin ?? null;
      res.writeHead(204).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end(page(srv.address().port, host));
  });
  await new Promise((r) => srv.listen(0, host === 'localhost' ? '127.0.0.1' : host, r));
  return { srv, port: srv.address().port, seen };
};

// ============================================================ 2 and 3, in a real browser
const puppeteer = await import('puppeteer');
const browser = await puppeteer.default.launch({ headless: 'new', args: ['--no-sandbox'] });

const drive = async (host) => {
  const { srv, port, seen } = await serveOn(host);
  const ctx = await browser.createBrowserContext();
  const p = await ctx.newPage();
  const logs = [];
  p.on('console', (m) => logs.push(m.text()));
  p.on('pageerror', (e) => logs.push(`pageerror: ${e.message}`));
  await p.goto(`http://${host}:${port}/`, { waitUntil: 'networkidle2', timeout: 60_000 }).catch(() => {});
  // Either the page navigated to the auth handler, or it set an error. Wait for whichever.
  await new Promise((r) => setTimeout(r, 6_000));
  const url = p.url();
  const err = await p.evaluate(() => window.__err ?? null).catch(() => null);
  await ctx.close();
  srv.close();
  // sdk comes from the SERVER's record, so it is readable whether or not the page navigated away.
  return { port, url, err, sdk: seen.sdk, beacon_origin: seen.beacon_origin, logs };
};

console.log('\n2. a real browser on http://localhost:<random port>, real SDK, real signInWithRedirect');
const local = await drive('localhost');
console.log(`   port ${local.port}  sdk-loaded=${local.sdk}  error=${local.err ?? 'none'}`);
console.log(`   ended at: ${local.url.slice(0, 110)}`);
check(local.sdk, 'the Firebase SDK loaded over https INTO an http page (the upgrade is allowed)');
check(local.err !== 'auth/unauthorized-domain',
  `localhost:${local.port} was NOT rejected as an unauthorized domain`);
check(/accounts\.google\.com|__\/auth\/handler/.test(local.url),
  'and the redirect actually left for Google');

console.log('\n3. THE CONTROL -- the same page on http://127.0.0.1:<random port>');
const ip = await drive('127.0.0.1');
console.log(`   port ${ip.port}  sdk-loaded=${ip.sdk}  error=${ip.err ?? 'none'}`);
console.log(`   ended at: ${ip.url.slice(0, 110)}`);
check(ip.sdk, 'the SDK loaded there too, so the two runs differ only in hostname');
check(ip.err === 'auth/unauthorized-domain',
  `127.0.0.1 IS rejected (${ip.err ?? 'no error'}) -- the check fires, so run 2 means something`);

await browser.close();

console.log(`\n${failed === 0 ? 'PROBE PASSED -- the design is viable' : `PROBE FAILED (${failed})`}`);
console.log(failed === 0
  ? '  localhost is matched by HOSTNAME, port-insensitively. A random port is fine.'
  : '  Do not build the local-server design on this result.');
process.exit(failed === 0 ? 0 : 1);
