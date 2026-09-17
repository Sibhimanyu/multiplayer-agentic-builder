# Flotilla brand assets

Flotilla's identity is a fleet of three boats moving together in a rising formation. The mark is intentionally asymmetric: it communicates coordinated agents making progress without turning into a literal nautical illustration.

## Preferred use

- Use `flotilla-lockup.svg` as the default signature on light backgrounds.
- Use `flotilla-lockup-white.svg` on dark or teal backgrounds.
- Use `flotilla-mark.svg` when the product name is already visible or space is limited.
- Use `flotilla-app-icon.svg` for square app surfaces. Browser-specific copies live at the public root.
- Keep the mark at 24 px tall or larger in interfaces. Use the supplied favicon artwork below that size.

## Clearspace, and the padding already inside these files

**None of these assets is tightly cropped.** Each carries transparent dead space inside its own `viewBox`, so a CSS `gap` or `margin` placed next to one is always larger than the number says, by an amount that scales with the rendered size. Measured from the path geometry:

| Asset | viewBox | left | right | top | bottom |
| --- | --- | --- | --- | --- | --- |
| `flotilla-mark.svg` | 520 × 420 | 9.1% | **18.0%** | 9.0% | 6.9% |
| `flotilla-lockup.svg` | 1060 × 260 | 2.5% | 1.6% | **13.7%** | **11.5%** |
| `flotilla-lockup-stacked.svg` | 760 × 540 | 3.3% | 3.4% | 6.1% | 5.0% |

Percentages are of the box, so they are size-independent: multiply by the rendered width for left/right, the rendered height for top/bottom.

This replaces the old instruction to "keep at least 20% of the mark's height clear on every side", which could not be followed — it never said whether the 20% was measured from the box edge or from the artwork, and the box hides how much clearance the file already contains. The rules now:

- **Clearspace is measured from the artwork, not the box.** The minimum is **0.34 × the mark's ink height** on every side.
- **Cancel the file's own padding at the call site** so the gap you write is the gap you get — e.g. `margin-right: calc(var(--mark-w) * -0.18)` beside `flotilla-mark.svg`. Do not re-crop these files: `exports/`, the favicons, the OG master and `client/edge/run.mjs` all assume the current boxes.
- **`margin:auto` does not optically centre the mark.** Its right padding is double its left, so the artwork sits 4.45% of its own width left of the box centre — 3 px at 67 px wide.

When the mark and the wordmark appear together, use the gap the supplied lockups already use, rather than choosing one:

| Pairing | Authored in | Gap |
| --- | --- | --- |
| mark left of wordmark | `flotilla-lockup.svg` | **0.34 × the mark's ink height** |
| mark above wordmark | `flotilla-lockup-stacked.svg` | **0.21 × the mark's ink height** |

`DESIGN.md` carries the same table plus the measured call sites in the product.

## Colors

| Name | Hex | Use |
| --- | --- | --- |
| Flotilla Teal | `#0F766E` | Primary mark, actions, emphasis |
| Ink | `#1A1917` | Wordmark and text |
| Paper | `#FAF9F7` | Warm light background |

The same values are available in `brand-tokens.css`.

## Typography

The wordmark uses Fraunces SemiBold at weight 600. Its final SVG paths are outlined, so the lockups render consistently without a font dependency. `fonts/Fraunces-SemiBold.ttf` is included for editable source work and licensed under the SIL Open Font License in `fonts/OFL.txt`.

## Asset map

- `flotilla-mark.svg`: primary teal mark
- `flotilla-mark-ink.svg`, `flotilla-mark-white.svg`: one-color alternatives
- `flotilla-wordmark.svg`, `flotilla-wordmark-white.svg`: wordmark only
- `flotilla-lockup.svg`, `flotilla-lockup-white.svg`: horizontal signatures
- `flotilla-lockup-stacked.svg`: centered stacked signature
- `flotilla-app-icon.svg`: square application icon
- `favicon.svg`, `safari-pinned-tab.svg`: browser artwork
- `flotilla-og.svg`: 1200 x 630 social preview master
- `exports/`: ready-to-use PNG renditions from 16 px through 1024 px

## Do not

- Rotate the mark further or separate its boats.
- Change the spacing or relative scale of individual boats.
- Add waves, wakes, outlines, gradients, shadows, or extra symbols.
- Recolor individual boats or place the teal mark on low-contrast colors.
- Stretch, skew, redraw, or typeset over the outlined wordmark.
- Use the earlier concept PNGs as production logos.
