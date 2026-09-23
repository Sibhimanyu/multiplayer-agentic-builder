# Order 0070 — the design system was deleted by my own commit

The user ran `/design-consultation`. The finding is not a missing design system. It is that the
design system landed on 2026-09-16 and I deleted it the same day.

## What the numbers said

`client/src/tokens.css`, by commit:

| commit | lines | `:focus-visible` | `tabular-nums` |
|---|---|---|---|
| 775663a (order 0066) | 331 | 4 | 1 |
| **646b0d5 (order 0067, mine)** | **179** | **0** | **0** |
| 48bbd01 (order 0069, mine) | 201 | 2 | 0 |

Order 0066 shipped focus rings, tabular figures, two skeletons, card hover/press states,
`text-wrap: balance` and a `prefers-reduced-motion` block, and its commit message recorded the
before/after measurements. My next commit removed all of it.

`git diff --numstat 775663a 646b0d5` shows the full blast radius — everything that shrank:

```
client/src/tokens.css              -152
client/src/components.tsx          -134   (BoardSkeleton, ProjectsSkeleton, BrandLockup)
client/src/App.tsx                   -8   (skeleton wiring -> bare "Connecting…")
client/edge/system-shot.mjs        -465   (deleted)
client/edge/layout-shot.mjs        -263   (deleted)
client/edge/run.mjs                 -37   (the brand-mark ownership scan)
docs/results/order-0066-design-system.md  -178 (deleted)
docs/results/order-0065-signed-out-layout.md -160 (deleted)
scripts/run-design-system-probe.sh  -12   (deleted)
```

## How

`git add -A` on a worktree that was already dirty. The session began with files staged at an
older revision than `HEAD`; I committed that state as though it were my font change and never
diffed `--stat` against `HEAD`.

Nothing failed. `tsc` was clean, `vite build` succeeded, the edge harness passed 177/177, and the
commit message described work that was being deleted rather than added.

## What this cost, in the user's words

Three of the last four things reported were symptoms of this commit:

- **"it seems to take so long to load up each page."** The skeletons were gone, so a cold load
  showed bare `Connecting…` text — exactly the failure order 0066 point 3 had already fixed. The
  font work in order 0067 was real and the 3572→968 ms measurement stands, but the *symptom*
  reported was a regression I had introduced hours earlier.
- **"where is the logo."** `BrandLockup` was deleted, along with the harness scan that forbids a
  bare `<div className="mark">`. Order 0069 then rebuilt a weaker version of a component that
  already existed, without the `onError` text fallback or the `data-size` variant.
- **"why do i just have an anchor element."** True independently, now fixed on the restored base.

## Restored

`git checkout 775663a -- <every path above>`, then the three later orders re-applied on top:
self-hosted fonts and `verify-bundle.mjs` (0067), `store/db.ts` long-polling and the session-gate
deadline (0068), the account pill and `.ghost` (0069). `BrandLockup` is the original, with its
fallback. The session gate is now `AskingWhoYouAre` — still text, because a skeleton of a page we
cannot yet identify is a worse lie, but text with an 8 s deadline.

## Verified in a real browser, because none of it is server-renderable

| item | reading |
|---|---|
| focus ring | `2px solid rgb(15, 118, 110)` on keyboard focus |
| card hover | `transition-property: transform, box-shadow` |
| `--shadow-lift` | `0 3px 8px rgba(26,25,23,.07)` |
| card titles | `text-wrap: balance` |
| tabular figures | `11` `18` `90` `99` all **31.20 px** |

Harness 177/177 plus the three restored brand-mark ownership assertions, which are the guard that
would have caught this.

## The rule this adds

`DESIGN.md` now exists at the repo root as the system of record, and its Ownership rules section
ends with: **never `git add -A` on a worktree you did not put in that state.** Diff `--stat`
against `HEAD` and account for every shrinking file.

The recurring lesson again, in its sharpest form yet: a true signal about the wrong subject. A
green build and a passing harness were both honest about compilation and about server-rendered
DOM. Neither was a claim about the stylesheet, and I read them as one.
