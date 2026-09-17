# Order 0073 — anonymous is abolished

> "Or continue anonymously. should be abolished. no option should be there for that."

## What it was for, and why that no longer holds

Order 0064 kept the anonymous option deliberately. The argument was that the denied-state
onboarding path depended on it: sign in, get refused by the rules, read your own uid off the
screen, get admitted out of band with `--admit <uid>`.

That path still works. It just starts from a Google account now, and is better for it — the uid an
owner admits belongs to a person they can name, instead of to a browser profile that disappears
when someone clears their cache. `firebase/bridge-run.ts` labels admitted browsers
`browser (anonymous)`; that label is now wrong for every new admission, which is a follow-up, not
a blocker.

The option also never led anywhere. An anonymous session is a member of nothing, so the only
screen it could reach was an empty index explaining why it was empty.

## Removed

- The "Or continue anonymously" control in `SignInView`, and its `onAnonymous` prop.
- `signIn('anonymous')` in `App.tsx`, and the `signInAnonymous` import with it.
- `SignInMethod` is now `'google'` — the union member is gone, not just unused. The CLI's
  `/login` page keeps its own anonymous path and calls `signInAnonymous` directly; keeping
  `'anonymous'` out of this type is what stops the board quietly regrowing the option.

## Browsers that already took it

A credential issued before this order still exists in those browsers. Refusing it silently would
render the sign-in screen forever with no hint why, so `session.anonymous` is now treated as
signed-out **and named on screen**: "This browser was signed in anonymously. Anonymous sessions
are no longer accepted."

It is deliberately not signed out eagerly — that would throw away the state the message exists to
explain. Signing in with Google replaces it.

## The assertion that fired

The edge harness asserted the opposite:

```
FAIL  signin: anonymous stays available — the denied-state onboarding path depends on it
```

Correct behaviour: it encoded order 0064's decision, and that decision was just reversed. It is
**inverted, not deleted** — a removed assertion proves nothing, and this one now guards the
removal from being quietly undone. With a control first, because "no anonymous option" also
passes on a blank render:

```
PASS  (control) signin: Google is offered
PASS  signin: the anonymous escape hatch is gone — Google is the only way in
PASS  signin: a stale anonymous session is named, not silently refused
```

183/183.

## Verified

Two independent reads, because the first one lied: a stale page in the browser daemon still showed
the old button after the deploy. Re-checked with a fresh tab (`Continue with Google` is the only
button) and with `curl` against the served bundle (no `continue anonymously` string in
`index-D03T3MW1.js`, which is the hash the live HTML references).

## Still open

`flotilla login --anonymous` is a separate surface and still exists: `cli/index.ts` documents the
flag, `firebase/flotilla-main.ts` sends `provider=anonymous`, and `Login.tsx` serves that path.
This order did not touch it, because it is the CLI's contract rather than the board's sign-in
screen, and removing a documented flag is a user-facing break on a different surface.
