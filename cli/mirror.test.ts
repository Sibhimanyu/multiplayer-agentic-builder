// The client's mirrored role table must agree with the server's, exactly.
//
// WHY A MIRROR EXISTS AT ALL: the client build deliberately never imports from `shared/`, so
// `client/src/store/directory-types.ts` restates the role slugs and the capability table. It is
// documented as cosmetic -- the server is what enforces -- but "cosmetic" is not "harmless". A
// drifted mirror shows a member a button their role cannot use, or hides one it can, and the only
// symptom is a person quietly believing the product does not do something.
//
// It HAD drifted. Order 0089 gave backend, frontend and qa the `triage` capability on the server
// and the mirror kept the old list, so three roles would have been shown no way to pick a
// suggestion up. The typechecker only caught it because the same change renamed a key; the
// capability drift itself was invisible.
//
// THROUGH hasCapability, NOT THE TABLE. That function is what the board calls, and the table is
// private to the module. Testing the exported behaviour needs no new exports and cannot pass
// because two internals happen to look alike.
//
// A test may import both sides even though the bundle must not: this runs in node.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasCapability as mirrorHas, type RoleSlug as MirrorSlug } from '../client/src/store/directory-types.ts';
import { DEFAULT_ROLES, ROLE_SLUGS, hasCapability as serverHas } from '../shared/store/directory.ts';

/** Every capability that exists, derived from the roles rather than restated. */
const ALL_CAPS = [...new Set(ROLE_SLUGS.flatMap((s) => DEFAULT_ROLES[s].capabilities))].sort();

test('the two sides agree for every role and every capability', () => {
  // CONTROL FIRST: an empty role list or an empty capability list would pass every loop below.
  assert.ok(ROLE_SLUGS.length >= 5, `expected the real role set, got ${ROLE_SLUGS.length}`);
  assert.ok(ALL_CAPS.length >= 6, `expected the real capability set, got ${ALL_CAPS.join(',')}`);

  const disagreements: string[] = [];
  for (const slug of ROLE_SLUGS) {
    for (const cap of ALL_CAPS) {
      const server = serverHas(slug, cap);
      const mirror = mirrorHas(slug as unknown as MirrorSlug, cap as never);
      if (server !== mirror) {
        disagreements.push(
          `${slug}/${cap}: server=${server} mirror=${mirror}` +
          (server ? ' (the board hides an action the role HAS)' : ' (the board offers one the server REFUSES)'),
        );
      }
    }
  }
  assert.deepEqual(disagreements, [],
    `the board and the server disagree:\n  ${disagreements.join('\n  ')}`);
});

test('an unknown role is the same nothing on both sides', () => {
  // A typo in a role name must not grant anything, and must not grant DIFFERENT nothings: the
  // board would then offer an action the server refuses, which reads as a bug in the server.
  for (const cap of ALL_CAPS) {
    const server = serverHas('nonexistent-role', cap);
    const mirror = mirrorHas('nonexistent-role' as unknown as MirrorSlug, cap as never);
    assert.equal(mirror, server, `unknown role disagrees on ${cap}`);
  }
  // And that fallback is the user seat: one capability, deliberately.
  assert.deepEqual([...DEFAULT_ROLES.user.capabilities], ['suggest']);
  assert.equal(serverHas('nonexistent-role', 'claim'), false);
});
