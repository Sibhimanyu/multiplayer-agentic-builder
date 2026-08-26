---
order:    0017
to:       all
issued:   2026-08-26
blocking: yes
---

# `X-Agent-Token` is canonical. First real numbers are in. Three rulings.

The Catalyst build has deployed and measured G1, G2, G4, G5 and G6. Recorded in
`docs/results/catalyst-run-1.md`. Four findings only deploying could have found, all invisible
to the dry run — because the double replays Data Store semantics and these are gateway, SDK and
ZCQL behaviours.

## RULING 1 — the auth header is `X-Agent-Token`, on every route

**The Catalyst API Gateway reserves `Authorization`.** It validates any such header as a Zoho
OAuth token *before the function runs*: `Bearer` gives `INVALID_TOKEN`, anything else
`AUTHENTICATION_FAILURE`, and the function never sees the request. No handler code can recover
it.

The CLI is shared. So either it branches per platform — the exact divergence this structure
exists to prevent — or one header works everywhere.

**`X-Agent-Token: <token>` is canonical for all three routes.** Not negotiable per-platform.
Now in `store-interface.md` under Wire-level rulings.

The Catalyst build proposed this and explicitly declined to decide it for Firebase. That was
right: it is a shared-surface change, so it is mine to rule on.

**Firebase and GitHub: check what your CLI sends and change it if needed.**

## RULING 2 — `created_at` is metadata and never an ordering key

Catalyst `datetime` columns **reject RFC3339**, the format the protocol specifies. Only
`YYYY-MM-DD HH:MM:SS` is accepted, reads return a `.mmm` suffix that is not accepted back, and
**milliseconds are dropped**.

So a Catalyst ledger stores second-resolution `created_at` where Firestore stores milliseconds.

`seq` is authoritative for ordering, so this is display and audit metadata. **Do not degrade
Firestore to match** — keep native fidelity per platform and record the difference (G9 entry
13). Nothing may sort, page or deduplicate on `created_at`.

## RULING 3 — the build's proposed sequence is correct

Proposed and confirmed: **snapshot builder → Cache presence + reaper → scope routes → the single
full conformance run → CLI → F1–F12.**

Not the CLI first. The suite is what proves the contract; the CLI is a client of a proven store.
Building the client against an unproven store means debugging two layers at once, and the
highest-value remaining item is completing A1–A15, which this order reaches soonest.

## Two more findings, now normative for everyone

**Never match on an error message string.** `zcatalyst-sdk-node` renames `error_code` to `code`,
drops the documented REST wrapper, and the message does not contain the code — so code written
against the documented payload silently fails to match, and message matching is not even a
fallback. This is why `claimTask` first returned a generic 400 instead of `{ok:false, owner}`.
Every adapter maps its backend's error shape to `StoreError` at one chokepoint, using structured
fields only. **Firebase: audit your own error mapping for the same class.**

**`readEvents` must not over-fetch by one.** ZCQL *rejects* `LIMIT 0, 301` rather than clamping,
so the fetch-one-extra trick fails at exactly the default page size. `has_more` costs an extra
query per full page.

## The G4 correction, which matters more than the latencies

**Every authenticated request pays 2 SELECTs before its own work**, because the protocol requires
resolving token → agent → project → role server-side on every call and that cannot be cached
without weakening the guarantee. An append costs **5 SELECTs + 2 INSERTs**.

So the 10,000 SELECT allowance binds at ~2,000 appends, while the 5,000 INSERT allowance would
have permitted 2,500.

**Every planning figure before this was framed around INSERTs and was therefore wrong** — mine
in the platform audit, and the build's own A5 warning. Both were reasoned from the schema instead
of measured against a live request. A5's real cost is ~1,505 SELECTs, 15% of the monthly
allowance.

G9 entry 4 is corrected against Catalyst's favour. Entry 1 was earlier corrected in its favour
after Firebase measured its counter-document ceiling. Both corrections came from measurement
replacing reasoning, which is the only way this register stays honest.

## Measurement discipline, observed and worth naming

The build flagged two things rather than letting them be read past:

- **G1 measures the ledger read path, not the folded snapshot** — the Stratus builder does not
  exist, so the design doc's 34 ms CDN figure is *not* what was measured and must not be
  compared against it.
- **G2's max was 1,186 ms against a p95 of 182 ms**, one sample in 200 at 9x p95. Not treated as
  a threshold, and explicitly not averaged away: a claim that occasionally stalls over a second
  is user-visible and a mean of 139 ms hides it.

It also declined to convert G5 into dollars without a verified rate card. Measured operations
beat a number multiplied by a guess. **All builds: same standard.**

## Do

**All:** rebase for the wire-level rulings. Confirm your auth header is `X-Agent-Token`.
**Catalyst:** proceed with your sequence as confirmed.
**Firebase:** audit error mapping for structured-field detection; check your auth header;
report your own G1/G2/G4/G5/G6 in the same shape.
**GitHub:** the header ruling applies to you from the start.
