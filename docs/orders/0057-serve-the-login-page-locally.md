---
order:    0057
to:       firebase
issued:   2026-09-15
blocking: yes
---

# WebKit blocks the handoff. Serve the login page from the CLI instead.

You found the real defect and left the suite red rather than softening it. That was right.

```
[blocked] The page at https://…/login?port=55830… requested insecure content
from http://127.0.0.1:55830/. This content was blocked
```

**Chrome permits loopback as a potentially trustworthy origin; WebKit does not implement that
carve-out.** So the loopback handoff cannot work in Safari, and every green Chrome run — including
the one order 0055 asked for — said nothing about whether a Safari user can log in. The default
browser on the user's machine.

You also measured the alternative instead of guessing, and declined it for a stated reason: a
top-level navigation *does* reach the listener, but it turns the contract into a GET carrying a
**refresh token in a URL**, which lands in browser history. Correct call. Do not adopt it.

## The ruling: the CLI serves the login page

There is no mixed content if there is no `https` page in the flow.

1. **The CLI serves the page itself** on `http://localhost:<port>/` — not `127.0.0.1`. Firebase Auth
   already lists **`localhost`** as an authorized domain; `127.0.0.1` is a different string to that
   check, and it is the reason to prefer the hostname.
2. The page loads the Firebase Web SDK **from the CDN over https**. An http page loading an https
   subresource is an upgrade, not a downgrade — permitted everywhere.
3. Sign-in runs there, and the result posts to **its own origin**. Same-origin http → http. No mixed
   content in any engine, no token in a URL, and the nonce becomes belt-and-braces rather than the
   only defence.

This is how `firebase login` and `gh auth login` work, and for this exact reason.

**Keep `/login` on the hosted board** as the fallback for anyone whose browser cannot reach a local
page, and keep the user-agent-aware message you added. But local-first is now the primary path.

### Check this before building

**Confirm `localhost:<random port>` satisfies Firebase's authorized-domain check.** The list holds
`localhost` with no port. If the check is port-sensitive, this design fails and I want to know before
you build it, not after. That is one probe.

## Also: `flotilla whoami` is still missing

The addendum to 0056 asked for it and it did not land — `whoami()` exists on the client and is called
in four places, but there is no subcommand. The user asked for this command by name.

Signed in → uid, email, project, credential path, exit 0. Not signed in → say so, name
`flotilla login`, exit 1. Not configured → the existing message, exit 1. **And put it in `--help`** —
a command missing from the help does not exist for the person who needs it.

## Standing

Assert the artifact. A control that never fires has not been run. State which engines you actually
exercised — that distinction is what caught this one.
