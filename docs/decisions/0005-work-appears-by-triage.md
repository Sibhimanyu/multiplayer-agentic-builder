# 0005 — Work appears by triage, and only by triage

Status: **proposed** (opinion recorded, not built — Order 0063 asked for the position before the
implementation)
Date: 2026-09-16
Raised by: Order 0063

## The question

Three things in this product end at "create a task":

1. **The client seat files a suggestion.** It has `suggest` and nothing else — no file scope, no
   claim, no agent. Its words are human-layer on purpose.
2. **An owner triages.** `triage` is already defined in `shared/store/directory.ts` as *"turn a
   suggestion into a task, or decline it"*, and owner and architect hold it.
3. **An architect publishes a contract**, and a published contract implies work that somebody has
   to do.

All three reach the same destination. The order asked which one it should be, because a second
definition of how work appears is the shape of defect this project has paid for repeatedly.

## The opinion

**Triage. Path 2 is the only one that creates a task; the other two produce inputs to it.**

Concretely:

- A client suggestion **never** becomes a task on its own. It is an event a triager reads.
- A published contract **never** becomes a task on its own. It is a pointer a triager reads.
- `createTask` requires the `triage` capability, which is why `create_task` is gated on `triage`
  in `functions/src/write-api.ts` rather than on a new capability invented for it.

## Why triage and not the other two

**Because the capability already exists and already says so.** `triage` was defined as "turn a
suggestion into a task, or decline it" before any of this was built. Making suggestion-acceptance
the creation path does not *add* a second definition — it collapses the three into the one the role
model already names. The alternative is to invent a second gate and then keep two in agreement
forever.

**Because a contract that creates its own work has no refusal.** The interesting half of triage is
*declining*. A client suggestion that is declined stays on the human layer and binds nothing; that
asymmetry is the whole reason the client seat is safe to hand to a non-engineer. If publishing a
contract auto-created tasks, the architect would have a path to put work on other people's boards
that nobody can decline — and the architect role exists *because* it publishes contracts and does
not implement them. Auto-creation quietly gives it the second half back.

**Because the client seat's emptiness is load-bearing.** `client` holds `suggest` and nothing else.
If a suggestion could become a task directly, the emptiest role in the system would gain the most
consequential write in it, and the file contract's guarantee — that a client's words never reach an
agent's inbox — would be broken by the very next line of code after the one that created the task.

**Because the ledger should name a decider.** `task_created` carries `actor_id`. Under triage that
is always a human who chose; under auto-creation it is a rule, and "who decided this was work" stops
having an answer at the moment someone asks it.

## What it costs, stated plainly

**It puts a human in the loop on the product's hottest path.** An architect who publishes a contract
implying six tasks has to go and make six tasks, and will reasonably ask why the tool watched them
do it. The honest mitigation is not auto-creation but *assisted* triage: a contract publication can
propose a set of tasks, and one triage act accepts them. The proposal is cheap and reversible; the
creation stays an act.

**It will feel slow before it feels safe.** Every argument above is about a failure that has not
happened yet, against friction that shows up on day one. Recorded here so that when someone proposes
auto-creation, the trade is on the table rather than rediscovered.

## What is already true in the code

- `create_task` requires `triage` (`functions/src/write-api.ts`).
- `flotilla task` writes with the **user's** token, not an agent token, so an agent cannot invent
  its own work (`firebase/flotilla-main.ts`).
- Nothing auto-creates a task from `contract_published` or from a client suggestion. That absence
  is the decision, and it is currently enforced by there being no such code — which is why this
  file exists to say it was chosen rather than merely not yet written.

## Not decided here

Whether the client seat's suggestions get a first-class `suggestion_filed` kind and a triage inbox,
or keep riding `task_progress` on the human layer. That is a real design question; this decision
only says the triage act is where a task is born.
