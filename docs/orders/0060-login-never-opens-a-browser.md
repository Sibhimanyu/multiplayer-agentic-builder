---
order:    0060
to:       firebase
issued:   2026-09-16
blocking: yes
---

# `flotilla login` never opens a browser, and a flag says it does.

/qa on the login flow. The local page is **correct** — it uses `signInWithPopup` and says *"A Google
window will open. This page stays open behind it."* That part works.

**The user never reached it.**

## ISSUE-001 — the CLI prints a URL and calls it done

```
Open this in your browser to sign in with Google:
    http://localhost:49414/
```

There is **no `open`, `xdg-open`, or `start` anywhere in `cli/`.** `flotilla login` prints a URL and
waits. The user did the reasonable thing — switched to their browser, where an earlier
`multiplayer-agents-eec02.web.app` tab was still open — and signed in on the **hosted** page, which
uses redirect and is exactly the flow Safari breaks.

**Every login failure reported over the last several exchanges traces back to this.** Three orders
went into making the local page work, and the user was never on it.

## ISSUE-002 — `--no-browser` is a no-op that implies the opposite

`--no-browser` is accepted and documented as *"prints the URL instead of opening one."* Since nothing
ever opens one, the flag does nothing — **and its existence is a claim that the default behaves
differently.** A flag that describes behaviour the product does not have is worse than no flag.

## Fix

1. **Open the browser by default.** `open` on darwin, `xdg-open` on linux, `start` on win32. Detach
   it, ignore its exit code — a failed launch must not fail the login.
2. **Still print the URL**, every time. The launch can silently do nothing, and the printed URL is
   what makes that recoverable.
3. **Make `--no-browser` real** — suppress the launch, keep the print. It is genuinely useful on a
   headless box, which is why it should do what it says.
4. **If the launch fails, say so** and fall back to the printed URL. Do not leave the user watching a
   terminal that looks like it is waiting on them.

## Test the thing that actually broke

Assert the **URL passed to the launcher**, not that a launcher was called. The bug is not "no browser
opened" — it is "the user ended up on a different page than the one we serve." A test that only
checks `spawn` was invoked would pass while handing it the hosted URL.

- Default: the launcher receives the **`http://localhost:<port>/` the server is bound to**, string
  for string.
- `--no-browser`: launcher **not** invoked, URL **still** printed. Both halves.
- `--hosted`: launcher receives the hosted URL — that flag exists and must keep working.
- Launcher failure: login still proceeds, URL still printed.

The control that stops this being vacuous: assert the localhost URL and the hosted URL are
**different**, so a test cannot pass by comparing a value to itself.
