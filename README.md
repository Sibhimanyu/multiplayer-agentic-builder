# Flotilla

**Several AI coding agents build one app together, without stepping on each other.**

Each person on the team runs their own agent — Claude Code, Codex, whatever they already
use, on their own subscription. Flotilla is the coordination layer above them: it hands out
tasks, enforces who may touch which files, and shows everyone one live board.

There is no hosted agent sandbox. Nothing runs your code but your own machine.

**[sibhimanyu.github.io/flotilla](https://sibhimanyu.github.io/flotilla/)** — what it is, the board, roles, and what it costs.

```bash
curl -fsSL https://multiplayer-agents-eec02.web.app/install.sh | sh
flotilla login
cd your-repo && flotilla new "My Project"
```

## How it works

```
your machine                          teammate's machine
  Claude Code / Codex                   Claude Code / Codex
        | files only                          | files only
  .agentic/ inbox · outbox              .agentic/
        |                                      |
  flotilla CLI  ────────────┐   ┌──────────────┘
                            ▼   ▼
              Firestore — tasks, claims, ledger
              RTDB      — presence
                            │
                    ┌───────┴────────┐
                    ▼                ▼
              live board        GitHub — code, contracts, PRs
```

**Agents speak filesystem, never network.** An agent appends a JSON line to
`.agentic/outbox.jsonl`; the CLI publishes it. So the agent holds no token, unsent work
survives a crash, and the whole thing works identically for Claude Code, Codex, or `echo`.

**Durable facts live in git, transient state lives in the store.** Contracts, schemas and
decisions are files you review in a PR — one file per fact, so merges cannot conflict.
Claims, presence and task state are not; they go to Firestore.

**Roles are permissions, not labels.** A role carries a file scope, a deploy scope and a
capability set. `backend` can lock `functions/**` and cannot lock `client/**` — refused
server-side, in a Cloud Function the agent cannot reach.

**Clients can ask, not write.** A `client` role sees the board and files questions and
suggestions. Their words land on the human layer of the ledger, which never reaches any
agent's inbox — so prompt injection from the least-trusted seat is impossible by plumbing
rather than policed by a filter. A human turns a suggestion into a task, or declines it
with a reason.

## Commands

```
flotilla init --project <id>   point this install at a Firebase project
flotilla login                 sign in with Google (--anonymous for a disposable identity)
flotilla whoami                the identity this machine is signed in as
flotilla new <name>            create a project here, connect this repo, write .agentic/
flotilla ls                    projects you are a member of
flotilla members <project_id>  the roster
flotilla connect <invite>      write AGENTS.md + .agentic/, store the agent token
flotilla claim <task_id>       atomic claim, then acquire the declared file scope
flotilla start                 drain the outbox, deliver the inbox, heartbeat
```

## Status

**Works, measured against production:** the board, atomic claims under contention, presence,
the git blackboard including rebase-on-conflict, the reaper, role enforcement, the client
seat, multi-user auth, and the CLI end to end from a clean install.

**Not done:** PR and CI state reaching the board. And **no real agent has written code through
this yet** — the coordination path is proven; the code-writing path is not. Every green test
uses a scripted writer.

## Why Firebase

Three complete implementations were built from one spec and measured against one conformance
suite — Zoho Catalyst, Firebase, and a pure-GitHub route. Firebase won on one thing that
mattered more than the rest: it is the only one with a real push subscriber, at 191 ms,
against ~5 s and ~8.5 s polls. See [`docs/results/scoreboard.md`](docs/results/scoreboard.md)
for every row, with the host and mechanism each number was measured against.

The two unchosen routes are preserved as tags — `archive/catalyst-route` and
`archive/github-route` — because they hold the evidence for two findings worth more than the
platform choice: **Catalyst's `is_unique` does not enforce under concurrent insert** (84.5%
violation), and **its Data Store compare-and-set reports success to every racer** while
writing one row, which no audit can detect.

## Documentation

- [Store interface](docs/reference/store-interface.md) — the contract every backend satisfies
- [The `.agentic/` file contract](docs/reference/agentic-file-contract.md) — CLI to agent
- [The git blackboard](docs/reference/blackboard.md) — where durable facts live
- [Project tier](docs/designs/project-tier.md) — projects, roles, the client seat
- [Multi-user auth](docs/designs/multi-user-auth.md) — why authorization needs a server
- [Scoreboard](docs/results/scoreboard.md) — the three-route comparison
- [Asymmetry register](docs/handoff/g9-asymmetries.md) — every finding, with its evidence class
- [Decisions](docs/decisions/) — what was chosen and why
