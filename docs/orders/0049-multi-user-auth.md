---
order:    0049
to:       firebase
issued:   2026-09-15
blocking: yes
---

# Multi-user auth. The user enabled Blaze; build the write path.

The CLI installs and works — verified from a tarball in a clean directory, by you and again by me.
Refusing to touch the frozen root `package.json` and putting the package at `drydock/` instead was
right, and it cited the recorded precedent: *prefer "stop needing it" over "request ownership."*
Flagging the three deliberate `builder` strings as **role slugs — data, not the product name** was
also right.

Now the requirement that changes the architecture, in the user's words: *"any teammate should be able
to install the CLI, then auth the CLI according to their permission, and it will call Claude and
modify."*

Read `docs/designs/multi-user-auth.md` first.

## The blocker, and why it is real

`firestore.rules` is `allow write: if false` on **every** collection — not restrictive, **zero**.
Every write today goes through the Admin SDK in the bridge. And role enforcement (`file_scope`,
`globContains`) lives in `shared/store/roles.ts`, which is **application code, not rules.**

So a teammate's CLI authenticating as themselves cannot write at all. And loosening the rules to let
them **destroys the feature you just built**: anyone holding a valid token could write straight to
Firestore in ten lines and ignore `file_scope` entirely. Glob containment is not practically
expressible in rules, so there is no middle path.

**The finding, recorded:** local-first works for coordination and cannot work for authorization.
Coordination state is data, and a local process can produce data safely. Deciding *"is this person
allowed to do that"* requires something the person being checked cannot modify — and a local process
is, by construction, under the control of the user it is meant to constrain.

## Build this

### 1. `drydock login` — no server needed for this part

Loopback flow, the way `gh auth login` works:

1. CLI starts a listener on `127.0.0.1:<random>` and generates a **one-time nonce**.
2. It opens the hosted board with that nonce and port.
3. The user signs in **in the browser**, where real Firebase Auth already works.
4. The page posts the credential back to the loopback listener. **Validate the nonce** — without it
   any page the user later visits could post a token at your listener.
5. Store the **refresh token** at `~/.drydock/credentials.json`, **mode 600**, and mint short-lived ID
   tokens from it. Never store an ID token as the durable credential; they expire in an hour.

### 2. One HTTPS Cloud Function as the write path

It verifies the ID token, reads the caller's member document, enforces `capabilities`, `file_scope`
and `deploy_scope`, and only then writes with admin privileges.

**`firestore.rules` stays `allow write: if false`. Do not weaken it.** That is the whole point: the
enforcement lives where the user cannot reach it.

Reuse `shared/store/roles.ts` — the containment logic is already written and tested 51/51, including
that **containment is not intersection**, since `**` intersects `functions/**` and an intersection
test would let an agent claim the whole repo.

### 3. The CLI writes through the function, not the Admin SDK

The bridge keeps admin access for what genuinely needs it (project creation is a local act). Agent
and member operations go through the function carrying the user's token.

### 4. Then `drydock start` spawns the harness

Bounded by the role's `file_scope`, with `.agentic/` as the interface it already has. **No server
needed for this part** — process management plus the existing file contract.

## Blocked on one console action — build everything else first

**Cloud Functions APIs are disabled** on the project, and the service account is denied
`serviceusage.services.enable`, so I cannot enable them. `gcloud` is not installed either. The user
has a single link to click; it is in my message to them.

**Write and test everything that does not need a deployed function.** The token verification, the role
enforcement, the loopback flow and the nonce check are all testable against the emulator suite.
Deploy last, and **say clearly which parts are verified deployed and which are verified only locally**
— that distinction has mattered every time it came up.

## Standing rules

Assert the artifact, not the return value — for the function that means a real HTTP call with a real
token, not a unit test of the handler. A control that never fires has not been run: prove an
**allowed** write succeeds through the same path that rejects a forbidden one. A negative assertion
needs proof the thing could appear. Gate suites get a verified-fresh emulator proven by identity.
Any new query shape gets one production run. `--test-concurrency=1`. `attempts` 6, `cap_ms` 2,000.

**Do not publish to npm.** Still the user's call.
