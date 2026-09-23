# Deploying the Firebase build

**This build is deployed** to `multiplayer-agents-eec02` (functions `api`, `write`, `githubWebhook`,
`reapClaims`, and hosting). The gates below are what a NEW Firebase project needs first.

Redeploying: `npm run build:all`, then `firebase deploy --only functions,hosting`. build:all compiles
`functions/lib`, which is what the deploy uploads; skip it and you ship the previous build.

## Gate 1 — the budget alert (do this first, verify it yourself)

The Blaze plan has **no spending cap by default**, only alerts. A runaway listener or a hot loop
in a contributor's CLI generates a real, uncapped bill. `firebase-tools` cannot see or set
budgets — Cloud Billing is a GCP surface it does not expose — so this cannot be automated from
the repo and cannot be verified by the CLI.

Console path:

```
console.cloud.google.com -> Billing -> Budgets & alerts -> Create budget
  Scope:      the one project, not the whole billing account
  Amount:     a specified target (see below)
  Thresholds: 50% / 90% / 100% of actual spend, email to the billing admin
```

Suggested threshold for a bake-off of this size: **$5/month**. Expected real spend at this
volume is **$0** — the whole workload fits inside the free tier — so a $5 budget means any alert
at all is a signal that something is looping, not that the project got popular.

If you want a genuine hard stop rather than an alert, the only mechanism is a Pub/Sub budget
notification wired to a function that detaches the billing account. That is a real
foot-gun-shaped safety net and out of scope here, but it is the honest answer to "can I cap it".

Record the threshold you set in `docs/handoff/impl-firebase-notes.md` before deploying.

## Gate 2 — the two values that were handed over as `<paste>`

```bash
export FIREBASE_PROJECT_ID=...        # was given as the literal string "<paste>"
export DEMO_REPO=owner/repo           # was given as the literal string "<paste>"
```

Also confirm which account should own this. `firebase login:list` on the build machine showed a
**personal** account, and none of its 8 projects looked like this bake-off.

---

## Once both gates are cleared

```bash
# 0. Correct account, correct project.
firebase login:list
firebase use "$FIREBASE_PROJECT_ID"

# 1. Everything that can be verified without the cloud. All of this passes today.
npm run typecheck
npm test

# 2. Security rules FIRST, before any data exists.
#    Deploying rules after data means a window where the database is open.
firebase deploy --only firestore:rules,firestore:indexes

# 3. The webhook secret, in functions/.env (gitignored). Secret Manager is disabled on this
#    project and the deploy account cannot enable it; see the note in functions/src/index.ts.
printf 'GITHUB_WEBHOOK_SECRET=%s\n' "$(openssl rand -hex 32)" > functions/.env
#    Paste the same value into the GitHub webhook settings below.

# 4. Functions.
npm run build:functions
firebase deploy --only functions

# 5. Repo -> project. Optional when exactly one project names the repo in repo_url; the
#    webhook falls back to that. Needed when several do, or every delivery is dropped as
#    "unmapped_repo".
#    Document id is the repo full_name with "/" replaced by "__", lowercased.
#      repos/{owner}__{repo}  ->  { project_id }

# 6. Dashboard.
cp client/.env.example client/.env.local   # fill in from console -> project settings
npm run build:client
firebase deploy --only hosting
```

### GitHub webhook settings

```
Payload URL:   https://us-central1-<project>.cloudfunctions.net/githubWebhook
Content type:  application/json          <- NOT form-encoded; the HMAC is over the raw body
Secret:        the value from step 3
Events:        Pushes, Pull requests, Check suites
```

`application/json` matters. With `application/x-www-form-urlencoded` the body GitHub signs is
not the JSON the handler parses, and every delivery fails verification in a way that looks like
a wrong secret.

---

## Post-deploy checks, in order

1. `curl -X POST .../githubWebhook` with no signature → expect **401**, not 500.
2. Send a GitHub "ping" from the webhook settings page → expect **200** with
   `dropped: "ping: signature verified, nothing to append"`.
3. Open the dashboard signed out → expect an empty board and `permission-denied` in the
   console, proving the rules deny a non-member.
4. `curl .../api/whoami` with no token → expect **401**.
5. Check the Firestore usage tab after an hour of idle. It should be **flat**. A climbing read
   count while nothing is happening means a listener is attached to something unbounded.

## Then, and only then

Run F1–F12 and record G1–G6. Those six metrics are the point of the exercise and they cannot be
faked from the emulator — see the "What is NOT measured" section of the notes for why emulator
numbers must not go in the comparison table.
