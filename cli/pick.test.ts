import assert from 'node:assert/strict';
import { test } from 'node:test';

import { pickTasks } from './pick.ts';

const t = (task_id: string, file_scope: string[], status = 'open', claimed_by: string | null = null) =>
  ({ task_id, status, claimed_by, file_scope });

test('only open, unclaimed tickets inside the fence are picked, oldest first', () => {
  const r = pickTasks([
    t('task_web', ['web/**']),
    t('task_server_old', ['server/**']),
    t('task_taken', ['server/**'], 'claimed', 'agent_x'),
    t('task_done', ['server/**'], 'merged'),
    t('task_server_new', ['server/routes/**']),
  ], ['server/**', 'test/**'], [], 'me');
  assert.deepEqual(r.fits, ['task_server_old', 'task_server_new']);
});

test('containment, not intersection: ** in a ticket does not fit a narrow fence', () => {
  assert.deepEqual(pickTasks([t('task_all', ['**'])], ['server/**'], [], 'me').fits, []);
  assert.deepEqual(pickTasks([t('task_all', ['**'])], ['**'], [], 'me').fits, ['task_all'], 'the owner fits everything');
});

test('a ticket needs ALL its globs inside the fence', () => {
  assert.deepEqual(pickTasks([t('task_mixed', ['server/**', 'web/**'])], ['server/**'], [], 'me').fits, []);
});

test('unscoped tickets are reported, never picked', () => {
  const r = pickTasks([t('task_raised', [])], ['**'], [], 'me');
  assert.deepEqual(r, { fits: [], unscoped: ['task_raised'], blocked: [] });
});

test('a ticket whose files another agent holds is blocked; my own lock does not block me', () => {
  const locks = [{ agent_id: 'agent_x', globs: ['server/**'] }, { agent_id: 'me', globs: ['test/**'] }];
  const r = pickTasks([t('task_server', ['server/api/**']), t('task_test', ['test/**'])], ['**'], locks, 'me');
  assert.deepEqual(r.blocked, ['task_server']);
  assert.deepEqual(r.fits, ['task_test']);
});
