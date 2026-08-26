---
order:    0008
to:       both
issued:   2026-08-25
blocking: yes
---

# Client-supplied keys must be scoped. The dry-run double is now recommended to both.

## 1. `request_dedupe` — accepted, and it is the worst of the three

The Catalyst workspace found it: `idempotency_key` is **client-supplied**, so reasoning "it's
a uuid v4, it's already globally unique" is unsafe. With table-global uniqueness, a client in
project A sending a colliding key makes project B's append absorb as a duplicate and return
**someone else's `seq`** — HTTP 200, a plausible `seq`, event never written.

Now `dedupe_key = <project_id>:<idempotency_key>`.

Corollary the separator rule caught on its own: `deliveryIdempotencyKey` was emitting
`gh:<delivery_id>`, and a colon inside a composite part is exactly what the builder rejects.
Now `gh_<delivery_id>`. A rule added for one reason caught an unrelated key format that had
already shipped.

`store-interface.md` mandatory behaviour 1 is now split:

- **1a** — the idempotency key is client-supplied and MUST be scoped per project. Never trust
  client-supplied uniqueness.
- **1b** — the idempotency record MUST store the `seq` the event **actually received**, not a
  candidate computed before allocation settled.

Both are backend-agnostic. Firebase: confirm you satisfy them; `runTransaction` probably gives
you 1b for free, but 1a is a real requirement regardless of backend.

## 2. Append write order (Catalyst) — accepted, and the reasoning matters

The dry run found it: with the dedupe row written **inside** the `seq` retry loop, attempt 2
re-inserts the same dedupe row and collides with a key attempt 1 wrote itself. Twelve
concurrent appends, one passed, eleven failed.

The obvious fix — hoisting the dedupe insert out of the loop — is **worse**, because the dedupe
row must record the final `seq`, which is unknown until the loop settles. Recording the first
candidate makes a later replay return a `seq` belonging to a different event: silent corruption
instead of a loud failure.

Accepted order: **event first, carrying its own dedupe key, then the dedupe row.** A `seq`
collision retries the event insert alone, touching exactly one unique column. A crash between
the two is recoverable by reading the orphan's `dedupe_key` back and adopting its `seq`, with
no UPDATE. `events.dedupe_key` deliberately not unique.

This reverses what was argued in step 4c, for a better reason. That is how it should work.

## 3. The dry-run double — recommended to Firebase

Build one. It caught G9 entry 5, which code reading would not have found.

What made it work, and what to copy:

- It replays the **measured** platform semantics, not the documented ones — including
  non-monotonic `ROWID` allocation, so a regression to `ORDER BY ROWID` visibly reorders in a
  test.
- It **refuses** an unrecognised query rather than returning `[]`, so a typo cannot read as
  "no rows".
- It runs concurrent operations for real, which is how the twelve-append failure surfaced.

Firebase: your equivalent is the emulator, which you are already using for section E. Push it
further — run genuinely concurrent `runTransaction` calls against it and assert exactly-one
semantics, rather than trusting that transactions work.

This is a **methodology** recommendation, not a design one. Do not go looking at how the other
build structured anything.

## 4. G9 register is open

`docs/handoff/g9-asymmetries.md` on the shared branch. **Coordinator-maintained — neither of
you edits it.** Ten entries so far. Report findings on your own branch and they get folded in.

It also records the severity trend from the three table-global defects: deadlock, then
cross-tenant denial of service, then silent cross-tenant event loss. Each quieter than the
last. That trend is the argument for probing over reading, and it belongs in the final writeup.

## Do

**Both:** `git fetch origin && git rebase origin/zoho-catalyst-app-builder && npm test &&
git push --force-with-lease` for the corrected MB1 and the register.

**Catalyst:** nothing new to build. You are correctly parked on the project ID.

**Firebase:** confirm 1a and 1b; audit the webhook for the three things in 0006 if you have not;
push the emulator toward genuine concurrency.

## Report back

`Order 0008: MB1a/1b confirmed` plus what you changed, if anything. Push.
