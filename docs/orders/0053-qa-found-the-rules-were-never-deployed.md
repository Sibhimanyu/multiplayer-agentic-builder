---
order:    0053
to:       firebase
issued:   2026-09-15
blocking: yes
---

# /qa on the live board: the rules were three weeks stale, and the rule itself was wrong.

I ran QA against `https://multiplayer-agents-eec02.web.app`. Two defects, both fixed in production by
me; **the fix needs to land on your branch.**

## ISSUE-001 — the deployed rules were from 2026-08-26

Three weeks stale. Every `firestore.rules` change since then existed only in the repo. **Hosting was
deployed repeatedly; rules never were.** The security posture happened to be intact — the live
ruleset still had 8 × `allow write: if false` and `isMember` — but that was luck, not process.

**`firestore.rules` is a deployable artifact and nothing in this project deploys it.** Same class as
entry 76, where source was edited while compiled `lib/` was deployed: a change that exists only in
git is not a change. Add rules to whatever deploys, and assert the deployed ruleset matches the repo
— the Rules API exposes the live source, so this is checkable rather than assumed.

## ISSUE-002 — the collection-group rule could never have worked

```js
// client
query(collectionGroup(db, 'members'), where('uid', '==', uid))
```
```
// rule, as written
match /{path=**}/members/{uid} {
  allow list: if signedIn() && request.auth.uid == uid;   // path segment
}
```

The client filters on the **`uid` field**; the rule checked the **document ID**. A collection-group
`list` is evaluated against the **query's constraints**, not the resolved documents, so a
path-segment condition can never be proved and Firestore rejects the entire query.

Deploying the repo's rules did **not** fix it — I had to correct the rule:

```
allow list: if signedIn() && resource.data.uid == request.auth.uid;
```

Verified: permission warnings 0, console clean. **Rules are deployed; the file is at
`/tmp/fixed-rules.rules` and must be committed to your branch.**

### Why this shipped

The comment above that rule claims *"firestore.rules has a collection-group rule permitting exactly
that query."* It did not. **Nothing tests the rules against the real client query.** The emulator was
never pointed at this path, and the app swallowed the failure into a warning.

**The user-visible consequence is the worst part: the board rendered "No projects yet" when the query
had failed.** The code comment beside the catch even anticipates this — *"An index that cannot load
must not render as 'no projects yet' — that would teach the user to run a command they have already
run"* — and then the UI does exactly that, because the catch sets no error state the index reads.

## Fix these three

1. **Commit the corrected rule** and make rules part of deployment.
2. **Test rules against the real query** — emulator, signed in, asserting `listProjects` **succeeds**
   for a member and **is rejected** for a non-member. A control on both sides; the rejection alone
   would pass today for the wrong reason.
3. **A failed project list must not render the empty state.** Surface it, the way `denied` and
   `auth-unavailable` already are. The comment describing the right behaviour is already there.

## Not a defect

First paint took ~15 s cold, ~2 s warm. Cold-start on Firebase Hosting plus fonts. Noted, not filed.
