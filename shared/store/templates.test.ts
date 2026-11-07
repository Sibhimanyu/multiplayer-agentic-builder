// Templates, seats, and roleFor reading a project's role document. Shared sessions, piece 1.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { DEFAULT_ROLES, RoleDeniedError, hasCapability, isRoleSlug, roleFor } from './directory.ts';
import { assertScopeAllowed } from './roles.ts';
import {
  CONTRIBUTOR_CAPABILITIES,
  PROJECT_TEMPLATES,
  isProjectTemplate,
  seatCapabilities,
  seatSlug,
  templateRoles,
} from './templates.ts';

// ---- templates -------------------------------------------------------------------------------

test('the web template is exactly the six default roles, so no existing project changes', () => {
  assert.deepEqual(templateRoles('web'), Object.values(DEFAULT_ROLES));
});

test('every template has an owner and a user seat, and nothing else is reserved', () => {
  for (const t of PROJECT_TEMPLATES) {
    const slugs = templateRoles(t).map((r) => r.slug);
    assert.ok(slugs.includes('owner') && slugs.includes('user'), t);
  }
  assert.deepEqual(templateRoles('deck').map((r) => r.slug), ['owner', 'contributor', 'user']);
  assert.deepEqual(templateRoles('blank').map((r) => r.slug), ['owner', 'user']);
});

test('a deck contributor can finish work but owns no files until the host draws them', () => {
  const c = templateRoles('deck').find((r) => r.slug === 'contributor')!;
  assert.deepEqual(c.file_scope, []);
  assert.deepEqual(c.capabilities, [...CONTRIBUTOR_CAPABILITIES]);
});

test('only the three templates are templates', () => {
  for (const t of ['web', 'deck', 'blank']) assert.equal(isProjectTemplate(t), true, t);
  for (const t of ['Web', 'slides', '', undefined]) assert.equal(isProjectTemplate(t), false, String(t));
});

// ---- seats -----------------------------------------------------------------------------------

test('a seat slug is the first word of the label, lowercased', () => {
  assert.equal(seatSlug('Priya, second speaker', []), 'priya');
  assert.equal(seatSlug('  José  ', []), 'jos');
});

test('a taken or reserved slug gets a suffix, not an error', () => {
  assert.equal(seatSlug('Priya', ['priya']), 'priya-2');
  assert.equal(seatSlug('Priya', ['priya', 'priya-2']), 'priya-3');
  assert.equal(seatSlug('Owner of slides', []), 'owner-2', 'nobody can mint a second owner');
  assert.equal(seatSlug('user', []), 'user-2');
});

test('a label with no usable word still gets a valid slug', () => {
  for (const l of ['42', '—', 'x']) assert.ok(isRoleSlug(seatSlug(l, [])), l);
});

test('a seat is the contributor set plus what --can names; an unknown name is refused', () => {
  assert.deepEqual(seatCapabilities([]), { ok: true, capabilities: [...CONTRIBUTOR_CAPABILITIES] });
  const r = seatCapabilities(['deploy', 'Triage', 'ship']);
  assert.ok(r.ok && r.capabilities.includes('deploy') && r.capabilities.includes('triage'));
  assert.ok(r.ok && r.capabilities.filter((c) => c === 'open_pr').length === 1, 'ship is open_pr, once');
  assert.equal(seatCapabilities(['deplyo']).ok, false);
});

// ---- roleFor with a project document ---------------------------------------------------------

const seat = { file_scope: ['slides/05-*.html'], capabilities: ['claim', 'acquire_scope', 'open_pr', 'suggest'], label: 'Priya' };

test('a seat is its document', () => {
  const r = roleFor('priya', seat);
  assert.deepEqual(r.file_scope, ['slides/05-*.html']);
  assert.ok(r.capabilities.includes('acquire_scope'));
  assert.equal(r.label, 'Priya');
  assert.equal(hasCapability('priya', 'open_pr', seat), true);
  assert.equal(hasCapability('priya', 'deploy', seat), false);
});

test('without its document a seat is the least privilege', () => {
  assert.deepEqual(roleFor('priya'), DEFAULT_ROLES.user);
  assert.equal(hasCapability('priya', 'claim'), false);
});

test('an unknown capability in a document is dropped, never kept', () => {
  assert.deepEqual(roleFor('priya', { ...seat, capabilities: ['claim', 'root', 'merge'] }).capabilities, ['claim']);
});

test('owner and user cannot be redefined by a document', () => {
  assert.deepEqual(roleFor('user', { capabilities: ['deploy'], file_scope: ['**'] }), DEFAULT_ROLES.user);
  assert.deepEqual(roleFor('owner', { capabilities: [], file_scope: [] }), DEFAULT_ROLES.owner);
});

test('a template role keeps its capabilities and takes only its scope from the document', () => {
  // Documents copied before order 0089 lack `triage`; reading them would strip it from old projects.
  const r = roleFor('backend', { file_scope: ['server/**'], capabilities: ['claim'] });
  assert.deepEqual(r.capabilities, DEFAULT_ROLES.backend.capabilities);
  assert.deepEqual(r.file_scope, ['server/**']);
});

// ---- the scope gate, with seats and grants -------------------------------------------------------

test('the gate admits a seat inside its document and refuses outside it', () => {
  assert.doesNotThrow(() => assertScopeAllowed('priya', ['slides/05-results.html'], seat.file_scope, { policy: seat }));
  assert.throws(() => assertScopeAllowed('priya', ['slides/02-intro.html'], seat.file_scope, { policy: seat }), RoleDeniedError);
});

test('a grant for the ticket widens the gate, and only by what was granted', () => {
  const granted = ['slides/02-intro.html'];
  assert.doesNotThrow(() => assertScopeAllowed('priya', ['slides/02-intro.html'], seat.file_scope, { policy: seat, granted }));
  assert.throws(() => assertScopeAllowed('priya', ['slides/03-*.html'], seat.file_scope, { policy: seat, granted }), RoleDeniedError);
});

test('without the document the same seat is refused outright', () => {
  // Control for the two above: the admission came from the document, not from the globs alone.
  assert.throws(() => assertScopeAllowed('priya', ['slides/05-results.html'], seat.file_scope), /hold a file scope at all/);
});

test('a grant cannot give a lock to a seat that may not hold one', () => {
  const noLocks = { ...seat, capabilities: ['suggest'] };
  assert.throws(() => assertScopeAllowed('viewer', ['a.txt'], [], { policy: noLocks, granted: ['a.txt'] }), RoleDeniedError);
});

// ---- globContains: a wildcard inside a file name ---------------------------------------------

import { globContains } from './roles.ts';

test('a partial-segment pattern on the allowed side contains the files it names', () => {
  assert.equal(globContains('slides/05-*.html', 'slides/05-results.html'), true);
  assert.equal(globContains('slides/0?-*.html', 'slides/07-close.html'), true);
  assert.equal(globContains('src/*.test.ts', 'src/a.test.ts'), true);
});

test('and nothing it does not', () => {
  assert.equal(globContains('slides/05-*.html', 'slides/02-intro.html'), false);
  assert.equal(globContains('slides/05-*.html', 'slides/05-results.css'), false);
  assert.equal(globContains('slides/05-*.html', 'slides/sub/05-x.html'), false, '* never crosses a /');
  assert.equal(globContains('a.b', 'aXb'), false, 'a dot is a dot, not any character');
});

test('a partial pattern requested is contained only by itself or a whole-segment wildcard', () => {
  assert.equal(globContains('slides/05-*.html', 'slides/05-*.html'), true);
  assert.equal(globContains('slides/*', 'slides/05-*.html'), true);
  assert.equal(globContains('slides/0*', 'slides/05-*.html'), false, 'refuse rather than decide inclusion');
});
