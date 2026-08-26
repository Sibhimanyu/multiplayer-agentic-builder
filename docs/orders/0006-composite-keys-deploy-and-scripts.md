---
order:    0006
to:       both
issued:   2026-08-25
blocking: yes
---

# `is_unique` is table-global. Spec corrected. Plus three answers.

## 1. Accepted, and the spec was wrong again

The Catalyst workspace probed it: **`is_unique` is global to the table, not per project.** A
bare `unique(task_id)` lets project A's claim block project B's identically-named task
forever — cross-tenant denial of service by name collision.

`store-interface.md` said exactly that wrong thing ("a task_claims table whose task_id column
is is_unique"). Corrected: mandatory behaviour 2 now requires composite key columns
(`"proj_01:task_items_crud"`) for `task_claims`, `scope_locks` and `request_dedupe`, with a
builder that rejects a separator inside any part so `"a:b"+"c"` cannot collide with
`"a"+"b:c"`. `events.seq` is exempt — it is deliberately global.

**This is the second defect from "unique" meaning global**, after the seq deadlock. Standing
rule from here: treat any new `is_unique` column as table-global until a probe says otherwise.

Firestore needs none of this — a transaction on a document path is naturally scoped. **G9
entry on both sides.** Do not normalise it away; "the same guarantee cost Catalyst a composite
key scheme and Firestore nothing" is precisely the kind of finding this exercise exists to
produce.

## 2. ZCQL injection is now a mandatory item

Also probed: **ZCQL has no parameter binding.** With `project_id` arriving from request
bodies, string escaping is the *entire* injection boundary. That is now mandatory behaviour 8
in `store-interface.md`: one audited chokepoint, tests asserting no unpaired quote survives
real payloads.

Firestore's SDK is parameterised and has no equivalent exposure. Another G9 asymmetry.

## 3. Deploy question — decided: copy `_lib` at package time

Catalyst deploys each function directory independently, so shared function code must either be
vendored per directory or published as a package.

**Decision: copy at package time. Do not publish a package.**

- One `predeploy` script syncs `functions/_lib/` into each function directory.
- The copies are **generated artifacts**: gitignore them, never edit them, always overwrite.
- Source of truth stays the single `functions/_lib/`.
- Add a guard that fails the build if a copy has drifted from source.

Why not a package: a private registry adds auth, versioning and publish steps to every
contributor's setup, on an open-source tool whose main advantage is low friction. Vendoring is
a build step with no registry, no credentials and no version skew. The cost is duplicated
bytes in the deployed bundle, which does not matter here.

## 4. Root scripts — approved as you did it, no change

`package.json`'s test script and `tsconfig.json` cover `shared/**` only, and both are frozen
by 0002. Adding `tsconfig.catalyst.json` as a **new** file and running your tree with an
explicit command was the right call.

**Keep it that way.** The root scripts stay shared-only, deliberately: both builds depend on
`npm test` at root meaning exactly "the shared suite, unmodified", and that has to remain
true and identical on both branches. Each build owns its own tsconfig and its own test
command. Firebase: same rule, use `tsconfig.firebase.json` if you have not already.

## 5. Findings I did not ask for and want kept

Three catches from the Catalyst workspace that are now required behaviour for both builds
where applicable:

- **Parse `DUPLICATE_VALUE` for its column name.** `seq`, `idempotency_key` and the claim key
  collide for three unrelated reasons and **only `seq` may be retried**. A catch-all answers a
  replayed append with a fabricated claim loss. Unparseable message → rethrow, never assume.
  This is mandatory behaviour 1 and 2 interacting; getting it wrong passes both tests
  individually and corrupts in production.
- **`crypto.timingSafeEqual` throws on length mismatch.** `sha256=ab` turns a verifier into a
  500 rather than a rejection. Shape-check the header before decoding. **Firebase: check your
  webhook for this exact bug.**
- **Ambiguous GitHub payloads are dropped, not guessed.** A PR closed without `merged: true`
  is not `merged`; an inconclusive `check_suite` is not `ci_failed`. Silent misclassification
  in an append-only ledger is unfixable later. Both builds.

## Do

**Both:** `git fetch origin && git rebase origin/zoho-catalyst-app-builder` for the corrected
spec.

**Catalyst:** composite keys are already built to this shape — confirm against the corrected
mandatory behaviour 2 and move on. Implement the `_lib` copy step per section 3.

**Firebase:** you need no composite keys and no escaper. Confirm both in G9 as things Catalyst
paid for and you did not. Then check your webhook for the `timingSafeEqual` length bug and the
two ambiguous-payload cases.

## Report back

`Order 0006: composite keys confirmed, _lib copy step added` (Catalyst) /
`Order 0006: G9 asymmetries recorded, webhook audited` (Firebase). Push.
