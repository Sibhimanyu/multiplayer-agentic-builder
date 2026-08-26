---
order:    0010
to:       both
issued:   2026-08-25
blocking: yes
---

# Two rulings, and territory is now written down

## RULING 1 — `timed_out` maps to `ci_failed`. Revert the narrowing.

Firebase asked, argued the opposite of what it then implemented, and narrowed it anyway because
divergence between builds is worse than a missing badge. That was the right instinct on
process. On the substance it was right the first time.

**`timed_out` is a conclusive terminal failure, not an inconclusive one.** GitHub renders it
with a red X. Dropping it leaves the board silent while the agent believes CI is still pending,
which is worse than a slightly generous label.

Order 0006 said "an inconclusive `check_suite` must not map to `ci_failed`". That wording was
imprecise and this is my correction: **conclusive failures map, everything else drops.**

The full table is now normative in `acceptance-checklist.md`, with new tests D5a and D5b:

`success` → `ci_passed` · `failure` → `ci_failed` · **`timed_out` → `ci_failed`** ·
`neutral`/`cancelled`/`skipped`/`stale`/`action_required`/`null` → drop

**Firebase:** revert the narrowing, the one-line change back. **Catalyst:** check yours against
the table; if you drop `timed_out`, change it.

## RULING 2 — the handoff wins. Territory is now `docs/reference/territory.md`.

Order 0001 said never edit `client/` without an order. `impl-firebase.md` step 9 said wire
`App.tsx`. Both could not be followed and that is my conflict to own, not a build's to
adjudicate.

**A build order step IS an order.** Following the handoff was correct, and the footprint chosen
was exactly right: `App.tsx`'s import line, a new `store/firestore.ts`, the dependency, an
`.env.example` — with `components.tsx`, `tokens.css` and `client/tsconfig.json` untouched, and
the `import.meta.env` typing kept as a triple-slash reference inside its own file so the shared
tsconfig stays byte-identical.

The freeze exists to protect **anything whose divergence would invalidate the comparison**, and
nothing else. `territory.md` now says exactly which paths those are, with a one-command check:

```bash
git diff --stat origin/zoho-catalyst-app-builder HEAD -- \
  docs shared package.json tsconfig.json \
  client/src/components.tsx client/src/tokens.css \
  client/index.html client/tsconfig.json client/src/store/types.ts
```

Empty means in bounds.

## The root-scripts catch was the most important thing in that report

Firebase's test files were under `shared/`, so root `npm test` reported **25 tests on its
branch and 19 on Catalyst's**. "Both builds pass the same tests" would have been measured by
**two different commands** — the headline claim of this entire exercise, quietly false, and
nothing would have failed to reveal it.

Two rules from it, now in `territory.md`:

1. **Test files never live under `shared/`.** Anything SDK-dependent goes in your own tree with
   its own `package.json`. Root `npm test` is exactly 19/19 on both branches.
2. **Prefer "stop needing it" over "request ownership."** Firebase asked who owned root
   `package.json`; the better answer was to restructure until it did not need to touch it.
   When a freeze blocks you, first check whether the dependency is avoidable.

**Catalyst:** run the territory check above. You added `tsconfig.catalyst.json` as a new file,
which is correct — but verify no test of yours resolves through `shared/`.

## MB1a in Firebase, and the key-construction rule

Firebase's `event_id` was `sha256(idempotency_key)` with no project in it. The document path
was correctly scoped so dedupe was never wrong — and it had reasoned from that to "scoping is
structural here", in a comment. True of the document, false of `event_id`. Two projects using
one key produced two distinct events sharing **one `event_id`**, conflating tenants in any
audit view, log correlation or client dedupe cache.

Failed on the test's first run. That is 0009 working exactly as intended, and it lands one
field over from where I predicted — which is the argument for writing the test even when you
expect it to pass.

**Its key-construction insight is accepted and generalised, not mandated.** Hashing each part
separately then combining digests makes both operands fixed-length hex, so the `"a:b"+"c"`
class **cannot exist** rather than needing policing. It also sidesteps Catalyst's silent
`varchar` 255 clamp.

But it is a genuine tradeoff, so both are permitted and the checklist now documents both:
separator-with-rejection is readable and debuggable on sight; hash-each-part is safe by
construction and opaque. **What is forbidden is a separator with no policing.** Assert
`scopedKey("a:b","c") !== scopedKey("a","b:c")` either way.

Correctly flagged as **not** a platform asymmetry. Not going in the register.

## Webhook audit — noted

`timingSafeEqual` not present, PR-merged strict, both verified by live probe rather than from
memory. Good. `timed_out` was the one real deviation and ruling 1 settles it.

## Do

**Both:** rebase, run the territory check, `--force-with-lease`.
**Firebase:** revert the `timed_out` narrowing. **Catalyst:** conform to the D5a table.

## Report back

`Order 0010: timed_out mapped, territory check clean`. Push.
