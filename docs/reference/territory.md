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
| `shared/**` | **governed, not frozen** (2026-09-11) | The old reason — "one file, byte-identical across two builds" — died with decision 0001. The real rule now: **the port is the contract and the conformance suite is its gate.** Pure *additions* that leave every existing type and constant untouched are fine (e.g. `HEARTBEAT_INTERVAL_MS`, order 0041). Changing existing behaviour, or anything the conformance suite asserts, needs an explicit order. |
| root `package.json`, `tsconfig.json` | **shared, frozen** | root `npm test` must mean exactly "the shared suite, unmodified" and run the same count on both branches |
| `client/src/components.tsx` | **UNFROZEN 2026-09-11** | the freeze existed so two competing builds rendered identically. Decision 0001 closed the comparison; there is one build, so this is product code. |
| `client/src/tokens.css` | **UNFROZEN 2026-09-11** | same reasoning. Verified correct against every locked rule before unfreezing, so changes here are additions rather than repairs. |
| `client/index.html`, `client/tsconfig.json` | **shared, frozen** | same |
| `client/src/store/types.ts` | **shared, frozen** | mirrors the interface |
| `client/src/App.tsx` — the store import line | **per-build** | this is step 9. One line. |
| `client/src/store/<platform>.ts` | **per-build** | your adapter |
| `client/package.json` deps | **per-build** | one build needs an SDK the other does not |
| `client/.env.example` | **per-build** | your config surface |
| `<platform>/**` | **per-build** | everything else you build |
| `tsconfig.<platform>.json` | **per-build** | as a NEW file, never by editing the shared one |
| `docs/handoff/impl-<platform>-notes.md` | **per-build** | your report |
| `docs/results/**` | **coordinator only** | comparison artifacts; a build editing its own scorecard is the conflict of interest the whole exercise exists to avoid |
| `docs/handoff/g9-asymmetries.md` | **coordinator only** | the register |
| `docs/orders/**` | **coordinator only** | append-only, never edited after issue |

## Credentials never enter the repo

A service-account key, token or private key is **never** committed, never placed in a worktree,
and never pasted into an order — orders are pushed, and a secret in git history survives every
later deletion.

Credentials live outside every repo, referenced **by path**:

```
~/.config/multiplayer-agents/           dir mode 700
  firebase-adminsdk.json                file mode 600
```

Point tooling at them with `GOOGLE_APPLICATION_CREDENTIALS` or the equivalent. An order may name
the **path**; it may never contain the material.

If a credential arrives inside the working tree — an attachment, a download — move it out and
delete the copy in the same action. `.context/` being gitignored is a safety net, not a
destination.

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
FROZEN=(docs shared package.json tsconfig.json
  client/src/components.tsx client/src/tokens.css
  client/index.html client/tsconfig.json client/src/store/types.ts
  ':(exclude)docs/handoff/impl-*-notes.md')

MB=$(git merge-base origin/zoho-catalyst-app-builder HEAD)
git diff --stat "$MB" HEAD -- "${FROZEN[@]}"      # empty = in bounds
git rev-list --count HEAD..origin/zoho-catalyst-app-builder   # >0 = needs rebase
```

Empty diff means you are in bounds. Anything listed is a violation — revert it and raise an
order request.

**Two bugs in the version first published here, both mine, both found by a build running it:**

1. It globbed all of `docs/`, so it flagged `docs/handoff/impl-<platform>-notes.md` — which
   this file's own table lists as **per-build**. The check contradicted the table it was meant
   to enforce. Fixed with the `:(exclude)` pathspec.
2. It diffed against the shared **tip**, which conflates two entirely different conditions:
   *you modified a frozen file* (a violation, revert it) and *the shared branch moved ahead of
   you* (not a violation, just rebase). Diffing from the **merge-base** shows only what your
   branch actually touched, regardless of how far the shared branch has moved. The
   `rev-list --count` line reports "behind" separately, because the two need different
   responses.

## Verify cross-branch invariants by RUNNING, not by reading

Any claim of the form "this is the same on both branches" must be established by **executing it
against the other branch**, not by comparing sources and reasoning that they match.

The Firebase root-scripts bug is the proof: from inside either branch, everything looked
correct. The script was fine. The suite passed. The defect — 25 tests on one branch, 19 on the
other — was **invisible from within a single branch** and only appeared when the same command
was run in both places.

```bash
REF=${XCHECK_REF:-origin/zoho-catalyst-app-builder}       # the SHARED branch, not the other build
git worktree add /tmp/xcheck "$REF"
( cd /tmp/xcheck && npm install --silent && npm test )    # count it, don't read it
git worktree remove /tmp/xcheck --force
```

**Compare against the SHARED branch, not the other build's.** Better than the direct
comparison first published here, for a reason that stands on its own: the shared branch is the
normative source for root `package.json` and `tsconfig.json`, and both builds are frozen to it,
so matching it proves the two builds match **each other transitively**. It also sidesteps the
question of whether one build may touch the other's branch at all. Override with `XCHECK_REF`
if a direct comparison is ever wanted.

**An absent or unparseable count must FAIL, not pass.** Missing is drift — a guard that goes
quiet when its input disappears is broken in the direction that matters.

A throwaway worktree is cheap. Reasoning that two files are identical is not evidence that two
commands produce the same result; the second one is what the claim actually asserts.

Applies to: root `npm test` count, the `.agentic/` tree in B2, the design tokens in E8, and
anything else the checklist words as "across both builds".
