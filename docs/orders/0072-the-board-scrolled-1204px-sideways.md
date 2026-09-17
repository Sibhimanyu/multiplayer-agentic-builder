# Order 0072 — the board scrolled 1204px sideways

Reported with a screenshot: "im having to horizontal scroll for so long. can we fit more?"

## Measured, inside the shell, at 1440

| | before | after |
|---|---|---|
| board content width | 2080 px | 1432 px |
| visible width | 876 px | 1196 px |
| **hidden** | **1204 px** | **0 px** |
| **columns fully visible** | **3 of 6** | **6 of 6** |
| column width | 262 px fixed | 177 px (grows to 257 at 1920) |

Three causes, each measured rather than guessed.

## 1. The panel clearance was always on (400 px)

`.board` carried `padding:22px 400px 22px 28px`. Locked pattern 3 requires that clearance so the
last column can scroll clear of the overlay detail panel — but it said nothing about carrying it
when no panel is open, and it did. 400 of the 1204 hidden pixels were reserved for a panel nobody
had opened.

Now `.board[data-panel="true"]` carries it, set from `Boolean(sel)` in `BoardView`. This satisfies
the locked pattern exactly rather than bending it: panel open, clearance present.

## 2. The rail was charging 320 px to repeat the cards

Locked pattern 2: *agent presence is a small avatar with a status ring on the card, not a separate
panel.* The `ScopeRail` beside the board is that separate panel, and on the board section every
fact in it is already on a card. It stays on the queue, which has no cards carrying presence.

`section !== 'board'` drops it, and `.main[data-wide="true"]` spans the freed column so the space
is actually reclaimed instead of left as a hole.

## 3. `.col` was a fixed 262 px

262 was chosen when the board WAS the page. Inside the shell it forces scroll before the content
needs it. Now `flex:1 1 262px` with `min-width:176px; max-width:300px`.

**176 is measured, not taste.** It is the width at which six columns plus five 16 px gaps plus
56 px of padding fit beside the 244 px sidebar at 1440. Checked with real cards at both candidate
floors:

| floor | hidden | visible | card overflow | longest title |
|---|---|---|---|---|
| 216 px | 236 px | 5 of 6 | none | 3 lines |
| **176 px** | **0 px** | **6 of 6** | **none** | 4 lines |

The cost is the longest title wrapping to four lines instead of three. The floor only binds at
1440 and below: at 1920 the columns grow back to 257 px and `max-width` holds them there.

Verified across widths: 1440 → 177 px, 0 hidden, 6/6. 1920 → 257 px, 0 hidden, 6/6.
1280 → 176 px, 156 px hidden, 5/6, which is the honest outcome at that width.

## The guard that caught this

`client/edge/run.mjs` asserts locked pattern 3 against `tokens.css`, and it failed the moment the
padding became conditional — correctly. It now asserts **both halves**, because either alone
passes for the wrong reason: a flat 400 px passes "clearance exists" while wasting it on every
load, and deleting the rule passes "no waste" while putting the last column back under the panel.

```
PASS  .board[data-panel="true"] padding-right 400px WHEN the panel is open
PASS  .board (control) no unconditional 400px clearance
```

Harness 182/182 with the CSS rules, ownership scans and controls all green.

## Not done

At 1280 the board still hides 156 px. Fitting six columns there needs a 160 px column, which is
past what a task card reads at. Scrolling is the right answer at that width, and it is now one
short nudge instead of a journey.
