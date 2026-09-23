// validateRoleScope: the only check between an owner and a role's file fence.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateRoleScope } from './write-api.ts';

test('a normal scope is accepted, trimmed and de-duplicated', () => {
  assert.deepEqual(validateRoleScope('backend', [' server/** ', 'test/**', 'server/**']), { ok: true, globs: ['server/**', 'test/**'] });
});

test('owner and user scopes are not editable', () => {
  assert.equal(validateRoleScope('owner', ['server/**']).ok, false);
  assert.equal(validateRoleScope('user', ['server/**']).ok, false);
});

test('an unknown role is refused', () => {
  assert.equal(validateRoleScope('backend-builder', ['server/**']).ok, false);
});

test('empty, non-list and oversized scopes are refused', () => {
  assert.equal(validateRoleScope('backend', []).ok, false);
  assert.equal(validateRoleScope('backend', 'server/**').ok, false);
  assert.equal(validateRoleScope('backend', ['']).ok, false);
  assert.equal(validateRoleScope('backend', Array.from({ length: 21 }, (_, i) => `d${i}/**`)).ok, false);
});

test('negations, absolute paths and .. are refused', () => {
  for (const g of ['!server/**', '/etc/**', 'server/../secrets/**', '../**']) {
    assert.equal(validateRoleScope('backend', [g]).ok, false, g);
  }
});
