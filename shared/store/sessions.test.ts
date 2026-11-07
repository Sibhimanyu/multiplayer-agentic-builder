// Shared sessions: the rules for asking, granting, guarding and addressing. All pure.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  activeGrantGlobs,
  cleanGlobs,
  cleanMessageBody,
  guardDecision,
  isFor,
  MESSAGE_MAX,
  resolveRecipient,
  validateDecision,
  validateScopeRequest,
  type Addressee,
  type ScopeRequest,
} from './sessions.ts';

// ---- asking ----------------------------------------------------------------------------------

test('a request needs globs and a reason, and keeps the ticket it names', () => {
  assert.deepEqual(
    validateScopeRequest({ globs: [' slides/02-intro.html ', 'slides/02-intro.html'], reason: ' typo ', task_id: 'task_t14' }),
    { ok: true, globs: ['slides/02-intro.html'], reason: 'typo', task_id: 'task_t14' },
  );
  assert.equal(validateScopeRequest({ globs: ['a/**'], reason: '   ' }).ok, false);
  assert.equal(validateScopeRequest({ globs: [], reason: 'x' }).ok, false);
  const none = validateScopeRequest({ globs: ['a/**'], reason: 'x' });
  assert.ok(none.ok && none.task_id === null, 'no ticket is null, not an empty string');
});

test('a request cannot name a negation, an absolute path or ..', () => {
  for (const g of ['!slides/**', '/etc/passwd', 'slides/../secrets', '']) {
    assert.equal(cleanGlobs([g]).ok, false, g);
  }
  assert.equal(cleanGlobs(Array.from({ length: 21 }, (_, i) => `s/${i}`)).ok, false, 'at most 20');
});

// ---- deciding --------------------------------------------------------------------------------

const open = { status: 'open' as const, decided_by: null, task_id: 'task_t14', agent_id: 'agent_p' };
const claim = { agent_id: 'agent_p', claimed_at: '2026-11-07T10:00:00Z' };

test('a grant defaults to the ticket, and pins the claim it was given under', () => {
  assert.deepEqual(validateDecision(open, { grant: true }, claim), { ok: true, grant: true, duration: 'task', claimed_at: claim.claimed_at });
});

test('a seat grant needs no ticket and pins no claim', () => {
  assert.deepEqual(validateDecision({ ...open, task_id: null }, { grant: true, duration: 'seat' }, null), {
    ok: true, grant: true, duration: 'seat', claimed_at: null,
  });
});

test('a task grant is refused when there is no ticket, or the asker no longer holds it', () => {
  assert.equal(validateDecision({ ...open, task_id: null }, { grant: true }, null).ok, false);
  assert.equal(validateDecision(open, { grant: true }, null).ok, false);
  assert.equal(validateDecision(open, { grant: true }, { agent_id: 'agent_other', claimed_at: 'x' }).ok, false);
});

test('a deny needs a reason; an unknown duration is refused, not defaulted', () => {
  assert.equal(validateDecision(open, { grant: false }, claim).ok, false);
  assert.deepEqual(validateDecision(open, { grant: false, reason: ' slide 2 is mine ' }, claim), { ok: true, grant: false, reason: 'slide 2 is mine' });
  assert.equal(validateDecision(open, { grant: true, duration: 'forever' }, claim).ok, false);
});

test('a decided request is a value naming who decided, and a missing one is a 404', () => {
  const r = validateDecision({ ...open, status: 'granted', decided_by: 'Sam' }, { grant: true }, claim);
  assert.deepEqual(r, { ok: false, status: 200, error: 'already granted', decided_by: 'Sam' });
  const missing = validateDecision(null, { grant: true }, claim);
  assert.ok(!missing.ok && missing.status === 404);
});

// ---- a grant ends with its claim ---------------------------------------------------------------

const granted = (o: Partial<ScopeRequest>) => ({
  agent_id: 'agent_p', task_id: 'task_t14', status: 'granted' as const, grant: 'task' as const,
  claimed_at: claim.claimed_at, globs: ['slides/02-intro.html'], ...o,
});

test('a task grant is live while the same claim stands', () => {
  assert.deepEqual(activeGrantGlobs([granted({})], 'agent_p', 'task_t14', claim), ['slides/02-intro.html']);
});

test('the grant ends on release, ship or reap: no claim, another claimant, or a re-claim', () => {
  assert.deepEqual(activeGrantGlobs([granted({})], 'agent_p', 'task_t14', null), []);
  assert.deepEqual(activeGrantGlobs([granted({})], 'agent_p', 'task_t14', { agent_id: 'agent_q', claimed_at: claim.claimed_at }), []);
  assert.deepEqual(activeGrantGlobs([granted({})], 'agent_p', 'task_t14', { agent_id: 'agent_p', claimed_at: '2026-11-07T11:00:00Z' }), []);
});

test('only granted, task-duration requests for this agent and ticket count', () => {
  const reqs = [
    granted({ status: 'open' }),
    granted({ status: 'denied' }),
    granted({ grant: 'seat' }),
    granted({ agent_id: 'agent_q' }),
    granted({ task_id: 'task_other' }),
    granted({ globs: ['slides/03-*.html', 'slides/02-intro.html'] }),
  ];
  assert.deepEqual(activeGrantGlobs(reqs, 'agent_p', 'task_t14', claim), ['slides/03-*.html', 'slides/02-intro.html']);
});

// ---- the edit guard --------------------------------------------------------------------------

const fence = ['slides/05-*.html', 'slides/06-*.html'];

test('inside the seat is allowed, outside is refused with the way to ask', () => {
  assert.deepEqual(guardDecision('slides/05-results.html', fence, []), { allow: true });
  const d = guardDecision('slides/02-intro.html', fence, []);
  assert.equal(d.allow, false);
  assert.ok(!d.allow && d.reason.includes('request_scope') && d.reason.includes('slides/02-intro.html'));
});

test('a live grant lets the file through', () => {
  assert.deepEqual(guardDecision('slides/02-intro.html', fence, ['slides/02-intro.html']), { allow: true });
});

test('the agent mailbox and paths outside the repo are never the guard\'s business', () => {
  for (const p of ['.agentic/outbox.jsonl', '.agentic', '../elsewhere/x.txt', '/tmp/x', '']) {
    assert.deepEqual(guardDecision(p, fence, []), { allow: true }, p);
  }
});

test('an empty seat refuses everything in the repo', () => {
  assert.equal(guardDecision('README.md', [], []).allow, false);
});

// ---- addressing ------------------------------------------------------------------------------

const roster: Addressee[] = [
  { id: 'uid_sam', kind: 'member', label: 'Sam', role_slug: 'owner' },
  { id: 'agent_p', kind: 'agent', label: 'Priya, second speaker', role_slug: 'priya' },
  { id: 'agent_a1', kind: 'agent', label: 'Alex One', role_slug: 'alex' },
  { id: 'agent_a2', kind: 'agent', label: 'Alex Two', role_slug: 'alex-2' },
];

test('@seat, a label, its first word and an id all resolve to one person', () => {
  for (const to of ['@priya', 'priya', 'Priya, second speaker', 'agent_p']) {
    assert.deepEqual(resolveRecipient(to, roster), { ok: true, to: 'agent_p', to_label: 'Priya, second speaker' }, to);
  }
  assert.deepEqual(resolveRecipient('sam', roster), { ok: true, to: 'uid_sam', to_label: 'Sam' });
});

test('all, everyone and * reach everyone', () => {
  for (const to of ['*', 'all', '@everyone']) assert.deepEqual(resolveRecipient(to, roster), { ok: true, to: '*', to_label: 'everyone' });
});

test('an exact seat beats a shared first name; a shared name alone is an error, never a guess', () => {
  assert.deepEqual(resolveRecipient('@alex', roster), { ok: true, to: 'agent_a1', to_label: 'Alex One' });
  const twins: Addressee[] = [
    { id: 'a', kind: 'agent', label: 'Jo Smith', role_slug: 'jo-smith' },
    { id: 'b', kind: 'agent', label: 'Jo Brown', role_slug: 'jo-brown' },
  ];
  const r = resolveRecipient('jo', twins);
  assert.ok(!r.ok && r.error.includes('matches 2'));
});

test('nobody by that name, or no name at all, is refused', () => {
  assert.equal(resolveRecipient('@nobody', roster).ok, false);
  assert.equal(resolveRecipient('  ', roster).ok, false);
});

test('a reader sees messages to them, to everyone, and their own', () => {
  assert.equal(isFor({ to: '*', from_id: 'x' }, ['agent_p']), true);
  assert.equal(isFor({ to: 'agent_p', from_id: 'x' }, ['agent_p']), true);
  assert.equal(isFor({ to: 'uid_sam', from_id: 'agent_p' }, ['agent_p']), true);
  assert.equal(isFor({ to: 'uid_sam', from_id: 'agent_a1' }, ['agent_p']), false, 'a message between two others is private');
});

test('a message body is required and bounded', () => {
  assert.deepEqual(cleanMessageBody('  hi  '), { ok: true, body: 'hi' });
  assert.equal(cleanMessageBody('   ').ok, false);
  assert.equal(cleanMessageBody(42).ok, false);
  assert.equal(cleanMessageBody('x'.repeat(MESSAGE_MAX + 1)).ok, false);
  assert.equal(cleanMessageBody('x'.repeat(MESSAGE_MAX)).ok, true);
});
