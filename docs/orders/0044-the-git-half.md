---
order:    0044
to:       firebase
issued:   2026-09-14
blocking: yes
---

# F4, F6, F7 — the git half. It is the last thing that does not need the console.

F5/F11/F12 pass on ledger evidence, 13/13. **The product is now called Drydock** (decision 0002) —
the UI brand is renamed; repo, branches and project ids deliberately keep their names, because they
are live infrastructure and the comparison record has to stay readable.

Your stampede guard is recorded as entry 62. Three parts of it earned that: **the lease is
`claimTask` itself** rather than a second primitive; **liveness is the holder's presence, not lease
age**, because age cannot distinguish a live long-held lease from a dead short-held one; and
**excluding the lease from what the sweep reports** — without which a holder whose heartbeat blipped
could reap its own lease mid-sweep and cause the exact stampede the guard prevents. That last one is
a self-referential bug found by design rather than by failure.

Also right, and not asked for: asserting the **ledger** rather than return values in F5, asserting
`actor_type: 'system'` in F11, asserting `seq` *ordering* in F12, and backdating only the agent's
last-seen while **leaving the reaper's own clock real** — the one thing a dead laptop actually
changes. And the negative control that gave each bridge its own lease, proving the `1` was the guard
and not four silently-broken bridges.

Declining F4/F6/F7 rather than half-running them was the right call. Take them now.

## The work: the blackboard path, end to end

This is **the git half of the architecture** and it has never been built on this route. Decision 0001
made git the durable store; so far only the coordination half exists.

- **F4** — the architect publishes a schema and `items-api v1`, then exits. Evidence: `git log`.
- **F6** — the backend publishes `items-api v2`, **breaking** (`qty` string → integer). Evidence:
  `git log`.
- **F7** — the frontend receives the pointer, **reads the contract from disk**, and reports blocked.
  Evidence: `inbox.jsonl` **and** the ledger.

### The rules that make this the blackboard and not a shared file

From `docs/reference/blackboard.md`, and they are load-bearing:

1. **One file per fact. Never a shared append-only markdown file.** This is what makes merges purely
   additive and conflicts structurally impossible. If you take one thing from that document, take
   this.
2. **Versions are new files, never edits.** `contracts/items-api.v2.yaml` beside `v1`. Editing v1 in
   place destroys the diff that tells a blocked consumer what broke — which is the single most
   valuable thing F7 needs.
3. **The CLI commits, never the agent.** The agent writes a file into the working tree and appends
   `contract_published` naming it; the bridge commits, pushes, and **rewrites the event body as a
   pointer** carrying `commit_sha`. The agent never handles a sha.
4. **`body.local` is populated before the inbox line is appended** — the bridge has already fetched
   the blob to disk, so the agent opens a file and never makes a network call. F7 is precisely the
   test of this: *reads the contract from disk*.
5. **Push rejection retries with `git pull --rebase`**, up to 3. Because it is one file per fact, the
   rebase cannot conflict.

### Carry the git lessons route G paid for

- **Every git child gets a deadline.** A wedged `git send-pack` with no timeout hangs a daemon
  forever while it looks healthy and publishes nothing.
- **Never sleep on an injected clock in a transport path.** A `FakeClock` that nobody advances turns
  one transient socket error into a permanent hang, which presents as a load-dependent *hang* rather
  than a failure.
- Route G measured `git push` at **~1.5 s** and `git ls-remote` at **1,347 ms**. Do not poll git. The
  store is the doorbell; git is the warehouse.

## Standing rules

- Assert the **artifact**, not the return value. F5 set the standard; hold it.
- **A control that never fires has not been run.** Scale it until it registers.
- `--test-concurrency=1`, always through `scripts/emul-suite.mjs`.
- `attempts` stays 6 and `cap_ms` stays 2,000 unless something here gives a stated reason to change
  both together.

## After this

**F1–F3 and F8–F10 are all that remain, and every one of them needs the console.** When F4/F6/F7
land, this route has done everything it can without the user.
