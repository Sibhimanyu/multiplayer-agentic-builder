# Flotilla — Design System

**Direction: Kanban Calm.** Chosen 2026-08-25 after comparing three directions (agent-axis,
task-axis, event-axis) and organising by **task**. The reasoning is in
`docs/designs/dashboard.md`; that file stays the source of truth for the board's pixels. This
file is the system: what the tokens are, what is locked, and what must never drift.

This system was **derived from the shipped artifact**, not proposed fresh. It already passes the
usual audit: warm paper rather than `#000`, one desaturated accent rather than a purple gradient,
consistently warm greys, tinted shadows, varied radii, a real type pairing. **Do not "modernise"
it.** Everything here is additive.

---

## Tokens

All of these live in `client/src/tokens.css` and nowhere else. No inline styles, no second
spacing scale, no second elevation scale.

### Surface and ink

| Token | Value | Use |
|---|---|---|
| `--paper` | `#FAF9F7` | warm off-white page |
| `--card` | `#FFFFFF` | raised surface |
| `--ink` | `#1A1917` | primary text |
| `--ink2` | `#4A4741` | secondary text |
| `--muted` | `#8A857C` | tertiary, labels |
| `--line` | `#E8E4DD` | hairline |
| `--line2` | `#D9D4CA` | stronger hairline, control borders |

Light mode only. Density: low, generous whitespace.

### Accent and semantics

One accent. `--teal` `#0F766E` with `--teal-soft` `#E6F2F0`. Semantic only beyond that:
`--red` `#B91C1C` / `--red-soft` `#FDEDED`, `--amber` `#B45309` / `--amber-soft` `#FDF4E7`.

Amber is not decorative — it is reserved for **an anonymous session**, the state that silently
produced an empty board. Do not spend it on anything else.

### Type

| Token | Family | Scope |
|---|---|---|
| `--sans` | Inter | body and UI |
| `--serif` | Fraunces | headings, project name, column titles |
| `--brand-serif` | Fraunces | the wordmark |
| `--mono` | JetBrains Mono | branches, ids, code **only** |

**Self-hosted, latin subset, same-origin** (`/brand/fonts/*.woff2`, order 0067). There is no
`fonts.googleapis.com` request: as a render-blocking third-party stylesheet it cost 3031 ms on a
cold load and 3572 ms to first paint. Preload Inter and Fraunces; they are on the paint path.

### Shape and motion

`--r-card:12px` `--r-ctl:8px` `--r-tag:5px`. Radii vary by nesting; they are not one value.

`--shadow` is the resting elevation. `--shadow-lift` is the hover elevation and is the **same
token doubled in offset**, not a new shadow with a new colour — that is how a system grows a
second elevation scale nobody decided on.

`--motion-fast:160ms` with `--ease:cubic-bezier(.2,0,.2,1)`. One duration, so two interactive
states cannot drift apart. Animate `transform` and `opacity` only — never `width`, `height`,
`top` or `left`.

### Spacing

One scale. Every new margin, padding and gap comes from it.

| Token | Value | Typical use |
|---|---|---|
| `--sp-1` | `2px` | hairline nudges, label offsets |
| `--sp-2` | `4px` | inside a tag or badge |
| `--sp-3` | `6px` | icon to its own label |
| `--sp-4` | `8px` | related lines in a stack |
| `--sp-5` | `12px` | inside a card, control padding |
| `--sp-6` | `16px` | between grouped blocks |
| `--sp-7` | `24px` | between groups |
| `--sp-8` | `32px` | between sections in a panel |
| `--sp-9` | `48px` | page section padding |
| `--sp-10` | `64px` | major page breaks |

**This scale is new and the shipped CSS does not yet conform.** `client/src/tokens.css` currently
carries 28 distinct pixel spacing values and the marketing site carries 38 more, including 9, 11,
13, 15, 17, 19, 34, 58, 74 and 86 — improvised one at a time. Migrate on touch; do not open a
sweep commit that rewrites every rule at once, because a spacing sweep is indistinguishable from
a spacing regression in review.

---

## Logo spacing

**The problem this section exists to solve.** `flotilla-mark.svg` and `flotilla-lockup.svg` are
not tightly cropped. Each carries dead space inside its own `viewBox`, so a CSS `gap` or
`margin` next to a logo is always **larger than the number says**, by an amount that scales with
the logo's rendered size. The old rule — "keep at least 20% of the mark's height clear on every
side" — could not be applied, because the box hides how much clearance the asset already
contains. Measured from the path geometry:

| Asset | viewBox | left | right | top | bottom |
|---|---|---|---|---|---|
| `flotilla-mark.svg` | 520 × 420 | 9.1% | **18.0%** | 9.0% | 6.9% |
| `flotilla-lockup.svg` | 1060 × 260 | 2.5% | 1.6% | **13.7%** | **11.5%** |
| `flotilla-lockup-stacked.svg` | 760 × 540 | 3.3% | 3.4% | 6.1% | 5.0% |

Percentages are of the box, so they are size-independent: multiply by the rendered width (for
left/right) or height (for top/bottom).

Two consequences, both of which were live bugs:

- **`margin:0 auto` does not centre the mark.** Its art sits 4.5% of its own width left of the
  box centre, because the right padding is double the left. At 67px wide that is 3px off.
- **A gap next to the mark is inflated by 18% of its width.** The board's lockup specified a
  10px gap and rendered a 17.25px one.

### The rules

1. **Gaps are optical.** A logo spacing number means ink to ink — the mark's artwork to the
   glyph's cap, not box to box. Verify by measuring rendered pixels, never by reading the CSS.
2. **Cancel the asset's padding at the call site**, so the gap you write is the gap you get:
   `margin-right: calc(var(--mark-w) * -0.18)`. Derive the factor from the table above. Do not
   re-crop the published assets — `exports/`, the favicons, the OG master and `client/edge/run.mjs`
   all assume the current boxes.
3. **Mark next to wordmark uses the ratio the authored lockup already uses**, not a scale step.
   Measured off the art in the assets themselves:

   | Pairing | Authored in | Gap |
   |---|---|---|
   | mark left of wordmark | `flotilla-lockup.svg` | **0.34 × the mark's ink height** |
   | mark above wordmark | `flotilla-lockup-stacked.svg` | **0.21 × the mark's ink height** |

   One ratio per axis, taken from the artwork, so a hand-built lockup cannot disagree with the
   supplied one.
4. **Everything else next to a logo uses the spacing scale.** A mark above a section heading, a
   lockup above a tagline, a lockup beside a version badge — those are layout, not lockup
   construction, and the ratios in rule 3 do not apply to them. Rule 1 still does.
5. **Line boxes inflate a gap too.** Text sits below its own half-leading, so the optical gap
   under a logo is the margin plus the asset's bottom padding plus the leading above the caps.
   For a 34px `h2` at `line-height:1.18` that last term is about 7px. This is why these numbers
   have to be measured.

### Measured call sites

Measured in Chromium at `deviceScaleFactor: 4`, one method for every row: screenshot each
element alone, take its background from its own modal pixel colour (the nav is translucent white
and the footer is `--card`, so a `--paper`-referenced threshold reports every pixel as ink), find
the first and last ink line, and subtract in page coordinates.

| Surface | Pair | CSS | Before | After | Target |
|---|---|---|---|---|---|
| board nav | `.brand-lockup` mark → "Flotilla" | `gap:var(--sp-4)` + cancel | 17.25px | **8.50px** | 0.33 × 24.5px ink = 8.1 |
| board sign-in | `[data-size=lg]` mark → "Flotilla" | `gap:var(--sp-5)` + cancel | 23.75px | **13.00px** | 0.33 × 37.25px ink = 12.3 |
| site nav | lockup → `pre-release` badge | `gap:var(--sp-5)` | 24.00px | **14.00px** | `--sp-5` + 2.0px asset padding |
| site closing | mark → `h2` | `margin-bottom:5px` | 36.25px | **15.25px** | `--sp-6` |
| site footer | lockup → tagline | `margin-top:4px` | 20.00px | **12.00px** | `--sp-5` |

Ratios against the authored `flotilla-lockup.svg`, rendered at matched ink heights and measured
the same way: **0.330** and **0.333**. The board lockup was at **0.704** and **0.638** — roughly
double the brand's own gap — and is now at **0.347** and **0.349**.

Optical centring, `#closing` mark against its heading's centre: **−2.42px → +0.43px**.

Two accepted exceptions, recorded so they are not mistaken for drift:

- **The `.mark-text` fallback sits at ratio 1.54.** When `flotilla-mark.svg` 404s, `BrandLockup`
  swaps in a styled "FL" that deliberately keeps the mark's box (order 0065), so ~9px of that box
  is empty on each side and the gap widens. The padding cancel is scoped to `img.mark` for the
  same reason — applied to the glyphs it would pull them 10px too close. Keeping the box is the
  older decision and it wins: a 404 must not also move the layout.
- **The site nav lands at 14.00px, not 12.00px.** `flotilla-lockup.svg` carries 1.6% of its width
  as padding on the right, which is 2.0px at `height:26px`. Below the size where anyone can see
  it, and cancelling it would put an un-scale-like number in the CSS for no visible gain.

---

## Locked patterns

Not open for reinterpretation. Each came out of a design review and several encode a bug that
already happened once.

1. **Six columns follow the task state machine** — Open, Claimed, In progress, Needs review, PR
   open, Merged. Each with a count badge.
2. **Agent presence is a small avatar with a status ring on the card**, not a separate panel.
   Ring: green connected, red blocked, grey offline.
3. **The detail panel overlays, never displaces.** `position:absolute; right:0; z-index:20`, and
   the board carries `padding-right:400px`. Displacing columns hid "PR open" and "Merged"
   entirely. That was a real bug. Do not reintroduce it.
4. **Freshness comes from `store.freshness`, never hardcoded.** `poll` → `updated {n}s ago` with
   a pulsing dot; `live` → a steady dot, no counter. Never fake liveness.
5. **Empty columns get a dashed empty state, never a blank.**
6. **Presence collapses past four**, so ten agents do not push the nav around.
7. **A refresh must not shift layout.** This is why the skeleton renders the real chrome.

---

## Interaction states

Order 0066. None of these are visible to a server render, which is why the edge harness scored
177/177 on a page that had none of them.

- **Focus.** One `:where(a,button,input,select,textarea,summary,[tabindex],.col-body,.board,.p-body):focus-visible`
  rule at `--focus-ring`. `:where()` contributes zero specificity, so a component needing a
  different ring overrides with a plain class and nothing is repeated when a control is added.
  **`:focus-visible`, not `:focus`** — a mouse click on a card must not leave a ring behind.
  Scrollers get an inset offset because an outset ring is clipped by their own overflow.
- **Cards lift and press.** `translateY(--lift)` with `--shadow-lift` on hover, `scale(--press)`
  on active. A task card is the most clickable thing in the product.
- **Buttons respond.** `.cta` is the primary; `.ghost` is the secondary and is what sign-out uses.
  Sign-out is the one destructive control in the nav and must never be `.linkish` again — teal,
  underlined and borderless made it the lightest thing on the page.
- **Numbers are tabular.** `font-variant-numeric: tabular-nums` on counts, freshness, seq numbers
  and durations. Verified by measurement: `11`, `18`, `90`, `99` all render at 31.20 px.
- **Titles use `text-wrap: balance`**, detail-panel body uses `pretty`.
- **`prefers-reduced-motion` suppresses the lift, the press and the skeleton sheen.** The shadow
  change stays: reduced motion is a request about movement, not a request to remove feedback.

## Loading

**Skeletons, not text.** `BoardSkeleton` and `ProjectsSkeleton` render the real `.nav`, `.stage`,
`.board` and six real `.col` elements with real column labels; only leaf content is a grey block.
The swap to real data is a content change, not a box change — locked pattern 7.

The one exception is the session gate (`AskingWhoYouAre`). Until the session resolves we do not
know whether the next screen is a board, an index or a sign-in card, and a skeleton of the wrong
page is a worse lie than a line of text. It stays text — with an 8 s deadline, because Firebase
Auth puts no timeout on its own initialisation.

---

## Ownership rules

**This section exists because the system was silently deleted once.** Commit `646b0d5` committed
a stale worktree with `git add -A` and reverted `tokens.css` (331→179), `components.tsx`
(677→543) and `App.tsx`, taking every focus ring, the tabular numerals, both skeletons, the card
states and the reduced-motion block with it. The commit message described work that was being
removed. Nothing failed: the build was clean and the harness still passed 177/177.

1. **The brand lockup has exactly one implementation.** `BrandLockup` in `components.tsx`. No
   file may render a bare `<div className="mark">`. Four nav bars drifted once; three of them
   spent weeks rendering the literal string `FL`.
2. **Only `store/session.ts` may call `signInAnonymously`.** The board once signed itself in
   anonymously on the way past the data layer, and every test seeded fixtures against whatever
   uid the harness happened to use.
3. **The build refuses a bundle with no Firebase config.** `client/verify-bundle.mjs` greps the
   emitted chunks for the API key, project id and auth domain. A config-less bundle throws at
   module scope, renders nothing, logs nothing, and exits 0 — it shipped twice.
4. **Never `git add -A` on a worktree you did not put in that state.** Diff `--stat` against
   `HEAD` before committing and account for every shrinking file.

### What the harness can and cannot see

The edge harness asserts server-rendered DOM, so it cannot see a focus ring, a hover lift, a
tabular figure or a skeleton's height. Those are verified in a real browser and the reading is
recorded in the order. It *can* see ownership, and does:

```
PASS  no file renders a bare <div className="mark">
PASS  (control) BrandLockup exists and references the asset
PASS  only BrandLockup references /brand/flotilla-mark.svg
PASS  only src/store/session.ts may call signInAnonymously
```

Every guard ships with its control assertion. A scan that proves nothing because it matches
nothing is worse than no scan.
