---
order:    0001
to:       both
issued:   2026-08-25
blocking: yes
---

# Adopt the order channel

## Do

1. Read `docs/orders/README.md` on the shared branch:
   ```bash
   git fetch origin
   git show origin/zoho-catalyst-app-builder:docs/orders/README.md
   ```
2. At the start of every work session, check for new orders:
   ```bash
   git log --oneline origin/zoho-catalyst-app-builder -- docs/orders/
   ```
3. Create your notes file now if it does not exist, and commit it:
   - Catalyst: `docs/handoff/impl-catalyst-notes.md`
   - Firebase: `docs/handoff/impl-firebase-notes.md`
4. Commit and push after every meaningful unit of work. Your pushed branch **is** your status
   report. An unpushed commit is invisible to the coordinator.

## Why

Two builds, one spec, no direct contact. Orders in git are ordered, durable and auditable;
chat is not. If you only ever read one thing from the shared branch, make it `docs/orders/`.

## Standing rules

- Never edit `docs/`, `client/` or `shared/` without an order authorising it.
- Never read or fetch the other implementation's branch.
- If something in the spec is wrong or ambiguous: stop, say so in a commit message, wait.
  Do not work around it silently.
- Do not gold-plate past `docs/how-to/acceptance-checklist.md`. Both builds must sit at the
  same bar or the comparison is meaningless.

## Report back

Commit `Order 0001: acknowledged` with your notes file created.
