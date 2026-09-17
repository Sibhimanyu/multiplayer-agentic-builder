# Order 0075 — the conversation gets the context

The user corrected the product model: **a task is an assignment, not the work.** The work happens
in a conversation, and that conversation needs three things it cannot know on its own — which task
you are on, what your role may touch, and what every other agent is holding *right now*. Flotilla
should supply them, and let the human type either in the CLI or in a local UI.

Chosen: **D** — build the tool layer first, put a browser front end on the same engine later.

## Why tools, not a chat client

The obvious build is a chat: Flotilla owns a prompt loop and re-injects context each turn. That
means reimplementing tool-use display, permission prompts and diff review, and chasing Claude
Code's UX forever.

Inverting it is smaller and better. Claude Code stays Claude Code; Flotilla exposes an MCP server
and the agent **pulls** live state at the moment it matters. `fleet_status` called mid-sentence is
more live than any preamble, because a preamble is stale the moment it is written.

It also keeps the positioning in PRODUCT.md exactly intact: `flotilla work` spawns a binary the
user already installed, under their own subscription. Flotilla still holds no model key.

## What shipped

`cli/mcp.ts` — an MCP server on stdio, newline-delimited JSON-RPC 2.0, four tools:

| tool | answers |
|---|---|
| `fleet_status` | who is connected, what scope they hold, what they are on |
| `my_assignment` | this machine's task, this member's role, the globs that role may write |
| `report` | one progress line to the shared ledger |
| `claim_task` | claim a task and acquire its file scope |

`flotilla work` writes a per-invocation `--mcp-config` and launches `claude` (or `codex`) with an
opening prompt telling it to call `my_assignment` and `fleet_status` before editing anything.
Per-invocation rather than `claude mcp add`, because a global server would follow the user into
unrelated repositories.

Two decisions worth keeping:

- **The fleet renders as prose, not JSON.** A snapshot dump costs several hundred tokens to say
  what four lines say, and makes the agent infer what matters. Saying `Do NOT edit these — another
  agent holds them: web/**` is the entire point of the call.
- **`report` goes through the outbox**, the same path `flotilla report` takes. Calling the API
  directly would be a second write path that works online and silently drops the line when it is
  not; the outbox exists to survive exactly that.

## Verified against the real client

Unit tests pin the parts that fail *silently* — a wrong handshake means Claude Code simply does not
list the server, with no error on either side. So the version echo, the rule that a notification
gets no reply, and "a tool error is a result, not a protocol error" are all asserted (9 tests).

Then the end-to-end proof, with real Claude Code driving a stub server:

```
$ claude --mcp-config … -p "Call fleet_status and my_assignment. Paste both verbatim."

1 agent(s) on inventory-tracker:

- Priya Raghavan · frontend · codex
  working
  holds web/**
  on t1: Fix the warehouse filter

Do NOT edit these — another agent holds them: web/**

You are acting as: backend
Your role may write: server/**
No task is claimed on this machine.
```

Also checked on the shipped binary: `work` refuses outside a project, and `flotilla mcp` writes
its refusal to stderr leaving **0 bytes on stdout** — a single stray byte there corrupts the
stream and the server vanishes from Claude Code with no error anywhere.

## Two pieces of rot found on the way, both the same shape

1. **`npm test` never ran the CLI tests.** The script globbed `shared/**` only. 76 passing CLI
   tests could have rotted unnoticed. Now 110 run.
2. **`npm run typecheck` never checked the CLI.** `tsconfig.json` included `shared/**/*.ts` and
   nothing else, so `cli/`, `firebase/` and `functions/` were unchecked. My own "typecheck clean"
   earlier in this order was therefore meaningless — a true signal about the wrong subject, for
   the third time today.

   Widening it to `cli/**` surfaced exactly **one** error, and it was mine:
   `rolePackFor(...).edit` — `RolePack` has `may_edit`. It would have shipped a broken
   `my_assignment` to every agent.

`firebase/` and `functions/` are still unchecked. That is a real gap and it is left open rather
than fixed blind.

## Next, per decision D

The localhost UI is a front end over this engine, not a parallel build: the same four tools, the
same renderers, a browser transport instead of stdio. A `client`-role member holds only `suggest`,
so their surface is a different one and should be scoped separately rather than assumed to be the
same chat.
