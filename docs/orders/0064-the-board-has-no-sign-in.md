---
order:    0064
to:       firebase
issued:   2026-09-16
blocking: yes
---

# The board signs in anonymously and has no sign-in. Your projects can never appear.

The user created a real project. The data is correct — I checked Firestore directly:

```
projects/proj_inventory_tracker   name "Inventory Tracker"  repo Sibhimanyu/inventory-tracker
  members/X1syxqJZaoNxxeVclsxZedI4SJK2   role=owner  uid=X1syx…  revoked=false
```

Member doc id equals the uid, the `uid` field is present, `revoked` is false. Everything the
collection-group query and rule need.

**The board still shows "No projects yet — 0".**

## Cause

`client/src/store/firebase.ts:206`:

```js
const cred = await signInAnonymously(this.auth);
```

**The board always signs in anonymously**, and `App.tsx` contains no sign-in affordance — zero
mentions. So the browser is a throwaway uid that is a member of nothing, while the project belongs
to `sibhi.gv@gmail.com`. The two identities can never meet.

We built `/login` for the CLI and never gave the board one.

## Build

1. **Google sign-in on the board.** Reuse `Login.tsx`'s provider handling — do not write a second
   one, or the two will drift the way `STALE_AFTER_MS` did before it was consolidated.
2. **Anonymous stays available**, because the denied-state onboarding path depends on it and is
   already asserted in the edge harness. It must be a **choice**, not the silent default.
3. **Persist the session.** `Login.tsx` uses `inMemoryPersistence` deliberately — a page authorising
   a terminal should leave nothing behind. **The board is the opposite**: signing in on every reload
   is wrong. Different pages, different correct answer; make that explicit in a comment so nobody
   "fixes" one to match the other.
4. **Show who you are** in the top nav, with a way out. A board that cannot tell you which account
   it is showing is how this bug survived.

## The test that would have caught it

Assert the board, signed in as a uid that **is** a member, renders the project — **and** that the
same board as a different uid renders the empty state. Both halves.

Every existing test seeded the fixture against whatever uid the harness used, so the two were always
the same identity and the mismatch was unreachable. **That is the defect in the test design, not a
missing case.**

## Note the shape

Third time in this project: `is_unique` was going to give atomic claims, the conformance suite was
going to prove the adapter, and the board was going to show your projects. Each was plausible,
written down, and only a real run found it. The user creating one real project surfaced in two
minutes what ~400 assertions could not.
