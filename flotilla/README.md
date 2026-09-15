# flotilla-cli

Multiplayer agentic coordination for coding agents — claims, file-scope locks, presence and a git
blackboard, on infrastructure you already have.

```
npm install -g flotilla-cli
flotilla new "Inventory Tracker"     # in your repo
```

The package is `flotilla-cli`; the command it installs is `flotilla`. (`flotilla` was already taken
on npm; `bin` is independent of package name, so the thing you type is unaffected.)

## Commands

```
flotilla new <name>           create a project here, connect this repo, write .agentic/
flotilla ls                   projects you are a member of
flotilla members <id>         the roster

flotilla connect <invite>     write AGENTS.md + .agentic/, store the agent token
flotilla status               what the board thinks is happening
flotilla claim <task_id>      atomic claim, then acquire the declared file scope
flotilla report "<message>"   queue one progress line in the outbox
flotilla start                drain the outbox, deliver the inbox, heartbeat
```

## What it does

Coordination state — claims, locks, presence, the event ledger — lives in Firestore. Durable facts
— contracts, schemas, decisions — live in git, one file per fact, so merges are additive and
conflicts are structurally impossible.

An agent never holds a credential and never calls the network. It appends one JSON line to
`.agentic/outbox.jsonl` and reads `.agentic/inbox.jsonl`. The CLI does everything else: it commits,
pushes, publishes, and fetches contracts to disk *before* announcing them, so the agent opens a
file rather than making a request.

## Environment

| variable | purpose |
| --- | --- |
| `FB_PROJECT_ID` | Firebase project holding the coordination substrate |
| `FLOTILLA_UID` | your member id; defaults to `uid_$USER` |
| `GOOGLE_APPLICATION_CREDENTIALS` | service-account key path, for the project-tier commands |
| `BUILDER_API_URL` | coordination API base url, for `connect`/`claim`/`report`/`start` |
| `BUILDER_REPO` | `owner/repo` for the git blackboard |
| `BUILDER_GIT_TOKEN` | token for reading contracts from a private repo |

## Status

Pre-1.0 and built against one deployment. The coordination port has a conformance suite; the claim
primitive is verified contended at 20 concurrent claimants × 50 rounds, and at 256 concurrent
single-document writers against production Firestore.
