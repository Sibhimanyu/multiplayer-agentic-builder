# Two edge cases that needed a frozen file — RESOLVED by order 0041

Both were found by **rendering**, not reading: `client/edge/run.mjs` server-renders the real
components through the real `BoardView` and asserts the DOM. Under order 0040 both were blocked,
because `components.tsx` was frozen and the order said to stop and name the line rather than edit.
Order 0041 unfroze the file — the freeze existed so two competing builds rendered identically, and
decision 0001 closed the comparison — and ruled on both.

Kept as a record of what the constraint was and how it was settled.

## 1. Blocked chain A→B→C — `components.tsx:143` — FIXED

**Was:** only the immediate blocker rendered. The prop was a single `blockedByTask?: TaskView` and
the walk was

```ts
while (cursor && !guard.has(cursor.task_id)) { guard.add(cursor.task_id); chain.push(cursor); break; }
```

an unconditional `break` inside a `while` — a one-element push wearing a loop's clothing. Deleting
the `break` would not have fixed it either: `cursor.blocked_by` is a `TaskId` *string* and the
component has no task index to resolve it against.

**Now:** the prop is `blockedChain?: TaskView[]` and the dead loop is **deleted rather than
repaired**, per the ruling. `App.tsx`'s `blockedChain(task, byId)` does the walk — it has the task
index, and components take data in via props and look nothing up. Cycle-guarded.

Asserted: `blockedChain()` returns `task_b->task_c` for A→B→C, a cyclic chain terminates instead of
hanging, and the panel lists both the immediate blocker *and* the rest of the chain.

## 2. Ten agents collapse to `+6` — `components.tsx:37` — FIXED

**Was:** `agents.slice(0, 5)` → `+5`. `docs/designs/dashboard.md:94` says `+6` (10 − 4); the
component's own comment said "collapses past 5". Both self-consistent, both totalling ten, and **no
measurement can settle a visual density choice.**

**Now:** `slice(0, 4)` → `+6`. `dashboard.md` is the declared source of truth for pixels, so the
design wins and the implementation note that drifted from it was corrected. Change the code, not the
design.

The failing assertion was deliberately left encoding the spec rather than guessing, because a guess
would have silently made the *design* wrong instead of the *code* wrong.

## `tokens.css` was never a blocker

Every rule the design locks was already correct in it — `.panel` at `position:absolute;right:0;
z-index:20`, `.board` with the 400px right padding, `.empty` dashed, `.card .title` wrapping rather
than truncating. Verified by `run.mjs`, which still asserts all four, because server-rendering
cannot see a dashed border. Unfrozen now, but untouched.

## Result

**40/40 server-rendered assertions and 4/4 stylesheet assertions.** All nine edge cases and all
seven locked patterns.
