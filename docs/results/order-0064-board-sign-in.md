# Order 0064 — the board can be a person

Date: 2026-09-16
Branch: `work`

## The blocker, and that it is gone

`proj_inventory_tracker` belongs to `X1syxqJZaoNxxeVclsxZedI4SJK2` (`sibhi.gv@gmail.com`). The
board signed in anonymously at `client/src/store/firebase.ts:206` and again at
`client/src/store/projects.ts:52`, so the browser asked *"which projects is `anon_…` a member
of"* — and answered honestly: none. The page then printed **"No projects yet — run `flotilla
new`"** to someone who had just run `flotilla new`.

Verified in a real browser against real Firebase Auth and real Cloud Firestore:
`client/edge/shots/0064-member-sees-project.png` shows **Inventory Tracker · OWNER ·
Sibhimanyu/inventory-tracker**, with `sibhi.gv@gmail.com` and a `Sign out` in the nav.

## What changed

| | before | after |
|---|---|---|
| who signs the board in | `firebase.ts` and `projects.ts`, independently, anonymously | `store/session.ts`, once, on a user's instruction |
| sign-in affordance on the board | none (`App.tsx` had zero mentions) | `SignInView` — Google, or anonymous as a choice |
| provider handling | `Login.tsx` only | `store/session.ts`, called by `Login.tsx` **and** the board |
| session across reloads | anonymous uid persisted by accident | `browserLocalPersistence`, set deliberately before any sign-in |
| whose board is this | unanswerable | `AccountChip` in the nav, with a way out |
| empty index | "run `flotilla new`", always | says *why* it is empty when the session is anonymous |

**Anonymous is still there and is still load-bearing.** The denied-state onboarding path — sign
in, get refused by the rules, read your own uid off the screen, get admitted — is what
`client/edge/shot.mjs` walks, and it still walks it. What changed is that the probe now **clicks
the button** a user clicks. That click is itself the assertion: if anonymous ever becomes the
silent default again, the button will not exist and that probe fails first.

## Two pages, two opposite persistence answers

Written down in `store/session.ts`'s header because someone will otherwise "fix" one to match the
other:

- **`cli/loginpage.ts`** (served by `flotilla login` on a loopback port) uses
  `inMemoryPersistence` and must. It hands one credential to a terminal and is then closed;
  leaving a Google session in an ephemeral `127.0.0.1` origin is a credential on the floor of a
  room nobody owns. **Untouched.**
- **The board** uses `browserLocalPersistence`. It is a place you return to, and the uid *is* the
  membership key, so dropping it means dropping your projects.

One correction to the order's wording: the `inMemoryPersistence` is in `cli/loginpage.ts`, not in
`Login.tsx`. `Login.tsx` is the *hosted* fallback and shares the board's origin, so it necessarily
shares its persistence — which is fine, it is the same person and the same account.

## An import cycle avoided rather than shipped

`session.ts` needs `configFromEnv` to build the app it signs into; `firebase.ts` needs `session.ts`
to learn who is signed in. Both run at startup, and a cycle between two such modules works until a
bundler reorders it. `configFromEnv` and `authDomainFor` moved to `client/src/store/config.ts`
unchanged, re-exported from `firebase.ts` so every existing caller and the edge harness import
exactly what they did before.

## The test that would have caught it — and why it could not exist before

The order is right that this was **a defect in the test design, not a missing case**. Every index
assertion handed `ProjectsIndex` a rows array directly, so no uid ever entered the picture; and
every other case seeded its fixture against whatever uid the harness happened to use, which made
the fixture's identity and the browser's identity *the same thing by construction*. A mismatch
between them was unreachable from the harness.

What made it reachable: `loadProjects` now **takes a uid** instead of minting one, and takes an
injectable `ProjectLister`. The new assertions drive one directory holding one project owned by
one specific person, and ask it twice.

```
PASS  session: a uid that IS a member gets its project from the directory
PASS  session: and the board signed in as that uid RENDERS proj_inventory_tracker
PASS  session: a uid that is NOT a member gets nothing from the directory
PASS  session: and the same board as that uid does NOT render the project — the other half
```

Edge harness: **177/177**, up from 146.

## Controls — a control that never fires has not been run

Four mutations, each applied, run, and reverted:

| mutation | what went red |
|---|---|
| the directory ignores the uid (returns the project to everyone) | **only half two** — half one still passed |
| the empty state forgets it is anonymous | the 2 anonymous-explanation checks |
| the nav stops naming the account | the 3 account-chip checks |
| a module outside `session.ts` calls `signInAnonymously` | the sign-in-ownership source rule |

**The first row is the order's point, measured.** A board that ignored the uid entirely — which is
exactly what shipped — passes "a member sees their project". Only the second half catches it. One
half would have been a test that could not fail for the bug it was written about.

The source rule (`client/edge/run.mjs`) has its own control: it asserts the scan *does* find the
call in `session.ts`, so a regex that matched nothing could not pass by finding nothing. It fired
once for real during development, on a mention inside a comment — the scan now strips comments,
because a rule that forbids writing down what the code used to do has the wrong incentive.

## Tested vs verified against production

**Tested** (server-rendered, no browser, no network):

- 177 edge assertions including the four above and the sign-in screen's two choices
- `client/edge/run.mjs`'s CSS rules and the new sign-in-ownership source rule
- client `tsc --noEmit` clean; `npm run build` clean

**Verified against production** — real Cloud Firestore, real Firebase Auth,
`multiplayer-agents-eec02`, board served from the real production build
(`scripts/run-board-session-probe.sh`):

- signed out, the board renders a sign-in screen and does **not** silently become anonymous
- the Google button genuinely starts a Google sign-in — it navigates to
  `…firebaseapp.com/__/auth/handler?…providerId=google.com`
- signed in as `X1syxqJZaoNxxeVclsxZedI4SJK2`, the index renders `proj_inventory_tracker`
- signed in as a **different** real identity, the same build renders the empty state and not the
  project — **both halves, in a browser, against live data**
- `/p/proj_inventory_tracker` opens for the member: the security rules allow the read
- the nav names the account
- the session **survives a full page reload** — the probe establishes it, reloads, and everything
  asserted after that is the shipped bundle restoring a persisted session on its own
- `client/edge/shot.mjs`: the anonymous → denied → `--admit` → live-board path still works, now
  driven through the button

**Neither, and this is the honest limit:**

- **No machine here has completed Google's consent screen.** That needs a password this workspace
  does not have and should not have. The member session is established with an Admin-SDK
  **custom token** for the real uid — real Firebase Auth issuing a real ID token for a real
  identity, which is precisely what the rules and the collection-group query see. The only thing
  skipped is Google's own UI. **The first person to click "Continue with Google" is testing that
  click.**
- The board is **not redeployed**. Everything above ran against a local serve of the production
  build. `firebase deploy --only hosting` has not been run.

## Two things to hand back

1. `client/edge/shot.mjs` admits a fresh anonymous uid to `proj_inventory` on every run — this
   run added `mNcevwYiw7YE0lXH2HkxoMDpF143`, and that project now carries three `browser
   (anonymous)` viewers. Pre-existing, not introduced here, and the same litter shape the rollup
   probe was made to avoid.
2. `proj_inventory_tracker` has **zero tasks**, which is order 0063's finding still showing
   through: `flotilla task` exists now but has never been run against this project.
