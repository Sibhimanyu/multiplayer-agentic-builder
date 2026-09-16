---
order:    0045
to:       firebase
issued:   2026-09-14
blocking: yes
---

# Build the project tier. Most of it does not need the console.

F4/F6/F7 pass, 37/37. **The git half is done** and `blackboard.md`'s central claim — *"because it is
one file per fact, the rebase cannot conflict"* — is now **measured**: two agents publishing
concurrently gave 1 rejection, 1 rebase, both facts landed, nothing lost. That rule had never
executed before. Entry 63.

Four things there earned their place, all recorded:

- **F6 asserts v1 is byte-identical**, not merely present — editing v1 in place would destroy the
  `v1..v2` diff, the most valuable thing a blocked consumer has, **while leaving every
  path-existence check green.**
- **A fetch failure appends no line and does not advance `lastSeen`** — announcing a contract whose
  file is not on disk is worse than announcing it late.
- **The sha control.** "No agent touched a sha" was proven on artifacts, *and* the control asserted
  the sha does exist on the ledger. A negative assertion is vacuous unless you prove the thing could
  have appeared. That is entry 60's mirror and it is now a rule.
- **Naming the local CDN as not-GitHub's-CDN, up front.** Entry 25 applied before it could bite.

And reporting the `concurrency.test.ts:398` flake rather than keeping the green re-run was right —
entry 64. The cheap move was available and invisible. A known-intermittent failure only reported when
it blocks something stops being known-intermittent and becomes a surprise later.

## I was wrong that everything left needs the console

I said F1–F3 and F8–F10 all wait on Auth. **Most of the project tier does not.** The admin SDK
bypasses rules, the CLI runs locally, and the UI can be asserted by the edge harness without a
browser. Only *seeing it live* needs Auth.

Read `docs/designs/project-tier.md` first — it is written against what exists, and more exists than
either of us expected.

## The gap

`PROJECT_ID = 'proj_inventory'` is hardcoded in `App.tsx` on both branches, and there is **no project
tier at all**: no create, no list, no routing. The 10-op port is entirely *within* one project.

But `firestore.rules` already models `projects/{pid}` with a `members/{uid}` subcollection,
`isMember()` with revocation, and member-scoped list. `AgentPresence` already carries `role_slug`.
**Do not rebuild those.** The rules even record why membership is a document rather than a custom
claim — a claim needs a token refresh to revoke, and revocation must be immediate. That reasoning
stands.

## Resolve the contradiction first

`firestore.rules` says `allow create, update, delete: if false; // API only` and defers to
`functions/src/authority.ts`. **Spark has no Cloud Functions.** Order 0043 already moved the reaper
and webhook receiver into the bridge for exactly this reason; that comment now points at code that
cannot run.

**Ruling: the CLI creates projects; the browser lists and opens them.** Creating a project connects a
repo, writes `.agentic/`, and generates role packs — all of which need the repo on disk. Client
writes stay denied, nothing is loosened, and no billing is required. Blaze plus one function is the
documented upgrade path, deliberately not taken. **Fix the stale comment** so it names the bridge.

## Work

1. **`ProjectDirectory` — a second port, not a bigger one.** `createProject · listProjects ·
   getProject · addMember · listMembers · setRole · revokeMember`, with its own conformance suite.
   **Do not grow `CoordinationStore` from 10 to 15.** That port has a passing suite and a
   contended-verified claim primitive; adding unproven surface behind a proven gate would also force
   every future backend to implement multi-project before it could implement coordination.
2. **Firestore adapter** for it — collections and rules exist; add admin-SDK writes in the bridge.
3. **`drydock new <name>`** — create the project, connect the repo, write `.agentic/`, generate role
   packs.
4. **Projects index + routing.** `/` lists projects with your role and member avatars; `/p/:id` is
   today's board with `PROJECT_ID` unhardcoded. The empty state **teaches the command**: *"No projects
   yet — run `drydock new <name>` in your repo."* For a developer tool that beats a button that
   cannot work. `components.tsx` and `tokens.css` are unfrozen — reuse the existing card, empty-state
   and avatar idioms rather than inventing chrome.

Stop there. **Roles-as-capabilities and the client seat are the next order**, and they depend on this
landing first.

## Standing rules

- Assert the **artifact**, not the return value. Assert the **rule**, not the outcome.
- A control that never fires has not been run; a negative assertion needs proof the thing could appear.
- Gate suites get a **dedicated fresh emulator**; a re-run is not evidence of a fix (entry 64).
- `--test-concurrency=1` through `scripts/emul-suite.mjs`. `attempts` 6, `cap_ms` 2,000 — untouched
  unless something gives a stated reason to change both together.
