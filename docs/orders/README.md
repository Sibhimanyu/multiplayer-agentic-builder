# Orders

How the two implementation workspaces receive instructions.

This uses the same shape as the product we are building: **the commit is the ledger, the
message is the doorbell.** Orders are durable, ordered and auditable in git. A chat message
only tells you to come and look.

## Roles

| Who | Branch | Writes | Reads |
|---|---|---|---|
| **Coordinator** | `zoho-catalyst-app-builder` | orders, shared code | both impl branches |
| Catalyst build | `impl/catalyst-*` | its own branch + notes | orders (read-only) |
| Firebase build | `impl/firebase-*` | its own branch + notes | orders (read-only) |

Only the coordinator writes the shared branch. Neither build may edit `docs/`, `client/` or
`shared/` without an order that says so.

The two builds never read each other's branch. Independence is the entire point of building
both — the moment one sees the other's approach you are comparing agents, not platforms.

## Reading orders — do this at the start of every work session

```bash
git fetch origin
git log --oneline origin/zoho-catalyst-app-builder -- docs/orders/
git show origin/zoho-catalyst-app-builder:docs/orders/0002-example.md
```

**Read-only. Do not merge or rebase to read an order.** That keeps you off the shared
branch's churn. Only rebase when an order explicitly tells you to.

## Picking up shared code, only when an order says to

```bash
git fetch origin
git rebase origin/zoho-catalyst-app-builder
npm install && npm test          # the shared suite must still pass
```

## Reporting back

There is no reply channel and you do not need one. **Commit and push.** The coordinator reads
your branch directly, including your commit messages.

Append to your own notes file — `docs/handoff/impl-catalyst-notes.md` or
`impl-firebase-notes.md` — as you go. That file is your report. Keep it honest: every
constraint hit, every workaround, real hours.

Acknowledge an order by naming it in a commit message: `Order 0002: rebased onto shared foundation`.

## Order format

```
---
order:    0002
to:       both | catalyst | firebase
issued:   2026-08-25
blocking: yes | no        # yes = stop current work and do this first
---
```

`blocking: yes` means stop what you are doing. `no` means fold it into your next step.

## Escalating

If an order contradicts a spec file, or a spec file looks wrong, **stop and say so in a commit
message on your branch.** Do not edit shared files. Do not work around it. A silent workaround
in one build and not the other invalidates the comparison, which is the one thing this whole
exercise is for.

## Conflicts

One file per order, numbered, never edited after issue. A correction is a new order that
supersedes an old one, never a rewrite. Same rule as the blackboard: additive only, so merges
cannot conflict.
