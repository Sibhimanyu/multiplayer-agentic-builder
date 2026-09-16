---
order:    0047
to:       firebase
issued:   2026-09-14
blocking: yes
---

# Roles become permissions. Then build the client seat.

The board is live, presence is observed at **1.3%** against an estimate of 1.4%, and F1/F2/F3 pass
23/23. Entries 68–70.

Four things in that run were right in ways worth repeating: **the denial path walked by something
that only knows what a user sees** — reading the uid off the screen rather than reaching behind the
UI; **F1 asserting the state underneath the screenshot**, because a screenshot shows a screen
rendered, not that the record behind it is correct; **F2 inviting and then assigning**, because one
combined call would never exercise `setRole`; and **F3 asserting three *distinct* directories**, since
three agents sharing one `.agentic/` would satisfy every other assertion in it.

Two corrections first, both small, both visible.

## 0. The copy lies, and the board has litter

**`components.tsx:132–133` still says "via the GitHub webhook".** There is no webhook — order 0043
moved PR/CI state to the bridge's **poll**. The checklist was updated and **the user-facing string was
not**, so the mechanism-naming rule got applied to the test and missed the product, surviving in the
one place a user actually reads. Fix both strings to name the poll.

And the live board carries four **"self test"** cards in Claimed. Clean the residue, and have the
self-test clean up after itself so it does not accumulate on a real board.

**On the port collision: that was mine.** Your `vite preview` hit "already in use" because I left a
server on 4173 and never stopped it. Your readiness-probe rule stands; so does a second one — a
coordinator who starts a long-lived process owns stopping it. Entry 69.

## 1. Roles become capabilities

Today a role is a `role_slug` string and prose in `role.md`. It constrains an agent only by asking it
nicely in a prompt. **That is not a permission.**

```
role:
  slug          "backend"
  file_scope    ["functions/**", "schema/**"]     may edit
  deploy_scope  ["functions"]                      may deploy
  capabilities  claim · publish_contract · open_pr
```

Three enforcement points, deliberately layered — **a prompt is guidance, the other two are gates**:

1. **The role pack** tells the agent its scope. `AGENTS.md` already does this.
2. **`acquireScope` refuses globs outside the role's `file_scope`.** The existing verified primitive,
   now bounded by role rather than by whatever the agent asks for.
3. **Deploy refuses targets outside `deploy_scope`.** Genuinely new — nothing today has a concept of
   a deployable target.

Defaults: `owner`, `architect`, `backend`, `frontend`, `qa`, `client`.

**Test both directions.** A refusal test passes trivially if the operation refuses everything — so
prove the in-scope glob is *accepted* by the same call that rejects the out-of-scope one. Entry 63's
rule: a negative assertion is vacuous unless you prove the thing could have appeared.

## 2. The client seat

A client administers the delivered app. They ask questions and suggest changes. **No code, no claim,
no scope, no agent.**

```
client capabilities:  read the board · append question and suggestion (human layer)
client cannot:        claim · acquireScope · deploy · publish contracts · run an agent
```

**The security property is the point, and it is structural.** `agentic-file-contract.md:46` — the
inbox carries *contract and coordination layers only; human-layer events are never written there*. A
client's words are human-layer by definition, so **they never enter any `inbox.jsonl`. Prompt
injection from the least-trusted seat is impossible by plumbing, not policed by a filter.**

**Prove it with a control, or it is worth nothing.** "The client's text never reaches an agent" is
vacuous unless the same text demonstrably *does* reach somewhere. So: append a client suggestion
containing an obvious injection payload; assert it **is** visible on the board and **is** in the
ledger; assert it is **absent** from every agent's `inbox.jsonl`. Both halves, one test.

**Triage is a feature, not overhead.** An owner or architect turns a suggestion into a task, or
declines it with a recorded reason. That step is where a human decides what agents work on — build it
as a surface on the board, not as a side channel.

## 3. Order of work

1. Fix the webhook copy and the self-test litter.
2. Role model on `ProjectDirectory`: `file_scope`, `deploy_scope`, `capabilities`; the six defaults.
3. Bind `acquireScope` to the role's `file_scope`. Both directions tested.
4. `deploy_scope` — the enforcement point, even if nothing deploys yet. A gate with no caller is fine;
   a caller with no gate is not.
5. The `client` role, with the injection control above.
6. The triage surface: suggestion → task, or declined with a reason.

Stop there. **F8–F10 come after**, and they need PR and CI state flowing through the bridge's poll.

## Standing rules

Assert the artifact, not the return value; the rule, not the outcome. A control that never fires has
not been run. A negative assertion needs proof the thing could appear. Gate suites get a
**verified-fresh** emulator, proven by identity rather than a port ping. Any new query shape gets one
**production** run before it is believed — the emulator does not enforce indexes.
`--test-concurrency=1`. `attempts` 6, `cap_ms` 2,000.
