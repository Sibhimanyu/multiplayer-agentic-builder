import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { inferRoleScopes, topLevelDirs } from './newproject.ts';
import { DEFAULT_ROLES } from '../shared/store/directory.ts';

const defaults = {
  backend: DEFAULT_ROLES.backend.file_scope,
  frontend: DEFAULT_ROLES.frontend.file_scope,
  qa: DEFAULT_ROLES.qa.file_scope,
};

test('a server/ + web/ + test/ repo gets fences that fit it', () => {
  assert.deepEqual(inferRoleScopes(['server', 'web', 'test', 'docs'], defaults), {
    backend: ['server/**'],
    frontend: ['web/**'],
    qa: ['test/**'],
  });
});

test('a role with no matching folder keeps its default', () => {
  const r = inferRoleScopes(['api', 'docs'], defaults);
  assert.deepEqual(r.backend, ['api/**']);
  assert.equal(r.frontend, undefined);
  assert.equal(r.qa, undefined);
});

test('a repo that already matches the template changes nothing', () => {
  assert.deepEqual(inferRoleScopes(['functions', 'schema', 'client'], defaults).backend, undefined);
  assert.deepEqual(inferRoleScopes(['functions', 'schema', 'client'], defaults).frontend, undefined);
});

test('several matching folders all land in the fence', () => {
  assert.deepEqual(inferRoleScopes(['server', 'migrations'], defaults).backend, ['server/**', 'migrations/**']);
});

test('topLevelDirs skips files, dot-folders and node_modules', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flotilla-dirs-'));
  for (const d of ['server', 'web', '.git', 'node_modules']) await fs.mkdir(path.join(root, d));
  await fs.writeFile(path.join(root, 'README.md'), '');
  assert.deepEqual((await topLevelDirs(root)).sort(), ['server', 'web']);
});
