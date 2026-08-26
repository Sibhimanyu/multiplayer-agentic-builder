# Territory — what is shared, what is per-build

Written 2026-08-25 to settle a real conflict: order 0001 says never edit `client/` without an
order, while `impl-firebase.md` build order step 9 says "wire `client/src/App.tsx` to
createFirestoreStore, one line". Both could not be followed.

**Ruling: the handoff wins.** A build order step is an order. The freeze exists to protect the
things that must stay identical, not to prevent a build from connecting itself.

## The rule

Freeze protects **anything whose divergence would invalidate the comparison**. Nothing else.

| Path | Territory | Why |
|---|---|---|
| `docs/**` | **shared, frozen** | one spec or the comparison is meaningless |
| `shared/**` | **shared, frozen** | the conformance suite must be one file, byte-identical |
| root `package.json`, `tsconfig.json` | **shared, frozen** | root `npm test` must mean exactly "the shared suite, unmodified" and run the same count on both branches |
| `client/src/components.tsx` | **shared, frozen** | the dashboard must render identically |
| `client/src/tokens.css` | **shared, frozen** | same |
| `client/index.html`, `client/tsconfig.json` | **shared, frozen** | same |
| `client/src/store/types.ts` | **shared, frozen** | mirrors the interface |
| `client/src/App.tsx` — the store import line | **per-build** | this is step 9. One line. |
| `client/src/store/<platform>.ts` | **per-build** | your adapter |
| `client/package.json` deps | **per-build** | one build needs an SDK the other does not |
| `client/.env.example` | **per-build** | your config surface |
| `<platform>/**` | **per-build** | everything else you build |
| `tsconfig.<platform>.json` | **per-build** | as a NEW file, never by editing the shared one |
| `docs/handoff/impl-<platform>-notes.md` | **per-build** | your report |
| `docs/handoff/g9-asymmetries.md` | **coordinator only** | the register |
| `docs/orders/**` | **coordinator only** | append-only, never edited after issue |

## Two rules that follow

**1. Test files never live under `shared/`.** Firebase found this the hard way: its test files
sat in `shared/`, so root `npm test` reported 25 tests on its branch and 19 on Catalyst's.
"Both builds pass the same tests" would have been measured by **two different commands**. That
would have quietly invalidated the headline claim of the whole exercise.

Anything SDK-dependent or platform-specific goes in your own tree with its own
`package.json`. Root `npm test` is exactly the shared suite, exactly 19/19, on both branches.

**2. Prefer "stop needing it" over "request ownership".** Firebase originally asked who owned
root `package.json`. The better answer was to restructure so it did not need to touch it. When
a freeze is in your way, first check whether the dependency on the frozen file is itself
avoidable.

## Verifying you are in bounds

```bash
git diff --stat origin/zoho-catalyst-app-builder HEAD -- \
  docs shared package.json tsconfig.json \
  client/src/components.tsx client/src/tokens.css \
  client/index.html client/tsconfig.json client/src/store/types.ts
```

Empty output means you are in bounds. Anything listed is a violation — revert it and raise an
order request instead.

## Verify cross-branch invariants by RUNNING, not by reading

Any claim of the form "this is the same on both branches" must be established by **executing it
against the other branch**, not by comparing sources and reasoning that they match.

The Firebase root-scripts bug is the proof: from inside either branch, everything looked
correct. The script was fine. The suite passed. The defect — 25 tests on one branch, 19 on the
other — was **invisible from within a single branch** and only appeared when the same command
was run in both places.

```bash
git worktree add /tmp/xcheck origin/<other-branch>
( cd /tmp/xcheck && npm install --silent && npm test )    # count it, don't read it
git worktree remove /tmp/xcheck --force
```

A throwaway worktree is cheap. Reasoning that two files are identical is not evidence that two
commands produce the same result; the second one is what the claim actually asserts.

Applies to: root `npm test` count, the `.agentic/` tree in B2, the design tokens in E8, and
anything else the checklist words as "across both builds".
