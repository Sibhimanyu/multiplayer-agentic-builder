---
order:    0065
to:       firebase
issued:   2026-09-16
blocking: yes
---

# The signed-out page is an unstyled document, and the brand mark regressed to plain text.

The user's words: "the UI is horrible." They are right, and one of the three causes is mine.

Measured on the deployed board at 1440×900:

```
.mark        <div> containing the literal string "FL"   — no SVG, 36px wide
.brand-lockup  absent
heading      left: 28px in a 1440px viewport
```

## 1. The brand mark regressed — my fault

Order 0054 replaced `<div className="mark">FL</div>` with a `brand-lockup` wrapping
`/brand/flotilla-mark.svg`. **It is not in the shipped bundle.** When I consolidated the branches I
restored the product `components.tsx` (which had `ProjectCard` and the `blockedChain` prop) and the
brand work went with it. The asset still serves — `/brand/flotilla-mark.svg` is HTTP 200 — and
nothing references it.

Restore the lockup **on top of** the current components, not by reverting to the older file. That is
the same mistake in the other direction.

## 2. Nothing is centered

The signed-out page is the one screen in the product with a single job and no data. It should be a
**centered card**, vertically and horizontally, with the lockup above it. Right now it is content
pinned to the top-left of an otherwise empty 1440px page.

The nav strip is also wrong here: a 60px bar holding only a broken mark, above a page that has no
navigation to offer. Signed out, the lockup belongs **in** the card.

## 3. The escape hatch outweighs the primary action

One button for "Continue with Google", then **three lines of grey prose** about throwaway identities
and being admitted to boards. The secondary path carries more visual weight than the thing you want
clicked.

Cut it to one line. The detail belongs where someone hits the denied state, not in front of everyone
who signs in.

## Constraints

- `tokens.css` and the existing idioms. The board and this page are one product.
- **Do not invent a second set of spacing values.** If centering needs a container the design system
  lacks, add it to `tokens.css` as one named thing, not inline styles.
- The `FL` fallback must stay for when the SVG cannot load — but styled, not raw default type.

## Verify by rendering, not by asserting presence

The edge harness server-renders, which is exactly why it scored 177/177 while the page looked like
this. **Presence assertions cannot see layout.** So:

- Assert in a real browser that the card's horizontal centre is within a few px of the viewport
  centre at 1440 and at 768.
- Assert `.mark` resolves to an `<img>` with a loaded SVG, and separately that the text fallback
  renders when the asset 404s — both halves.
- Screenshot both widths and put them in the report.

A layout that only looks right at one width is the bug being fixed, not evidence against it.
