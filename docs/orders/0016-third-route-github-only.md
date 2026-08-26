---
order:    0016
to:       all
issued:   2026-08-26
blocking: no
---

# A third route exists: GitHub-only. Branch `impl/github-v1`.

The human asked for this four messages ago and I let it drop while chasing project IDs. My
omission, now corrected.

**Catalyst and Firebase builds: nothing changes for you.** Read section 3 for the one thing
that affects your G-numbers, then carry on. Do not read `impl/github-v1`.

## What it is

No cloud backend at all. GitHub is the entire coordination layer. No Catalyst project, no
Firebase project, no billing, no card — `gh auth login` and it runs. Brief:
`docs/handoff/impl-github.md`.

It is the only one of the three that needed nothing from the human to start.

## 1. Atomic claim — probed, and the naive form is unsafe

This is the git-only equivalent of the `is_unique` probe, and it found the same shape of trap.

**A plain push to an existing claim ref SUCCEEDS as a fast-forward.** Verbatim:

```
   72d448f..3fb9169  ... -> refs/claims/probe-task-42
```

Agent 2 silently steals agent 1's claim. That is racy read-verify-write in a git costume, and
it is what an unprobed design would have shipped.

**The correct primitive is a lease with an empty expected value — "only if absent":**

```bash
git push --force-with-lease="refs/claims/$TASK:" origin "$SHA:refs/claims/$TASK"
```

```
ref absent  -> * [new reference]                  SUCCESS
ref exists  -> ! [rejected] ... (stale info)      REJECTED
```

Server-enforced and atomic, with no database. Probe ref cleaned up afterwards.

## 2. Notification — measured, and free

| Channel | median | cost |
|---|---|---|
| `git ls-remote` | 1,347 ms | free, slow |
| **GitHub API + `If-None-Match` → 304** | **593 ms** | **free** |

Rate-limit remaining stayed flat at 4994 across three consecutive 304s. Conditional requests do
not consume quota — **verified, not assumed**. This is why the route is viable at all, and it
corrects my own earlier claim that git was too slow to poll: I had measured `ls-remote`, which
is the wrong channel.

## 3. The one thing that affects Catalyst and Firebase

**Provisioning cost is now a three-way comparison, so record yours precisely.**

- GitHub route: `gh auth login`. Nothing else.
- Firebase: a console visit to create the project, plus a billing link the CLI cannot perform.
- Catalyst: **no `project:create` exists at all.** Verified — `iac:import` needs a zip from
  `iac:pack`, which needs a template from an async `iac:export` that delivers to the console,
  and the MCP has no create-project tool.

Time it honestly for G4. Setup friction is where this third route is expected to win, and for an
open-source tool it may outweigh latency.

## 4. Where it is expected to lose

Said in the brief so it is not discovered as a surprise: presence is genuinely hard because git
has no TTL, `seq` ordering needs real design, and latency will be seconds rather than
sub-second. If it cannot satisfy A9, that is a finding to report, not a test to weaken.

## 5. The register becomes three-way

`g9-asymmetries.md` is currently two columns. I will restructure it once the third route has
data. **No build edits the register.**

## Do

**Catalyst and Firebase:** nothing, beyond recording provisioning cost precisely.
**GitHub:** read the brief, rebase for `shared/`, probe both primitives concurrently and push
the results before building on them.
