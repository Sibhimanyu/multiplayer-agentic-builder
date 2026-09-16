# Multi-user: how a teammate's CLI gets an identity

Design, 2026-09-14. Written because the requirement is now explicit: **any teammate installs the CLI,
authenticates as themselves, and the CLI runs Claude bounded by their role.**

## The blocker, stated exactly

`firestore.rules` is currently `allow write: if false` on **every** collection. Not restrictive —
**zero**. Every write in the system goes through the Admin SDK in the bridge, which bypasses rules
entirely.

```
allow get, list:  if isMember(pid)      ← reads are member-gated
allow write:      if false              ← writes are impossible for any user, ever
```

And role enforcement — `file_scope`, `deploy_scope`, `globContains` — lives in
`shared/store/roles.ts` and `firebase/store.ts`. **Application code, not rules.**

So a teammate's CLI authenticating as a real user and writing with the client SDK **cannot write at
all.** The requirement is blocked by the security model, not by missing code.

## The fork, and it is real

### Option A — a server-side write path. **Recommended.**

1. **`drydock login`** opens the hosted board with a one-time nonce, the user signs in there with a
   real provider, and the page posts the credential back to a **localhost listener** the CLI started.
   This is how `gh auth login` and `firebase login` work. **No server is needed for the auth step** —
   only a browser and loopback.
2. The CLI stores a **refresh token** at `~/.drydock/credentials.json`, mode 600, and mints short-lived
   ID tokens from it.
3. **Writes go to one HTTPS Cloud Function** carrying that ID token. The function verifies the token,
   reads the caller's member document, enforces `file_scope` / `deploy_scope` / capabilities, and
   writes with admin privileges.
4. `firestore.rules` stays `allow write: if false`. **Unchanged. Still the strongest posture.**

**Why this is the right shape:** role enforcement stays somewhere the user cannot reach. That is the
whole point — a teammate must not be able to bypass their own scope.

**Cost: this requires Blaze.** Cloud Functions' free tier is 2M invocations/month, so this workload
realistically costs **$0** — but a billing account must be attached.

### Option B — loosen the rules, enforce roles client-side. **Rejected.**

Allow member writes directly, keep role checks in the adapter. No Blaze.

**This destroys the feature that was just built.** A teammate holding a valid token can write straight
to Firestore with ten lines of script, ignoring `file_scope` entirely. Role enforcement becomes
*advisory* — a suggestion to well-behaved clients. Glob containment cannot practically be expressed in
security rules, so there is no middle path here.

Building permissions and then making them bypassable is worse than not having them, because the board
would *show* enforcement that is not real.

### Option C — stay single-operator. Does not meet the requirement.

## The finding worth recording

**Local-first works for coordination. It cannot work for authorization.**

Decision 0001 chose Spark, and order 0043 moved the webhook receiver and the reaper into the local
bridge precisely because Spark has no Cloud Functions. **That was right** — coordination state is
data, and a local process can produce data safely.

Authorization is different in kind. Deciding *"is this person allowed to do that"* requires something
the person being checked cannot modify. **A local process is, by construction, under the control of
the user it is meant to constrain.** No amount of client-side care fixes that.

This is the first requirement in the project that genuinely needs a server, and it needs one for a
reason that will not go away.

## What the user must decide

**Attach a billing account to enable Blaze.** Expected cost ~$0 for this workload, but it is a card on
file, and that is not a decision a coordinator makes.

If the answer is no, the honest fallback is **single-operator, with the multi-user story marked
unbuilt** — and the roles feature relabelled as what it would then be: a guardrail for cooperating
agents, not a permission boundary.

## Then: the CLI runs Claude

Separate and simpler, once identity exists.

`drydock start` currently drains the outbox and delivers the inbox. It does **not** spawn an agent —
the design has always assumed a human starts Claude Code alongside it. The requirement changes that:
the CLI spawns the harness, bounded by the role's `file_scope`, with `.agentic/` as the interface it
already has.

This part needs no server. It is process management plus the existing file contract.
