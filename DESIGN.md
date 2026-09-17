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
