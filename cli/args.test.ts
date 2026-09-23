import assert from 'node:assert/strict';
import { test } from 'node:test';

import { positional } from './args.ts';

test('a value flag takes its value with it', () => {
  assert.equal(positional(['Fit', 'Test', '--repo', 'o/r'], ['--repo']), 'Fit Test');
});

test('flags anywhere, several of them', () => {
  assert.equal(positional(['--kind', 'backend', 'Wire', 'it', '--id', 'task_x'], ['--kind', '--id']), 'Wire it');
});

test('a bare switch is dropped without eating the next word', () => {
  assert.equal(positional(['Wire', '--dry-run', 'it'], ['--repo']), 'Wire it');
});
