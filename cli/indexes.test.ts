// Every collectionGroup query needs a declared COLLECTION_GROUP index. Derived, not remembered.
//
// THIS TRAP HAS FIRED THREE TIMES: members.uid, invites.code_sha256, agents.token_sha256. Each
// time the symptom was a 500 in production and nothing locally, because automatic single-field
// indexes are COLLECTION-scoped only and the emulator does not enforce indexes at all. Each time
// the fix was one line in firestore.indexes.json that nobody could have known to write.
//
// So the required set is read out of the SOURCE. Adding a collectionGroup query without its index
// now fails here instead of in production.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(join(root, dir))) {
    const rel = `${dir}/${e}`;
    if (e === 'node_modules' || e.startsWith('.')) continue;
    if (statSync(join(root, rel)).isDirectory()) tsFiles(rel, acc);
    else if (e.endsWith('.ts') && !e.endsWith('.test.ts')) acc.push(rel);
  }
  return acc;
}

/** (collection, field) pairs the code actually queries across a collection group. */
function requiredPairs(): { file: string; group: string; field: string }[] {
  const found: { file: string; group: string; field: string }[] = [];
  for (const rel of [...tsFiles('functions/src'), ...tsFiles('firebase'), ...tsFiles('client/src')]) {
    const src = readFileSync(join(root, rel), 'utf8');
    // Two call shapes, because the project uses two SDKs: the admin chain
    // `db.collectionGroup('x').where('f', ...)` and the modular
    // `query(collectionGroup(db, 'x'), where('f', ...))`. The field match therefore does NOT
    // require a leading dot. The field pattern also has to allow DIGITS: without them it matched
    // `uid` and silently skipped `code_sha256` and `token_sha256`. The control below caught both.
    const re = /collectionGroup\(\s*(?:[A-Za-z0-9_.]+\s*,\s*)?['"]([A-Za-z_]+)['"]\s*\)([\s\S]{0,240})/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const group = m[1]!;
      const w = /\bwhere\(\s*['"]([A-Za-z0-9_.]+)['"]/.exec(m[2]!);
      if (w) found.push({ file: rel, group, field: w[1]! });
    }
  }
  return found;
}

test('every collectionGroup query has a COLLECTION_GROUP index declared', () => {
  const declared = JSON.parse(readFileSync(join(root, 'firestore.indexes.json'), 'utf8')) as {
    fieldOverrides: { collectionGroup: string; fieldPath: string; indexes: { queryScope: string }[] }[];
  };
  const has = (g: string, f: string) =>
    declared.fieldOverrides.some((o) => o.collectionGroup === g && o.fieldPath === f
      && o.indexes.some((i) => i.queryScope === 'COLLECTION_GROUP'));

  const pairs = requiredPairs();
  // The control: if the scan finds nothing, it proves nothing, and this test would pass forever
  // on a repo that had quietly lost every query.
  assert.ok(pairs.length >= 3, `the scan found only ${pairs.length} collectionGroup queries; it is not looking properly`);

  const missing = pairs.filter((p) => !has(p.group, p.field));
  assert.deepEqual(
    missing.map((p) => `${p.group}.${p.field} (${p.file})`),
    [],
    'these collectionGroup queries will 500 in production with FAILED_PRECONDITION',
  );
});
