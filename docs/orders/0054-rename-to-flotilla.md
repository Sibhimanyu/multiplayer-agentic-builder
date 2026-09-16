---
order:    0054
to:       firebase
issued:   2026-09-15
blocking: yes
---

# Rename Drydock to Flotilla, everywhere it is the product name and nowhere it is data.

Decision 0004 supersedes 0002. The user chose it; the reasoning is in the record. Short version: the
architecture is local-first with every agent on a different laptop, so naming it after a **place**
was wrong. Flotilla names the agents — independent vessels, no mothership.

## Rename

- Package `drydock-cli` → **`flotilla-cli`** (verified free on npm)
- Binary `drydock` → **`flotilla`**
- Directory `drydock/` → **`flotilla/`**
- UI brand "Drydock" → **"Flotilla"**, mark `DD` → **`FL`**, `<title>`
- Config `~/.drydock/` → **`~/.flotilla/`**
- Env `DRYDOCK_*` → **`FLOTILLA_*`**
- Every generated file: `AGENTS.md`, `role.md`, `protocol.md`, `current-task.md`
- Every user-facing string: help text, empty states, error messages, the installer

## Do NOT rename

Repo, branches, Firebase project ids, Firestore collections, the hosted URL — **live infrastructure.**
Renaming breaks running installs and makes the comparison record unreadable. Same boundary decision
0002 drew.

**`backend-builder` and `frontend-builder` role slugs stay** — data, not the product name. You flagged
these correctly during the last rename; the same reasoning holds.

## The lesson from last time, applied

Order 0048's rename covered the CLI's own help text **and not the files the CLI generates** — a real
agent found `builder claim` in a generated role pack afterwards. **A rename is not done when the
binary is renamed.**

So: grep the **built bundle** and the **generated output**, not just source. Assert that a freshly
generated project contains zero occurrences of the old name. That assertion is the deliverable, not
the rename.

## Migration for anyone already installed

Nobody outside this machine has it, so no compatibility shim. But `~/.drydock/` may exist locally —
`flotilla init` must not silently read the old path. Fresh config, clean break.

## Verify

Rebuild, repack, install the tarball into a clean directory under a scrubbed environment, and run
`flotilla --help`. Then grep the installed bundle for `drydock` and assert **0**. Same standard as
the project-id check: source being clean proves nothing.

Report the grep counts, not that you did the rename.
