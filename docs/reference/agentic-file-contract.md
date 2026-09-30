# The `.agentic/` File Contract

This is the interface between the CLI and the local agent. It is **identical in both
implementations** and must not diverge. It is the reason the agent never knows which backend
it is running against.

## The point

The agent speaks **filesystem**, not HTTP.

- The agent holds no token, so prompt injection cannot exfiltrate a credential it never had.
- Unsent work survives an agent crash, because it is on disk.
- Every message the agent tried to send is auditable, byte for byte.
- It works identically for Claude Code, Codex, or a human with `echo >> outbox.jsonl`.

This is also the answer to "what is the harness launch contract?" There isn't one. The
contract is a file format.

## Layout

```
AGENTS.md                        generated role prompt, agent reads at session start
.agentic/
  project.json                   { project_id, name, repo_url, brief, protocol_version }
  role.md                        role pack prompt: responsibilities, file scope, branch prefix
  protocol.md                    the subset of the protocol the agent needs
  tasks/
    current-task.md              the claimed task: title, description, acceptance, and
                                 "Facts to re-verify": stale blackboard facts that pin
                                 files in its scope (see blackboard.md, Pins)
  contracts/                     materialised from the git blackboard, read-only to the agent
    items-api.v2.yaml
    schema/items.sql
  decisions/
    0007-qty-is-integer.md
  inbox.jsonl                    CLI appends. contract + coordination layers ONLY.
  inbox.cursor                   agent writes: byte offset it has consumed
  outbox.jsonl                   agent appends. CLI drains.
  outbox.cursor                  CLI writes: byte offset it has published
  outbox.d/                      spool dir for payloads over 4 KiB
  state.json                     CLI-owned: last_seen_seq, last_written_seq, agent_id
```

`.agentic/` and `AGENTS.md` are generated. Add `.agentic/` to `.gitignore`.

## Inbox

The CLI appends one JSON object per line. **Contract and coordination layers only.** Human
layer events are never written here — see the protocol. This exclusion is the whole reason
agents stay coherent over a long session.

```jsonl
{"v":"0.2","seq":4211,"layer":"contract","kind":"contract_published","ts":"2026-08-25T09:41:02Z","body":{"name":"items-api","version":2,"path":"contracts/items-api.v2.yaml","local":".agentic/contracts/items-api.v2.yaml","supersedes":1}}
{"v":"0.2","seq":4213,"layer":"coordination","kind":"task_unblocked","ts":"2026-08-25T09:41:04Z","body":{"task_id":"task_items_ui","was_blocked_by":"task_items_crud"}}
```

Note `body.local`: the CLI has already fetched the blob and written it to disk. The agent
opens a file. It never makes a network call.

The agent tracks its own read position in `inbox.cursor`. The CLI never rewrites `inbox.jsonl`,
only appends, so an agent reading while the CLI writes is safe.

## Outbox

The agent appends; the CLI publishes. The agent does no networking.

```jsonl
{"v":"0.2","kind":"task_progress","ts":"2026-08-25T09:44:01Z","body":{"task_id":"task_items_crud","summary":"CRUD handlers done, validator extracted","files_changed":["functions/items/index.js"]}}
{"v":"0.2","kind":"contract_published","ts":"2026-08-25T09:45:10Z","body":{"name":"items-api","version":2,"file":"contracts/items-api.v2.yaml"}}
{"v":"0.2","kind":"task_blocked","ts":"2026-08-25T09:46:33Z","body":{"task_id":"task_items_ui","reason":"needs items-api v2","blocked_by_task_id":"task_items_crud"}}
```

For `contract_published` the agent names a **file it has written into the working tree**. The
CLI commits it to the blackboard branch, pushes, and rewrites the event body as a pointer
before publishing. The agent never deals with commit shas.

### Framing

JSONL. One object per line, LF-terminated, no embedded raw newlines — escape as `\n`.

**Atomicity.** A single `write()` with `O_APPEND` is atomic in practice on local filesystems
for payloads under one page, 4 KiB. POSIX does not guarantee non-interleaving above that, and
network filesystems break it outright.

**Payloads over 4 KiB — and a contract fragment will exceed it — MUST use the spool
directory instead:**

```
write   .agentic/outbox.d/.tmp-<uuid>
rename  .agentic/outbox.d/<uuid>.json      # rename() on one filesystem is atomic
```

A reader never observes a partial file. The CLI drains `outbox.jsonl` and `outbox.d/` together,
ordered by mtime.

### Requests: `claim_requested` and `handoff_requested`

Two outbox kinds are **requests**, not ledger facts. The CLI performs them and the ledger records
what actually happened (`task_claimed`, `task_handed_off`), so the agent still never touches the
network or git.

```jsonl
{"v":"0.2","kind":"handoff_requested","ts":"2026-09-30T17:02:11Z","body":{"task_id":"task_items_crud","note":"GET and list are done and tested. POST next: validator is in functions/items/validate.js. The fixture DB must be reset between runs or ids collide."}}
```

`handoff_requested` is for an agent that is about to run out of budget or context mid-task. The
note is **required** (a handoff with nothing to say is a release). On `flotilla start` the CLI:

1. pushes a WIP checkpoint of the in-scope changes to the task branch, exactly as
   `flotilla ship --wip` does;
2. records `{ from, note, branch, head_sha, at }` on the task and releases the claim, in one
   server-side step, so nobody can claim it without the note already on the card;
3. releases the file-scope lock through the same path as `flotilla release`.

If any of that is refused (not the claimant, push failed, no note) the agent is told on its
inbox with `handoff_refused` and still holds the task. The MCP server exposes the same request as
its `handoff` tool, and a person runs it directly as `flotilla handoff <task_id> --note "..."`.

### Handoff delivery

When anyone next claims a handed-off task (`flotilla claim <id>`, or the no-id claim), the CLI
prints the note, checks the working tree out onto the handed-off branch if the tree is clean
(a dirty tree is left alone and told the two commands), and appends one inbox line **before** the
agent starts:

```jsonl
{"v":"0.2","seq":0,"layer":"coordination","kind":"handoff_received","ts":"2026-09-30T17:20:40Z","body":{"task_id":"task_items_crud","from":{"agent_id":"agent_be01","label":"Bea"},"note":"GET and list are done ...","branch":"agent/backend/items-crud","head_sha":"3f1c...","handed_off_at":"2026-09-30T17:02:14Z","checked_out":true,"earlier_handoffs":0}}
```

`seq` is 0 because it is a delivery to one agent, not a ledger event (the same convention as
`claim_denied`). The full history, newest first, is written to `tasks/current-task.md` under
"Handed off to you", and `ship` keeps pushing to the handed-off branch rather than starting a
fresh one. A task keeps its last ten handoffs.

### Cursors

Separate files, never in-band.

The CLI reads `outbox.cursor`, publishes from that offset to EOF, then writes the new offset
**after** the publish succeeds. A crash therefore re-sends rather than drops, which makes the
wire path at-least-once. That is why `appendEvent` requires an idempotency key.

## Generated `AGENTS.md`

```markdown
# Backend Builder

You own Catalyst Functions, Data Store access, API contracts and backend tests
for the Inventory Tracker project.

## Your file scope
You may edit:      functions/**, schema/**
You may not edit:  client/**, test/e2e/**
Push to:           agent/backend/<task-slug>

## How you communicate
Append one JSON line to .agentic/outbox.jsonl. Never call the network.
Read .agentic/inbox.jsonl from the offset in .agentic/inbox.cursor.
Contracts you need are already on disk in .agentic/contracts/.

Do not ask other agents questions. If you are blocked, append task_blocked
with a reason and stop. A human will unblock you.

## Publishing a contract
Write the file into contracts/ in the working tree, then append
contract_published naming that file. Do not commit it yourself.

## Permissions
push branches: yes    open PRs: yes    merge: no
```

## Rules for both implementations

1. Byte-identical layout, filenames and JSONL schema. A divergence here invalidates the
   comparison.
2. Human-layer events never reach `inbox.jsonl`.
3. `body.local` is always populated for contract events before the line is appended.
4. Payloads over 4 KiB go to `outbox.d/`, never appended to `outbox.jsonl`.
5. The outbox cursor advances only after a successful publish.
6. Emoji and 4-byte UTF-8 are stripped on write to durable storage, in both builds.
7. Offline is normal, not an error. Unpublished lines accumulate; the agent keeps working.
