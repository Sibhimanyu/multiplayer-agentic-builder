---
order:    0002
to:       both
issued:   2026-08-25
blocking: yes
---

# The shared foundation is on the shared branch. Consume it, do not fork it.

`shared/` now exists on `zoho-catalyst-app-builder`. It was written by the Catalyst workspace
and promoted by the coordinator. Verified before promotion: **19 tests pass, 0 fail, typecheck
clean.**

```
shared/store/types.ts         the CoordinationStore interface
shared/store/memory.ts        in-memory reference implementation
shared/store/conformance.ts   section A conformance suite  <-- both builds run THIS
shared/store/errors.ts        StoreAuthError / StoreBusyError / StoreOfflineError
shared/store/retry.ts         jittered backoff
shared/sanitize.ts            emoji + 4-byte UTF-8 stripping, varchar/text caps
shared/globs.ts               file-scope intersection
shared/clock.ts               injectable clock
shared/log.ts                 structured logging
package.json  tsconfig.json   root workspace for the above
```

## Do — Firebase workspace

**Stop before writing any store code.**

```bash
git fetch origin
git rebase origin/zoho-catalyst-app-builder
npm install
npm test          # must be 19/19 before you continue
```

Then implement `store/firestore.ts` against `shared/store/types.ts` and make it pass
`shared/store/conformance.ts` **unmodified**.

If you have already started your own `memory.ts` or conformance suite, **delete it** and use
these. Two different suites means "both builds pass the same tests" is a false claim, and that
claim is the entire deliverable.

## Do — Catalyst workspace

```bash
git fetch origin
git rebase origin/zoho-catalyst-app-builder
```

Your commit `f5a7dce` is now the shared foundation. From here `shared/` is **frozen to you
too**. If you need to change it, that is an order request, not an edit: say so in a commit
message and wait. A unilateral change to `shared/` desynchronises the other build silently.

Continue with build order step 3, the Data Store tables.

## Why

`shared/store/conformance.ts` is the only thing that makes "both implementations satisfy the
same contract" a measured fact rather than an assertion. It has to be one file, running
identically against both.

## Report back

Commit `Order 0002: rebased onto shared foundation, 19/19 passing` once `npm test` is green.
