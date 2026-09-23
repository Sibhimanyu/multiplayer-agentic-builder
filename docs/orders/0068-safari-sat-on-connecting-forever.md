# Order 0068 — Safari sat on "Connecting…" forever

Reported with a screenshot: Safari at `multiplayer-agents-eec02.web.app`, the page showing
nothing but the word `Connecting…` in the top-left corner. Chromium, same URL, same build,
renders the sign-in page in full.

## What could not be established

Safari refuses `do JavaScript` from Apple Events unless a Developer setting is enabled, so the
failure was NOT reproduced under instrumentation. Changing the reporter's browser security
settings to get a reading was not worth it. What follows is a hypothesis plus a diagnostic that
will settle it on the next reload, not a confirmed root cause.

Ruled out by measurement rather than reasoning:

- `authDomain` is already same-origin. `authDomainFor` (store/config.ts) treats the console's
  default `<project>.firebaseapp.com` as unset and returns `<project>.web.app` when the board is
  served from it. Verified `https://multiplayer-agents-eec02.web.app/__/auth/handler` → 200 and
  `/__/auth/iframe` → 200. The Safari ITP trap this project already knows about is closed.
- The bundle carries a complete Firebase config (order 0067's `verify-bundle.mjs` passes), so
  this is not another blank-page-from-missing-env.

## Two hangs, one appearance

`Connecting…` was rendered from two unrelated places that look identical on screen:

- `SignedIn`, waiting on `onAuthStateChanged` to fire (`session === undefined`)
- `ProjectsIndexRoute`, waiting on the `members` collection-group query (`!ready`)

A screenshot of the stuck page therefore could not say which half was stuck. This is the exact
ambiguity `store/firebase.ts` argues against in its `StoreStatus` comment, reintroduced one layer
above it.

`Connecting` (App.tsx) now takes what it is waiting for, and after 8s replaces the placeholder
with that name plus a Reload button. It cannot cancel either call — neither Firebase API takes a
timeout — but a stuck page now reports itself instead of looking like a slow network.

## The likely cause, and the supported fix

Firestore's default transport is WebChannel, a long-lived stream. Safari and response-buffering
proxies can accept the connection and never deliver the first chunk. The SDK does not time that
out, so `getDocs` never settles — not a rejection, a promise that stays pending forever, which is
precisely a permanent `Connecting…`.

`client/src/store/db.ts` is new: one memoised `initializeFirestore(app, {
experimentalAutoDetectLongPolling: true })` per app, used by both `BrowserFirestoreStore` and
`BrowserDirectory`, which each called bare `getFirestore` before. The probe only changes behaviour
where the stream is already broken, so it costs nothing where WebChannel works.

Memoised per app via a WeakMap rather than per module because `initializeFirestore` must run once
and before the first `getFirestore`, and client/edge/cases.tsx builds more than one app.

## Verification

- `npm run build` clean; edge harness 177/177.
- Chromium still renders the sign-in page after the change (FCP 1320 ms, `#root` populated).
- Safari: unverified. If it still hangs, the page will now name which of the two calls did not
  return, which is the reading this order could not take.
