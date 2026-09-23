# Order 0071 — the board had no verbs

The user ran `/design-shotgun` against the live UI: "i dont like the current one. it is not very
intuitve." Three directions were generated and A was chosen, with one instruction: keep Flotilla's
colour theme.

## What was actually wrong

Not the palette. Three findings, each checked against the code rather than felt:

1. **The UI had no verbs.** Every button in the app: sign in, sign out, accept/decline a
   suggestion, close a panel — and `<button className="cta">Invite teammate</button>` at
   components.tsx:107, which had no `onClick` at all. A dead button. You could not create a
   project, create a task, or claim one from the web. Every write was CLI-only.
2. **The trunk test failed.** Cover everything but the nav and you got a wordmark and an account
   pill. Two routes, zero navigation.
3. **Projects were drawn as a kanban column.** Home was a column headed `Projects | 0` holding a
   dashed card. In this product a column means a *task state*; reusing the shape for a flat list
   says the list is a state you are stuck in.

The board answered "what is happening" and was also the landing page, so it had to answer "what do
I do next" as well. It could only answer the first.

## The backend was already there

`functions/src/write-api.ts` has handled `create_task`, `claim`, `acquire_scope`, `release` and
the rest since order 0063, gated by capability: `create_task` needs `triage` (owner, architect),
`claim` needs `claim` (everyone but the client seat). Only `cli/auth.ts` ever called it. Giving
the board verbs was a client job, not a backend build — `client/src/store/write.ts` posts to the
same endpoint with the member's Firebase ID token. There is no second write path.

## What shipped

- **`client/src/Shell.tsx`** — sidebar, top bar, right rail. Five sections, two real (My queue,
  Fleet board) and three honestly unbuilt. An unbuilt section is **not** the dashed empty state:
  "no file locks held" and "file locks are not built" are different claims, and the dashed block
  already means the first. Each stub says what will live there and names the command that does the
  job today.
- **`client/src/Queue.tsx`** — the new home. Claimable rows each carrying their own Claim button,
  the file scope they lock, and why they cannot be claimed when they cannot. A disabled action
  states its reason instead of disappearing.
- **`splitQueue`** in App.tsx separates a dependency blocker from a scope blocker. The first comes
  off the task; the second has to be derived from the live locks, and saying which is which is the
  whole value of the row.
- The six-column board is **unchanged** and becomes `/p/:id/board`. `BoardView` gained one
  `chromeless` flag rather than a fork, so the nine frozen edge cases still render it with its own
  nav.
- `/p/:id` now means the queue. Old links keep working and land somewhere more useful.
- The dead "Invite teammate" button is gone.

## Claim reserves; it does not start anything

The agent runs on the claimer's own machine. Clicking Claim does exactly what `flotilla claim`
does — atomic claim plus scope acquisition — and the local agent picks the work up on its next
poll. The row then reads "claimed, waiting for your agent" until presence says otherwise. A button
implying the click started an agent would be a promise the architecture cannot keep.

`ok:false` is rendered as a sentence, not an error. A lost claim race is two people doing the
right thing at the same moment, which is why write-api returns 200 for it.

## Design

Kanban Calm, unchanged: same palette, type pairing, radii and density. The approved comp was drawn
in these tokens for that reason. New CSS is named tokens in `tokens.css`; no inline styles, no
second spacing scale, `--w-side` and `--w-rail` named because the grid and the breakpoints both
reference them.

**A defect the render caught:** `.cta` had no `:disabled` style, so the blocked rows drew a
full-strength teal Claim button that did nothing and contradicted the reason printed beside it.
Fixed with a flat surface rather than opacity, which would have dimmed the label below contrast.
Verified: enabled `rgb(15,118,110)`, disabled `rgb(232,228,221)`.

## Verified

- Build clean, `verify-bundle` green, edge harness **182/182** — five new route assertions.
- `projectIdFromPath('/p/a/b')` used to be a control asserting nested paths are not projects. One
  nested segment is now a section, so the control moved out a level to `/p/a/b/c` rather than
  being deleted. A suite that stops rejecting anything is the failure that line existed to prevent.
- Shell rendered with fixture data and screenshotted at 1440×900; deployed and confirmed live
  (brand mark `naturalWidth > 0`).

## Standing, disclosed

`impeccable detect` reports `overused-font` on Fraunces and Inter. Both are the committed world —
chosen 2026-08-25 after comparing three directions, locked in DESIGN.md, reaffirmed by the user
this session, and self-hosted to remove a measured 3031 ms render-blocking request. The narrow
`ignore-value` suppression does not take: the tool lowercases the value on write and matches
case-sensitively on read. `ignore-rule` would silence it but needs the user's explicit approval,
so the findings are left standing rather than worked around.

## Still open

The client capability table in `store/directory-types.ts` mirrors `shared/store/directory.ts`
because the client build deliberately does not reach into `shared/`. It is cosmetic — it decides
what is drawn, never what is allowed — and the server refuses regardless, so drift is degraded
rather than unsafe. Worth a conformance check that diffs the two tables.
