# Two edge cases cannot be built without changing frozen files

Order 0040: *"`components.tsx` and `tokens.css` stay frozen. If the design genuinely cannot be
built without touching them, stop and say which line and why."* These are those cases.

Both were confirmed by **rendering**, not by reading — `client/edge/run.mjs` server-renders the real
frozen components and asserts the DOM. Seven of the nine edge cases and all four locked patterns
pass. These three assertions fail:

```
FAIL  edge 5: the REST of the chain is listed
FAIL  edge 9: 10 agents collapse to +6 (rendered +5)
FAIL  edge 9: and exactly 4 avatars are shown
```

`tokens.css` is **not** a blocker — every rule the design locks is already correct there
(`.panel` is `position:absolute;right:0;z-index:20`, `.board` carries the 400px right padding,
`.empty` is dashed, `.card .title` wraps). Verified by `run.mjs`.

---

## 1. Blocked chain A→B→C — `components.tsx:143`, with dead code at `146–149`

**Design:** *"Blocked chain A→B→C | detail panel lists the full chain, not just the immediate
blocker."*

**Actual:** only the immediate blocker renders.

```ts
143   blockedByTask?: TaskView; onClose: () => void;
...
146   const chain: TaskView[] = [];
147   let cursor = blockedByTask;
148   const guard = new Set<string>();
149   while (cursor && !guard.has(cursor.task_id)) { guard.add(cursor.task_id); chain.push(cursor); break; }
```

Line 149 `break`s unconditionally and never advances `cursor`, so the loop is a one-element push
wearing a loop's clothing.

**Deleting the `break` would not fix it.** `cursor.blocked_by` is a `TaskId` *string*, and the
component has no task index to resolve it against — it receives one `TaskView`, not a map. So the
fix is necessarily a **prop change at line 143**:

```ts
blockedByTask?: TaskView      →      blockedChain?: TaskView[]
```

and lines 146–149 delete entirely.

**The App side is already done and tested.** `BoardView` exports `blockedChain(task, byId)`, which
walks the chain and is cycle-guarded; `cases.tsx` asserts it returns `task_b->task_c` for A→B→C and
terminates on a cycle. There is simply no prop to hand the result to, so `App.tsx` still passes the
immediate blocker and the panel still shows one row.

## 2. Ten agents collapse to `+6` — `components.tsx:37`

**Design edge case:** *"10 agents instead of 4 | avatars collapse to `+6`"* — i.e. **4 shown, 6
hidden**. Order 0040 names this figure explicitly.

**Actual:** `+5`.

```ts
34  /** Collapses past 5 so 10 agents does not push the nav around. */
...
37    const shown = agents.slice(0, 5);
```

Five shown, five hidden. A one-character change (`5` → `4`) produces the specified `+6`.

**This one is a genuine conflict between two frozen documents**, not simply a bug:
`docs/designs/dashboard.md:94` says `+6`, `components.tsx:34` says "collapses past 5", and both
files are frozen. One of them is wrong and I cannot tell which was intended — the doc's arithmetic
(10 − 4 = 6) is self-consistent, and so is the component's (10 − 5 = 5). It needs a ruling, not a
guess:

- if the **doc** is right → `components.tsx:37` becomes `slice(0, 4)`
- if the **component** is right → the doc's edge-case row should read `+5`

`cases.tsx` currently asserts the design's `+6` and therefore fails. That is deliberate: the test
encodes the spec, so whichever way the ruling goes, the failing assertion is the thing to update.
