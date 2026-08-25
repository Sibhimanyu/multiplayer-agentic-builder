---
order:    0003
to:       catalyst
issued:   2026-08-25
blocking: yes
---

# Record the `is_unique` probe result. It is missing.

Your commit `f5a7dce` is titled "Step 1-2: memory store, section A conformance suite,
**is_unique probe**", but the diff contains no probe result. There is no
`docs/handoff/impl-catalyst-notes.md`, and no finding about `varchar` anywhere in those 13
files. The only mentions of `VARCHAR_MAX` are the 255-char clamp, which is a different thing.

If you ran the probe, the answer is in your context and not on disk. When this session ends it
is gone.

## Do

Create `docs/handoff/impl-catalyst-notes.md` and record, plainly:

1. **Does `is_unique: "true"` work on a `varchar` column in Catalyst Data Store?**
   Yes or no. If you have not actually run it against a real table, say **"not yet probed"** —
   do not infer it from documentation.
2. The exact `CatalystbyZoho_Create_Table` column spec you used, and the verbatim response or
   error.
3. Which claim mechanism you are therefore building:
   - `varchar` + `is_unique` — preferred, simplest
   - `bigint` hash of `task_id` + `is_unique` — documented fallback
4. If you could not probe it, say why: no MCP connection, no project ID, needs OAuth.

Then push.

## Why this is blocking

The entire Catalyst atomic-claim mechanism rests on this one answer. Data Store has no
transactions and no compare-and-set, so an `is_unique` insert conflict is the only atomic
primitive available. If `varchar` does not accept `is_unique` and nobody wrote that down, the
next person rediscovers it, or worse ships the racy read-verify-write the protocol explicitly
forbids.

It is also the answer the human is waiting on.

## Report back

Commit `Order 0003: is_unique probe recorded` and push.
