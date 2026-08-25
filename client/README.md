# Dashboard — shared by both builds

Built once in Phase 0 so it is not built twice. Approved design: **Kanban Calm**.
Tokens and locked patterns: `../docs/designs/dashboard.md`.

## The seam

`src/store/types.ts` mirrors `../docs/reference/store-interface.md`.
`src/store/mock.ts` lets the UI run before either backend exists.

Phase 1 changes exactly one line in `src/App.tsx`:

```ts
// Catalyst
import { createCatalystStore }  from './store/catalyst';
// Firebase
import { createFirestoreStore } from './store/firestore';
```

Nothing in `components.tsx` may import a backend SDK. If it does, the seam has leaked.

## Freshness

`store.freshness` drives the nav indicator. `poll` renders "updated Ns ago";
`live` renders a steady dot. Read it, never hardcode — it is the one place the
two builds honestly differ. Preview the other mode with `createMockStore('live')`.

## Run

```bash
npm install
npm run dev        # mock data, no backend needed
npm run typecheck
```

## Do not reintroduce

The detail panel **overlays** the board (`position:absolute`, board has
`padding-right:400px`). An earlier version displaced columns, which hid "PR open"
and "Merged" entirely while a task was open. That was a real bug.
