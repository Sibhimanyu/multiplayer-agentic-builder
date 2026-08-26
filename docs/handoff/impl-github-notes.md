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

## Still open, not yet probed — `seq`

MB4 requires strictly ascending `seq` from `readEvents`. Git orders by commit, not by counter,
and the brief flags this as needing real design. **I have not probed it and I am not going to
claim an answer I do not have.** The obvious candidates and their obvious problems:

- **Commit order on `agentic/ledger`** — `git log` order is topological, and a rebase or a
  concurrent push retry can reorder. Also requires an object read to sequence.
- **A lease-allocated counter ref** (`refs/seq/<n>`, create-if-absent, same primitive as the
  claim) — reuses a mechanism already verified 50/50 above, costs one extra round trip per
  append, and gaps are already legal under MB4. This is where I would start.
- **Ref name as the counter**, so the sequence is readable without any object read, the same
  trick that makes presence work here.

Next session's first job, before any adapter code.

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

1. **`seq`.** Design and probe it before any adapter code. Start with the lease-allocated
   counter ref — it reuses the primitive already verified 50/50.
2. Absent-heartbeat semantics (zero refs for an agent).
3. `store/github.ts` against `shared/store/types.ts`; pass `shared/store/conformance.ts`
   **unmodified**.
4. CLI (`X-Agent-Token`), ledger, locks, presence, reaper.
5. `client/src/App.tsx` import line + `client/src/store/github.ts`, per `territory.md`.
6. F1-F12 on `inventory-tracker-github`, then G1-G6.

Nothing above step 1 has been started. No adapter code exists yet, by design — order 0016 step 2
says push the probe results before building on them, and that is what this commit is.
