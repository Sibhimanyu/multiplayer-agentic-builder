// Live-check scripts create REAL projects in production. None may name a real repo.
//
// They all did: 31 throwaway projects claimed Sibhimanyu/inventory-tracker, so when the GitHub
// webhook came back it could not tell which project a PR belonged to and dropped every delivery
// as ambiguous. The repo in these scripts is a label (they push to local bare remotes, if at
// all), so a made-up one costs nothing.

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

const root = path.join(import.meta.dirname, '..');
const REAL = /Sibhimanyu\/inventory-tracker(?![-\w])/;

test('no live-check script points a production project at a real repo', async () => {
  const files: string[] = [];
  for (const dir of ['firebase', 'flotilla']) {
    for (const f of await fs.readdir(path.join(root, dir))) if (f.endsWith('.mjs')) files.push(path.join(dir, f));
  }
  // Control: the scan must reach the scripts that used to do it.
  assert.ok(files.includes(path.join('flotilla', 'stranger.mjs')), 'scan did not find flotilla/stranger.mjs');
  assert.ok(files.length >= 9, `scan found only ${files.length} scripts`);

  const offenders: string[] = [];
  for (const f of files) if (REAL.test(await fs.readFile(path.join(root, f), 'utf8'))) offenders.push(f);
  assert.deepEqual(offenders, [], 'use flotilla-test/scratch instead');
});

test('the pattern catches the real repo and not its -firebase sibling', () => {
  assert.ok(REAL.test("'Sibhimanyu/inventory-tracker'"));
  assert.ok(REAL.test('github.com/Sibhimanyu/inventory-tracker.git'));
  assert.ok(!REAL.test('Sibhimanyu/inventory-tracker-firebase'));
});
