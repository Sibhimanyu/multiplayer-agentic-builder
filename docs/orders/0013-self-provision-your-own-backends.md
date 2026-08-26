---
order:    0013
to:       both
issued:   2026-08-25
blocking: yes
---

# Provision your own backends. Stop waiting on me for IDs.

The human has delegated this: **you handle project setup yourselves.** Both CLIs are installed
and already authenticated on this machine. I verified the capabilities below rather than
assuming them.

| Tool | Version | Auth | Can create a project? |
|---|---|---|---|
| `catalyst` | 1.27.0 | Sibhimanyu G | **No.** Only `project:list` / `project:use` / `project:reset` |
| `firebase` | 15.23.0 | sibhi.gv@gmail.com | **Yes.** `firebase projects:create` |
| `gh` | authed | Sibhimanyu | Yes. `gh repo create` |
| `gcloud` | **not installed** | — | Billing attach is NOT automatable |

## Catalyst — use Project-Rainfall. Do not touch the other one.

There is no `project:create` in the Catalyst CLI, so a new project cannot be provisioned
without the console. Two projects exist under org `60083782173`:

```
onam-utsavam       53069000000013054    <-- SOMEONE ELSE'S WORK. DO NOT TOUCH.
Project-Rainfall   53069000000013030    <-- your target
```

**Designated target: `Project-Rainfall`, project ID `53069000000013030`, org `60083782173`.**

This is the scratch project you already used for the `is_unique` probe and cleaned up
afterwards. Asking before using it was right; it is now designated.

```bash
catalyst project:use Project-Rainfall --org 60083782173
catalyst project:list --org 60083782173        # confirm the active selection
```

**Before you create anything: verify it is still empty.** If it contains tables, functions or a
Slate app you did not put there, **stop and report**. Do not build into someone's work on the
assumption that "scratch" is still true.

## Firebase — create a new one. Do not reuse any existing project.

Eight projects exist and **every one is unrelated personal work**: Abhishri Academy, Family
Tree, Mobitech, Restaurant-Display, Student Manager, Whatsapp Sender, WishLink, Zoho Birthday
Wishes. None is a scratch project. Do not touch any of them.

```bash
firebase projects:create catalyst-builder-fb --display-name "Catalyst Builder (Firebase route)"
firebase use catalyst-builder-fb
```

If that ID is taken, append a short suffix and record what you actually got. Then enable
Firestore and Hosting.

**Billing is the one thing you cannot do.** `firebase projects:create` lands on Spark, and
Cloud Functions require Blaze. `gcloud` is not installed and `firebase-tools` has no billing or
budget command — that is register entry 10, now confirmed twice.

So: provision everything you can, then **report exactly what a human must click**, in one
short list, with the project ID filled in. Do not block on it — get everything else deployed
and green first, and leave the webhook function as the only outstanding item.

## GitHub demo repos — one EACH, not shared

```bash
gh repo create Sibhimanyu/inventory-tracker-catalyst  --private --description "Demo target, Catalyst route"
gh repo create Sibhimanyu/inventory-tracker-firebase  --private --description "Demo target, Firebase route"
```

Create only your own. **Do not share one repo.** Both builds push agent branches, open PRs and
receive webhooks during F1–F12; a shared repo would have them colliding on branch names and
each other's webhook deliveries. That would destroy the independence the whole exercise rests
on, and it would corrupt G1 and G2 for both.

## What to record, because it is now G-data

In your notes, and this is the point of the exercise:

- Every ID you provisioned, verbatim.
- **How long provisioning took, and how many manual console steps it needed.** Catalyst: no
  CLI project creation at all. Firebase: one CLI command, then a manual billing step. That
  asymmetry is a real adoption cost and belongs in the register.
- Every command that failed, with the verbatim error.
- Anything you had to do in a browser.

I will add a register entry from whatever you report. Do not write to
`docs/handoff/g9-asymmetries.md` yourself.

## Scope limit — read this before running anything

You are creating real resources on a real person's accounts. Stay inside this:

- **Create only** what this order names. No extra projects, no extra repos.
- **Delete nothing** you did not create.
- **Never touch** `onam-utsavam` or any of the eight Firebase projects.
- If a command would modify something pre-existing, stop and report instead.
- Record every created resource so it can be cleaned up later.

## Do

Provision, deploy, then run the suite against the real backend once (per 0005), then F1–F12,
then G1–G6. Push after every commit.

## Report back

`Order 0013: provisioned <ids>` plus the manual-steps list if any. Push.
