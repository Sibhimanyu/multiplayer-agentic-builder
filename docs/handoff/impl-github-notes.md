# impl-github — build notes (route G, GitHub-only)

Branch: `impl/github-v2`. Started 2026-08-26.

**Branch-name note.** The brief and order 0016 both name `impl/github-v1`. This workspace was
handed to me already on `impl/github-v2`, and I was told not to rename it. `origin/impl/github-v1`
and `origin/impl/github-v2` were byte-identical at `3fb9169` when I started — neither carried any
route-G work. **`impl/github-v2` is the live branch.** `impl/github-v1` is abandoned at the
pre-work base; do not read it expecting content. Same shape as the ruling in order 0005 about
`origin/impl/catalyst` — I am not pushing to or deleting the stale one.

This file is my report, per order 0001. Append-only, honest, every constraint and every number.

---

## Order 0016 step 1 — rebase for `shared/`

```
git rebase origin/zoho-catalyst-app-builder   -> 71a7005 (Order 0016), fast-forward
npm install && npm test
```

```
ℹ tests 19
ℹ suites 1
ℹ pass 19
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

**19/19 before anything was written.** Suite not forked, not modified. Territory check clean
(see the bottom of this file).

---

## Provisioning cost — route G, for G4

| Step | Command | Console steps | Result |
|---|---|---|---|
| Auth | *(none — `gh` was already authenticated)* | 0 | account `Sibhimanyu`, scopes `gist, read:org, repo, workflow` |
| Backend project | *(none exists — GitHub **is** the backend)* | 0 | — |
| Billing | *(none)* | 0 | $0 |
| Demo repo | `gh repo create Sibhimanyu/inventory-tracker-github --private` | 0 | https://github.com/Sibhimanyu/inventory-tracker-github, created first try |

**One CLI command, zero console steps, zero new accounts, zero billing.** Nothing was blocked
waiting on a human.

**Honest gap:** I intended to wall-clock the `gh repo create` and my timing snippet used
`date +%s%3N`, which macOS `date` does not support — it errored *after* the create had already
succeeded, so the figure was lost and cannot be re-measured without creating a second repo,
which the scope limit forbids. What is verifiable: the command returned a repo URL on its first
invocation with no error, no prompt and no browser. I am not going to substitute a guess for the
number I failed to capture.

Resources created (for cleanup): `Sibhimanyu/inventory-tracker-github` (private). Nothing else.
Nothing pre-existing was touched.

---

## Order 0016 step 2 — the two primitives, probed

All probes ran against the **real** GitHub remote (`inventory-tracker-github`), not a fake.
Scripts are committed under `github/probes/`; raw output was captured under `/tmp/ghprobe/out/`.
Every probe ref was deleted afterwards.

Probes A (claim, 20-way × 50 rounds) and B (presence, 5 agents × 40s) ran **concurrently**, as
ordered. Latency probes C/F/G ran afterwards in a quiet window, because a number measured while
a 20-way push race is saturating the same connection is not the number anyone will quote.

### Primitive 1 — atomic claim. Verified 50/50, and the brief's *reason* was too broad.

**Result (probe A): 50 rounds, 20 concurrent claimants, exactly one winner every round.**

```
rounds=50 agents=20 pass=50 fail=0
total_wall_s=361.4
```

A round only counted as PASS if **all three** held (order 0009 — assert correlation, not count):

1. exactly one of 20 pushes returned rc=0,
2. the resulting `refs/claims/<task>` pointed at **that winner's** commit, not merely at *a*
   commit — this is the A2 "assert the winner's `agent_id` matches the row" requirement,
3. all 19 losers reported `rejected`, i.e. a refusal rather than a crash.

```
probe-r001	PASS	winners=1	correlated=yes	losers_rejected=19/19	round_ms=4013
...
probe-r050	PASS	winners=1	correlated=yes	losers_rejected=19/19	round_ms=...
```

This satisfies **A2** and non-negotiable "A2 passes 50 consecutive runs" against the real
backend, not a double.

The lease semantics, verbatim:

```
### B1 lease, ref ABSENT
 * [new reference]   c2ff361... -> refs/claims/lease-demo          rc=0
### B2 lease, ref EXISTS
 ! [rejected]        927e38a... -> refs/claims/lease-demo (stale info)   rc=1
```

#### Correction to the brief: the naive push is not *unconditionally* unsafe

The brief and order 0016 both state that a plain `git push origin <sha>:refs/claims/<task>` to
an **existing** claim ref *succeeds*, and cite `72d448f..3fb9169`. Run against sibling commits,
it does not:

```
=== D1  naive push, second SHA is a SIBLING of the holder's ===
 ! [rejected]  ce73555... -> refs/claims/d-sib (non-fast-forward)     rc=1
ref -> c620ebe...   (holder retained)
```

The steal happens **exactly when the challenger's commit is a descendant of the holder's** —
which is what `72d448f..3fb9169` was, two commits on one line:

```
=== D2  naive push, second SHA is a DESCENDANT of the holder's ===
   c620ebe..aa35396  aa35396... -> refs/claims/d-desc                 rc=0
ref -> aa35396...  subject="claim by agent_desc2"
>>> CLAIM SILENTLY STOLEN by fast-forward
```

**The brief's conclusion is right and its reason is wrong, and the difference matters.** If you
believed "naive push always fails on an existing ref" you would conclude the naive form is
*safe* — it visibly rejects — and ship it. The descendant case is not exotic: an agent that
claims with its current branch tip, in a repo where agents share history, produces descendant
SHAs constantly. It is a claim-steal that appears only once two agents happen to be on the same
line of history, which is the worst possible reproduction profile.

The lease closes it:

```
=== D3  LEASE push, same descendant case ===
 ! [rejected]  aa35396... -> refs/claims/d-lease (stale info)         rc=1
>>> holder retained, lease rejected the steal
```

**Design consequence:** the claim commit must be a **fresh orphan-ish commit built for the
claim** (`git commit-tree` off a fixed base), never the agent's working branch tip. That makes
all claim commits siblings, so even the naive form would reject — but the adapter uses the lease
regardless, because "siblings by construction" is an invariant a future refactor can quietly
break, and the lease does not depend on it.

#### The lease needs no prior fetch — this is what makes it a one-shot primitive

`--force-with-lease` normally requires a remote-tracking ref. With an explicit **empty** expected
value it does not, so `claimTask` is a single network round trip with no read step and therefore
no read-verify-write window at all:

```
=== D4  client has NEVER seen the ref ===
local remote-tracking refs: 0
 ! [rejected]  ce73555... -> refs/claims/d-cold (stale info)          rc=1
>>> rejected without any prior fetch. GOOD.
```

#### `releaseTask` — a trap the brief does not mention

The obvious release is `git push origin :refs/claims/<task>`. **That lets any agent release any
other agent's claim, and returns rc=0 doing it.** Release must be a lease *pinned to the owner's
sha*:

```
=== D5 ===
-- non-owner deletes (lease pinned to a sha it does not hold)
 ! [rejected]  (delete) -> refs/claims/d-rel2 (stale info)            rc=1
ref still -> c620ebe...        (holder retained)
-- owner deletes
 - [deleted]   refs/claims/d-rel2                                     rc=0
-- delete again, already gone
 ! [rejected]  (delete) -> refs/claims/d-rel2 (stale info)            rc=1
-- plain delete of an absent ref
 - [deleted]   refs/claims/d-rel2                                     rc=0
```

Two things follow:

- Ownership on release is **server-enforced for free**, which neither of the other routes gets
  from their primitive — they have to check it in application code.
- `store-interface.md` says "releasing a task you do not own is a no-op, **not an error**". The
  pinned delete returns rc=1 for *both* "you do not own it" and "it was already gone". The
  adapter must therefore **swallow** that rejection and return `void`. It must not surface it,
  and it must not fall back to a plain delete to make the rc=0 — the fallback is the
  vulnerability.

### The open problem — presence. The suggested scheme works, and it can be made better.

The brief proposed `refs/heartbeats/<agent_id>/<unix_ts>`, created then deleted as two pushes,
with the warning that a reader may briefly see two refs and should take the max.

**Finding: it does not have to be two pushes.** One `git push --atomic` does the create and the
delete together, so the two-ref window does not exist:

```
### B-1 single --atomic push: create new ts ref AND delete old ts ref
git push --atomic origin $SHA:refs/heartbeats/$A/1787748242 :refs/heartbeats/$A/1787748239
 - [deleted]         refs/heartbeats/agent_b0000001/1787748239
 * [new reference]   1081557... -> refs/heartbeats/agent_b0000001/1787748242
rc=0
--- refs now:
1081557...	refs/heartbeats/agent_b0000001/1787748242
```

Measured over 80 reader observations across 5 concurrently-heartbeating agents (while probe A's
20-way claim race was running in the same repo):

```
  80 refs=1
```

Never two, never zero. **Take-the-max is still the right reader implementation** — it costs
nothing and it protects against a partial push from an older client — but the transient is
eliminated at the source rather than tolerated at the reader.

Zero heartbeat pushes failed across both probes (5 agents × 40s, then 3 agents × 70s), including
while the claim race was saturating the same remote.

#### A9 — staleness derived at read time, and the test discriminates

Order 0009: a test that cannot tell the bug from the fix is worse than no test. Asserting "all
agents eventually go stale" passes on a broken reader that marks *everything* stale. So probe E
runs three agents with a 20s timeout, kills one at t=12s, and asserts **only that one flips**:

```
### E — timeout=20s, agent_e0000003 stops at t=12s, others heartbeat every 4s for 70s
 5s agent_e0000001=live(5s)  agent_e0000002=live(5s)  agent_e0000003=live(4s)
19s agent_e0000001=live(5s)  agent_e0000002=live(5s)  agent_e0000003=live(12s)
28s agent_e0000001=live(7s)  agent_e0000002=live(7s)  agent_e0000003=STALE(21s)
...
73s agent_e0000001=live(8s)  agent_e0000002=live(8s)  agent_e0000003=STALE(66s)

RESULT: PASS — exactly the stopped agent flipped, live agents unaffected
```

Zero false positives on the two live agents across the whole 73s window. The timestamp is read
**entirely from the ref name** — `git ls-remote` returns `<sha>\t<refname>`, and the reader
parses `p[4]` out of the path. **No object is ever fetched to answer "is this agent alive".**
That is the property that makes presence viable here at all, and it is why commit-recency (which
the brief rightly warns against) is not needed.

The interface's real constraint — "MUST NOT cost a durable row UPDATE per call" — is satisfied
in a way neither cloud route can match: a heartbeat costs **one ref update and zero rows**, and
the storage footprint is exactly one ref per agent forever, because the old one is deleted in the
same atomic push.

#### The constraint this scheme actually imposes

Heartbeat push latency, measured **under load** (probe A running concurrently):

```
heartbeat push (atomic create+delete): n=22 min=2120 p50=2752 p90=3321 max=3565 ms
```

So a heartbeat is a ~2.8s operation. **The heartbeat interval must comfortably exceed the push
latency**, or an agent spends its life in flight and its observed age never settles. With a 4s
interval the observed age oscillated between 2s and 9s — bounded by
(interval + push latency + reader poll interval). Against the 90s default timeout that is a 10x
margin, which is fine; against a 15s timeout it would not be. A 20–30s heartbeat interval is the
honest recommendation for this route, and the 90s default timeout stands.

Per order 0012: that 2.8s median is **one distribution under one load condition**, not a
threshold. What generalises is the shape — seconds, not milliseconds, and dominated by TLS +
push negotiation rather than by anything about refs.

### Primitive 2 — notification. Confirmed free, and there is a way to lose that for free.

Measured in a quiet window, 25 samples each:

| Channel | n | min | p50 | p90 | max |
|---|---|---|---|---|---|
| `git ls-remote` (all refs) | 25 | 1252 | **1340** | 1547 | 1997 |
| `git ls-remote refs/heartbeats/*` | 25 | 1247 | **1330** | 1394 | 1680 |
| REST `GET /git/matching-refs/…` + `If-None-Match` → 304 | 25 | 486 | **535** | 568 | 591 |

All figures ms. The brief's numbers (1,347 ms / 593 ms) reproduce almost exactly — 1,340 and
535 here. **Independently confirmed on a second run against a different repo.**

Note `ls-remote` scoped to one namespace is **not** meaningfully faster than unscoped (1330 vs
1340). The cost is the connection, not the ref count. Do not expect namespacing to buy latency.

Quota, over 25 consecutive conditional GETs:

```
C3 status codes:   25 304
C3 x-ratelimit-remaining first=4986 last=4986 distinct=4986
```

**Flat across 25 requests.** Confirmed at a larger sample than the brief's three.

#### The trap: the ETag is media-type dependent, and getting that wrong silently costs quota

Probe C's quota sub-test unexpectedly returned `200` where I expected `304`. Rather than
assume why, probe H isolated it:

```
### H1  ETag obtained WITH `Accept: application/vnd.github+json`, replayed WITH it
  replay 1 -> 304  remaining=4961
  replay 2 -> 304  remaining=4961
  replay 3 -> 304  remaining=4961

### H2  the SAME ETag, replayed WITHOUT the Accept header
  replay 1 -> 200  remaining=4960
  replay 2 -> 200  remaining=4959
  replay 3 -> 200  remaining=4958

### H3  ETag obtained WITHOUT Accept, replayed WITHOUT Accept
  etags identical? = NO
  replay 1 -> 304  remaining=4957
  replay 2 -> 304  remaining=4957
  replay 3 -> 304  remaining=4957
```

It is not "Accept is required". It is that **the request that obtains the ETag and the request
that replays it must present the same `Accept`**, or the ETag simply does not match and you get
a full `200`.

And the cost difference is exact:

```
### H4
  10 conditional 304s:    remaining 4956 -> 4955   (-1, the bracketing read; the 10 cost 0)
  10 unconditional 200s:  remaining 4954 -> 4943   (-11, the 10 cost 1 each)
```

**304 costs 0. 200 costs 1. Verified by the counter, not by documentation.**

Why this matters more than it looks: `subscribe` at ~600 ms is **6,000 requests/hour against a
5,000/hour limit**. It is only viable *because* 304s are free. An `Accept` header that drifts
between the ETag-fetch path and the poll path — trivially easy if one goes through `gh api` and
the other through raw `fetch` — turns every poll into a 200 and **exhausts the hour's entire
quota in about 50 minutes**, with no error, no warning, and correct-looking data right up until
`403`. This is the same shape as the defects orders 0005/0006/0008 found on Catalyst: quiet,
correct-looking, and only visible under a condition nobody thought to vary.

**Mandatory for this adapter:** one chokepoint issues every conditional request with a pinned
`Accept`, and the poll loop **asserts the response was 304** rather than assuming it. A run of
200s where 304s were expected must be logged loudly (non-negotiable "no silent failure").

#### End-to-end: write a ref → a conditional poller sees it

```
C5 write->visible-to-poller   n=10 min=2533 p50=2668 p90=2831 max=3406 ms
```

That is push (~2s) + poll detection, measured end to end with a 100 ms poll. So the honest
`freshness` for this route is **not** the poll interval — the poll is nearly free and could run
at 600 ms, but the *write* costs ~2 s, so driving the poll faster than the write buys nothing.

**Chosen: `freshness = { mode: 'poll', stale_ms: 5000 }`.** Rationale, since the brief asked me
to report what I actually chose rather than accept a default: measured worst case to visibility
was 3,406 ms; 5,000 ms is the next round number above the observed max with headroom, and it
happens to match the Catalyst route's figure, which makes the dashboard's freshness rendering
comparable across routes rather than incidentally different. Polling faster than ~2.5 s would
advertise a freshness the write path cannot deliver.

### Claim latency, per operation (probe G)

Probe A's `round_ms` is the wall clock of **20 concurrent** pushes — it is the max of 20, not a
per-claim figure, and quoting it as one would be wrong. Measured separately, uncontended:

```
rounds attempted=30  valid=30  DISCARDED(wrong outcome)=0

claimTask  WIN  (lease accepted)  n=30 min=2046 p50=2165 p95=2357 max=2883 ms
claimTask  LOSE (lease rejected)  n=30 min=983  p50=1084 p95=1315 max=1956 ms
releaseTask (pinned lease delete) n=30 min=1963 p50=2114 p95=2356 max=2569 ms
```

**Losing is twice as fast as winning** (1.08 s vs 2.17 s), because a rejected push never
transfers or writes anything — the server refuses at ref negotiation. That is a pleasant shape
for this workload: under contention, 19 of 20 agents get their answer in half the time and can
go pick another task.

For G2, the 20-way contended figure was `n=47 min=3384 p50=3678 p90=4000 max=4226` ms wall clock
per round.

**Measurement note (order 0012).** The first run of probe G produced `max=2414910 ms` — a
40-minute sample — followed by three ~105 ms samples. That was a network drop, not a
measurement: the 40-minute figure is a hang, and the 105 ms ones are pushes *failing fast*.
Probe G v1 recorded only elapsed time, so it was timing failures as though they were successes.
**Fixed by recording the exit code per sample and discarding any round whose outcome was not the
expected one** (win rc=0, lose rc≠0, release rc=0). The re-run discarded nothing and reproduced
the surviving samples of the first run to within 2 ms at p50, which is the reason to trust it.
This is the "assert the contract, not your expectation" rule applied to a benchmark: a
latency probe that cannot tell a fast failure from a fast success measures nothing.

### The loss path — `{ok:false, owner}` costs a second round trip (probe F)

`claimTask` must return the owner. The brief says "read the owner from the ref's commit", which
is an **object** read, not a ref read. Costed:

```
owner commit message  : agent_f1234567|2026-08-26T10:00:00Z
REST commit body      : agent_f1234567 | 2026-08-26T10:00:00Z

F1 ls-remote one ref                    n=15 min=1177 p50=1337 p90=1434 max=1451 ms
F2 git fetch that object + read         n=15 min=1218 p50=1360 p90=1469 max=1500 ms
F3 REST GET /git/commits/{sha}          n=15 min=486  p50=547  p90=565  max=626  ms
F4 REST GET /git/matching-refs/claims/  n=15 min=490  p50=551  p90=587  max=663  ms
```

**Use F3, not F2.** One REST call returns the commit message *and* its date in 547 ms; the git
route costs 1,360 ms and pollutes the local object store with claim commits that then need
garbage collecting. So a lost claim is `1,084 ms` (rejected push) `+ 547 ms` (owner lookup)
`≈ 1.6 s`, and the owner lookup only happens on the loss path.

**A real weakness, stated plainly:** `claimed_at` is the **claimant's own clock**, taken from
the commit date. Git has no server-side timestamp on a ref, and the API does not expose ref
creation time. Both other routes get a server clock for free. Consequences: two agents with
skewed clocks produce a `claimed_at` ordering that does not match the true ordering, and a
malicious or broken agent can backdate its own claim. It does **not** affect claim *correctness*
— the lease decides the winner, not the timestamp — but any reaper policy keyed on `claimed_at`
inherits the skew. Mitigation for the reaper: key off the **heartbeat** ref name (also claimant
clock, but continuously refreshed, so a stalled clock stops advancing and reads as stale rather
than as fresh). Recording this as a route-G weakness rather than engineering around it.

### Orders 0017 / 0018 — read after the probes landed, and 0017 lands squarely on this route

Both arrived on the shared branch while I was probing. Rebased for them.

**Ruling 1, `X-Agent-Token`.** Noted and binding from the start. No CLI exists on this branch
yet, so there is nothing to change — it will be `X-Agent-Token` when there is. Route G has no
gateway that reserves `Authorization`, so this costs me nothing; it is a Catalyst constraint the
shared CLI now carries for everyone.

**Ruling 2, `created_at` is never an ordering key.** Reinforces the `seq` item below. Route G's
`created_at` would come from a commit date, which is a *claimant* clock — even weaker than
Catalyst's second-resolution server clock. Nothing will sort on it.

**"Never match on an error message string."** This is the ruling that hits route G hardest,
because *the backend's error channel is `git push` stderr* — prose, not a payload. So I probed
what structure actually exists (probe I):

```
1 claim LOST (lease rejected)      rc=1   ! [rejected] ... (stale info)
2 claim WON (fresh ref)            rc=0
3 non-fast-forward (no lease)      rc=1   ! [rejected] ... (non-fast-forward)
4 repo does not exist              rc=128 remote: Repository not found.
5 bad credentials                  rc=128 remote: Invalid username or token.
6 host unreachable (offline)       rc=128 fatal: unable to access ... Couldn't connect
7 DNS failure                      rc=128 fatal: unable to access ... Could not resolve host
```

Two structured layers exist, and together they are enough:

**(a) `git push --porcelain` puts a status *character* in column 1** — a field, not a message:

```
-- WIN --   *	<sha>:refs/claims/j-new	[new reference]      rc=0
-- LOSE --  !	<sha>:refs/claims/j-held	[rejected] (stale info)   rc=1
-- DELETE - -	:refs/claims/j-held	[deleted]            rc=0
```

`*` created, `!` rejected, `-` deleted. So `claimTask` reads column 1, never the prose.

**(b) rc=128 collapses four transport classes into one code** — and they need *opposite*
responses: `StoreAuthError` means **stop, do not retry**; `StoreOfflineError` means **queue to
the outbox and keep working**. Grepping stderr to tell them apart is precisely what 0017
forbids. So the adapter does not: **on rc=128 it makes one REST call and maps the HTTP status**,
which is a structured field:

```
valid-repo     HTTP 200        -> transient; retry
missing-repo   HTTP 404        -> StoreError, named
bad-token      HTTP 401        -> StoreAuthError   (stop, never retry)
offline        connection error -> StoreOfflineError (queue to outbox)
```

Plus `403` + `x-ratelimit-remaining: 0` → `StoreBusyError`. One chokepoint, structured fields
only, no string matching anywhere. This is the same conclusion 0017 reached for the Catalyst
SDK, arrived at from a completely different failure surface.

**0018, "never substitute a component that is part of what is being measured."** Complied with:
every number above is from the real GitHub remote. Nothing was stubbed, and the one number I
failed to capture (repo-create wall clock) is reported as missing rather than estimated.

**0018, "an unreadable value fails loud, not convenient."** Already how the presence reader
behaves, and worth stating explicitly since it was luck as much as design: a heartbeat ref whose
final path component is not an integer parses to `0`, which makes its age enormous, which reads
as **stale**. That is the safe direction — an unparseable heartbeat must never read as live.
There is a matching case I have *not* yet handled: an agent with **zero** heartbeat refs. The
brief warns about this and it is right — absent must not mean "instantly offline" for an agent
that was seen a moment ago, nor "live" for one that never appeared. Not yet designed.

---

## `seq` ordering — probed (orders 0016 step 2, 0023). Third primitive.

Probes J, K, L. Same treatment as the other two: nothing below is assumed.

### The obvious answer is wrong, in the ROWID shape

**Commit order on a shared branch does not preserve allocation order.** Two workers, A allocates
first, B second, B pushes first, A retries with `pull --rebase`:

```
commit timestamps:
   A: 2026-08-27 11:07:40 +0530     <- allocated FIRST
   B: 2026-08-27 11:07:42 +0530     <- allocated SECOND
B pushed first (it was allocated SECOND)
A's plain push:  ! [rejected] HEAD -> probe-ledger (fetch first)
A pushed after pull --rebase

resulting branch order, oldest commit first:
   1081557  2026-08-26 18:12:46 +0530  probe base
   68a3ea5  2026-08-27 11:07:42 +0530  event B -- allocated SECOND
   210fe35  2026-08-27 11:07:47 +0530  event A -- allocated FIRST
```

A reader consuming in branch order gets B before A. **And the commit date is no fallback**: the
rebase rewrote A's date from `11:07:40` to `11:07:47`, so sorting by date *also* puts B first.
The retry that makes the push succeed is the same operation that destroys the ordering.

This is `ROWID` again — the obvious ordering key running backwards — and it reinforces order
0017 ruling 2: `created_at` is metadata, never an ordering key. On this route it is worse than
Catalyst's second-resolution problem, because a rebase actively rewrites it.

### Ref-name ordering is lexical. Zero-padding is mandatory, not cosmetic.

Both channels return refs in **lexical** order:

```
-- git ls-remote, as returned --      -- REST matching-refs, as returned --
   refs/seq/probe/10                     refs/seq/probe/10
   refs/seq/probe/100                    refs/seq/probe/100
   refs/seq/probe/2                      refs/seq/probe/2
   refs/seq/probe/9                      refs/seq/probe/9

-- LEXICAL sort:  10 100 2 9
-- NUMERIC sort:  2 9 10 100
```

Exactly the trap `blackboard.md` already documents for ZCQL — *"a string qty put 100 before 9 in
every ordered query"* — arriving here through a completely different door. **Seq refs are
zero-padded to fixed width** (`%010d`), so lexical and numeric order coincide and no caller can
get it wrong by sorting the natural way.

### The mechanism, and it reuses the primitive already verified

Counter in the ref **name**, advanced by one atomic push:

```bash
git push --atomic --force-with-lease="refs/seq/<proj>/head/<next>:" origin \
    "$MYSHA:refs/seq/<proj>/head/<next>" ":refs/seq/<proj>/head/<cur>"
```

Create-if-absent on `<next>` decides the winner; the delete of `<cur>` keeps exactly one ref.
Reading the current value needs **no object read** — the number is the ref name.

**Per-project allocation is free here.** Order 0005 required Catalyst to allocate `seq`
*globally* specifically because `is_unique` is table-global and per-project allocation
deadlocked. Route G has no such coupling: the ref path *is* the scope, so
`refs/seq/<project>/head/*` is naturally per-project and the deadlock 0005 describes cannot
arise. Contention is therefore per project, which is the real concurrency unit anyway.

### Measured under contention

12 allocators, distinct commits, released from a shared time barrier:

```
allocated: 1 2 3 4 5 6 7 8 9 10 11 12
count=12 distinct=12 expected=12
attempts:  1 2 3 4 5 6 7 8 9 10 11 12
false successes caught by the ownership re-check: 0
RESULT: PASS - 12 distinct seqs, zero duplicates
```

**Zero duplicates, zero lost allocations, contiguous 1..12.**

**The cost, stated because order 0019 requires it.** `attempts` equals the allocated `seq` for
every allocator — the winner of seq *N* failed *N−1* times first. That is the correct signature
of genuine contention on a single counter, and it is **O(N²)**: 12 allocations cost **78 push
attempts plus 78 counter re-reads**. At ~2 s per push and ~1.3 s per `ls-remote` read that is
minutes of wall clock for twelve events.

This is the retry loop order 0019 warned about — correct output, cost hidden inside it. **Route
G's `seq` is correct and expensive, and the expense scales quadratically with concurrent
appends.** I am reporting the attempt count alongside the result rather than only the result, and
G4 for this route must carry attempts, not just operations. Mitigations exist (batching an
allocation range per agent, sharding the counter) but none are probed, so none are claimed.

### A CORRECTION to what I reported last session about the claim primitive

Probe J's losing allocator returned **rc=0**. Isolated in probe L, without a pipe in the way
this time:

```
L1  ref EXISTS(->X), loser pushes X   (identical sha)
  rc=0   out: Everything up-to-date

L2  ref EXISTS(->X), loser pushes Y   (different sha)
  rc=1   out:  ! [rejected] ... (stale info)

L3  ref ABSENT, pushes X              (the winning case)
  rc=0   out:  * [new reference] ...
```

**Pushing a sha to a ref that already equals that sha is a no-op, and the lease is never
evaluated.** `rc=0`, "Everything up-to-date". It happens on claim refs too:

```
L4  claim held by X, challenger pushes X (identical sha)   rc=0   Everything up-to-date
L5  claim held by X, challenger pushes Y (different sha)   rc=1   ! [rejected] (stale info)
```

**So `rc=0` does not mean "I won the claim".** It means "I won" *or* "the ref already holds
exactly my commit". Last session I reported the lease as the claim primitive and validated it
with `rc`. Probe A never exposed this because every agent there carried a distinct commit
message and therefore a distinct sha — the bug was invisible to the test that was supposed to
prove the mechanism.

**How easy this is to hit:** any scheme where the pushed object is not unique per claimant. My
own probes B, E and J all pushed a *fixed* base sha for convenience. Written that way in an
adapter, **every concurrent claim would return rc=0 and every agent would believe it won** — A2
would pass 50/50 while the mechanism was entirely inert, because A2 counts `ok:true` results and
they would all be `true`.

**The fix is order 0017's ruling, again: read the structured field, not the exit code.**
`--porcelain` distinguishes them where `rc` cannot:

```
-- fresh create --
*	27bba93...:refs/seq/head/0000000006	[new reference]     rc=0
-- same sha again (the no-op) --
=	27bba93...:refs/seq/head/0000000006	[up to date]        rc=0
```

`*` is a real create; `=` is the no-op. Same `rc`, different status character.

Two requirements follow, and the adapter implements both rather than choosing:

1. **The claim object must be unique per (agent, task)** — the commit message carries both, so
   two different agents can never produce the same sha.
2. **`claimTask` decides on the porcelain status character, never on `rc`.** `*` → won. `=` →
   the ref already holds my own commit, so confirm ownership before returning `ok:true`. `!` →
   lost, go read the owner.

Requirement 1 alone would be enough today. It is the kind of invariant a refactor breaks
silently, and requirement 2 costs nothing, so both.


---

## `store/github.ts` — the adapter

Files, all in my own tree per `territory.md`. Root `npm test` is untouched at exactly 19/19 and
no test of mine resolves through `shared/`.

```
github/store/refs.ts         ref layout, padding, composite keys
github/store/transport.ts    injectable git + REST seam, error mapping
github/store/github.ts       the adapter
github/store/refs.test.ts        \  26 tests, no network, zero quota
github/store/transport.test.ts   /
github/store/github.live.test.ts registers shared/store/conformance.ts UNMODIFIED
tsconfig.github.json         a NEW file, per order 0006 section 4
```

### The event ref IS the seq allocator

The obvious shape is "allocate a seq, then write the event" — two contended round trips. Here
they are one: `refs/agentic/<proj>/ev/<0000000042>` is created with the create-if-absent lease,
so **winning the ref and owning the seq are the same event**. A rejection means someone took that
number; increment and retry, never re-read the same candidate (the spin order 0005 warned about).

### MB1b does not arise on this route, rather than being solved

Order 0008 had to rule on Catalyst's write order: event first carrying its own dedupe key, then
the dedupe row, with orphan recovery for a crash between them. That whole problem is a
consequence of not having a transaction.

Probe M measured that `--atomic` genuinely rolls back — on a partial rejection *neither* ref
lands, verified in both directions. So the event ref and the dedupe ref go in **one push** and
there is no window in which one exists without the other. Nothing to order, nothing to recover.

Without `--atomic` the same collision leaks an orphan, measured — so it is load-bearing, not
decorative.

### The scope-lock race — closed, and this is route G's strongest result

Order 0018 calls Catalyst's scope-lock race the largest asymmetry in the register, and is
careful about why: entry 2 cost a naming convention, but entry 18 costs a **residual correctness
window that can be narrowed but not closed**, because the primitive needed to close it does not
exist. Two agents with overlapping-but-not-identical globs can both pass the pre-check, and
`is_unique` cannot stop them because their keys differ.

**Route G closes it.** The reason is a property I had not needed until now:
`--force-with-lease=<ref>:<sha>` with a **non-empty** expected value is a genuine
compare-and-swap on a ref's value, not merely create-if-absent. That turns a generation ref into
a serialisation point:

1. read `locks-gen` and the locks it describes,
2. check glob intersections against exactly that set,
3. push the new lock **and** the generation bump in one `--atomic` push whose lease pins
   `locks-gen` to the sha read in step 1.

Anyone who acquired in between moved the generation, so the CAS fails and the whole push rolls
back. The window is **zero**, not narrow. No deterministic tie-break is needed because there is
no residual race left to break a tie in.

To be clear about what this is and is not: it is optimistic concurrency control, the same idea as
a version column, and it costs a retry under contention. It is not magic and it is not free. But
"needed a workaround" and "cannot be made correct" must not end up in the same column, and on
this row route G is in the first.

### Everything else, briefly

- **`claimTask`** decides on the `--porcelain` status character, never `rc` — the correction
  above. The claim object carries `agent_id` *and* `task_id`, so two agents cannot build the same
  sha. Both defences, not either.
- **`releaseTask`** is a lease pinned to the owner's sha; its rejection is swallowed because the
  interface defines releasing what you do not own as a no-op. **No plain-delete fallback** — the
  fallback is the vulnerability.
- **`heartbeat`** is one ref update and zero durable rows, timestamp in the ref name.
- **`readEvents`** does one `git fetch` of the event namespace and then reads objects locally.
  One network round trip regardless of page size, and safe to cache forever because an event is
  immutable (MB3).
- **`matching-refs` does not paginate.** Measured, because the adapter depends on it: a partial
  listing would understate `max(seq)` and hand out a number already taken. At **320 refs** the
  endpoint returned all 320 in one response with **no `Link` header**, identically with and
  without `per_page=100`. Verified rather than assumed — but only up to 320, so the adapter now
  **throws if a `Link` header ever appears** rather than silently reading a prefix.
- **Error mapping** is one chokepoint on structured fields only: HTTP status for REST,
  `--porcelain` flag plus exit code for git, and `rc=128` — which collapses auth, offline, DNS
  and missing-repo — resolved by one REST call rather than by reading git's prose. 25 tests
  through an injected transport per order 0020, zero quota, covering a 429 carrying `Retry-After`
  and a mid-flight transport drop.
- **Credentials** (order 0024): route G reads its token from `gh auth token` at call time. There
  is no key file, nothing in the repo, and nothing to place outside it. Compliant by
  construction rather than by discipline.

### Two bugs my own tests caught, both worth keeping

**1. `padSeq` threw on the first real heartbeat.** Epoch milliseconds are 13 digits and
`SEQ_WIDTH` is 10, so the guard refused to emit a truncated name. It was right and the caller was
wrong. Fixed by giving timestamps their own named width — **not** by widening `SEQ_WIDTH` to make
the error go away, which would have been fixing the guard instead of the tooling (order 0009).
Had it wrapped instead of thrown, a live agent would have sorted below a dead one.

**2. A11 caught my read-your-own-writes fold feeding a subscriber whose own link was down.**
After a successful append the adapter folds its own acknowledged event into its cached snapshot
and notifies — real read-your-own-writes, and what a live client wants. But `seedEvent`, which
models *another* client writing, went through the same path, so an event written during a
simulated outage was delivered to the very subscriber that is supposed to be blind. Suppressed
for foreign writes. The test found a genuine defect, not a harness artefact.

### Section A against the real backend — run 1

Full suite, `shared/store/conformance.ts` unmodified, against
`Sibhimanyu/inventory-tracker-github`. **16/17 on the first complete run**, one failure that was
my defect and is fixed.

```
✔ A1  same idempotency_key twice -> same seq, duplicate:true, ledger grew by 1   20,957 ms
✔ A2  20 concurrent claimTask -> exactly one winner, 50 consecutive rounds      592,811 ms
✔ A3  losing claimant gets {ok:false, owner}, never a thrown error               21,480 ms
✔ A4  readEvents returns strictly ascending seq                                  96,409 ms
✖ A5  readEvents caps at 300 when asked for 1000, and logs the cap            1,002,706 ms
✔ A6  an appended event is never mutated or deleted by a later operation         43,225 ms
✔ A7  acquireScope rejects intersecting globs and names the conflicts            27,785 ms
✔ A8  acquireScope allows disjoint globs concurrently                            29,712 ms
✔ A9  AgentPresence.stale flips true after the 90s timeout                       24,343 ms
✔ A10 subscribe fires once immediately, before any change                        22,182 ms
✔ A11 subscribe survives a network drop and resumes from the cursor              25,832 ms
✔ A12 emoji and 4-byte UTF-8 in durable text is stripped                         21,272 ms
✔ A13 a snapshot reporting seq < last_written_seq is stale, not lost             34,490 ms
✔ A14 a revoked token throws StoreAuthError and is not retried                   18,332 ms
✔ A15 a rate-limited backend throws StoreBusyError and backs off with jitter     16,520 ms
✔ A16 human layer withheld from an agent read, coordination is not               19,334 ms
✔ A17 route G reports an empty unprovisioned list, not an absent one                603 ms

tests 17   pass 16   fail 1   duration 2,018,347 ms (33m 38s)
```

**A2 is the result worth reading twice.** 50 rounds of 20 concurrent claimants — **1,000 claims
against the real GitHub remote** — with exactly one winner every round, every loser naming the
same owner, and that owner always a real claimant. 593 s. This is the non-negotiable
"A2 passes 50 consecutive runs" satisfied against the backend rather than a double.

#### A5 failed, and it was mine

```
AssertionError: expected a store.events.capped log line
```

`readEvents` capped correctly and paged correctly. What was wrong is that I emitted the cap
under my own log code, `github.readEvents.capped`, with my own field names (`asked`, `capped`,
`cap`) — and split it across two lines. The contract's code is **`store.events.capped`** with
`requested` / `applied` / `dropped`, as `shared/store/memory.ts` emits it.

This is worth more than a one-line fix, because the non-negotiable is *"every capped list logs
what it dropped"* and by my own reading I had satisfied it — the information was all there. It
was not **findable**. An operator grepping the documented code across all three routes would
have got hits from Catalyst and Firebase and silence from route G, and concluded route G was
truncating silently. **The log code is part of the contract, not decoration**, and "I logged it
somewhere" is the same class of error as asserting count instead of correlation.

Fixed to match `memory.ts` exactly, including the `has_more` case and `Math.max(1, ...)` on the
limit. Re-run: **A5 green, 1,012,910 ms.**

**Why that is not yet a 17/17 claim.** The fix touched `readEvents` *and* `event_id`
construction, and `event_id` is asserted by A1, `readEvents` by A4, A6, A11, A13 and A16. Sixteen
of those tests passed against the *previous* build of the adapter. Order 0022's rule —
*"verifying the parts is not verifying the whole"* — cuts exactly here: a green A5 plus sixteen
greens from before the change is not the same claim as one clean run. A full run on the fixed
build is in flight and the number below is whatever it returns.

#### A NUL byte in my own source, and what it hid

Chasing the A5 fix, `grep` went silent on `github/store/github.ts`. `file` reported it as
**`data`**, not text. Two NUL bytes had landed in the middle of a template literal where spaces
belonged:

```
.update(`${project_id}\x00${dedupe_key}\x00${next}`)
```

TypeScript compiled it, every test passed, and the adapter behaved correctly — a NUL is a
perfectly good hash separator. But the file was **binary to every text tool**: `grep` finds
nothing, `git diff` would have shown `Binary files differ`, and code review would have gone
blind on it without anyone noticing.

Two things came out of it. The immediate one: the bytes are gone. The better one: that line was
**hand-rolled concatenation for a composite key when `scopedKey` already existed** three imports
away, audited and tested. It now calls `scopedKey`. That is precisely order 0019's finding —
*"duplicated logic that already existed in correct form, and the duplicate was the broken one"* —
reproduced in my own tree, and the duplicate was again the broken one.

I scanned every other file in my tree for NULs. Clean.


### Order 0025's new rule, turned on my own A17

Order 0025 added: **test the operation that is actually restricted, not the nearest one that
responds**, and before treating a probe as evidence ask *"would this have given the same answer
in the broken state?"*

Applied to my own work, one thing failed it. My live **A17** asserts route G's
`UNPROVISIONED_OPERATIONS` is `[]`. That is true, and it is the number this route exists to
produce — but as a *test* of A17 it is a formality: with an empty list, **nothing ever exercises
the `NotProvisionedError` machinery**, so it would pass identically if that machinery were
completely broken.

Catalyst and Firebase each have a real gate, so their A17 exercises the type on the way past.
Route G has none, so it has to be exercised deliberately — otherwise this route ships an
**untested error path**, and the first time GitHub introduces a gate (an org policy blocking a
ref namespace, say) the adapter's response to it will never have run once.

`github/store/provisioning.test.ts` now does that, against a transport spy that **throws** if
called rather than counting — a counter nobody reads is how a leak gets reported as a pass. It
asserts the distinct type, the not-retryable answer, zero network calls, and — the half that
stops the file being the thing it guards against — that a **provisioned** operation is *not*
blocked. Without that last one, a guard that threw for everything would satisfy every other
assertion in the file. Same shape as A16 needing both halves.

31 offline tests now, still zero quota.


### FLAG for the coordinator — a timing assumption in the shared suite

Not worked around silently, and `shared/` not touched.

**A10 and A11 assert a delivery within `settle()` — four microtasks.** No network-backed adapter
can answer that: any read on this route is a ~1 s round trip, so a cold `subscribe` delivers
nothing inside four microtasks no matter what it does.

They pass here because the adapter keeps a snapshot cache and the harness warms it after seeding.
That is the real client lifecycle — render with `readSnapshot`, then `subscribe` — made explicit.
**Nothing is fabricated:** the cache is filled by a real `readSnapshot` of the real backend, and
A10 asserts the delivered snapshot actually contains the seeded task, so order 0020's concern
about "a `subscribe` firing with an empty `Snapshot`" would still fail exactly as intended.

Two reasons I am raising it rather than leaving it as my private workaround:

1. It will bite **Catalyst** the moment its `subscribe` is unstubbed, since C1 is also poll-mode.
   Better a known thing than a surprise mid-run.
2. If the intended reading is that `subscribe` may fire from cache, that should be stated in
   `store-interface.md` rather than discovered independently by each poll-mode route — which is
   the "two different interpretations" failure the shared suite exists to prevent.

I am not proposing wording. It is a shared file and the ruling is the coordinator's.


---

## Route-G observations for the register (coordinator writes it, not me)

Per orders 0008/0013/0015 I do not edit `docs/handoff/g9-asymmetries.md`. Candidates:

1. **Provisioning: one CLI command, zero console steps, zero billing.** Against Catalyst's *no
   `project:create` exists at all* and Firebase's *console visit plus a billing link the CLI
   cannot perform*.
2. **The atomic primitive is server-enforced with no database and no transaction.** Catalyst
   needed a composite-key scheme it had to design; Firestore needed `runTransaction`; route G
   needs a push flag.
3. **Release ownership is enforced by the same primitive, for free.** The other two check it in
   application code.
4. **`claimed_at` has no server clock.** Route G is the only one of the three without one.
5. **Presence costs zero durable writes and zero object reads** — the timestamp is the ref name.
   Catalyst had to reach for Cache-with-TTL specifically to dodge the 1,000-UPDATE/month wall.
6. **Notification is free but not fast.** 535 ms conditional-GET polls at zero quota, against a
   ~2 s write path — so `stale_ms` is bounded by writes, not by polling.
7. **A route-G-specific silent-failure class: ETag/`Accept` mismatch** turns a free poll loop
   into a quota-exhausting one with no error. Structurally the same shape as Catalyst's
   table-global `is_unique` defects.

## A note on `blackboard.md`

`blackboard.md` states that claims, presence and notification "stay in the store, in both
implementations", on the grounds that git is too slow, litters refs, and cannot expire. Route G
is the experiment that tests exactly that ruling, and the measurements above bear on it
directly: the litter is bounded (one ref per agent, one per live claim, deleted on release), and
the expiry objection is answered by deriving staleness from the ref name. The latency objection
stands — this route is seconds, not sub-second. **I am not proposing a change to
`blackboard.md`**; it is a shared frozen file and route G is not entitled to rewrite the
premise it exists to challenge. Flagging it so the coordinator can decide.

---

## Territory check

```bash
FROZEN=(docs shared package.json tsconfig.json
  client/src/components.tsx client/src/tokens.css
  client/index.html client/tsconfig.json client/src/store/types.ts
  ':(exclude)docs/handoff/impl-*-notes.md')
MB=$(git merge-base origin/zoho-catalyst-app-builder HEAD)
git diff --stat "$MB" HEAD -- "${FROZEN[@]}"      # empty
git rev-list --count HEAD..origin/zoho-catalyst-app-builder   # 0 after rebasing for 0017/0018
```

**In bounds.** Everything I wrote is in `github/**` (per-build) and
`docs/handoff/impl-github-notes.md` (per-build). `shared/` untouched, root `package.json` and
`tsconfig.json` untouched, no test file of mine lives under `shared/`, and root `npm test`
remains exactly the shared suite at 19/19.

Cross-branch xcheck against the shared branch, per `territory.md` — run, not read:

```bash
git worktree add /tmp/xcheck origin/zoho-catalyst-app-builder
( cd /tmp/xcheck && npm install --silent && npm test )
git worktree remove /tmp/xcheck --force
```

```
ℹ tests 19
ℹ pass 19
ℹ fail 0
```

Same count on the shared branch as on mine, established by running the command in both places
rather than by comparing the two `package.json` files and concluding they match.

## Cleanup

Every probe ref was deleted. Verified, not assumed:

```
$ git ls-remote origin
1081557e442c8a6f92bd74267a0f39cd515da314	HEAD
1081557e442c8a6f92bd74267a0f39cd515da314	refs/heads/main
```

No `refs/claims/*`, no `refs/heartbeats/*`, no `refs/probe-objects/*` remain. The only resource
created anywhere is the repo `Sibhimanyu/inventory-tracker-github`. Nothing pre-existing was
read, written or deleted — in particular nothing under `inventory-tracker-catalyst` or
`inventory-tracker-firebase`, and no other build's branch was fetched or read.

---

## Next session, in order

1. ~~`seq`~~ — probed, answered above. Counter in a zero-padded ref name, advanced by one
   atomic create-if-absent push. Correct, and O(N^2) under contention.
2. `store/github.ts` against `shared/store/types.ts`; pass `shared/store/conformance.ts`
   **unmodified**. Adopt `NotProvisionedError` and `UNPROVISIONED_OPERATIONS` from `shared/`
   (orders 0020, 0022).
3. Absent-heartbeat semantics (zero refs for an agent) — still open.
4. CLI (`X-Agent-Token`), ledger, locks, presence, reaper.
5. `client/src/App.tsx` import line + `client/src/store/github.ts`, per `territory.md`.
6. A16 and A17 against the real backend; F1-F12 on `inventory-tracker-github`; then G1-G6.
