---
order:    0050
to:       firebase
issued:   2026-09-15
blocking: yes
---

# Google sign-in is live. Wire `drydock login` to it, and stop baking in the project id.

The write function is deployed and I verified it independently — a no-token POST returns **our** 401
body rather than an IAM edge, so the request reaches our code, and `firestore.rules` still carries
**8 × `allow write: if false`**. Entries 74–77.

Three things from that run are recorded and stand: **the nonce check was itself a denial of service**
in its first form — any page the user visited could kill a login in progress with one POST — and the
fix (refuse, log, don't burn the nonce, don't abort) is the right shape. **The deploy was analysing
compiled `lib/` while you edited source**, which is the artifact rule inverted and worth keeping in
mind permanently. And **my diagnosis was wrong**: the blocker was never disabled APIs, it was a dead
`githubWebhook` declaring `defineSecret` at module scope, resolved during codebase *analysis*
regardless of `--only`.

## The user has enabled Google sign-in

Verified via `defaultSupportedIdpConfigs`: `google.com`, `enabled: true`, client ID provisioned.
Authorized domains already include `localhost`, `multiplayer-agents-eec02.web.app` and
`.firebaseapp.com`. **No further console work is needed for auth.**

## 1. `drydock login` uses Google, not anonymous

The loopback flow already exists and its nonce handling is already right. Change the provider: the
hosted page runs a real Google sign-in, and the resulting credential goes back over loopback exactly
as now.

**Keep anonymous sign-in working.** It is what lets someone open the board and see the `denied` state
with their uid, which is a real onboarding path and is already asserted in the edge harness.

**Test what a Google identity changes.** An anonymous uid is per-browser and disposable; a Google
uid is stable and belongs to a person. So assert a **second login as the same Google account returns
the same uid** — otherwise membership silently means nothing across sessions, and every role
assignment would evaporate the first time someone logs in again.

## 2. The project id must stop being compiled in

I checked the **installed artifact**, not the source: `multiplayer-agents-eec02` is baked into the
bundle a stranger would receive. That is correct for teammates and wrong for "anyone", and it makes
`drydock-cli` a public package that can only ever talk to one person's Firebase project.

- `drydock init --project <id>` writes to `~/.drydock/config.json`; `DRYDOCK_PROJECT` overrides it.
- **Derive the function URL and auth config from the project id**, not from a second constant that can
  drift out of step with it.
- **No default.** Unconfigured must fail with a message naming the command to run, not fall back to
  this project — a silent default is how someone else's CLI quietly writes to your database.
- Verify by the artifact rule again: `grep` the **built bundle** for the project id and assert it is
  absent. Source being clean proves nothing; that is exactly how it got there.

## 3. Then the real-agent run — the thing that has never happened

~400 assertions pass and **every one of them uses a scripted writer.** Claude Code has never been
pointed at a `.agentic/` directory. The design claims a real agent is indistinguishable from `echo`;
that is documented, not measured, and it is the same shape of claim as `is_unique` giving atomic
claims, the 34 ms read justifying C1, and the conformance suite proving the adapter. Each was
plausible, written down, and wrong until run.

Do it small and honestly: **one project, one real Claude Code session, one task.** Report what
actually happened, including anything the file contract did not anticipate. A failure here is worth
more than another green suite.

## Not yet

**Do not publish to npm.** Once the project id is configurable and a real agent has driven this once,
the publish decision is the user's and the command is `npm publish --access public` from `drydock/`.

## Standing rules

Assert the artifact, not the return value — for the bundle that means grepping the built file. A
control that never fires has not been run. A negative assertion needs proof the thing could appear.
Gate suites get a verified-fresh emulator proven by identity. `--test-concurrency=1`. `attempts` 6,
`cap_ms` 2,000.
