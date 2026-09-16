---
order:    0059
to:       firebase
issued:   2026-09-16
blocking: yes
---

# Redirect cannot work on the local page in Safari. Use popup, and fix the gesture.

Google sign-in completes and the page returns to its own sign-in state. `getRedirectResult` resolves
with no user.

## Why, and why it is structural

`signInWithRedirect` parks pending state on the **`authDomain` origin**
(`multiplayer-agents-eec02.firebaseapp.com`). On return to `http://localhost:<port>` the SDK must
read that cross-origin state, and **Safari's ITP blocks it.** Firebase documents this: redirect is
unreliable in ITP browsers whenever `authDomain` is not the page's own origin.

**A locally served page on a random port can never be same-origin with `authDomain`.** So this is not
a bug to fix in the page — redirect is the wrong primitive *here*, for the same kind of reason popup
was the wrong primitive on the hosted page.

## The reversal, and why it is not a reversal

Order 0056 made redirect the default because Safari blocked the popup. **That diagnosis was probably
wrong.** Safari blocks popups that are *not* tied to a user gesture; a click is a gesture. Look at
`loginpage.ts:215`:

```js
await signInWithRedirect(auth, new GoogleAuthProvider());
```

inside a handler that has already `await`ed. **An `await` before the call discards the gesture**, and
the popup gets blocked — not by policy, by losing its cause. If the popup had been opened
synchronously in the click, it likely would have worked all along.

So: **popup on the local page, called synchronously in the click handler, with nothing awaited
before it.** Move any initialisation to page load. If the SDK must be awaited, do it before the
button is enabled, not after it is pressed.

Keep redirect on the **hosted** page — same origin as `authDomain` there, so ITP does not bite, and
that path is verified.

## Verify in Safari.app, not WebKit

The last run reported WebKit 26.6 green while the user's Safari failed. **Playwright's WebKit is not
Safari and does not implement ITP.** Every ITP defect in this flow is invisible to it — that is why
two orders of green WebKit runs preceded this report.

`safaridriver --enable` needs an administrator password, so `login-safari.mjs` exits 2. **That
exit-2 is now the most important line in the suite**: it means the only engine that can falsify this
was never run. Say so on every report that touches auth, rather than listing WebKit as though it
covered Safari.

Ask the user to run the one command if automated Safari coverage is wanted:

```
sudo safaridriver --enable
```

Until then, this fix is verified by a human clicking, and the report must say so.

## One more thing

The popup path already exists behind `?popup=1`. **Do not simply flip the default and leave the
gesture bug** — then popup fails for the original reason and the report reads "popup blocked" again.
The gesture fix is the actual work.
