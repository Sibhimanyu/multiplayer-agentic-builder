---
order:    0014
to:       both
issued:   2026-08-26
blocking: yes
---

# Names, fixed. Supersedes the Project-Rainfall designation in 0013.

## Why this supersedes 0013

Order 0013 designated `Project-Rainfall` because the Catalyst CLI has no `project:create`.
The human has decided to create a **fresh** project in the console instead, which is the better
answer — a bake-off should not run in a scratch project someone might also be using.

**`Project-Rainfall` is no longer the target. Do not build in it.** It reverts to off-limits
alongside `onam-utsavam`.

## The four names

| Thing | Name | Created by |
|---|---|---|
| Catalyst project | **`catalyst-builder`** | the human, in the console |
| Firebase project | **`catalyst-builder-fb`** | the Firebase build, `firebase projects:create` |
| Demo repo, Catalyst route | **`inventory-tracker-catalyst`** | the Catalyst build, `gh repo create` |
| Demo repo, Firebase route | **`inventory-tracker-firebase`** | the Firebase build, `gh repo create` |

Symmetric and greppable. The backend projects are named for the **tool**; the demo repos are
named for the **app the agents build inside it**. Those are different things and the names
should not blur them.

## Catalyst build

The project will appear under org `60083782173`. Find it yourself — do not wait for an ID:

```bash
catalyst project:list --org 60083782173
catalyst project:use catalyst-builder --org 60083782173
```

Expect three projects listed. Yours is `catalyst-builder`. **`onam-utsavam` and
`Project-Rainfall` are both off-limits** — do not read, write, or select either.

If `catalyst-builder` is not listed yet, the human has not created it. Say so and stop; do not
substitute another project.

Use the **Development** environment. Production is out of scope for the bake-off, and the ZAID
differs between them — that is the documented number-one cause of auth breaking after
promotion.

```bash
gh repo create Sibhimanyu/inventory-tracker-catalyst --private \
  --description "Demo target for the Catalyst route bake-off"
```

## Firebase build

```bash
firebase projects:create catalyst-builder-fb --display-name "Catalyst Builder (Firebase route)"
```

If that ID is globally taken, append `-1`, then `-2`, and **report the exact ID you got in your
first line back.** The human needs to recognise it in the console to attach billing, and a
silently-suffixed name they cannot find is worse than a failed create.

```bash
gh repo create Sibhimanyu/inventory-tracker-firebase --private \
  --description "Demo target for the Firebase route bake-off"
```

Billing: create on Spark, deploy everything that works there, leave the webhook function as the
single outstanding item, then hand over one short list of console clicks with the real project
ID filled in. The human has confirmed they will do the Blaze link themselves. Do not block.

## Record for the register

Provisioning cost is now G-data, and the asymmetry is already visible: the Firebase build
creates its project with **one CLI command**; the Catalyst build cannot create one at all.

I verified that wall rather than assuming it. `iac:import -n <name>` is the only Catalyst
command that can create a project, and it needs a zip from `iac:pack`, which needs a template
from `iac:export`, which is asynchronous and delivers to the console rather than to disk. The
Catalyst MCP has no create-project tool either — `List_All_Projects` exists, but the only
`Create_*` tools are for tables, columns, job pools and CORS domains.

Report: wall-clock provisioning time, CLI commands versus console steps, and every verbatim
error. I will write the register entry; do not edit `g9-asymmetries.md`.

## Do

Provision, then deploy, then the shared suite against the real backend once per 0005 with the
operation count recorded, then F1–F12, then G1–G6.

Those measurements are the deliverable. Fourteen orders in, we have fourteen correctness
findings and zero numbers.
