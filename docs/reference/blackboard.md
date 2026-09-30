# The Git Blackboard

Durable facts live in git. Ephemeral coordination state lives in the store. This file
specifies the git half. Identical in both implementations.

## Split, and why

| Fact | Durable | Atomic | Needs diff/review | Lives in |
|---|---|---|---|---|
| API contract | forever | no | **yes** | **git** |
| Data schema | forever | no | **yes** | **git** |
| Decision + rationale | forever | no | **yes** | **git** |
| Task claim | transient | **yes** | no | store |
| File-scope lock | transient | **yes** | no | store |
| Heartbeat | seconds | no | no | store |
| Task state | medium | no | no | store |

Contracts and schemas are **code**: versioned artifacts a human reviews in a PR. Claims and
presence are not. No single system is good at both, so each half goes where it belongs.

Putting contracts in git rather than the ledger removes three problems at once: the Catalyst
`text` 10,000-char cap, the silent emoji corruption in an append-only log, and the absence of
any diff between contract v1 and v2 — which is exactly the information a blocked consumer
needs most.

## The one rule that decides whether this works

**One file per fact. Never a shared append-only markdown file.**

A single `BLACKBOARD.md` that every agent appends to conflicts on every merge from every
branch, forever. One file per fact makes merges purely additive, so conflicts are structurally
impossible. This is the changesets / ADR-directory / migrations pattern.

If you take one thing from this document, take this.

## Branch layout

```
agentic/blackboard          long-lived, everyone pushes directly, no review gate
```

Contracts do not need review to be *published* — they need review to be *merged into main*.
Pushing straight to a shared branch removes the case where a blocked agent cannot see a
contract sitting on somebody's unmerged feature branch.

```
contracts/
  items-api.v1.yaml            kept forever, never edited
  items-api.v2.yaml            new version = new file
schema/
  items.sql
decisions/
  0007-qty-is-integer.md
```

## Naming

| Kind | Pattern | Example |
|---|---|---|
| Contract | `contracts/<name>.v<n>.yaml` | `contracts/items-api.v2.yaml` |
| Schema | `schema/<table>.sql` | `schema/items.sql` |
| Decision | `decisions/<nnnn>-<slug>.md` | `decisions/0007-qty-is-integer.md` |

**Versions are new files, never edits.** Editing `items-api.v1.yaml` in place destroys the
diff that tells a consumer what broke. A new version is always a new path.

## Contract format

OpenAPI 3.1 fragment. Not prose. If the contract is a paragraph in a text field you have moved
the ambiguity, not removed it.

```yaml
# contracts/items-api.v2.yaml
name: items-api
version: 2
supersedes: 1
breaking: true
migration_note: >
  qty changed from string to integer. ZCQL sorts text lexically, so a string qty
  put "100" before "9" in every ordered query.
openapi: 3.1.0
paths:
  /items:
    post:
      requestBody:
        name: { type: string }
        sku:  { type: string, unique: true }
        qty:  { type: integer }
      responses:
        "201": { item_id: string, name: string, sku: string, qty: integer }
        "409": { error: "sku_exists" }
```

## Decision format

ADR-lite. The rationale is the point — it is what stops the next agent re-litigating.

```markdown
# 0007 — qty is an integer, not a string

Status: accepted
Date: 2026-08-25
Affects: task_items_crud, task_items_ui, task_items_qa

## Decision
Store `qty` as an integer.

## Why
ZCQL sorts text lexically, so a string `qty` puts "100" before "9" in every
ordered query. Catalyst has no unsigned type, so the handler rejects negatives.

## Consequence
items-api v2 is a breaking change rather than additive. Do not re-litigate.
```

## Pins and stale facts

A fact is written about some code, and the code keeps moving while the fact does not. A fact
may therefore **pin** the paths it describes, and is **stale** when a commit touching any pinned
path is newer than the fact's own last commit on `agentic/blackboard`.

### Syntax

One key, `pins:`, holding a list of repo-relative git-style globs (`*` within a segment, `**`
across segments, a trailing `/` meaning the whole directory). Block or flow form. Where it goes
depends only on the file type:

| Fact | Carrier | Example |
|---|---|---|
| `contracts/*.yaml` | a top-level key | `pins: [server/items/**]` |
| `decisions/*.md` | YAML frontmatter, `---` on line one | see below |
| `schema/*.sql` | the leading `--` comment block | `-- pins: [server/items/**]` |

```markdown
---
pins:
  - server/items/validate.ts
  - schema/items.sql
---
# 0007 — qty is an integer, not a string
```

Parsed forgivingly: an item that is absolute, climbs out with `..`, or starts with `:` or `!`
(git pathspec magic) is dropped and named, and the rest of the list still counts. `pins: []`
means "no pins, on purpose". A pin that matches no tracked file is reported, because it can never
go stale and is nearly always a typo.

### Freshness

| Status | Means |
|---|---|
| `fresh` | pinned, and nothing it pins has a commit newer than the fact |
| `stale` | some pinned path has a newer commit; the commits are listed |
| `unpinned` | declares no pins, so freshness is not known |
| `superseded` | a contract version older than the newest `v<n>` of the same name. Never flagged. |

"Newer" is **committer time across two histories**: the blackboard is an orphan branch, so a
fact and its code share no ancestry and the comparison cannot be a graph question. Committer
rather than author time, because a rebase that lands old work today is the code moving today.
Clock skew between machines shifts a flag by the skew, which is acceptable for a flag whose whole
job is "go and look". The code side is `HEAD` of the checkout asking; the blackboard side is the
local `origin/agentic/blackboard` (else a local `agentic/blackboard`). Only local refs are read,
except by `flotilla facts`, which fetches first because a human asked.

### Where it shows

- `flotilla facts` — every fact, its status, and for a stale one the newest commits that moved
  its code (sha, date, subject).
- `flotilla status`, and `flotilla sync` after a merge — one line counting stale facts, only
  when there are any.
- `flotilla claim` — stale facts whose pins overlap the claimed scope go into
  `.agentic/tasks/current-task.md` under **Facts to re-verify**.
- MCP — `blackboard_facts`, and `my_assignment` appends the same flags for the globs the agent
  holds, so `flotilla work` and `flotilla chat` agents get them at session start.

### Clearing a flag

**A fact is never edited by the tooling.** Stale is a flag for a human or an agent to review,
and there is no stored "verified" bit: freshness is recomputed from git every time. To clear it,
re-verify the fact against the code and **re-commit the fact** on `agentic/blackboard`, so its
last commit is newer than the code again. For a contract that commit is the next version —
versions are new files, and the old one becomes `superseded`. For a decision or schema it is an
ordinary commit to that file on the blackboard branch (the CLI's publish path refuses to
overwrite a published fact, so this is a deliberate human act, reviewed like any other).

## Write path — the CLI, never the agent

The agent writes a file into the working tree and appends `contract_published` naming it.
The CLI does the rest:

```
1. git checkout agentic/blackboard
2. copy the named file into place
3. git add <one path>          # never git add -A
4. git commit -m "publish items-api v2"
5. git push origin agentic/blackboard        (~1.5 s measured)
6. rewrite the event body as a pointer:
   { name, version, path, commit_sha, supersedes }
7. store.appendEvent(...)                    (~200 ms)
```

Total publish: about 1.8 seconds. The agent never handles a commit sha.

**On push rejection** (someone else pushed first): `git pull --rebase` and retry, up to 3
times. Because it is one file per fact, the rebase cannot conflict.

## Read path — the CDN, not `git fetch`

Measured on this machine against a real GitHub remote:

| Operation | median |
|---|---|
| `git ls-remote` | **1,347 ms** |
| `git fetch`, no-op | **1,354 ms** |
| HTTPS GET of a static CDN object (`raw.githubusercontent.com`) | **34 ms** |

**That 34 ms is GitHub's CDN, and it belongs to route G.** It is not a Stratus number, not a
Firestore number, and must never be cited as one. See `g9-asymmetries.md` entry 25.

Git is **40x slower** for answering the same question. So consumers do not use git:

```
https://raw.githubusercontent.com/{owner}/{repo}/{commit_sha}/contracts/items-api.v2.yaml
```

Sha-pinned, therefore immutable, therefore cacheable forever. Each agent fetches each contract
exactly once, ever. Works for private repos with a token.

**Never poll git.** The store is the doorbell; git is the warehouse. Facts change perhaps 5 to
30 times a day, so git costs about 20 operations per agent per day — roughly 27 seconds. The
hot path never touches it.

Real `git fetch` is the fallback for when you actually want history.

## End-to-end latency

```
publish:  write 116 ms + push ~1.5 s + append ~200 ms   ≈ 1.8 s
consume:  store notify (0-5 s) + CDN read 34 ms         ≈ 2 s typical, 7 s worst
```

For reference, the blocked-agent case in the design mockup had been waiting **8 minutes** —
because the contract had not been written yet, not because of transport. Transport is nowhere
near the bottleneck.

## What git deliberately does not do

- **Claims.** 1.35 s per remote operation means two agents sit inside the same claim window
  comfortably. `push refs/claims/<task>` is genuinely atomic server-side, but it litters the
  repo with refs and cannot expire when a laptop dies.
- **Presence.** A heartbeat commit every 20 s is 4,320 commits per agent per day.
- **Notification.** See the 40x measurement above.

Those three stay in the store, in both implementations.
