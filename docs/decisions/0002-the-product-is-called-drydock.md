# 0002 — The product is called Drydock

Status: **accepted**
Date: 2026-09-14
Decided by: the coordinator, at the user's instruction
Supersedes: "Catalyst Builder", which named a vendor this project no longer builds on

## Decision

**Drydock.** CLI binary `drydock`. The dashboard brand mark is `DD`.

## Why

A drydock is where one large thing is built by **many trades working at once, each in an assigned
zone, coordinated by a board on the wall.** That is this product, not by analogy but by mechanism:

| the metaphor | the mechanism |
|---|---|
| many trades, one hull | several agents, one repo |
| assigned zones nobody else enters | `acquireScope` — non-intersecting file globs |
| the job is signed for before work starts | `claimTask` — exactly one winner, verified contended |
| the board on the wall | the Kanban dashboard |
| the ship outlives the crew that built it | the git blackboard — contracts and decisions persist |

The name earns its keep in the first line of a README: *"Drydock — several AI coding agents build one
app together, without stepping on each other."*

## Why not the alternatives

- **Anything with "Catalyst"** — decision 0001 made Catalyst the *unchosen* route. Naming the product
  after a vendor it does not run on is the original complaint, only worse now.
- **Crew** — CrewAI occupies exactly this space. A collision in the same category is not a name.
- **Trellis** — the best metaphor for scope locks specifically (parallel growth without tangling) and
  a better fit for the calm, warm aesthetic. Lost because Roots Trellis is established in web tooling,
  and because the metaphor covers one mechanic rather than the whole product. **Runner-up.**
- **Wright, Playwright-adjacent** — shadowed by Microsoft's browser tool.
- **Chorus, Atelier, Tessera** — good images, weaker as typed commands.

## Honest tension, recorded rather than glossed

**Drydock is industrial; the dashboard is not.** "Kanban Calm" is warm off-white, serif headings,
generous whitespace, one teal accent. A heavy shipyard word sits slightly against that.

Judged worth it: the name has to survive a README, a repo, and a CLI prompt, where precision and
memorability beat tonal match. The interface carries the calm; the name carries the meaning. If the
tension ever becomes a real problem, **Trellis** is the fallback and the reasoning is above.

## Consequence

Rename the UI brand and title. **Do not rename the repo, branches, or Firebase/Catalyst project ids** —
those are live infrastructure, renaming them breaks measured results and running builds, and the
comparison record must stay readable. The *product* is Drydock; the *artifacts* keep their names.
