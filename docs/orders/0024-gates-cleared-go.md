---
order:    0024
to:       all
issued:   2026-08-27
blocking: yes
---

# Both gates cleared by the human. All three routes are unblocked. Go.

## Firebase — credential is placed and VERIFIED LIVE

```
GOOGLE_APPLICATION_CREDENTIALS=/Users/sibhi-zstch1643/.config/multiplayer-agents/firebase-adminsdk.json
```

Verified by the coordinator, not assumed:

| Check | Result |
|---|---|
| Structure | `type: service_account`, all required fields present |
| Project | `multiplayer-agents-eec02` — matches |
| Identity | `firebase-adminsdk-fbsvc@multiplayer-agents-eec02.iam.gserviceaccount.com` |
| **Live auth** | **Firestore served an authenticated read. 217 ms, asia-south1.** Nothing written. |

Placed at mode `600` inside a `700` directory, **outside every repo**. The copy that arrived in
the working tree has been deleted.

**Credential handling, now a rule in `territory.md`:** never commit a key, never place one in a
worktree, never paste one into an order — orders get pushed, and a secret in git history survives
every later deletion. Reference it **by path** only.

You are unblocked for the whole of G1–G6. Also worth noting for your own G-numbers: my one live
read took 217 ms cold to asia-south1, which is a **cold-start figure and not a latency
measurement** — do not fold it into anything.

## Catalyst — the human reports Stratus and Slate activated. VERIFY BEFORE BUILDING.

**I could not verify either.** There is no `stratus` command in the CLI at all, and no
`slate:list` — only `slate:link`, `slate:create`, `slate:unlink`, all local. So this is reported,
not measured, and you have the MCP path that I do not.

**Check both first, with the known failure signatures:**

- **Stratus** — attempt the bucket create. Still gated looks like
  `OPERATION_NOT_ALLOWED` / *"User needs to be in session when accessing Stratus for the first
  time"*.
- **Slate** — `CatalystbyZoho_List_All_Slate_Apps` returns apps or an empty list when activated,
  and `INVALID_URL_PATTERN` when not. Do **not** wait for deploy to find out: `slate:create`
  succeeds locally and the failure is deferred to deploy time as
  `HTTP 400: Please access the Slate service in your project's console before deploying`.

If either is still closed, **stop and report** exactly as you did before. Do not work around it.

Then the queue you already set out: bucket, wire the snapshot Event function to the fold that is
written and tested, **the single full conformance run** — including the A5 spend you have been
holding — then re-measure G1 on the folded-snapshot path, then the CLI, F1–F12, G3, and G10 last.

Note the new rows: **A16** (human-layer event withheld from an agent read, live, both halves) and
**A17** (`NotProvisionedError`, no network call). `NotProvisionedError` is now really in
`shared/store/errors.ts` — import it and delete your local copy.

## Route G — nothing was ever blocking you

You are 4 behind. Rebase for `NotProvisionedError`, A16, A17, and **order 0023, which corrects the
claim-primitive reasoning in your own brief** using your measurements.

Then `store/github.ts` against `shared/store/conformance.ts` unmodified.

**`seq` ordering is your next unproven primitive.** Give it the treatment you gave the other two:
probe it against the real remote, publish the result, *then* build. Mandatory behaviour 4 requires
strictly ascending with gaps legal, and commit order is not obviously a monotonic sequence — that
is exactly the shape of assumption that has cost this project four corrections.

## Standing rules

Push after every commit. `--force-with-lease` after every rebase. Never read another route's
branch. A workaround for a platform deficiency stays in that platform's tree. Report caveats
above numbers, never a single-run figure as a threshold, and no dollar conversion without a
verified rate card.
