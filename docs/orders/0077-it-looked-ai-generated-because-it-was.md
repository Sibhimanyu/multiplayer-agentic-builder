# Order 0077 — it looked AI generated because it was

> "look at the current design and fix it. it looks too AI generated"

Correct, and specifically so. The craft floor names the three looks AI-built interfaces land in.
Number one is *cream ground, high-contrast serif display, one desaturated accent.* Kanban Calm was
that, exactly, with teal standing in for terracotta. Both its typefaces — Inter and Fraunces — are
on the detector's overused list, which flags them by name.

Four tells, all in one screenshot:

1. **Cards were the default container.** The rail was three identical cards; the queue was a card
   holding rows. "App UI made of stacked cards instead of layout" is a hard-rejection item.
2. **Every scrap of metadata was a pill**, so nothing was emphasised.
3. **Flat type**: 25 / 15.5 / 14px. Three sizes that barely differed.
4. **Uniform radius, zero texture.** Nothing decided; the safe value everywhere.

It was never ugly. It was *generic* — the safest option on every axis simultaneously, which is
what "AI generated" actually means.

## Direction: instrument panel

**Dark chosen from the use scene, not the category.** This sits beside a terminal while agents
run. Cream paper is a document aesthetic on an operations product.

- Ground `#0D1117`, surface `#161B22`, accent `#2DD4BF`.
- **IBM Plex Sans + Mono.** Not Inter, Fraunces, Geist, Plus Jakarta or Space Grotesk — every one
  is on the overused list, and swapping one for another trades a generic choice for a generic
  choice. Space Grotesk was in the original plan for this direction and was dropped for that
  reason. Plex was drawn for technical interfaces and its sans and mono are one family.
- **The queue and the rail became lists.** Rows on the ground, separated by the rule that already
  separated them. Five nested boxes became layout.
- **Section heads are mono, 11.5px, uppercase, +0.08em.** An instrument labels; it does not
  headline. The h1 went to 34px at −0.033em so the page finally has a voice.
- **Depth is light, not shadow.** On dark there is nothing darker to cast onto, so `--shadow` is
  an inset top highlight, the way a real panel catches light.

## Measured, not picked

Every colour was solved and then re-measured in the rendered page:

| token | on `--paper` | on `--card` |
|---|---|---|
| `--ink` | 16.02 | 14.64 |
| `--ink2` | 9.58 | 8.75 |
| `--muted` | 5.23 | 4.78 |
| `--teal` | 10.17 | 9.29 |

- **`--muted` is `#7C8894`, not `#768390`.** The latter measures 4.46 on `--card`. Rejected for
  0.04, because a near-miss is a miss.
- **`.cta` carries dark text.** White on `#2DD4BF` is **1.86:1** — the primary button would have
  shipped unreadable. The ground colour on it is 10.17. On a dark UI the accent is the light, so
  the text on it is the dark; carrying the light-theme habit across is how this breaks.
- **The avatar palette was solved, not chosen.** The first attempt looked right and failed on four
  of six for white initials. Each hue was darkened until white cleared 4.5:1 *and* the chip still
  cleared 3:1 against `--card`.
- **Offline is now the dimmest ring, not the brightest.** `#C4BFB6` was light-page grey.

### The measurement that lied

The first rendered-contrast pass reported two failures — `.qrow .why` at 1.86 and `.side-nav a` at
1.00. Both were wrong: the script read `rgba(45,212,191,.13)` as a *solid* colour instead of
compositing it over its parent. Fixed to composite every translucent layer down to the root; both
pass (4.83 and 7.19). Two false bugs, nearly reported as real.

## Unchanged

All seven locked patterns, and the harness that guards them: **183/183**, including the six
columns, the overlay panel geometry, the conditional clearance and its control. The spacing scale
and the measured logo table survive untouched. Only the world changed.

`--serif` and `--brand-serif` are kept as *names* so no call site breaks; both resolve to the sans.
There is no serif in this world.

## Verified

- Design detector: **2 findings → 0.** The overused-font flags are gone, which was the mechanical
  half of the complaint.
- Live cold load: **FCP 404 ms, zero third-party requests**, three font files fetched (the mono
  loads only on pages that use it). The work of order 0067 held.
- `flotilla-mark.svg` recoloured to the new accent in place — the harness rule that only
  `BrandLockup` may reference it is what made that safe. The old `Inter-var`, `Fraunces-var` and
  `JetBrainsMono-var` files are deleted and `index.html` no longer preloads fonts nothing uses.

## Still open

`docs/designs/dashboard.md` describes the superseded world. Its locked patterns are restated in
`DESIGN.md` and are current; the pixels in it are not.
