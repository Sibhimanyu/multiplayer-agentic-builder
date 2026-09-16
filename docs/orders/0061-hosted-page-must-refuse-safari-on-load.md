---
author:   coordinator
order:    0061
to:       firebase
issued:   2026-09-16
blocking: yes
---

# The hosted page walks a Safari user through Google, then fails at the last step.

The user reached this, on the hosted page:

> Could not reach the flotilla CLI on port 53007. This browser may have blocked the request: Safari
> refuses connections from an https page to `http://127.0.0.1`.

**The message is correct and it arrives far too late.** They had already signed in with Google. The
failure was knowable on page load: this is `https`, the browser is WebKit, and the handoff is
`http://127.0.0.1`. Nothing about that depends on the sign-in succeeding.

## Fix — refuse before the button, not after Google

On load, when the page is `https` **and** the engine is WebKit, do not render "Continue with Google".
Render the refusal, and name the two ways out:

- `flotilla login` — the local page, which works in Safari
- or open this same link in Chrome

`looksLikeWebKit` already exists and already excludes Chrome and Edge by name. Use it earlier.

**Do not remove the late error.** A user can change browsers mid-flow, and the after-the-fact message
is still the right thing when the POST genuinely fails for another reason. This adds an earlier gate;
it does not replace the later one.

## The deeper problem: nothing distinguishes the two pages

Three times now the user has reported a failure from the hosted page while believing they were on the
local one. The pages are near-identical — same brand, same heading, same button. The only tell is one
line of body copy.

**Make them unmistakable.** The hosted page should say, on its face, that it is the fallback and that
`flotilla login` is the normal path. A user who lands there by accident — from a restored tab, a
bookmark, a stale link — should be able to tell in one glance, without reading a sentence about
redirects.

## Also

`flotilla login` now opens the browser itself (order 0060, verified: the launcher receives the
localhost URL, string for string). So a user arriving at the hosted page is almost always arriving
from a **stale tab**. Consider whether the hosted page should require a live, unexpired nonce before
rendering anything actionable — a stale tab with old parameters is the exact shape of what happened
here.

## Verify

Load the hosted page in WebKit and assert **no sign-in button renders** and the refusal names both
escapes. Load it in Chromium and assert the button **does** render — the control, without which
"refuses in WebKit" would also pass for a page that refuses everywhere.

Safari.app is still not driven. Say so.
