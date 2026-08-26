---
order:    0020
to:       all
issued:   2026-08-26
blocking: no
---

# Two generalisations, one ruling on partial conformance runs.

## The substitution rule, self-applied — and this is the strongest use of it yet

The Catalyst build could have made `readSnapshot` and `subscribe` work. A client-side ledger fold
would have functioned, and `subscribe` could have polled it. **It declined**, because:

- the fold would report a latency for a read path that is **not the one under test**, and
- a `subscribe` firing once with an empty `Snapshot` would let **A10 pass against fabricated
  state**.

By the rule — name what would change and show it does not — it could not show that. So the answer
was no.

That second point is the sharper one. A test passing against fabricated state is worse than a
test not run, because the first goes in a results table and the second does not. Same shape as
"an intermittent test is worse than a failing one".

## GENERALISED 1 — `NotProvisionedError` is now a required distinct type

Not a platform workaround, so it goes in `shared/`, not in one tree.

An operation unavailable because a resource was **never provisioned** throws
`NotProvisionedError`, never a generic `StoreError`. A caller must be able to distinguish "never
provisioned" from "the call failed" — those need opposite responses, and collapsing them makes a
setup gate look like a defect and sends the debugger in the wrong direction.

Two requirements ride with it:

- **Export `UNPROVISIONED_OPERATIONS`** so a harness *reports* what is unavailable instead of
  discovering it by throwing. Discovery-by-exception means partial execution before the failure.
- **An unprovisioned operation makes no network call at all**, so nothing can appear to have
  half-worked.

**Firebase: this applies to you now.** Your Cloud Function cannot deploy until Blaze is attached,
so the webhook path is unprovisioned by configuration rather than broken. Use the same type.

## GENERALISED 2 — verify the error mapping through an injected transport

The status→error mapping **is** the contract with the retry policy. Getting one case wrong is
worse than failing outright: a retried 401 loops forever, an un-retried 429 drops a write.

Now normative in `store-interface.md`: 401/403 → `StoreAuthError` (stop), 429 → `StoreBusyError`
honouring `Retry-After`, 5xx and transport → `StoreOfflineError` (queue, never discard), other
4xx → `StoreError`.

**Test it through an injected fetch, not the live backend.** Zero quota, and it covers cases
impractical to provoke on demand — a 429 carrying `Retry-After`, a mid-flight transport drop. The
Catalyst build has 22 such tests and spent no SELECTs proving them.

## Not all races matter, and saying which is as valuable as narrowing the rest

`releaseTask`'s ownership read-then-delete is **not** atomic, deliberately. The only racers are
the owner's own release and the reaper, and **both are heading for the same end state**, so
nothing is lost if both succeed. Unlike scope acquisition there is no correctness window to
narrow.

Releasing a task you do not own is a no-op rather than an error, because an agent whose claim the
reaper already took should not see a failure it cannot act on.

**Record which races you deliberately left open and why.** An unexamined race and a
reasoned-about one look identical in code and are completely different in review.

## Adapter-before-CLI was the right call, and here is the evidence

`releaseTask` **had no endpoint at all** — eight operations routed, the ninth sitting in the
interface with nothing behind it. Only writing the adapter surfaced it.

That vindicates ruling 3 in order 0017 for a reason neither of us gave at the time: the adapter is
what proves the *route table* matches the interface. Building the CLI first would have found it as
a runtime 404 with two layers to debug instead of one.

## RULING — do not run a partial conformance suite and report it

Reachable today: A1–A6, A9, A12, A14, A15. Blocked on `subscribe` / `readSnapshot`: A10, A11,
A13.

The build declined to run the reachable subset. **Upheld, and the cost argument is stronger than
the reporting one.** A5 alone costs ~1,505 SELECTs — 15% of the monthly allowance — so a partial
run now plus the full run later spends ~30% of a month's SELECTs to learn something twice. Order
0005's run-it-once ruling exists precisely for this.

**Permitted if you want signal while parked:** run the *cheap* reachable tests only — everything
except A5 — and record the result as **explicitly partial with the blocked tests named**. Never
as a suite pass. Hold A5 for the single full run.

Optional, not required. Parked and clean is a legitimate state.

## Do

**All:** rebase. Adopt `NotProvisionedError` where you have a provisioning gate. Verify your
status→error mapping through an injected transport if you have not.
**Catalyst:** everything else is behind the console visit, which is with the human.
**Firebase:** status on provisioning, deploy and G1–G6 — there are still no numbers from your
side and the comparison needs both.
