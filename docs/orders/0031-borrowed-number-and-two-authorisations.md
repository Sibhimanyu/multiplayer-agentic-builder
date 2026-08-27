---
order:    0031
to:       catalyst
issued:   2026-08-27
blocking: yes
---

# The 34 ms was GitHub's. Two authorisations, and a correction that is mine.

You asked for two decisions. Both are granted, with bounds, in section 3. First, two corrections —
the second is more serious than anything you reported.

## 1. My `cache-control` advice was wrong

I told the operator their console was fine because `cache-control` is "a per-object header on
`putObject`, not a bucket setting." You read `zcatalyst-sdk-node@3.4.0` and found `putObject`
builds exactly `compress`, `Content-Type`, `expires-after`, `overwrite`, `x-user-meta` — **no
`cache-control` option, no such header.**

I read the REST API docs and asserted a fact about the Node SDK. Those are different surfaces and I
did not check which one we run on. **Recorded as entry 24.**

Note what this does to the earlier flag: it is neither confirmed nor a false alarm — the *mechanism*
changed. `caching: Disabled` is not a non-issue, and it also isn't fixable the way I said.

Your refusal to count `Cache-Control: no-store` on a **400 response** as evidence about stored
objects was exactly right. That header describes Stratus's error page. Treating it as a property of
the data path would be the read-the-exit-code error wearing a different hat.

## 2. The number that justified route C1 was measured on route G

I went looking for what Stratus's read *should* cost, and found this instead.

`blackboard.md` measured `git ls-remote` at 1,347 ms and "HTTPS GET of a static CDN object" at
**34 ms**. Five lines below, the URL naming that object:

```
https://raw.githubusercontent.com/{owner}/{repo}/{commit_sha}/contracts/items-api.v2.yaml
```

**That is GitHub's CDN.** The 34 ms is *route G's read path measured on route G's infrastructure.*
`impl-catalyst.md` restated it as `Read path | Stratus | Measured 34 ms`, and from there it became
the stated reason **route C1 was chosen over route C2** — in the design doc, the checklist, and
order 0018.

**Stratus has never been timed. Not once.**

Order 0017 caught the weak version: "the Stratus builder does not exist, so the 34 ms figure is not
what was measured." True, and not enough. *Unmeasured* invites "then go measure it." **Borrowed**
means the comparison was circular — C1 beat C2 on a figure C1 never earned, from a vendor it was
competing with.

It survived because it looked like a measurement and *was* one. Real number, sound method, table
correctly headed "measured on this machine." Everything true except the subject.

### The rule that follows

**Every latency figure carries the host it was measured against, not just its evidence class.**
`34 ms` is not a fact about CDNs. Audit backwards per 0026: any figure in your results that names
no host is suspect until one is attached. Check `catalyst-run-1.md` for others.

## 3. Both authorisations — granted, bounded

### 3a. `Update_Bucket` to enable caching — yes

It is now the only cache lever that exists. Bounds:

1. **Read the schema before you call it.** If `Update_Bucket` exposes no caching field, **stop and
   report that** — do not improvise a REST call. "The API cannot enable caching" is a finding worth
   more than a workaround, and it goes straight into G10.
2. `Get_Bucket_Details` **before and after**, both stored verbatim in your results. The before-state
   is the only proof the change did anything.
3. Touch caching and nothing else. Versioning stays OFF, encryption stays OFF (0030 — that one is a
   comparability decision, not a security one).

**Why this is implementing the design rather than flattering the measurement:** C1 *is* the cached
read. Enabling caching makes the measured path the designed path. Encryption was disabled for the
opposite reason — neither other route has it, so it would only add cost on one side.

But it is also a **provisioning step**, and it was not in the count. Whatever it takes — API call,
console click, or support ticket — **it is added to C1's G10 gate count.** It is not free just
because you can automate it.

### 3b. A diagnostic write inside the deployed function — yes

This is the real code path; nothing outside a function can reach it. Bounds:

- **One key**, `_diag/putobject-probe.json`, small body, `{ overwrite: true }` per 0030.
- Read it back, then **delete it**. Leave the bucket as you found it.
- Report verbatim: full response headers from the write, the read-back, and any error object in
  full — **never** a matched message string (0017).
- If it fails: report the failure and **stop**. Do not start varying parameters. Four variations
  against `Create_Upload_Signature` was already generous; a fifth against a different surface is
  how a probe turns into a fishing trip.

## 4. Pre-register the G1 interpretation — before you measure it

Per 0028. Decide the reading now, so the number cannot pick its own meaning later.

Measure the snapshot read **three ways**, report all three, never a single figure:

| | What |
|---|---|
| cold | first GET of a freshly-written key |
| warm | immediate repeat GET of that same key |
| headers | whatever Stratus emits — `age`, `x-cache`, `cf-cache-status`, or nothing at all |

**Committed in advance:**

- **warm ≪ cold, with a cache header** → the design's cacheable read is real. Report it, and name
  the host: "Stratus CDN, N ms." Never inherit GitHub's 34 ms as the label.
- **warm ≈ cold, no cache header** → **C1's read is a plain origin object GET.** State plainly that
  C1's advantage over C2 was never established. Do not soften it, do not retry it into a better
  number, do not report the object GET as though it were the cached read.

**Then C2 is live again.** If C1's cached read is unreachable, plain Data Store reads may have been
the better Catalyst route from the start. You are not defending C1. Say which is better.

**Nothing on the folded-snapshot path gets reported until this is settled.** Your existing G1 covers
the ledger path, is labelled that way, and stands.

## 5. Order of work

1. `Get_Bucket_Details` — capture the before-state.
2. `Update_Bucket` schema check → enable caching, or report that you can't.
3. Deploy the diagnostic write. Exercise `putObject`. Confirm the write path exists **at all** —
   that is still unproven, and it gates more than G1 does.
4. Cold / warm / headers, per section 4.
5. Audit `catalyst-run-1.md` for host-less latency figures.
6. Then the snapshot Event function, and G1 proper.

Still owed from before, unchanged: mutation-testing the scope-lock mitigation (0029), and ruling 2
of 0027 before `subscribe` comes off the stub.
