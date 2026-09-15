# The real-agent run — order 0050

~400 assertions passed before this, and every one used a scripted writer. A real Claude session
had never been pointed at a `.agentic/` directory. This is what happened the first time one was.

**Setup:** one real project in production Firestore (`proj_agent_run_mu287qrc`), one task
(`task_items_qty`, "Add a quantity field to the items handler"), one workspace scaffolded by the
real writers — `writeAgenticTree` for `AGENTS.md` and the tree, `writeScopeFile` for the role pack.
Nothing special-cased. The agent was given the directory and told to read `AGENTS.md` and follow it,
with no knowledge of this project's history.

## The headline: the claim holds

**The agent's line published through the bridge unmodified.** It wrote to `outbox.jsonl` without
being told the envelope, and `drainOnce` read it exactly as it reads a scripted line:

```
PASS  the bridge published it unmodified (1 published, 0 failed)
PASS  task_blocked is on the ledger, naming the task, carrying the agent's own reason
PASS  seq was assigned by the SERVER (1), not taken from the agent's line
PASS  layer came from LAYER_OF (coordination), not from the agent's field
PASS  the outbox cursor advanced to EOF after publish (930 == 930)
```

So "a real agent is indistinguishable from `echo`" is now **measured** rather than documented, for
the write path. The agent also did the right *judgement* thing: faced with a task it could not
perform, it appended `task_blocked` with a specific reason and stopped, which is exactly what
`AGENTS.md` asks for.

## What the file contract did not anticipate

Four defects, none of which a scripted writer could have found, because a script does what it is
told and an agent does what it is *convinced of*.

### 1. `AGENTS.md` contradicted the role pack about git — FIXED

`AGENTS.md` said `Push to: feat/be-<task-slug>` and `push branches: yes`. `roles/backend.md` said
*"never run git yourself — the bridge does both."* Both were true of the **system**; only one was
true of the **agent**. The agent hit the contradiction, chose the more restrictive reading, ran no
git, and reported it as unresolved.

Now: *"Branches are named: …"*, *"never run git — the bridge does both for you"*, and
*"branches pushed for you: yes"*.

### 2. `AGENTS.md` stated something false — FIXED

*"Contracts you need are already on disk in `.agentic/contracts/`."* The directory was empty. The
agent checked, found nothing, and flagged the file as wrong.

This is the **third** instance of the same class: entry 70's webhook string, order 0048's
`flotilla new` that did not exist, and now this. Product copy asserting something the product does
not do. Now the sentence explains the *ordering guarantee* it was trying to express — contracts are
fetched to disk **before** being announced, so an empty directory is normal until one is.

### 3. `builder claim` — FIXED

`tasks/current-task.md` told the agent to run `builder claim <task_id>`. Order 0048 renamed the CLI
to `flotilla`, but that pass covered `cli/index.ts`'s own help text and **not the files the CLI
generates**. The agent looked for a `builder` binary, did not find one, and said so.

### 4. The outbox envelope was never specified — FIXED

`protocol.md` documents the `body` fields of each event and not the line that wraps them. The agent
inferred `{v, seq, layer, kind, ts, body}` by mirroring an inbox line, and guessed `seq: 1` from
`state.json`.

**The guess was harmless — `readPending` takes only `kind` and `body` — but it was a guess**, and
the fields it invented (`seq`, `layer`) are precisely the ones the server assigns and would have
overridden. `AGENTS.md` now says so explicitly: two fields are needed, everything else is assigned,
extras are ignored rather than rejected.

## Left open, deliberately

- **There is no way for an agent to claim a task.** `current-task.md` names a CLI command; the
  protocol has no claim event an agent can append, and the agent correctly declined to invent one.
  A claim is an atomic server operation, so this is a real gap in the agent-facing surface rather
  than a wording problem, and it needs a decision rather than a patch.
- **`state.json` ownership is unstated.** The agent deliberately did not update
  `last_seen_seq`/`last_written_seq`, reasoning that `protocol.md` never mentions the file so it was
  not its to write. It advanced `inbox.cursor` — which the contract does assign to the agent — and
  left the rest. That is the correct reading of an underspecified document, and the document should
  say which it is.
- **A bootstrap gap and a dependency block look identical on the ledger.** Both are `task_blocked`.
  The agent noted it wanted to signal "the repo is empty" distinctly and had no way to.

## The honest caveat

The agent could not complete the *work* — the repository was empty, with no `functions/`, no
`schema/` and zero commits, so "add a quantity field to the items handler" had no handler to add it
to. That is a flaw in my scenario, not in the agent or the contract. What was exercised end to end
is the **coordination** path: read the inbox, decide, write the outbox, publish to the ledger. The
*code-writing* path — agent edits files, bridge commits and pushes — has still never been run by a
real agent, and should not be claimed until it has.
