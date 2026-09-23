# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary: a small product team, 3 to 6 people, building one app together.** Each person runs
their own AI coding agent — Claude Code, Codex, whatever they already use — on their own machine
and their own subscription. Nobody shares an agent and nobody pays for someone else's.

Members hold one of six roles, defined in `shared/store/directory.ts`:
`owner · architect · backend · frontend · qa · client`.

**Secondary: the client.** Someone administering the app on the customer's end. They watch the
board, ask questions about the product and suggest changes. They cannot write code and hold no
file scope. Confirmed as a real requirement, not exploratory — but an occasional participant, not
the centre of gravity.

## Product Purpose

Several coding agents working the same repository at the same time collide: two agents edit the
same file, or both believe they own a task. Flotilla is the coordination layer above the agents.
It hands out tasks, enforces who may touch which files, and shows one live board of what every
agent is doing.

Success is a team running three or more agents in parallel on one codebase for a full working
session without a collision, and without anyone having to ask in chat who is doing what.

## Positioning

**The agents stay on the user's own machine, under the user's own subscription. Flotilla never
runs an agent and never holds a model key.** It coordinates processes it does not own.

That is the mechanism a hosted multiplayer agentic IDE cannot truthfully copy: those products run
the agent for you, which means they pay for inference and must charge for it. Flotilla's cost
structure is a coordination ledger, not a fleet of GPUs.

Two consequences that follow from the mechanism, not from taste:

- **Agents speak the filesystem, never the network.** An agent reads and writes
  `.agentic/inbox.jsonl` and `.agentic/outbox.jsonl` with cursors. The CLI is the only thing that
  talks to the coordination store. Agents behind NAT on laptops are not addressable network
  services, so no agent-to-agent RPC is possible or wanted.
- **The CLI commits, not the agent.** Durable facts live in git as one file per fact, so merges
  between agent branches stay purely additive.

## Operating Context

The working loop, as it exists today:

1. `flotilla connect <invite>` writes `AGENTS.md` and `.agentic/`, stores the token.
2. `flotilla task <title>` creates work so there is something to claim.
3. `flotilla claim <task_id>` claims atomically, then acquires the file scope.
4. `flotilla start` runs the long loop: drain outbox, deliver inbox, heartbeat.
5. `flotilla report "<msg>"` appends one progress line.
6. The web board shows the result to every member at once.

Events are split into three layers — contract, coordination, and human. Agents subscribe to
contract and coordination only. Heartbeats and prose progress are dashboard-only, deliberately
kept out of agent inboxes to avoid polluting agent context.

Installation is a single `curl` command; the CLI authenticates through Google sign-in on a
loopback port.

## Capabilities and Constraints

- Two ports, deliberately not merged: `CoordinationStore` (10 operations, frozen conformance
  suite) and `ProjectDirectory` (7 operations). Task coordination and project membership are
  different problems.
- Roles are capability sets carrying `file_scope` and `deploy_scope`. **Scope containment is not
  intersection** — `**` intersects `functions/**` without containing it, and treating the two as
  the same is how a role silently gains write access it was never granted.
- A task moves through six states: open, claimed, in progress, needs review, PR open, merged.
- Backend is Firebase: Firestore for the ledger, claims and change notification; Realtime Database
  for presence only, because it has `onDisconnect` and Firestore does not.
- Light-mode web board, plus a TypeScript CLI. No mobile app, no native client.

**Explicitly undecided / not yet true — do not write copy that assumes otherwise:**

- **No real agent has yet written code through the system.** Only the coordination path is proven.
- The web UI cannot create a project, create a task, or claim a task. Every write is CLI-only.
- PR and CI state does not reach the board yet; the GitHub bridge is unbuilt.
- No pricing, no hosted offering, no accounts beyond Google sign-in.

## Brand Commitments

- The product is named **Flotilla**. Recorded in `docs/decisions/0004`. It was renamed from
  Catalyst Builder and briefly Drydock; repository names, branches and project ids deliberately
  keep their older names because they are live infrastructure that measurements refer to.
- The mark is `client/public/brand/flotilla-mark.svg`: a fragmented capital F that also reads as
  three boats seen from above. Both readings are load-bearing; future identity work refines this
  base rather than replacing it.
- Voice, as established in the README and the orders log: plain, measured, and specific. Claims
  carry their evidence. Figures name their host and their mechanism.

## Evidence on Hand

Real, and usable in any surface that needs proof:

- A live deployment at `https://multiplayer-agents-eec02.web.app`.
- A working one-command install, with Google sign-in proven on Chrome and Safari.
- `docs/results/scoreboard.md`: a three-route platform comparison (Zoho Catalyst, Firebase, pure
  GitHub) built in parallel from one shared spec, where every row is marked comparable or not and
  names its mechanism.
- `docs/handoff/g9-asymmetries.md`: ~66 measured asymmetries, each carrying its evidence class
  and host.
- `docs/orders/0001`–`0070`: an append-only record of every change and every mistake.
- A sample application at `~/Desktop/inventory-tracker` with four non-intersecting file scopes,
  built to exercise the role model.
- Measured platform defects found while building, including Catalyst `is_unique` failing under
  concurrent insert at an 84.5% violation rate.

**Absences that must never be fabricated:** there are no users, no customers, no testimonials, no
uptime record, no benchmarks against competing products, and no evidence of an agent shipping code
through Flotilla.

## Product Principles

1. **Coordinate processes you do not own.** The agent belongs to the user, on their machine, under
   their subscription. Anything requiring Flotilla to run or pay for inference is out of bounds.
2. **A failure must render as itself.** A permission denial, an outage, an empty account and a
   stalled connection are four different things with four different fixes. Collapsing them into
   one grey message is a bug, not a simplification.
3. **Every figure names its host and its mechanism.** A latency number without the machine it was
   measured on is not evidence.
4. **The ledger is append-only and the record includes the mistakes.** The orders log keeps errors
   in it on purpose; a record that only lists successes cannot be trusted about either.
5. **Boring, conventional interaction.** The novel thing is the coordination model. The interface
   should be the most familiar object in the room.
