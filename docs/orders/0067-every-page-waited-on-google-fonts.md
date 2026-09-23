# Order 0067 — every page waited on Google Fonts, and the last build shipped blank

Reported: "it seems to take so long to load up each page."

## What the measurement said

Host: `multiplayer-agents-eec02.web.app`, Firebase Hosting, us-central1.
Mechanism: `performance.getEntriesByType('paint'|'resource'|'navigation')` read in a
real browser after navigation, not a synthetic estimate.

Cold load, before:

| figure | value |
|---|---|
| first contentful paint | 3572 ms |
| DOMContentLoaded | 3552 ms |
| `fonts.googleapis.com` stylesheet, responseEnd | 3031 ms |
| third-party requests before paint | 1 |

The bundle was never the problem. Over the wire it was 196 KB and finished in 118 ms.
The page spent three seconds blocked on a cross-origin stylesheet for three families
(Fraunces, Inter, JetBrains Mono) before it was allowed to paint a single pixel.

The page was also loading fonts twice: the render-blocking Google stylesheet *and* a
self-hosted `Fraunces-SemiBold.ttf` behind a separate `Fraunces Brand` family.

## What changed

- Downloaded the latin-subset variable woff2 for all three families into
  `client/public/brand/fonts/` (147 KB total, one file per family covers every weight).
- `client/src/tokens.css`: three same-origin `@font-face` rules replace the single
  `Fraunces Brand` rule. `--brand-serif` now resolves to plain `Fraunces`; the
  duplicate family is gone.
- `client/index.html`: the two `preconnect` hints and the `fonts.googleapis.com`
  stylesheet are deleted, replaced by `preload` for the two fonts on the paint path.
- `firebase.json`: `/brand/fonts/**` is `immutable`, `/brand/*.svg` gets a day.
  Under the previous blanket `no-cache` the brand mark revalidated on every load
  (305 ms of the cold path).

Cold load, after: **FCP 968 ms, zero third-party requests.** Repeat visits 28–464 ms.

## The mistake this order also had to fix

The first deploy of the font change rendered a completely blank page: `#root` had zero
children, `document.body.innerText` was empty, and the console was silent. `client/.env`
does not exist in a fresh worktree and is gitignored, so `vite build` happily emitted a
bundle with no Firebase config. `initializeApp` then threw at module scope, before any
React code ran — which is why nothing painted and nothing logged.

This is the second time in this project a config-less bundle has shipped green.

`client/verify-bundle.mjs` now runs as part of `npm run build` and greps the emitted
chunks for the API key, the project id, and an auth domain. Proven both ways: with
`.env` moved aside the build exits 1 and names what is missing; restored, it exits 0.

A true signal about the wrong subject, again — `vite build` reported success about
compilation, which was genuinely fine, while the artifact was unusable.

## Still open

The bundle is 893 KB raw / 235 KB gzip in one chunk, almost all Firebase SDK, and Vite
warns about it on every build. It is not what made the page slow, so it is not fixed
here. Splitting it only pays off once the shell can render before auth resolves.
