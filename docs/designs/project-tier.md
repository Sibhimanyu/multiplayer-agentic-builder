# The project tier — projects, roles, and the client seat

Design, 2026-09-14. Written against what exists, not from scratch — a surprising amount of this
is already built, and one piece of it is now self-contradictory.

## The three tiers

| tier | what it does | status |
|---|---|---|
| **project** | create, list, connect a repo, assign roles | **the gap** |
| **coordination** | claims, scope locks, presence, ledger | built, A2 verified contended |
| **durable** | contracts, schema, decisions in git | in progress |

The 10-operation `CoordinationStore` port is entirely *within* one project — every operation takes a
`project_id` it assumes already exists. `PROJECT_ID = 'proj_inventory'` is hardcoded in `App.tsx` on
both branches. There is no tier above it.

## What already exists (do not rebuild it)

`firestore.rules` on `impl/firebase-v1` already models this:

```
projects/{pid}                      allow get, list: if isMember(pid)
                                    allow create, update, delete: if false   // API only
projects/{pid}/members/{uid}        existence + revoked != true == membership
```

And the reasoning is already recorded in the rules themselves: **membership is a document, not a
custom claim, because a claim needs a token refresh to revoke and revocation has to be immediate.**
One extra read per rule evaluation is the price, and rule-evaluation reads are not separately billed.

`AgentPresence` already carries `role_slug`. So projects, members, revocation and a role *label* are
all present. What is missing is everything that gives a role *meaning*, and any way to make a project.

## The contradiction: "API only", on a plan with no API

The rules deny all client writes and defer project mutations to `functions/src/authority.ts`.
**Spark has no Cloud Functions**, and order 0043 already moved the webhook receiver and the reaper
into the local bridge for exactly this reason. That comment now points at code that cannot run.

### Ruling: the CLI creates projects. The browser lists and opens them.

Not a workaround — the better design:

- **Creating a project is inherently a local act.** It connects a repo, writes `.agentic/`, and
  generates role packs. All of that needs the repo on disk. A browser cannot do it without uploading
  the developer's working tree somewhere.
- **The security model stays intact.** Client writes remain denied. Project creation happens through
  the admin SDK in the bridge, which bypasses rules by design and is the one place already trusted
  with a service-account key.
- **No billing.** Blaze plus one Cloud Function for project CRUD is the documented upgrade path if
  browser-side creation is ever wanted. It is a real option, deliberately not taken yet.

The projects index therefore has an **empty state that teaches the command**: *"No projects yet — run
`drydock new <name>` in your repo."* For a developer tool that is better UX than a button, not worse.

## Roles become capabilities, not labels

Today a role is a `role_slug` string plus prose in `.agentic/role.md`. It constrains the agent only
by *asking it nicely* in a prompt. That is not a permission.

```
role:
  slug            "backend"
  file_scope      ["functions/**", "schema/**"]      may edit
  deploy_scope    ["functions"]                       may deploy
  capabilities    claim · publish_contract · open_pr
```

Three enforcement points, deliberately layered — a prompt is guidance, the others are gates:

1. **The role pack** tells the agent its scope (`AGENTS.md` already does this).
2. **`acquireScope`** refuses globs outside the role's `file_scope` — the existing verified primitive,
   now bounded by role rather than by whatever the agent asks for.
3. **Deploy** refuses targets outside `deploy_scope`. This one is genuinely new; nothing today has a
   concept of a deployable target.

Default roles: `owner`, `architect`, `backend`, `frontend`, `qa`, `client`.

## The client seat

A client administers the delivered app. They ask questions and suggest changes. They do not write
code, claim tasks, or hold a scope — **and they have no agent.**

**This lands on a seam that already exists.** `agentic-file-contract.md:46`:

> The CLI appends one JSON object per line. **Contract and coordination layers only. Human layer
> events are never written here** — this exclusion is the whole reason agents stay coherent over a
> long session.

A client's question or suggestion **is human-layer content by definition.** Therefore:

- **A client cannot instruct an agent.** Not by policy — by plumbing. Their words never enter any
  `inbox.jsonl`. Prompt injection from a client seat is structurally impossible, which matters because
  the client is the least-trusted seat and the one most likely to paste something hostile.
- **Agents stay coherent.** They do not drown in stakeholder discussion.
- **A human triages.** An owner or architect turns a suggestion into a task, or declines it with a
  recorded reason. That triage step is the feature: it is where a human decides what agents work on.

The exclusion was built for agent coherence. It turns out to be exactly the right permission boundary
for an untrusted seat, which is worth noticing rather than taking as luck.

**Client capability set:** read the board · append `question` and `suggestion` (human layer) · nothing
else. No claim, no scope, no deploy, no agent, no contract publish.

## Port shape: a second interface, not a bigger one

**Do not add project CRUD to `CoordinationStore`.** That port is 10 operations with a passing
conformance suite and a contended-verified claim primitive; growing it to 15 would put unproven
surface behind a proven gate, and every future backend would have to implement multi-project before
it could implement coordination at all.

```
CoordinationStore   within one project        10 ops, verified
ProjectDirectory    across projects            createProject · listProjects · getProject
                                               addMember · listMembers · setRole · revokeMember
```

Two ports, two conformance suites. A local SQLite build can implement coordination and stub the
directory at one project. Territory rules still apply: the port is the contract, the suite is its gate.

## UI

```
/                     projects index — cards, last activity, your role, member avatars
                      empty state teaches `drydock new <name>`
/p/:project_id        the Kanban board that exists today, with PROJECT_ID no longer hardcoded
```

`components.tsx` and `tokens.css` are unfrozen (order 0041), so the index reuses the existing card,
empty-state and avatar idioms rather than inventing chrome.

## Order of work

1. `ProjectDirectory` port + conformance suite.
2. Firestore adapter — the collections and rules already exist; add the admin-SDK writes in the bridge.
3. `drydock new` in the CLI: create project, connect repo, write `.agentic/`, generate role packs.
4. Projects index + routing; unhardcode `PROJECT_ID`.
5. Roles as capabilities: bound `acquireScope`, then `deploy_scope`.
6. The client seat: role, human-layer append, and the triage surface on the board.

Steps 1–4 are **F1** on the acceptance checklist, which has never been built.
