# Next-Agent Handoff

Updated 2026-08-25. Phase 0 is complete. Two parallel implementations are next.

## Where things stand

Planning and design are done. The repo now contains a complete, verified spec plus a working
shared dashboard. No backend exists yet.

**Decided:**

| Decision | Choice |
|---|---|
| Dashboard direction | **Kanban Calm**, task-axis, warm light, teal. `docs/designs/dashboard.md` |
| Agent-to-agent comms | Shared ledger only. No RPC, not A2A. Three layers, agents see two. |
| Durable facts | **git blackboard**, one file per fact. Events carry a pointer, never a payload. |
| Read path | Stratus snapshot over CDN, measured 34 ms. Never poll Data Store; never poll git. |
| Atomic claim | Insert against an `is_unique` column. Data Store has no transactions. |
| Build plan | **Both platforms in parallel**, Catalyst C1 and Firebase F, from one spec. |

## What to do next

Open **two Conductor workspaces** off this branch and run them simultaneously:

| Workspace | Branch | Brief | Estimate |
|---|---|---|---|
| 1 | `impl/catalyst` | `docs/handoff/impl-catalyst.md` | ~1 day |
| 2 | `impl/firebase` | `docs/handoff/impl-firebase.md` | ~4 hrs |

Both implement the same ten operations in `docs/reference/store-interface.md` and are measured
against the same `docs/how-to/acceptance-checklist.md`. Neither may edit shared files.
They must not read each other's branch — independence is what makes the comparison valid.

Whichever workspace starts first writes `shared/store/memory.ts` and the section A conformance
suite; the other reuses it.

## Phase 0 artifacts

| File | What it is |
|---|---|
| `docs/reference/store-interface.md` | **The contract.** Ten operations, both builds implement it. |
| `docs/protocol/agent-coordination.md` | Protocol v0.2. Three layers, contract-shaped events. |
| `docs/reference/agentic-file-contract.md` | `.agentic/` layout, JSONL framing, cursors, spool dir. |
| `docs/reference/blackboard.md` | Git half. One file per fact. Latency measurements. |
| `docs/how-to/acceptance-checklist.md` | Identical bar. Sections A-H, including the G metrics. |
| `docs/designs/dashboard.md` | Approved tokens and locked patterns. |
| `client/` | Working React dashboard, mock store, typechecks clean, renders verified. |

## Open questions

- **Does `is_unique` work on a `varchar` column?** Load-bearing for the Catalyst claim.
  Documented on `email` and `bigint`, unverified on `varchar`. Fallback: hash `task_id` to a
  `bigint`. Probe this first in workspace 1.
- **What is NoSQL's free tier and unit cost?** It is absent from the pricing reference. If it
  resembles Data Store's, route C3 dominates C1 outright: same cost, same speed, and the
  schema constraints that generated half the findings simply disappear. Worth 10 minutes.
- **Which Catalyst data centre?** Circuits, Integration Functions and QuickML are US-only.
  None are in scope, but confirm before anyone designs them in.
- **Zoho policy on Google Cloud dependencies?** Could close the Firebase question outright.
- Which GitHub repo hosts the Inventory Tracker demo.

## Do not

- Do not use **Web Client Hosting**. Deprecated; Slate replaced it.
- Do not plan on **Signals** for push. Targets are Webhook, Function, Circuit — no browser, no CLI.
- Do not put contract content in an event payload. Pointer only.
- Do not heartbeat into a Data Store UPDATE. The free tier is 1,000 per month.
- Do not use a single shared `BLACKBOARD.md`. One file per fact, or every merge conflicts.
- Do not deliver human-layer events to an agent inbox.
- Do not reintroduce a detail panel that displaces board columns.

## Reference measurements

Taken on this machine against a real GitHub remote, 2026-08-25:

| Operation | median |
|---|---|
| `git ls-remote` | 1,347 ms |
| `git fetch`, no-op | 1,354 ms |
| `git commit`, local | 116 ms |
| `git push`, local bare | 197 ms |
| HTTPS GET, static CDN object | **34 ms** |
