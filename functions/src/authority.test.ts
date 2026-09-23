// The role packs the server resolves permissions from. No emulator: this is a pure table.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_ROLES, ROLE_SLUGS } from '../../shared/store/directory.ts';
import { ROLE_PACKS } from './authority.ts';

test('every real role slug has a role pack', () => {
  // Control: the scan below must have something to scan.
  assert.ok(ROLE_SLUGS.length >= 6, 'ROLE_SLUGS is unexpectedly short');
  for (const slug of ROLE_SLUGS) assert.ok(ROLE_PACKS[slug], `no role pack for ${slug}`);
});

test('no role pack is keyed on a slug that does not exist', () => {
  for (const key of Object.keys(ROLE_PACKS)) {
    assert.ok((ROLE_SLUGS as readonly string[]).includes(key), `stale role pack key ${key}`);
  }
});

test('the owner can push and open PRs', () => {
  assert.equal(ROLE_PACKS.owner.push_branches, true);
  assert.equal(ROLE_PACKS.owner.open_prs, true);
  assert.equal(ROLE_PACKS.owner.publish_contracts, true);
});

test('a user seat can do none of it', () => {
  assert.deepEqual(ROLE_PACKS.user, { push_branches: false, open_prs: false, merge: false, publish_contracts: false });
});

test('packs follow the shared capabilities, both ways', () => {
  for (const slug of ROLE_SLUGS) {
    const caps = DEFAULT_ROLES[slug].capabilities;
    assert.equal(ROLE_PACKS[slug].open_prs, caps.includes('open_pr'), `${slug} open_prs`);
    assert.equal(ROLE_PACKS[slug].publish_contracts, caps.includes('publish_contract'), `${slug} contracts`);
    assert.equal(ROLE_PACKS[slug].push_branches, caps.includes('acquire_scope'), `${slug} push`);
  }
});

test('no role pack grants merge', () => {
  for (const [slug, pack] of Object.entries(ROLE_PACKS)) assert.equal(pack.merge, false, slug);
});
