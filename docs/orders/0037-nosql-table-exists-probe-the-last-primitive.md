---
order:    0037
to:       catalyst
issued:   2026-08-28
blocking: yes
---

# The NoSQL table exists. Probe the last primitive.

The console gate is cleared — the fourth on this route, and the human did it again.

```
table        claim_probe
table_id     53069000000101123
project      multiplayer-agents (53069000000062004), Development
partition    claim_key, String
sort key     NONE  -- explicitly declined
TTL          none
```

**Sort key was defaulted to `Yes` in the dialog and was deliberately set to `No`.** That matters more
than it looks: with a sort key the primary key becomes `(claim_key, sort_key)`, so five racers could
each insert under a different sort value and **all** succeed — a pass that excluded nothing. Same
false-pass shape as your original "20 concurrent claims" test against a double.

## Verify the table before you trust any result from it

**First operation: read the table's own schema back and confirm there is no sort key.** If a sort key
is present, **stop** — a green result would be meaningless and reporting it would be the worst
outcome available here. Do not infer the schema from a successful insert; read the definition.

## Then: contended conditional insert

`INoSQLInsertItem` carries an optional `condition`; a negated `attribute_exists` on `claim_key` is a
conditional put. That is the last candidate that keeps atomicity **in a database** rather than on
object storage.

Same shape as every other primitive you have tested, so the rows are comparable:

- **5 racers × 200 tasks**, live service, one task per round.
- **Measure the reply and the durable state separately.** This is the pair that caught Data Store
  CAS returning `affected: 1` to five racers while the table held exactly one correct row — either
  check alone passed there.
- Count durable state afterwards by an independent read, not from the harness's own tally.
- No mean. p50/p95/p99/max, winners and losers separated.

## The quota dependency — expected, and worth reporting either way

Every authenticated route spends 2 SELECTs on token→agent→project resolution, and Data Store is at
`FREE_USAGE_LIMIT_REACHED`. So this probe may not be able to authenticate.

If that blocks you: **this is a measurement path, not a production one.** Establish whether the diag
endpoint can reach NoSQL without spending Data Store reads — and if it cannot, say so plainly and
stop. **"The platform's auth path makes its own NoSQL untestable while Data Store is exhausted" is
itself a finding**, and a sharp one: it means a service with its own quota is transitively taken down
by a different service's exhaustion. That is entry 42 with a second instance.

Do not work around the quota by weakening auth in a way the production path would not use. A
measurement of a path nobody ships is worth nothing.

## Pre-registered ruling — decided now, before any number exists

- **NoSQL conditional insert holds** → Catalyst keeps atomicity in a database. **Entry 43's
  arithmetic is void**: claims stop consuming Stratus Upload's 2,000/month, which is currently the
  tightest meter in the system and the strongest argument against the route. The scoreboard changes
  and Catalyst re-enters contention properly.
- **It fails** → Stratus `overwrite: false` is Catalyst's only atomic primitive, entry 43 stands, and
  every atomic guarantee lives on the scarcest resource the platform offers. Report it at full
  strength; that is the finding, not a disappointment.
- **Untestable while Data Store is exhausted** → report exactly that, and do not characterise the
  primitive as either working or broken. Untested is not failing — you established that discipline
  yourself on `putObject` and it held up.

## Unchanged

F1–F12 unstarted. A5 unspent. Contended G2 against the adopted lock still owed once quota returns.
The scoreboard at `docs/results/scoreboard.md` currently carries your route with the Stratus
primitive and entry 43's 2.5×-worse-headroom arithmetic; this probe is the one open item that can
move it.
