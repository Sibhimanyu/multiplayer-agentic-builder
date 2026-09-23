# Order 0069 — three nav bars, and sign-out as a bare anchor

Reported with a screenshot of the nav: "where is the logo and where is the proper sign out btn
why do i just have an anchor element".

Both were real. They are separate faults that happened to land in the same 60px strip.

## The logo existed and three pages did not use it

`client/public/brand/flotilla-mark.svg` has been in the repo the whole time, and `TopNav` in
components.tsx rendered it. But the nav was written out longhand in four places, and only one of
them had been updated:

| where | rendered |
|---|---|
| `components.tsx` TopNav (the board) | the SVG mark |
| `App.tsx` ProjectsIndex | `<div className="mark">FL</div>` |
| `App.tsx` the signed-out nav | `<div className="mark">FL</div>` |
| `Login.tsx` | `<div className="mark">FL</div>` |

`FL` is a two-letter text stand-in that predates the SVG. Whichever page you landed on first
decided whether Flotilla appeared to have a logo at all, and the projects index — the page you
land on after signing in — was one of the three that did not.

`BrandLockup` is now a component in components.tsx and all four sites call it. There is no longer
a place to render the brand wrongly.

## Sign-out was styled as the lightest thing on the page

`AccountChip` put the address and the sign-out control loose in the nav with `.linkish` — teal,
underlined, no border, no padding. The one destructive control on the page was the only one that
looked like body copy, which is what "why do i just have an anchor element" is describing.

- `.account` is now one pill: hairline border, paper fill, 999px radius, so the avatar, the
  address and the button read as a single control rather than three things drifting at the edge.
- A 24px avatar carries the first letter of whatever label is actually shown, so it cannot
  disagree with the text beside it. Anonymous gets `?` and the amber token, keeping the existing
  rule that an anonymous session is marked rather than left to look like any other signed-in one.
- Sign-out is `.ghost`: a bordered button with hover, `:active` and `:focus-visible`.

While there: `.cta` had no hover, no press and no focus ring at all. It has all three now.

## Verification

Deployed, then read back from the DOM rather than eyeballed:

- `.nav .mark` → `IMG`, `src="/brand/flotilla-mark.svg"`, 36×29
- `.account .ghost` → `BUTTON`, `text-decoration-line: none`, border `rgb(217,212,202)`
- `.account` border-radius `999px`
- avatar renders `?` for the anonymous session under test

Build clean, edge harness 177/177.
