# 0004 — The product is called Flotilla

Status: **accepted**
Date: 2026-09-15
Decided by: the user
Supersedes: **decision 0002 (Drydock)**

## Decision

**Flotilla.** Binary `flotilla`, package `flotilla-cli`, brand mark `FL`.

## Why it beats Drydock

Drydock named the *place work happens*. **There is no place.** The architecture is deliberately
local-first: every agent runs on a different person's laptop, on their own Claude subscription, with
no server in the coordination path. A drydock is one fixed location everyone travels to — precisely
what this product was built not to be.

**Flotilla names the agents, and gets the shape right:** many independent vessels, separately
crewed, no mothership, moving together toward one objective. That is the system.

It also resolves the tension recorded in decision 0002 — Drydock was industrial against a warm,
low-density interface. Flotilla is lighter and matches it.

## What it costs, stated plainly

**Flotilla says nothing about territory.** Ships do not own patches of sea. Drydock's assigned zones
mapped exactly onto `acquireScope` and non-intersecting globs — the mechanic that differentiates this
product from Amoeba, and the one thing enforced server-side.

The runner-up, **Mosaic**, kept territory *and* fixed the location problem (tiles cannot overlap; no
centre implied). It lost on the user's call, and the reasoning is recorded here so it is not
re-derived from scratch.

Also lost: the owner walking the dock, which was a clean fit for the `client` role.

## Consequence

Rename the brand, the CLI, the package and the installer. **Do not rename** the repo, branches,
Firebase project ids, or Firestore collections — those are live infrastructure, and renaming them
breaks running installs and makes the measured comparison record unreadable. Same boundary as
decision 0002 drew for Drydock.

The `backend-builder` / `frontend-builder` **role slugs stay** — they are data, not the product name.
