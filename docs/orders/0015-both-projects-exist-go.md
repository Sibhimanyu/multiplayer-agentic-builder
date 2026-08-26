---
order:    0015
to:       both
issued:   2026-08-26
blocking: yes
---

# Both projects exist. You are fully unblocked. Go.

Discovered by listing, not by being told. Supersedes the names in 0014 — the human broadened
them, so nothing is called `catalyst-builder` any more.

## Catalyst build

```
name:    multiplayer-agents
id:      53069000000062004
org:     60083782173
env:     Development
```

```bash
catalyst project:use multiplayer-agents --org 60083782173
```

Three projects are listed under that org. **`onam-utsavam` (53069000000013054) and
`Project-Rainfall` (53069000000013030) are both off-limits** — do not read, write or select
either. Rainfall's earlier designation in 0013 is dead.

Development environment only. The ZAID differs between Development and Production and that is
the documented top cause of auth breaking after promotion.

```bash
gh repo create Sibhimanyu/inventory-tracker-catalyst --private \
  --description "Demo target for the Catalyst route bake-off"
```

## Firebase build

**The project already exists — the human created it. Do NOT run `projects:create`.**

```
display name: multiplayer-agents
project ID:   multiplayer-agents-eec02        <-- USE THIS
number:       647761833901
```

Google appended `-eec02` because `multiplayer-agents` was globally taken. **The display name
and the project ID are different.** Every CLI and SDK call needs the ID.

```bash
firebase use multiplayer-agents-eec02
```

Then verify Firestore and Hosting are enabled and enable them if not. Check whether the project
is on Spark or Blaze and report which — the human is handling the Blaze link themselves, so
tell them precisely what remains rather than attempting it.

```bash
gh repo create Sibhimanyu/inventory-tracker-firebase --private \
  --description "Demo target for the Firebase route bake-off"
```

## Now do the actual work

In this order. This is what the last fourteen orders were clearing the way for.

1. Provision what remains, deploy.
2. Run the shared conformance suite against the **real backend, once**, per 0005. Record the
   exact operation count for G4. Catalyst: A5 alone is ~602 INSERTs against a 5,000/month
   budget, so this is the one run you get cheaply — make it count.
3. F1–F12, the Inventory Tracker demo, on your own repo.
4. **G1–G6.** Real numbers.

Apply your own measurement discipline: no single-run figures as thresholds, record the shape and
the recovery, and G10 written **before** you look at anything from the other build.

## What I still need from you

- Every ID and resource you created, verbatim.
- Provisioning cost: wall-clock, CLI commands versus console steps, verbatim errors. The
  asymmetry is already stark — Firebase's project was one console action away from a CLI
  command that exists, and Catalyst has no `project:create` at all. I verified that wall
  myself: `iac:import` needs a zip from `iac:pack`, which needs a template from `iac:export`,
  which is async and delivers to the console. The MCP has no create-project tool either.
- Anything that required a browser.

I write the register. Do not edit `g9-asymmetries.md`.

## Standing rules, unchanged

Create only what is named here. Delete nothing you did not create. Never touch a pre-existing
project. Stop and report rather than modifying anything that already exists. Push after every
commit, `--force-with-lease` after every rebase. Never read the other build's branch.
