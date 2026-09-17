# Order 0065 — the brand mark is back, and the signed-out page is a centred card

Date: 2026-09-16
Branch: `work`

## Measured before and after, in a real browser

| | before | after (1440×900) | after (768×1024) |
|---|---|---|---|
| `.mark` | `<div>` containing the string `FL` | `<img>`, decoded, 54×44 | `<img>`, decoded, 54×44 |
| `.brand-lockup` | absent | present, inside the card | present, inside the card |
| card horizontal centre | content at left 28px | **720.0** vs viewport 720 — off by **0.0px** | **384.0** vs 384 — off by **0.0px** |
| card vertical centre | top of page | **450.0** vs 450 — off by **0.0px** | **512.0** vs 512 — off by **0.0px** |
| nav on the signed-out page | 60px bar holding a broken mark | **0 navs** | **0 navs** |
| the anonymous escape hatch | 3 lines of grey prose (86px) | **22px — one line** | **22px — one line** |
| primary action width | inline, narrower than the prose beside it | 338px of a 400px card | 338px of a 400px card |

Screenshots: `client/edge/shots/0065-signed-out-1440.png`,
`0065-signed-out-768.png`, `0065-signed-out-mark-404.png`, `0065-signed-in-nav.png`.

## 1. The mark

`BrandLockup` in `components.tsx`, used by all four places that draw the brand: `TopNav`,
`ProjectsIndex`'s nav, `LoginView`'s nav, and the signed-out card. **One component rather than
four call sites**, because the regression was that three of them kept an older literal while the
fourth got the fix.

Restored **on top of** the current components, as the order required — `ProjectCard`,
`blockedChain` and everything else 0064 added are untouched. Nothing was reverted.

The CSS moved from `.nav .mark` to `.brand-lockup .mark`. That is not tidying: a nav-scoped rule is
*why* the lockup could not simply be dropped into a card, and it is the shape that let three navs
disagree with a fourth.

**The `FL` fallback stays and is now styled.** `onError` on the `<img>` swaps to a `<span
class="mark mark-text">` in the brand serif, at the mark's teal, in the mark's own box. An `<img>`
that 404s otherwise renders as a broken-image glyph, which is worse than two letters — but a
missing asset must not also change the typeface.

## 2. The centring

One named container in `tokens.css`, as the constraint required — no inline styles, no second set
of spacing values:

```css
.centered{grid-row:1 / -1;display:flex;justify-content:center;padding:28px;overflow-y:auto}
.centered > *{margin:auto}
```

Two decisions in it worth keeping:

- **`grid-row:1 / -1`** because `#root` is `grid-template-rows:auto 1fr` and this page has no nav
  to occupy the first row. Without it the page is only as tall as its content and centres
  vertically inside nothing.
- **`margin:auto` on the child, not `align-items:center` on the parent.** When the card is taller
  than the viewport, centring via `align-items` overflows past the *top* edge and the top of the
  card cannot be scrolled to. The auto-margin form degrades to top-aligned-and-scrollable.

The card itself is `.login[data-signin="board"]` — a modifier on the existing block, not a new one.
Same typography, same gap rhythm, same `--r-card` / `--shadow` / `--line` tokens as every other
card in the product.

The nav is gone from this page only. `.centered` is also used by the two pre-session "Connecting…"
placeholders, which were inline-styled and pinned top-left — the same defect one screen along.

## 3. The escape hatch

Three lines of grey prose became `Or continue anonymously.` — 86px to 22px, measured. The primary
button is now full-width and is the widest element in the card.

**The explanation did not vanish, it moved to where it is load-bearing:** the denied state now
says *"An identity is a member of nothing until someone admits it — including an anonymous one."*
That is the screen where someone is actually looking at the consequence. The anonymous empty index
already carried its own version from order 0064.

## Verification — by rendering, because presence could not see this

**`client/edge/run.mjs` scored 177/177 on the build the user called horrible, and scores 177/177
now.** That is not a defence of it; it is the order's point restated. `renderToStaticMarkup` has no
layout engine. It confirmed a heading existed and could not see that the heading sat at left 28px
in a 1440px viewport, or that `.mark` was a div of text.

So `client/edge/layout-shot.mjs` measures a real Chromium: box geometry read back off the page and
an image asserted to have actually `decode()`d. **Every geometry assertion runs at 1440 and at
768** — a layout that centres at one width and breaks at the other is the bug being fixed.

`decode()` rather than `naturalWidth`: the asset is an SVG with a `viewBox` and no width
attribute, for which `naturalWidth` is unreliable. `decode()` is the definitive answer.

### Both halves of the mark

| | asserted |
|---|---|
| asset serves | `.mark` is an `IMG`, HTTP < 400, `decode()` resolves, box 54×44 |
| asset 404s (intercepted) | `.mark` is a `SPAN` reading `FL`, `font-family` resolves to `"Fraunces Brand"`, colour `rgb(15,118,110)`, same 54×44 box, **and the card is still centred** |

The 404 half is driven by request interception, so the app is unmodified — it meets a missing asset
exactly as it would if the file were deleted.

## Controls — a control that never fires has not been run

Four mutations, each applied, rebuilt, measured, reverted:

| mutation | what went red |
|---|---|
| the card goes back into `.stage` | 7 — both centring axes at **both** widths, the card-not-full-bleed control, and the fallback's centring |
| the lockup regresses to `<div className="mark">FL</div>` — **the exact shape that shipped** | 11, including the asset never being requested and the fallback losing its typeface |
| the SVG gets no `onError` fallback | 4 — the whole 404 half |
| the escape hatch goes back to three lines | 2 — the one-line measurement at both widths |

Two more controls are permanent rather than mutational:

- **"It is a card with margin, not a full-bleed block."** Centred and full-bleed measure the same
  distance from centre, so a centring assertion alone would pass for an unstyled page.
- **The signed-in nav.** "No nav strip" would pass for a change that deleted the nav everywhere,
  so the probe signs in anonymously, lands on the projects index, and asserts that nav *does*
  exist, *does* carry the lockup, its mark *is* an `IMG` at 36×29, and that no
  `<div class="mark">FL</div>` survives anywhere on the page. That last one is the assertion that
  would have caught the original regression.

### And a source rule, because of *how* the regression happened

It was not an edit — it was a branch consolidation that restored an older `components.tsx`
wholesale. So `run.mjs` now also asserts, without needing a browser: no file renders a bare
`<div className="mark">`, `BrandLockup` exists and references the asset, and **only** `BrandLockup`
references `/brand/flotilla-mark.svg`. Its own control checks the scan can see its subject, and it
was verified to fire by reintroducing the bare div in `App.tsx` (`FAIL … -- src/App.tsx`) and
restoring it.

## Two probe bugs, found by running it

Recorded rather than quietly fixed, since running the thing is the whole point:

1. `/brand/flotilla-mark.svg` returned **304** at the second viewport — the browser cache. An
   `=== 200` assertion failed on a correctly served asset. Now `< 400`, which is the condition the
   fallback actually exists for.
2. A leftover `check(document !== null, …)` in the node context threw `ReferenceError: document is
   not defined`. It was also a check that could never fail, which is the anti-pattern it was
   supposed to be guarding against. Deleted and replaced with the signed-in nav control above.

## Tested vs verified

**Tested** (no browser): 177/177 edge assertions, two source rules with their controls, client
`tsc --noEmit` and `vite build` clean.

**Verified in a real browser** (Chromium, production build served locally): every number in the
table at the top of this file, both halves of the mark, and the four mutation controls. The two
existing browser probes still pass unchanged — `session-shot.mjs` (12/12, real Firebase Auth and
Firestore) and `shot.mjs` (12/12, including the anonymous → denied → `--admit` → live-board path).

**Not done:** the board is **not redeployed**. Everything ran against a local serve of the
production build; `firebase deploy --only hosting` has not been run, so
`multiplayer-agents-eec02.web.app` still shows the old page.

## One thing I did not change

The card reads **Flotilla** (lockup) directly above **"Sign in to Flotilla"** — the word repeats.
It is visible in `0065-signed-out-1440.png`. Trimming the heading to "Sign in" would fix it, but
the order named three causes and this was not one of them, and that string is the synchronisation
point three browser probes wait on. Flagging rather than taking it.
