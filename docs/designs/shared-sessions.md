# Shared sessions — seats the host draws, agents that talk, and asking for more

Design, 2026-11-07. Written against what exists on `master` at ec44096. **Built the same day**;
"As built" at the end records where the build differs from the design.

## What this is for

One person starts a session on a project. They share it with someone else. Each person runs their
own Claude or Codex through the Flotilla CLI, on their own machine and their own subscription. The
host decides exactly what each guest may touch, the agents can talk to each other, and a guest who
needs something outside their area asks the host instead of being stopped flat.

And it must work for **any** project, not only a website.

The test case that is not a website: a slide deck. The host shares it with the second speaker. The
second speaker's agent can edit slides 5–8 and nothing else. To fix a typo on slide 2 it asks; the
host taps yes or no. While both work, either agent can message the other ("I renamed the chart on
slide 6, update your reference on slide 3").

## What exists, and what changes

| want | today | change |
|---|---|---|
| start and share a session | `flotilla new`, then `flotilla invite <role>` mints a single-use code; `flotilla connect <code>` joins | one command, `flotilla share`, does both and draws the guest's area at the same time |
| the host draws each person's area | six fixed web roles, `RoleSlug` is a closed union in `shared/store/directory.ts`. `flotilla role <role> --scope` redraws a role's globs but cannot add a role | roles become **project-defined seats**; the six become one template |
| any kind of project | areas are file globs, which already fit any project whose parts are files | templates per project kind; the rule "one part, one file" for decks |
| agents talk to each other | an agent receives ledger events (tickets, locks, handoffs) in `inbox.jsonl`; there is no message between two people or two agents | a `messages` collection, delivered alongside the inbox |
| ask for more | an out-of-fence lock is refused by `assertScopeAllowed` in `functions/src/write-api.ts`; there is no way to ask | `scope_requests`, granted or denied by the host |
| refused, not merely discouraged | refused at **lock** time and at **ship** time. An agent can still *edit* a file outside its fence locally; `ship` just won't commit it | a local edit guard that refuses the write as it happens, for Claude Code |

The server stays the gate. Nothing in this design moves an enforcement point onto the laptop; the
local edit guard is a convenience that fails earlier, and `assertScopeAllowed` plus `ship` remain
the authority (the lesson of order 0049, recorded at the top of `cli/harness.ts`).

## Piece 1 — seats the host draws

### Ruling: a role is a project document, not a member of a union

`projects/{pid}/roles/{slug}` already exists. `createProject` in `firebase/directory.ts` copies
each default role into it — `slug`, `file_scope`, `deploy_scope`, `capabilities` — and `authorize`
in `functions/src/write-api.ts` already fails closed when the document is missing. But only
`file_scope` and `deploy_scope` are *read* from it; capabilities are still checked against the
static table (`hasCapability(slug)`, `ROLE_PACKS`). The document becomes the whole role:

```
projects/{pid}/roles/{slug}
  file_scope:    string[]       // already written and read
  deploy_scope:  string[]       // already written and read
  capabilities:  Capability[]   // already written; now READ, replacing hasCapability(slug)
  label:         string         // new; "Second speaker", shown on the board
  seat_for:      uid | null     // new; set when the role was drawn for one person by `share`
  created_by:    uid
  created_at:    string
```

- `RoleSlug` becomes `string`, validated by `/^[a-z][a-z0-9-]{1,31}$/`.
- `owner` and `user` are **reserved** and keep their fixed definitions: the owner is unscoped and
  the user seat can only suggest. Nothing a host types can redefine either.
- `roleFor(slug)` keeps its rule exactly: **an unknown slug gets the least privilege**. It now reads
  the project's role document first and falls back to `user`, never to a default of convenience.
- `ROLE_PACKS` in `functions/src/authority.ts` stops being a static table derived from
  `DEFAULT_ROLES`; `resolveAgent` reads the agent's role document. One more point read per request,
  the same price `GET /whoami` already pays, and the same reason: revocation and redrawing are
  immediate, never cached.

### Ruling: templates, not questionnaires

`flotilla new <name>` takes `--template`:

| template | seats it writes |
|---|---|
| `web` (default, today's behaviour) | architect, backend, frontend, qa, user — the six roles as they are now |
| `deck` | contributor (claim, lock, open PR, suggest), user |
| `blank` | user only; the host draws every seat with `share` |

`DEFAULT_ROLES` moves into `shared/store/templates.ts` as the `web` template, unchanged. `new`
already fits role scopes to the repo layout (PR #2); that fitting applies to whichever template is
chosen.

### `flotilla share` — one command for the host

```
flotilla share --scope "slides/05-*.html,slides/06-*.html,slides/07-*.html,slides/08-*.html" \
               --label "Priya, second speaker"
```

1. Draws a personal seat: slug derived from the label (`priya`), `file_scope` from `--scope`,
   `capabilities` from the contributor preset, `seat_for` filled in when she connects.
2. Mints the single-use invite for that seat (the existing invite path).
3. Prints one line to send: `flotilla connect fl_9c2…`.

`--as <role>` shares an existing template role instead of drawing a personal one (`--as frontend`).
`--can ship,deploy,triage,invite` widens the preset; the default is the narrowest seat that can
still finish work. Redrawing later is the existing `flotilla role <slug> --scope …`, now valid for
any seat.

### The deck rule: one part, one file

Locks are file globs. A guest can own slides 5–8 only if slides 5–8 are files, so a deck keeps
one file per slide (`slides/01-title.html` …). The `deck` template does not scaffold slides; it
writes the roles, and the host draws each person's files with `share`. Locking a range of lines inside one file is **not** in this design: it would put a new,
unproven primitive behind the lock that A2 verified, and splitting files is free.

## Piece 2 — asking for more

### The flow

1. Priya's agent tries to lock `slides/02-*.html`. Today: `RoleDeniedError`, end of story.
   After: the refusal says *"outside your seat — run `flotilla request` or call the
   `request_scope` tool"*.
2. `flotilla request --scope "slides/02-*.html" --reason "typo in the title" [--task <id>]`
   (MCP tool `request_scope` for the agent) writes one document:

   ```
   projects/{pid}/scope_requests/{rid}
     requested_by: uid, agent_id, label
     globs: string[], reason: string, task_id: TaskId | null
     status: 'open' | 'granted' | 'denied'
     grant: 'task' | 'seat' | null
     decided_by, decided_at, denied_reason
   ```
3. The host sees it within one notification: in `flotilla work`/`chat` (the fleet rail), in the
   output of `flotilla start`, and on the board.
4. `flotilla grant <rid>` or `flotilla deny <rid> --reason "…"`. A denial needs a reason, for the
   reason `declineSuggestion` does.
5. The answer lands in the requester's inbox as a `scope_granted` / `scope_denied` line and the
   agent continues or stops.

### Ruling: a grant is for one ticket unless the host says otherwise

`grant` defaults to `--for task`: the globs are added to that ticket's allowed scope and disappear
when the ticket ships, is released, handed off or cancelled. `--for seat` widens the seat
permanently. Granting for the ticket is the default because "fix one typo on slide 2" should not
quietly become "owns slide 2 forever".

Mechanically: `TaskView` gains `granted_scope?: string[]`, and `assertScopeAllowed` admits a glob
that is inside the seat's `file_scope` **or** inside the claimed ticket's `granted_scope`. Granting
is atomic in the same way accepting a suggestion is: two hosts tapping at once produce one grant
and one `ok:false` naming the winner.

Who may decide: anyone holding `invite` (the owner by default). A guest cannot grant themselves
anything: there is no code path from a guest token to a `granted` status.

### The local edit guard

`flotilla connect` and `flotilla work` install a Claude Code `PreToolUse` hook on `Edit`, `Write`
and `NotebookEdit` that refuses a path outside the seat (plus any live grant) and tells the agent
to call `request_scope`. The hook reads the fence from `.agentic/`, which the bridge keeps current,
so redrawing a seat takes effect without restarting the agent.

This is the "refused, not discouraged" promise kept at the moment of editing instead of at ship
time. It is not the security boundary — a user can delete a hook on their own laptop — and the
design says so in the hook's own header, the way `cli/harness.ts` does.

## Piece 3 — agents and people that talk

### Ruling: messages are their own collection, not ledger events

```
projects/{pid}/messages/{mid}
  from_uid, from_label, from_kind: 'person' | 'agent'
  to: uid | '*'               // one member, or everyone with a seat
  body: string                // ≤ 2000 characters, plain text
  in_reply_to: mid | null
  sent_at: string             // server clock
```

Not ledger events, for the reason suggestions are not: the ledger is the record of work, capped at
300 events per read, and a chatty session would push real events out of an agent's window.

- **Sending.** `flotilla say @priya "…"` or `flotilla say --all "…"`; MCP tool `send_message` for the
  agent; a box in `flotilla chat`. Any member with a seat may send. The `user` seat may not, so a
  user's words still cannot reach an agent's prompt (decision 0005's property, kept).
- **Receiving.** `flotilla start` subscribes and appends each message to `.agentic/messages.jsonl`;
  the MCP tool `read_messages` returns unread ones; `flotilla work` and `chat` show them in the
  fleet rail.
- **What a message cannot do.** It grants nothing. "You may edit slide 2" in a message changes no
  fence; only `grant` does. The agent's instructions in `AGENTS.md` say so in one line, so an agent
  that is told something in a message still has to `request_scope`.

## Order of work

| # | piece | why this order |
|---|---|---|
| 1 | seats as project documents, templates, `flotilla share` | pieces 2 and 3 address seats; without it there is nobody to grant to |
| 2 | scope requests, grant/deny, the edit guard | the collaboration rule the deck example depends on |
| 3 | messages | independent of 2; could run in parallel once 1 lands |

Each piece ends with `npm run board` — the board derives roles from source, so piece 1 changes what
it can claim (see below).

## What each piece is tested by

Every rule in `CLAUDE.md` applies: a function gets a test, a conditional gets both branches, a new
test file is reachable from an npm script.

**Piece 1**
- Directory conformance: create, read and redraw a custom seat; a reserved slug (`owner`, `user`)
  is refused; an invalid slug is refused; an unknown slug resolves to `user`'s permissions.
- `resolveAgent` with a custom seat gets that seat's permissions; with its role document deleted it
  gets none (fail closed).
- `assertScopeAllowed` for a custom seat: inside passes, outside throws `RoleDeniedError`.
- `share`: one command produces a seat and an invite; connecting with it yields that seat's fence in
  `AGENTS.md` and `.agentic/`.
- Templates: `web` produces exactly today's six roles (a snapshot of `DEFAULT_ROLES`), so existing
  projects are unchanged.

**Piece 2**
- Request → grant `--for task` → lock succeeds → ship → the same lock is refused again.
- Request → deny without a reason is refused; with a reason, the requester's inbox gets it.
- Two concurrent grants: exactly one wins (emulator, same harness as the claim race).
- A guest token cannot set `status: granted` on any path (forged-request test, like "agents cannot
  merge").
- The edit guard: inside → allowed, outside → blocked with the `request_scope` hint; a live grant
  → allowed.

**Piece 3**
- Send to one member reaches only that member's `messages.jsonl`; `--all` reaches every seat.
- The `user` seat cannot send.
- A message never changes `file_scope` (control assertion: a message containing a glob, then a
  lock on that glob, still refused).

## The board

The board reads roles from `shared/store/directory.ts`. After piece 1 it reads the `web` template
from `shared/store/templates.ts` and adds a line that seats are drawn per project.
Section 05 ("Honest gaps") gains or loses lines as each piece lands; "nobody reviews anybody's
work" is untouched by this design.

## Open questions

1. **Guests who are not developers.** Shipping pushes a branch, so today every seat needs write
   access to the GitHub repo. A co-presenter may not have a GitHub account. Options: the host's
   bridge pushes on the guest's behalf, or a guest's work arrives as a handoff the host ships.
   Not decided here; it does not block pieces 1–3.
2. **Codex.** The edit guard is a Claude Code hook. Codex has no equivalent hook surface we have
   verified; for Codex seats the gate stays at lock and ship time until one is found.
3. **Who may grant.** This design says "holds `invite`". A host might want a deputy who can grant
   but not invite; that would be a new capability, `grant`, and is left out until someone asks.

## As built

- **Where it lives.** Rules: `shared/store/sessions.ts` and `shared/store/templates.ts` (pure, unit
  tested). Firestore: `firebase/sessions-db.ts`, shared by the write path, the agent API and the
  store's lock gate. Agent's machine: `cli/sessions.ts` (fence file, `flotilla guard`, one sync pass).
- **Template roles keep their capabilities.** `roleFor(slug, policy)` reads capabilities from the
  role document only for seats a host drew. The four template roles keep the template's
  capabilities and take only their scopes from the document, because documents copied before order
  0089 lack `triage` and reading them would quietly take it away from older projects.
- **Agents get seat permissions.** `resolveAgent` used a static table of template roles, so a
  guest's agent resolved to deny-all and could lock its files but never push or open the PR. It now
  reads the seat's document (`packFor` in `functions/src/authority.ts`). `merge` is still never
  granted this way.
- **A grant ends with its claim.** A ticket grant stores the claim's `claimed_at`; it is live only
  while that same claim stands. Ship, release, handoff, cancel and the reaper all end it without
  knowing grants exist.
- **Granted files are locked for the agent.** A lock is one document per agent, so on the next
  `flotilla start` pass (about 10 s) or `read_messages` call the agent re-acquires the union of
  what it holds and what was granted, through the same server gate.
- **A wildcard inside a file name.** `globContains` did not handle `slides/05-*.html` on the
  allowed side: such a fence contained nothing, not even its own files. It does now for literal
  paths. A partial pattern on the *requested* side is still contained only by itself or a whole-
  segment `*`; deciding inclusion between two partial patterns is refused, not guessed.
- **A host cannot hand out more than they hold.** `create_seat` refuses capabilities or files the
  host's own seat lacks.
- **Both new collections are server-only** in `firestore.rules`, read included. The board does not
  show requests or messages yet; the CLI, `flotilla chat` and the MCP tools do.
- **Not verified against live Firebase.** Unit tests cover every rule and the CLI's sync and guard.
  The emulator suite covers the store. The new write and API routes have no end-to-end run until
  the functions and rules are deployed.
