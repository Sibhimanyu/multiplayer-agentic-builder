---
order:    0056
to:       firebase
issued:   2026-09-15
blocking: yes
---

# The popup is blocked by default in Safari, and the page is a dead end when it is.

`/login` works and the diagnosis is correct — *"Your browser blocked the sign-in popup."* That is the
error message doing its job.

**But the user cannot get past it.** Safari blocks popups by default, so this is the **first-run
experience on macOS**, not an edge case. And the page offers no way forward: no retry, no alternative.
The only escape is to change a browser setting and re-run `flotilla login` from the terminal.

## Fix 1 — do not require a popup

`signInWithPopup` is the wrong primitive for a page opened *by a CLI*. Use **`signInWithRedirect` +
`getRedirectResult`**: a top-level navigation is not a popup and is not blocked.

**The nonce and port must survive the round trip.** Google returns to `/login` with its own query
parameters, so persist both in `sessionStorage` **before** redirecting and restore them in
`getRedirectResult`. Losing the nonce mid-flow would turn a working login into "malformed nonce",
which is a worse bug than the one being fixed.

Keep the popup as an option if you want it, but **redirect is the default.** Popup-first with a
redirect fallback still shows a blocked-popup flash on every Safari first run.

## Fix 2 — the error page must offer a way out

Any failure that is recoverable in the browser gets a **retry button** that re-attempts using the
nonce and port already in hand. "Allow popups, then try again" is useless when *try again* means
switching to a terminal and re-running a command.

Where a failure genuinely is not recoverable in the page — a burned nonce, a closed listener — say
so and name the command. That distinction is the point: **do not tell the user to retry when they
cannot, and do not make them leave when they can.**

## Verify in Safari, not just Chrome

The last run verified the POST crosses in Chrome. **This defect only exists in Safari**, and it is
the default browser on the user's machine. Whatever cannot be automated, say so — but the redirect
path itself is testable: assert the nonce and port survive a simulated round trip through
`sessionStorage`, with the query string replaced by Google's.

Report which browsers you actually exercised.

---

## Addendum — there is no way to ask "am I signed in?"

The user asked for the command. There isn't one. `whoami()` exists on the client and is called in
four places internally, but it is **not a subcommand** — `flotilla whoami` returns
`unknown command`. The only way to check is `flotilla ls`, which answers the question as a side
effect of doing something else.

Add **`flotilla whoami`**:

- **Signed in** → uid, email if present, the configured project, and where the credential lives.
  Exit 0.
- **Not signed in** → say so, name `flotilla login`. Exit 1, so scripts can branch on it.
- **Not configured** → the existing unconfigured message. Exit 1.

Three states, three exit codes' worth of meaning — a command whose whole job is answering a question
must not answer it only in prose.

**Print it in `--help`.** Order 0048's lesson: a rename that misses generated files is not done, and
a command that is not in the help does not exist for the person who needs it.
