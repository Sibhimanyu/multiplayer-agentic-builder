// The role pack: what a role may edit, and what it may not. Order 0084.
//
// WHY THIS FILE EXISTS. A live agent opened AGENTS.md, found
//
//     You may edit:      **
//     You may not edit:  **
//
// on adjacent lines, called it "a template artifact", and picked which line to believe. It
// guessed right. Nothing in the repository would have caught it: the two lists came from two
// different sources -- the allow list from the shared role table, the deny list from a prose
// table in the CLI with no `owner` key -- and no test had ever compared them to each other.
//
// The guard is the INTERSECTION, across every role, because that is the property that was
// broken rather than the one instance of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rolePackFor } from './index.ts';
import { ROLE_SLUGS, roleFor } from '../shared/store/directory.ts';
import type { WhoAmI } from './client.ts';

const who = (role_slug: string): WhoAmI => ({
  agent_id: 'a1',
  role_slug,
  project_id: 'p1',
  permissions: {
    push_branches: true, open_prs: true, merge: false, publish_contracts: false,
  },
} as WhoAmI);

test('no role both allows and forbids the same glob', () => {
  // The control FIRST: an empty slug list would pass every assertion below.
  assert.ok(ROLE_SLUGS.length >= 5, `expected the real role set, got ${ROLE_SLUGS.length}`);
  for (const slug of ROLE_SLUGS) {
    const pack = rolePackFor(who(slug));
    const both = pack.may_edit.filter((g) => pack.may_not_edit.includes(g));
    assert.deepEqual(both, [], `${slug} both allows and forbids: ${both.join(', ')}`);
  }
});

test('a role that may edit everything forbids nothing', () => {
  // The exact case that shipped broken. `owner` has no entry in the CLI's prose table, so it
  // fell through to a default of `not: ['**']` while its allow list came from the shared table
  // as `['**']`.
  const owner = rolePackFor(who('owner'));
  assert.deepEqual(owner.may_edit, ['**']);
  assert.deepEqual(owner.may_not_edit, [], 'an unscoped role cannot forbid anything');
});

test('a role that may write somewhere is never told it may write nowhere', () => {
  // THE INTERSECTION TEST DOES NOT CATCH THIS. `**` is not literally in `['client/**']`, so a
  // deny list containing `**` passes it -- and the first version of the fix shipped exactly that:
  //
  //     You may edit:      client/**
  //     You may not edit:  **, contracts/**, schema/**, ...
  //
  // The second line denies the first. `**` is the absence of a scope, not a directory a role
  // owns, so it may only appear when the allow list is empty.
  for (const slug of ROLE_SLUGS) {
    const pack = rolePackFor(who(slug));
    if (pack.may_edit.length === 0) continue;
    assert.ok(!pack.may_not_edit.includes('**'),
      `${slug} may edit ${pack.may_edit.join(', ')} and is also told it may edit nothing`);
  }
});

test('a scoped role is told about the scopes it does NOT hold', () => {
  const fe = rolePackFor(who('frontend'));
  assert.deepEqual(fe.may_edit, roleFor('frontend').file_scope);
  assert.ok(fe.may_not_edit.length > 0, 'a scoped role has somewhere it may not write');
  // Derived from the other roles' real scopes, so it cannot name a directory no role owns and
  // cannot go stale when a role's scope changes.
  const everyOtherScope = new Set(
    ROLE_SLUGS.filter((r) => r !== 'frontend').flatMap((r) => roleFor(r).file_scope),
  );
  for (const g of fe.may_not_edit) {
    assert.ok(everyOtherScope.has(g), `${g} is forbidden but belongs to no other role`);
  }
  assert.ok(fe.may_not_edit.includes('functions/**'), 'the backend scope must be named');
});

test('an unknown role may write nothing, and is told so without contradiction', () => {
  // Least privilege on a typo'd slug. Here `**` in the deny list is correct and not a
  // contradiction, because the allow list is empty.
  const unknown = rolePackFor(who('nonexistent-role'));
  assert.deepEqual(unknown.may_edit, []);
  assert.deepEqual(unknown.may_not_edit, ['**']);
});

test('the deny list is the other roles PROJECT fences when the backend sends them', () => {
  const me = {
    ...who('backend'),
    file_scope: ['server/**', 'test/**'],
    role_scopes: { backend: ['server/**', 'test/**'], frontend: ['web/**'], qa: ['test/**'] },
  } as WhoAmI;
  const pack = rolePackFor(me);
  assert.deepEqual(pack.may_edit, ['server/**', 'test/**']);
  assert.ok(pack.may_not_edit.includes('web/**'), 'the project frontend fence is named');
  assert.ok(!pack.may_not_edit.includes('client/**'), 'the template frontend fence is not');
  assert.ok(!pack.may_not_edit.includes('test/**'), 'and nothing I may edit is forbidden');
});
