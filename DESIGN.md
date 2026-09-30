# Flotilla — Design System

**Direction: Graphite.** Chosen 2026-09-30, replacing Instrument panel, which replaced Kanban
Calm.

Dark, neutral and essentially monochrome. Emphasis comes from weight, size, contrast and
**inversion** — a primary control is near-white with dark text — and never from a hue. Colour is
kept for state only, desaturated and quiet: red for broken, blocked and failing; green for live,
connected and passing; amber for the anonymous session and nothing else.

**Why the teal went.** Instrument panel was GitHub's blue-black (`#0D1117`) with a bright teal
accent (`#2DD4BF`) on the primary button, the current nav item, the focus ring, the live dot,
every "backend" chip, the version pill, the chat keyword column and the selected card's 3px halo.
The user's verdict was "don't make it have the neon type" — and it was neon: one saturated light
on a tinted near-black is the second of the three looks AI-built interfaces land in. Measuring
it did not save it; 10.17:1 is legible and still reads as a glow. The replacement keeps
everything the user did not object to — dark, Plex, lists not cards, the scales, every locked
pattern — and removes the hue rather than swapping it for another one.

**Why not back to light.** Kanban Calm (cream ground, Fraunces display, one desaturated accent)
was rejected as "too AI generated", correctly: it is look number one exactly. It is recorded in
`docs/designs/dashboard.md`, which describes a **superseded** world; its *locked patterns*
survive unchanged and are restated below. Dark is still chosen from the use scene, not the
category: this sits beside a terminal while agents run.

**Where the monochrome comes from.** The generated `docs/board.html` is plain monochrome and
bold, and the user likes it; a filled chip there means "can change production". Graphite is the
same idea on a dark ground: the one filled near-white chip on the board is **Owner review** — the
card that is waiting on a human. That page is its own world and is not restyled by this one.

Three rules carried over, because they are what stop any world becoming a generated one:

- **Cards are not the default container.** A bordered, rounded, filled box wrapping a list is the
  habit; rows on the ground separated by a rule are layout. The queue, the rail, the projects
  index, the detail panel's glob list and the chat page's starter prompts are lists.
- **The mono is content, not costume.** Globs, branches and ids *are* the material, and the small
  legends (sidebar sections, rail, panel labels) are set in it because a panel labels rather than
  headlines. Group headings that a person navigates by are sans, bold, in ink.
- **Every colour value here was measured, not picked.** The numbers are in the tables.

---

## Tokens

All of these live in `client/src/tokens.css` and nowhere else. No inline styles, no second
spacing scale, no second elevation scale. `cli/chatpage.ts` and `cli/loginpage.ts` carry the same
values by hand because they have no build step; **a value changed here is changed there too.**

### Surface and ink

True greys: R = G = B, no blue in them. Three grounds, three hairlines, three text levels.

| Token | Value | Use | on `--paper` | on `--card` | on `--raise` |
|---|---|---|---|---|---|
| `--paper` | `#121212` | page ground | — | — | — |
| `--card` | `#1A1A1A` | raised surface: nav, sidebar, cards, panel, chat rail | — | — | — |
| `--raise` | `#232323` | one step up: hover, selected card, count pills, code, current nav item | — | — | — |
| `--ink` | `#EDEDED` | primary text, focus ring, the inversion surface | **16.00** | **14.87** | **13.42** |
| `--ink2` | `#B8B8B8` | secondary text, tag labels | **9.44** | **8.77** | **7.92** |
| `--muted` | `#8C8C8C` | tertiary, legends, meta | **5.57** | **5.18** | **4.67** |
| `--line` | `#262626` | hairline between rows | 1.24 | 1.15 | — |
| `--line2` | `#363636` | tag and control borders | 1.55 | 1.44 | — |
| `--line3` | `#4A4A4A` | outlined buttons, the hover edge | 2.11 | 1.96 | — |

Dark only. `color-scheme: dark` is set, with `accent-color` and `caret-color` in ink, so the
browser's own scrollbars, caret, radios and form controls theme with the page.

**`--muted` is the tightest pair and was chosen for it.** `#8C8C8C` clears 4.5 on all three
grounds, including `--raise` at 4.67 — which matters, because a disabled button is muted text on
a raised surface. Anything darker fails there first.

Hairlines are not text and are not held to 4.5; they are separators. `--line3` is the one that
must be *seen* as an edge (an outlined Claim button), and it is the only one above 2:1.

### The inversion, and state

| Token | Value | Pair | Measured |
|---|---|---|---|
| `--inverse` / `--on-inverse` | `#EDEDED` / `#121212` | primary button, Owner review badge | **16.00** |
| `--inverse-hover` | `#FFFFFF` | primary hover — on dark, nearer means lighter | **18.73** |
| `--red` | `#E5877E` | broken, blocked, CI failed, a failure heading | **7.22** paper · **6.71** card |
| `--red-soft` | `rgba(229,135,126,.12)` | red badge ground | red on it: **5.57** over card · **6.09** over paper |
| `--green` | `#86B98F` | live dot, connected ring | **8.34** paper · **7.75** card |
| `--amber` | `#D9B260` | the anonymous session | **9.36** paper · **8.69** card |
| `--amber-soft` | `rgba(217,178,96,.12)` | anonymous avatar ground | amber on it: **6.93** over card · **7.61** over paper |
| `::selection` | `rgba(237,237,237,.22)` | text selection, ink on it | **8.58** (composited to `#424242`) |
| disabled | `--muted` on `--raise` | a button that cannot act | **4.67** |

Soft variants are alpha, so they are measured **composited** onto the ground they sit on — a first
pass on the old palette that read `rgba(...,.13)` as a solid colour reported two failures that did
not exist.

**The primary is an inversion, not a hue.** `.cta` is `--inverse` with `--on-inverse` text.
Nothing else on a graphite page is that bright, so it leads without colour. There is exactly
**one** filled primary in view at a time: row actions (Claim, Make a ticket) are outlined in
`--line3` and **fill on hover**, so the action under the pointer becomes the primary exactly when
it is being chosen. Five filled buttons down one list is a wall — it was a wall of teal.

**Kinds are labels, not colours.** Backend, frontend, qa, docs and devops had five tints, three
of them light-page values that survived the move to dark (`#EEEDEA` behind `#ADBAC7` measured
**1.69:1**). A kind is not a state, so it is an outlined tag with the word in `--ink2`.

**Amber is reserved for an anonymous session**, the state that silently produced an empty board.
Graphite enforces the rule the old world only stated: "confusing" suggestions, the "Waiting" and
"Scope held" labels, the blocked-row wash, "Not a member of this project", the hosted-login
fallback banner, and the chat page's task state and "offline" marker all used amber, and none of
them is an anonymous session. They are now weight, ink or muted.

**Avatars are greys.** Six saturated fills made the presence stack the most colourful object on
the board and meant nothing; the state is the ring. Fills `#474747 #353535 #565656 #3A3A3A
#606060 #404040`, ink initials at 7.94 / 10.48 / 6.27 / 9.72 / 5.37 / 8.86.

**The mark is ink on the board.** `flotilla-mark.svg` is teal and is a published asset (favicons,
the OG master, the marketing site), so it is not recoloured at the source. `BrandLockup` draws it
through `filter: grayscale(1) brightness(1.35)`, which lands on `#ECECEC` — `--ink` within one
step. The chat and CLI login pages inline the real mark paths in `currentColor`; the chat header
used to draw a three-triangle stand-in and the login page a teal "FL" square, two logos that
existed nowhere else.
### Type

| Token | Family | Scope |
|---|---|---|
| `--sans` | IBM Plex Sans | body, UI, headings |
| `--mono` | IBM Plex Mono | globs, branches, ids, and the section legends |
| `--serif`, `--brand-serif` | IBM Plex Sans | kept as names so no call site breaks; **there is no serif** |

One superfamily. Not Inter, Fraunces, Geist, Plus Jakarta or Space Grotesk — every one of those is
on the detector's overused list, and swapping one for another would have traded a generic choice
for a generic choice. Plex was drawn for technical interfaces.

**The scale.** One scale. Every `font-size` comes from it.

| Token | Value | Typical use |
|---|---|---|
| `--t-0` | `11px` | mono legends, chips, badges, glob tags. **The floor.** |
| `--t-1` | `12px` | secondary meta, counts, timestamps |
| `--t-2` | `14px` | UI default, body |
| `--t-3` | `16px` | conversation body, anything read in paragraphs |
| `--t-4` | `18px` | panel and card heading |
| `--t-5` | `21px` | page heading |
| `--t-6` | `24px` | — |
| `--t-7` | `28px` | display; nothing on an operations panel is larger |

Line-height is bound to purpose, not to size: `--lh-tight:1.2` at `--t-4` and up, `--lh:1.5` for
UI text, `--lh-read:1.6` for `--t-3` paragraphs. A heading at body line-height floats between its
paragraphs, which is the Layout defect below.

Three rules, and each one exists because it was broken:

1. **Integers only.** Until order 0083 this section pinned the two families and forbade five
   fonts by name, and pinned no sizes at all. The shipped CSS had drifted to **18 distinct
   values** — 9, 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 18, 19, 20, 22, 26, 34 —
   twelve of them half-pixels. Every half-pixel got there by nudging an existing rule rather than
   moving a step, and .5px is below what anyone can see: it buys no hierarchy and costs a scale.
2. **11px is the floor.** Not taste. Below it the design detector fails functional text outright
   (`undersized-ui-text`), and `.av.sm` had shipped at **9px**. Anything that needs to be smaller
   needs less to say.
3. **Twelve of the eighteen sat inside a 5px band.** That is why nothing on the board read as
   more important than anything else — a 13.5px title beside a 12.5px label is not a hierarchy,
   it is noise. The detector names the same thing from the other side: `flat-type-hierarchy`.

The ~1.15 step is deliberately small for the bottom half (11 → 12 → 14) because a panel needs
legend/meta/body to be *distinguishable*, not dramatic, and widens at the top (18 → 21 → 28)
where the jumps do the work headings are for.

**The board's hierarchy, top to bottom:** page heading `--t-7` 600 at `-0.025em` (My queue,
Projects, an unbuilt section, the chat opening line) → group heading `--t-3` 600 in ink (Ready
for you, Suggestions) → row and card title `--t-2` (600 in the queue, 500 on a board card) →
meta `--t-1` → mono legends and tags `--t-0`. The queue h1 was 34px, the one value above
`--t-7`; it is now `--t-7`. The group headings were `11.5px` tracked mono in `--muted`, which
made "Ready for you" — the point of the screen — quieter than the row ids under it; they are
sans, bold, in ink now. Mono legends stay for the labels a reader does not navigate by: sidebar
sections, the rail, the detail panel's section labels.

**The board now has no half-pixel font size.** Counted with comments stripped, `tokens.css` went
from 16 distinct literal font sizes to 3 — `18px`, `22px` and `26px`, all inside `BrandLockup`,
whose gaps are measured against its rendered size in "Logo spacing" and must not move without
re-measuring. The marketing site's half-pixels are still debt: migrate on touch, and do not open
a sweep commit — a type sweep is indistinguishable from a type regression in review.

**Self-hosted, latin subset, same-origin** (`/brand/fonts/*.woff2`, order 0067). There is no
`fonts.googleapis.com` request: as a render-blocking third-party stylesheet it cost 3031 ms on a
cold load and 3572 ms to first paint. Preload **Plex Sans 400 and 600**; they are on the paint
path. (This line said "preload Inter and Fraunces" until order 0083 — both fonts were deleted in
0077 and the instruction outlived them.)

**The CLI serves the same two files.** `flotilla chat` is a second surface, and "any visual
divergence between the two builds is a bug" applies to it. The fonts ship inside the npm tarball
at `dist/brand/fonts/` and the loopback server serves them from disk, so the chat page renders in
Plex with no network. A local tool that reaches the internet to draw its own text is broken on a
plane.

**Known divergence: the CLI's login page.** `cli/loginpage.ts` is served by the one-shot loopback
server `flotilla login` starts, which serves the page and the credential callback and nothing
else. It now carries Graphite's colours, scale and the real mark, but names `IBM Plex Sans` without
shipping it, so on a machine without Plex installed it renders in the system sans. Closing that
means serving `/brand/fonts/` from that server, the way `serveChat` does — a server change, not a
page change. Until then this is the one sanctioned exception to the no-fallback rule.

### Shape and motion

`--r-card:12px` `--r-ctl:8px` `--r-tag:5px`. Radii vary by nesting; they are not one value.

**Depth is light, not shadow.** On a dark ground a drop shadow is invisible: there is nothing
darker to cast onto. `--shadow` is `inset 0 1px 0 rgba(255,255,255,.04)` — a highlight along the
top edge, the way a real panel catches light. `--shadow-lift` strengthens that highlight and adds
a `--line3` hairline — it added a teal one until Graphite. One elevation idea, expressed in the
terms this ground can actually show. The one real drop shadow is the detail panel's, cast leftward
over the board it overlays, where there *is* something to cast onto.

**Selected is an edge, not a glow.** A selected card is `--raise` with a 1px `--ink2` ring. It was
a 3px teal halo — the brightest object on the board, for a state that only needs "this one".

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

**The board now conforms; the marketing site does not.** The Graphite change rewrote nearly every
rule in `client/src/tokens.css` for colour, and each rule it rewrote landed on this scale — which
is "migrate on touch", applied to a change that touched almost everything, not a sweep commit.
Counted with comments stripped, the board went from **30 distinct pixel spacing values to 3**:
`-8px` and `-6px` (the avatar-stack overlap, a geometric value rather than a gap) and the
`400px` panel clearance that locked pattern 3 requires. `cli/chatpage.ts` and
`cli/loginpage.ts` use the scale throughout. The marketing site still carries 38 improvised
values, including 9, 11, 13, 15, 17, 19, 34, 58, 74 and 86; migrate those on touch, and do not
open a sweep commit that rewrites every rule at once, because a spacing sweep is
indistinguishable from a spacing regression in review.

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
   entirely. That was a real bug. Do not reintroduce it. **And it is full height:** inside the
   shell, `.main` was a block scroller, so the `.stage` the panel is `bottom:0` against was only as
   tall as the tallest column — at 1440×900 the panel ended at y=423. The wide main is a one-row
   grid now, and the panel runs 60 → 900. Found in a screenshot, not in the CSS.
4. **Freshness comes from `store.freshness`, never hardcoded.** `poll` → `updated {n}s ago` with
   a pulsing dot; `live` → a steady dot, no counter. Never fake liveness.
5. **Empty columns get a dashed empty state, never a blank.**
6. **Presence collapses past four**, so ten agents do not push the nav around.
7. **A refresh must not shift layout.** This is why the skeleton renders the real chrome. The
   projects index carries `data-index="true"` on its `.board`, and so does `ProjectsSkeleton`,
   so the list-at-reading-width layout applies to both and the swap stays a content change.

---

## Interaction states

Order 0066. None of these are visible to a server render, which is why the edge harness scored
177/177 on a page that had none of them.

- **Focus.** One `:where(a,button,input,select,textarea,summary,[tabindex],.col-body,.board,.p-body):focus-visible`
  rule at `--focus-ring` — 2px `--ink`, measured in Chromium as `rgb(237, 237, 237)` on a tabbed
  card. `:where()` contributes zero specificity, so a component needing a
  different ring overrides with a plain class and nothing is repeated when a control is added.
  **`:focus-visible`, not `:focus`** — a mouse click on a card must not leave a ring behind.
  Scrollers get an inset offset because an outset ring is clipped by their own overflow.
  **Text fields are the exception**: the new-task and raise forms autofocus their first field, so
  the ring fired on arrival. Their focus is the border stepping up to `--ink2`, the same fix the
  chat composer already had.
- **Cards lift and press.** `translateY(--lift)` with `--shadow-lift` on hover, `scale(--press)`
  on active. A task card is the most clickable thing in the product. Rows on the projects index
  are rows, not cards, and take a surface on hover instead of a lift.
- **Buttons respond.** `.cta` is the primary; `.ghost` is the secondary and is what sign-out uses.
  Both share one box (`--r-ctl`, `--sp-3`/`--sp-5`, `--t-2`), so a pair reads as a pair. Inside
  the account pill the ghost is a pill a size down. Sign-out must never be `.linkish` again —
  teal, underlined and borderless made it the lightest thing on the page. Row actions are
  outlined `.cta`s that fill on hover (see "The inversion, and state").
- **Disabled is flat, not faded.** `--muted` on `--raise`, 4.67:1. Opacity on the whole control
  would take the label below contrast.
- **Numbers are tabular.** `font-variant-numeric: tabular-nums` on counts, freshness, seq numbers
  and durations. Verified by measurement: `11`, `18`, `90`, `99` all render at 31.20 px.
- **Titles use `text-wrap: balance`**, detail-panel body uses `pretty`.
- **`prefers-reduced-motion` suppresses the lift, the press and the skeleton sheen.** The shadow
  change stays: reduced motion is a request about movement, not a request to remove feedback.
- **Narrow (≤860px).** The queue row drops to one column — id, title, meta, then Claim with its
  reason beside it. At 390px the three desktop columns gave a title 150px and five words a line.

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
