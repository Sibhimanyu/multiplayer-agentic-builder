---
order:    0055
to:       firebase
issued:   2026-09-15
blocking: yes
---

# `flotilla login` opens a page that cannot sign anyone in.

The user ran it. The browser opened the board's **projects index** — no sign-in button, nothing
actionable. Screenshot confirms it.

**Cause: there is no `/login` route.** `client/src` contains **zero** occurrences of
`signInWithPopup`, `GoogleAuthProvider`, `nonce`, or `cli_port`. The CLI opens `/login`, the SPA
rewrite serves `index.html`, and the app renders its only other route.

**The CLI half is complete and correct** — random port, one-time nonce, single use, 127.0.0.1-only
bind, all with the reasoning written down. **The browser half was never built.** Order 0050 said
"the hosted page runs a real Google sign-in and the credential returns over loopback exactly as now,"
and that was taken as describing something that existed.

Same class as entry 78: the CLI renamed its own help text and not the files it generates. Here the
CLI grew a login flow and the page it opens was never written.

## The contract, from `cli/auth.ts`

POST to `http://127.0.0.1:<port>`, JSON body:

```json
{ "nonce": "<echoed exactly>", "refresh_token": "...", "id_token": "...",
  "uid": "...", "email": "..." }
```

Required: `nonce`, `refresh_token`, `uid`. Wrong nonce → 403 and the listener **keeps waiting**
(deliberate — a bad POST must not kill a live login). Second valid response → 409.

## Build `/login`

1. Read `nonce` and `port` from the query string. **Missing or malformed → render an error saying
   the login must be started by `flotilla login`.** Never proceed with a guessed port.
2. `signInWithPopup(new GoogleAuthProvider())`. Support `?anonymous=1` for
   `flotilla login --anonymous`, since the CLI already advertises that flag.
3. POST the contract above to `http://127.0.0.1:<port>`, echoing the nonce **verbatim**.
4. Render the outcome: signed in and safe to close; or the failure, naming which step failed. A
   silent blank page is the bug being fixed — do not reintroduce a quieter version of it.

**Confirm the CLI opens a URL carrying both parameters.** If it opens a bare `/login`, that is the
other half of the same defect.

## Mixed content

The page is `https://`; the listener is `http://127.0.0.1`. Browsers **permit** this — loopback is a
[potentially trustworthy origin](https://w3c.github.io/webappsec-secure-contexts/) — but the CLI must
answer the preflight, and it already handles `OPTIONS` with 204. **Verify the POST actually crosses
in a real browser.** If it is blocked, say so plainly rather than working around it; that changes the
design, not the implementation.

## Prove it

An automated test cannot click a Google consent screen. So:

- **Test everything either side of the popup** — parameter parsing, the error path for a missing
  nonce, the POST shape, the nonce echoed verbatim, the failure render.
- **Drive the real loopback**: start the CLI's listener, POST the contract from the page's own code
  path, and assert the CLI accepts it. That covers the wire without needing Google.
- **Assert the negative too**: a POST with a wrong nonce gets 403 and the listener stays alive.

State clearly which step is stubbed and which is real. `--anonymous` **can** be driven end to end —
do that one for real.
