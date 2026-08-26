# Provisioned resources — Firebase route

Everything this build created, so it can be cleaned up. Order 0013/0015 scope limits: only
what the orders name, nothing pre-existing modified, nothing deleted.

## The project — created by the human, NOT by this build

| | |
|---|---|
| display name | `multiplayer-agents` |
| **project ID** | **`multiplayer-agents-eec02`** |
| project number | `647761833901` |
| account | `sibhi.gv@gmail.com` |
| plan | **Spark** (functions unavailable; see outstanding) |

The display name and the project ID differ — Google appended `-eec02` because
`multiplayer-agents` was globally taken. **Every CLI and SDK call needs the ID.**

Verified independently rather than taken on trust: I catalogued eight projects on this account
at the start of this session, `projects:list` now returns nine, and the ninth is this one.

## Created by this build

| Resource | Identifier | Reversible? |
|---|---|---|
| Firestore database | `(default)` in **`asia-south1`** (Mumbai) | location is **PERMANENT** |
| Firestore security rules | `firestore.rules` deployed | yes, redeploy |
| Firestore indexes | `firestore.indexes.json` deployed | yes |
| Hosting release | https://multiplayer-agents-eec02.web.app | yes |
| Web app | `1:647761833901:web:542a29cfcccb7db0fd3b24` | yes, delete in console |
| GitHub repo | `Sibhimanyu/inventory-tracker-firebase` (private) | yes, delete |
| Local (gitignored) | `client/.env.local` | yes |

### Why asia-south1, and why it is worth recording

The database location is permanent and it **directly determines G1 and G2**. This machine is in
India and Catalyst is a Zoho product served from India, so a nearby region is the like-for-like
comparison. Accepting a US multi-region default (`nam5`) would have added roughly 200 ms of RTT
to every Firestore latency figure and flattered Catalyst on all of them — a measurement artefact
masquerading as a platform difference.

## Outstanding — requires a human, no CLI can do it

1. **Blaze plan** — console.firebase.google.com/project/multiplayer-agents-eec02/usage/details
   → Modify plan → Blaze, attach a billing account. Cloud Functions require it.
2. **Budget alert** — console.cloud.google.com/billing → Budgets & alerts → Create budget.
   Scope: **this project only**. Amount **$5/month**. Alerts at 50 / 90 / 100% of *actual* spend.
   Expected real spend at this volume is **$0**, so any alert at all means something is looping.
3. Then this build runs: `firebase deploy --only functions --project multiplayer-agents-eec02`

**Order matters: 2 before 3.** Blaze has no spending cap by default, only alerts.

## Nothing was touched

The eight pre-existing projects were read once, to confirm the target was not among them. None
was selected, modified or deleted: `abhishri-academy`, `family-tree-1d268`, `mobitech-c93c0`,
`restaurant-display-6ea77`, `student-manager-7e6d4`, `whatsapp-sender-5f564`,
`wishlink-birthday`, `zoho-birthday-wishes`.
