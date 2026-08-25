# Dashboard Design — approved

Direction chosen: **Kanban Calm**, organised by **task**. Approved 2026-08-25 after comparing
three directions (agent-axis, task-axis, event-axis).

Source of truth for pixels: `~/.gstack/projects/Sibhimanyu-multiplayer-agentic-builder/designs/control-room-20260824/variant-B-kanban-calm.html`

Both builds render this. Only the data hook differs. Any visual divergence between the two
builds is a bug.

## Tokens

```css
/* canvas + surface */
--paper:  #FAF9F7;   /* warm off-white page */
--card:   #FFFFFF;
--ink:    #1A1917;
--ink2:   #4A4741;
--muted:  #8A857C;
--line:   #E8E4DD;
--line2:  #D9D4CA;

/* single accent */
--teal:      #0F766E;
--teal-soft: #E6F2F0;

/* semantic */
--red:   #B91C1C;  --red-soft:   #FDEDED;
--amber: #B45309;  --amber-soft: #FDF4E7;

/* type */
--sans:  'Inter', -apple-system, BlinkMacSystemFont, sans-serif;
--serif: 'Fraunces', Georgia, serif;      /* headings, project name, column titles */
--mono:  'JetBrains Mono', ui-monospace, Menlo, monospace;  /* branches, ids, code ONLY */

/* shape */
--r-card: 12px;  --r-ctl: 8px;  --r-tag: 5px;
--shadow: 0 1px 2px rgba(26,25,23,.04), 0 1px 1px rgba(26,25,23,.02);
```

Light mode only. Density: low, generous whitespace.

## Locked patterns

These came out of the design review and are not open for reinterpretation.

1. **Six columns follow the task state machine**: Open, Claimed, In progress, Needs review,
   PR open, Merged. Each with a count badge.
2. **Agent presence is a small avatar with a status ring on the card**, not a separate panel.
   Ring: green connected/working, red blocked, grey offline.
3. **The detail panel overlays, never displaces.** `position:absolute; right:0; z-index:20`,
   and the board carries `padding-right:400px` so the last column can scroll clear of it.
   Displacing columns hid "PR open" and "Merged" entirely — that was a real bug, do not
   reintroduce it.
4. **Freshness indicator in the top nav**, driven by `store.freshness`:
   - `mode:'poll'` → `updated {n}s ago` with a slow-pulsing teal dot
   - `mode:'live'` → a steady live dot, no counter
   Read it from the store. Never hardcode. This is the one honest place the two builds differ.
5. **Empty columns get a dashed empty state**, never a blank. Copy: "Nothing claimed / Tasks
   land here the moment an agent calls `claim`."
6. **Contracts render as a code block inside the detail panel**, with the version pill and a
   `supersedes vN` note when present.
7. **No layout shift on refresh.** A poll returning identical data must not reflow.
   Keys must be stable; heights must not depend on load state.

## Component contract

```
<App>                       owns the store, one subscribe() for the whole page
  <TopNav>                  logo · project name · repo · presence avatars · FreshnessPill · Invite
  <Board>                   6 <Column>, horizontal scroll, padding-right for the panel
    <Column>                title (serif) · count · scroll body · empty state
      <TaskCard>            title · kind tag · badges · avatar · branch (mono)
  <DetailPanel>             overlay. task meta · description · file scope · blocks · contract
```

Data in, no fetching inside components. `App` holds the single subscription; everything below
receives props. That keeps both builds' component tree identical.

## Edge cases the design must handle

Each is checked in `docs/how-to/acceptance-checklist.md` section E.

| Case | Behaviour |
|---|---|
| 47-char task title | wraps to 2 lines, card grows, never truncates mid-word |
| 90-char file path | truncates from the left with ellipsis, keeps the filename visible |
| Zero tasks in a column | dashed empty state with the copy above |
| Zero agents connected | avatars area shows "no agents connected", not an empty gap |
| Blocked chain A→B→C | detail panel lists the full chain, not just the immediate blocker |
| CI failed | red badge on the card, visible without opening it |
| Agent offline | grey status ring, `stale` derived at read time |
| Snapshot stale | freshness pill counts up; never shows a false live state |
| 10 agents instead of 4 | avatars collapse to `+6`, board unaffected |

## Deliberately absent

The kanban axis tells you least about **agents**, which is the thing that differentiates this
product from Linear. Variant A's summary strip (agents live · in progress · blocked · needs
review · open PRs · lock conflicts) is the known fix and is the first candidate enhancement
after the demo lands. Not in Phase 1 scope.
