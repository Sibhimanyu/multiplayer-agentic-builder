---
order:    0066
to:       firebase
issued:   2026-09-16
blocking: yes
---

# Five things Kanban Calm specified in spirit and never got in `tokens.css`.

The user ran a design audit and asked for all of it fixed. Order 0065 is handling the broken mark and
the uncentred sign-in page. **This is everything else.**

Read this first: **the design system is not the problem.** Against the usual audit checklist the
palette already passes — warm paper rather than `#000`, one desaturated teal rather than a purple
gradient, consistently warm greys, tinted shadows, varied radii, and a real type pairing. Do not
"modernise" it. Kanban Calm was chosen after comparing three directions and the reasoning is in
`docs/designs/dashboard.md`. Everything below is **additive**.

## 1. Focus rings — an accessibility failure, not polish

There is no `:focus-visible` anywhere in 178 lines of `tokens.css`. Keyboard users get the browser
default or nothing.

One token, applied to every interactive thing: cards, buttons, links, the column scrollers. Use
`--teal` at a visible offset so it reads on both `--paper` and `--card`. **`:focus-visible`, not
`:focus`** — a mouse click on a card must not leave a ring behind.

## 2. Tabular numbers

Task counts, seq numbers, durations and timings sit in proportional Inter, so **digits jitter as they
change on a live board.** A count going 9 → 10 should not shift the layout next to it.

`font-variant-numeric: tabular-nums` on the count badges, the freshness pill, and anything rendering
a seq or a duration. The mono family is already there for ids and branches — this is for the numbers
that live in sans.

## 3. Loading state

A cold load shows **"Connecting…" as bare text for up to 15 seconds.** The user read that as a broken
app twice, and they were being reasonable.

Skeleton columns that match the real board's shape — six columns, a few card-height blocks. It must
not reflow when real data replaces it; locked pattern 7 in `dashboard.md` already says a refresh must
not shift layout, and a skeleton that resizes on arrival breaks that rule in a new place.

## 4. Hover and pressed states on cards

A task card is the most clickable element in the product and does not respond to being touched.

Hover: a small lift using the existing shadow token, not a new one. Press: `transform:
scale(.98)` or a 1px translate. 150–200 ms, on `transform` and `opacity` only — never on `width`,
`height` or `top`.

## 5. `text-wrap: balance` on card titles

`dashboard.md`'s edge-case table has a 47-character title wrapping to two lines. That is exactly
where a single orphaned word lands. `balance` on titles, `pretty` on the detail-panel body.

## Constraints

- **Everything goes in `tokens.css` as named tokens.** No inline styles, no second spacing scale.
- Do not change the palette, the type pairing, the radii, or the density.
- `prefers-reduced-motion` must disable the hover lift and the press transform. A motion preference
  that only covers page transitions is not honoured.

## Verify in a browser, because none of this is visible to a server render

Your edge harness scored 177/177 on a page with an unstyled brand mark and no centring. **Presence
assertions cannot see any of the five things above.**

- Focus ring: tab to a card, assert a visible outline; assert a *mouse click* leaves none. Both halves.
- Tabular numbers: render a count at `9` then `10` and assert the element's width **does not change**.
  That is the actual bug, and "the CSS property is set" is not the same claim.
- Skeleton: assert the board's height before and after data arrives differs by less than a few px.
- Reduced motion: assert the transform is suppressed under the media query, with a control proving it
  is present without it.

Screenshot the skeleton and the loaded board at 1440, and put both in the report.
