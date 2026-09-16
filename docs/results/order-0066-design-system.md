# Order 0066 — the five things Kanban Calm specified and never got

Date: 2026-09-16
Branch: `work`

Everything here is **additive**. The palette, the type pairing, the radii and the density are
unchanged — Kanban Calm was chosen after comparing three directions and the reasoning is in
`docs/designs/dashboard.md`. Nothing above the order-0066 block in `:root` was touched.

## What landed, measured in a browser

| | before | after |
|---|---|---|
| `:focus-visible` in 178 lines of tokens.css | **none** | one rule over a `:where()` list; keyboard gives `solid 2px rgb(15,118,110)` at `2px` offset, mouse gives `none` |
| digits in sans | `11`=9.77px `18`=12.31px `90`=15.02px | **all 15.56px** |
| cold load | `Connecting…` as bare text for up to 15s | six-column skeleton; board height `840.0px → 840.0px`, top `60.0 → 60.0` |
| card hover / press | nothing | `translateY(-1px)` + deeper shadow; `scale(.985)` on press |
| card titles | no `text-wrap` | `balance` (49-char title on the probe board) |
| `prefers-reduced-motion` | covered nothing | lift, press, transition and skeleton sheen all suppressed |

Screenshots: `client/edge/shots/0066-skeleton-1440.png`, `0066-loaded-1440.png`,
`0066-focus-ring.png`.

## The five

**1. Focus rings.** One rule over a `:where(a,button,input,select,textarea,summary,[tabindex],
.col-body,.board,.p-body)` list. `:where()` contributes **zero specificity**, so a component that
needs a different ring overrides it with a plain class selector and nothing has to be repeated
when a control is added. The scrollers get the same token at a *negative* offset, because an
outward ring on an `overflow:auto` box is clipped by its own overflow.

`:focus-visible`, never `:focus` — a mouse click on a card must not leave a ring behind, and a
rule written with `:focus` is how focus styles end up deleted from a codebase entirely.

**2. Tabular numbers.** A rule list in `tokens.css` rather than a utility class: adding a
`className` at twelve call sites is the same thing wearing a different hat, and it is the form
that gets forgotten at the thirteenth. Applied to `.count`, `.fresh`, `.badge`, `.verpill`,
`.branch`, `.dep .st`, `.p-head .id` and friends. The already-mono selectors are included
deliberately — `--mono` falls back through four families and "the fallback happens to be
monospaced" is luck, not a guarantee.

**3. Loading state.** `BoardSkeleton` renders the **real chrome**, not a picture of it: the real
`.nav`, the real `.stage`, the real `.board` and six real `.col` elements carrying the real column
labels. Only the leaf content is a grey block. That is what makes the swap a *content* change
rather than a *box* change — locked pattern 7 says a refresh must not shift layout, and a skeleton
that resizes on arrival would break that rule in a new place. Measured: **0.0px** of height change
and **0.0px** of movement.

The labels are real rather than blanked because they are known before any data arrives. A skeleton
should withhold what it does not know, not what it does.

`ProjectsSkeleton` does the same for the index, which had the same bare-text defect one screen
along.

**One deliberate loss:** `signing-in` and `live` are no longer distinguished on screen. That
distinction ("the rules are not the problem") was written for whoever is debugging the board, not
for whoever is using it, and it cost every user the one thing that says the app is alive. The
state is still on `status`, and every state a user can *act* on — denied, auth-unavailable,
error — still says exactly what it is.

**4. Hover and press.** `--shadow-lift` is the existing `--shadow` with a deeper offset, not a new
shadow with a new colour — that is how a system grows a second elevation scale nobody decided on.
The transition names `transform` and `box-shadow` only; never `width`, `height` or `top`, which
would make every hover a layout pass and reflow the column under the pointer.

A *selected* card keeps its teal selection ring instead of the hover shadow (source order, equal
specificity) and still lifts, because the lift is a transform. That is deliberate: selection is
more important to preserve than hover feedback.

**5. `text-wrap`.** `balance` on `.card .title`, `pretty` on `.sect p`. Different values on
purpose: `balance` optimises for even line lengths across a short block, which is right for a
title and wrong for a paragraph, where only the orphan needs preventing.

**The motion constraint.** `prefers-reduced-motion` suppresses the hover lift, the press
transform, the transition itself, the skeleton sheen **and** the existing poll-dot pulse. A
looping shimmer is exactly the kind of animation someone sets this preference to stop. The
hover still *responds* — the shadow change stays — because reduced motion is a request about
movement, not a request to remove feedback.

## Also: the heading

`Sign in to Flotilla` → **`Sign in`**. The lockup directly above it already says Flotilla, so the
longer heading read the word twice in adjacent lines.

**Four probes waited on that string.** They now wait on `.login[data-signin="board"]` — a
synchronisation point that is a structure rather than a sentence cannot be broken by rewording the
sentence. `client/edge/{shot,session-shot,layout-shot}.mjs` and the new `system-shot.mjs`, all in
this commit.

## Verification

`client/edge/run.mjs` scores **177/177** before and after. It would score 177/177 with no focus
ring, jittering digits, no loading state and dead cards, because `renderToStaticMarkup` has no
layout engine, no `:focus-visible` heuristic, no font metrics and no media queries. That is the
order's point, not a defence of the harness.

`client/edge/system-shot.mjs` measures a live Chromium. **It builds its own board**: a throwaway
project with a throwaway member, filled through the port's own `createTask` (order 0063),
measured, then deleted. An earlier version pointed at `proj_inventory` and signed in anonymously —
a fresh anonymous uid is a member of nothing, so the board went to the denied state and there was
no `.board` to measure; and the alternative, walking the `--admit` flow, leaves another anonymous
viewer on a real project every run. Real Firestore, real rules, real identity, nothing left
behind.

## Controls — a control that never fires has not been run

Six mutations, each applied, rebuilt, measured in the browser, reverted:

| mutation | what went red |
|---|---|
| `:focus-visible` → `:focus` | **only the mouse half** — the keyboard half passed, which is the whole reason both halves exist |
| tabular figures removed | the width equality, plus both "is it applied" checks |
| skeleton → bare text | "renders a skeleton, not bare text" and the block count |
| hover/press removed | lift, shadow and press |
| `prefers-reduced-motion` inverted to `no-preference` | **7 assertions, in both directions** — motion suppressed for everyone *and* present for the people who asked for it off |
| `text-wrap: balance` removed | titles are balanced (`wrap`) |

Three controls are permanent rather than mutational:

- **The tabular measurement is taken on a proportional family, and asserts so.** The first version
  measured `.count`, which is `--mono` and therefore already fixed-width — its control reported
  `11 = 18 = 90` with the property switched *off*, so it could not have failed. The order said it
  plainly: "this is for the numbers that live in sans."
- **"No layout property is in the transition list"**, so a future edit cannot add `height` to it.
- **The reduced-motion section is controlled by the section above it**, which proves the transform
  is present — which is what makes its absence mean anything.

## Three probe bugs, found by running it

Recorded rather than quietly fixed:

1. **The mouse-click half reported a ring.** Chrome's focus-visible heuristic is *modal*: clicking
   the very element you just tabbed to keeps the ring. The probe was reusing the keyboard page and
   modelling a user who does not exist. The mouse half now runs on a page that has never seen a
   key press.
2. **"Hover deepens its shadow" failed on a selected card.** An earlier section clicked it,
   `.card[data-sel="true"]` replaces the box-shadow with the selection ring, and the measurement
   was true of that card and nothing to do with hover. Now measures
   `.card:not([data-sel="true"])`.
3. **The `pretty` assertion passed on an absent element.** Only one seeded task had a description,
   the board sorts by `task_id`, and the panel it opened had no paragraph — so the check passed
   through an `|| element is absent` branch, which is a check that cannot fail. Every seeded task
   now has a description and the assertion is strict.

## What the order asked for that cannot hold literally

> render a count at `9` then `10` and assert the element's width **does not change**

**It cannot.** `10` is one more digit than `9` and is therefore wider under any font, tabular or
not — measured, `7.78px → 15.56px`. Reported rather than silently substituted.

The invariant tabular figures *do* give, and the one the jitter is actually about, is that two
numbers with the **same digit count** measure the same. Proportional Inter renders `11` at 9.77px
and `18` at 12.31px, so a live count ticking 18 → 11 shifts every pill to its right. That is what
is asserted, with the control above showing the same measurement diverging when the property is
off.

## Tested vs verified

**Tested** (no browser): 177/177 edge assertions, three source rules with their controls, client
`tsc --noEmit` and `vite build` clean, `npm test` 34/34 for the shared suite, firebase-scope
typecheck clean.

**Verified in a real browser** (Chromium, production build served locally, real Cloud Firestore
and real Firebase Auth): every number in the table at the top, the six mutation controls, and all
four pre-existing probes still green — `layout-shot.mjs`, `session-shot.mjs` and `shot.mjs`
including the anonymous → denied → `--admit` → live-board path.

**Not done:** the board is **not redeployed** — everything ran against a local serve of the
production build. You said you would deploy.

## One thing left standing

The `impeccable` design hook reports two `broken-image` findings in `client/src/components.tsx`.
Both are matches on **prose inside `BrandLockup`'s doc comment** — the paragraph that explains
what an `<img>` whose source 404s does — not on code. The real `<img>` has a valid `src` that
`layout-shot.mjs` asserts decodes in a browser. Left standing rather than persisting a file-wide
ignore for a comment match.
