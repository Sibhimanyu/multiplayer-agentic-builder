# 0006 — Anyone can pick a suggestion up, and picking it up is the triage

Status: **accepted** (built — order 0089)
Date: 2026-09-22
Supersedes: part of [0005](0005-work-appears-by-triage.md)
Raised by: the user, directly — *"rename the client to user … they should be able to raise
suggestions and that flow should be the same as the ticket. anyone should be able to pick it up
and work on it. the user should also be able to set priority … is it an error? is it an
improvement?"*

## What changed

Three things, and only the third touches 0005:

1. **`client` is now `user`.** "Client" read as the person paying for the project. The seat is
   for whoever *uses* the delivered app, which is usually a different person and usually many
   more of them.
2. **The seat is real.** `suggest` was a capability with no model, no storage and no caller
   behind it — the emptiest role in the system could do nothing at all, including the one thing
   it was named for. There is now a suggestion, four report types, and three store operations.
3. **`triage` is held by every working role**, not just owner and architect.

## What 0005 said, and what survives

0005 ruled that **work appears by triage and only by triage**, and reserved `triage` to owner and
architect. Its three arguments were:

- the capability already existed and already said "turn a suggestion into a task, or decline it",
  so using it avoids inventing a second gate;
- a contract that creates its own work has no refusal, and the interesting half of triage is
  *declining*;
- the client seat's emptiness is load-bearing, so a suggestion must not become work by itself.

**All three survive.** There is still exactly one way work appears. No second gate was invented —
`accept_suggestion` is gated on `triage`, the same capability `create_task` is. Declining still
exists and now *requires a reason*, because a refusal with no reason is an ignore with paperwork.
And `user` does not hold `triage`, so the emptiest seat still cannot put work on anybody's board.

## What is reversed, and why

Only the **size of the group holding the gate**.

0005 reserved `triage` to owner and architect. That makes a suggestion queue that moves when an
owner happens to be looking at it, which is not a queue — it is an inbox with one reader. The ask
was explicitly that *anyone* can pick a suggestion up, and picking one up **is** the triage act:
accepting creates the ticket. Reserving the act reserves the work.

So `backend`, `frontend` and `qa` gained `triage`. Concretely: a frontend developer reading the
board sees "Search returns nothing", picks it up, and that single action creates the ticket and
hands it to them. Nobody waits for an owner to transcribe a complaint into a card.

The scope check did not move. Accepting writes a ticket whose `file_scope` the accepter will then
lock, so `assertScopeAllowed` runs on accept exactly as it does on `acquire_scope` — a frontend
member cannot accept a suggestion as `functions/**` work and hand themselves the server.

## Priority is derived, not asked for

The ask was "set priority … is it an error? is it an improvement?" — which already contains the
answer. **The reporter picks the thing they can actually judge.** Somebody using the app cannot
rank their request against work they have never seen; asked for a priority they will pick high,
and a board where everything is urgent has no priority at all. They *can* answer "is it broken,
or would it just be better", and that answer carries real urgency.

So there is one field, `report`, with four values, and `REPORT_ORDER` derives the ordering:

| | |
|---|---|
| `broken` | it does not work |
| `confusing` | it works, and I could not tell how |
| `improvement` | it works, and it could be better |
| `idea` | it does not exist yet |

`confusing` sits above `improvement` deliberately: a feature nobody can operate is closer to
broken than to imperfect, and it is the class of report filed once and then never again.

## A suggestion is not a ledger event

It has its own collection and never enters the ledger.

0005 got the "a user's words never reach an agent" property by marking suggestions *human layer*,
which works as long as every delivery path keeps filtering correctly. Keeping them out of the
ledger entirely gets the same property by construction: `inbox.jsonl` is fed from the ledger, so
there is nothing to filter and therefore no filter to get wrong.

What *does* reach the ledger is the ticket an accept creates, carrying the suggestion id in its
description — so the trail from "a user complained" to "this branch" stays unbroken.

## Accepting is atomic, like a claim

Two people reading the same board will pick the same suggestion up seconds apart. The loser gets
`ok:false` naming the winner — a 200, not a 4xx, for the same reason a lost claim is — and
**one complaint produces one ticket**. Proven in conformance AS2 with two concurrent accepts.

## What this does not do yet

- **A user cannot raise anything from the web.** The seat, the report types, the store operations
  and the API all exist; the sign-in-and-report form and the suggestions lane on the board do not.
- **Only the in-memory store implements it.** The Firestore adapter does not, so the operations
  answer 501 in production. The port declares them optional precisely so that is honest rather
  than a crash.
- **No CLI verbs.** `flotilla suggest` / `suggestions` / `accept` are not written.
