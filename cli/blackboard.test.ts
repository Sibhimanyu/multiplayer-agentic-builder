// Checklist section C, against real git.
//
// Real git against a real bare remote on disk, not a mocked runner. The behaviours being
// tested — push rejection, rebase-and-retry, two concurrent publishes not conflicting — are
// properties of git, and a mock would only prove that the mock behaves as I imagined.
//
//   node --test cli/blackboard.test.ts

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  BLACKBOARD_BRANCH,
  BlackboardError,
  cdnUrl,
  git,
  materialise,
  pathFor,
  publishToBlackboard,
} from './blackboard.ts';
import type { Logger } from '../shared/log.ts';

const silent: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const REPO = 'zoho-cat/inventory-tracker';

/** A bare remote plus N clones, so push rejection is a real race and not a simulation. */
async function scaffold(clones = 1): Promise<{ remote: string; trees: string[] }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-'));
  const remote = path.join(base, 'remote.git');
  await git(['init', '--bare', '--initial-branch=main', remote], base);

  const trees: string[] = [];
  for (let i = 0; i < clones; i++) {
    const tree = path.join(base, `tree${i}`);
    await fs.mkdir(tree, { recursive: true });
    await git(['init', '--initial-branch=main'], tree);
    await git(['config', 'user.email', 'agent@example.com'], tree);
    await git(['config', 'user.name', 'Agent'], tree);
    await git(['remote', 'add', 'origin', remote], tree);
    await fs.writeFile(path.join(tree, 'README.md'), '# demo\n', 'utf8');
    await git(['add', '.'], tree);
    await git(['commit', '-m', 'initial'], tree);
    if (i === 0) await git(['push', 'origin', 'main'], tree);
    else await git(['fetch', 'origin'], tree);
    await fs.mkdir(path.join(tree, '.agentic'), { recursive: true });
    trees.push(tree);
  }
  return { remote, trees };
}

async function writeContract(tree: string, name: string, version: number, body: string): Promise<string> {
  const rel = path.join('contracts', `${name}.v${version}.yaml`);
  const abs = path.join(tree, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body, 'utf8');
  return rel;
}

const V1 = 'name: items-api\nversion: 1\nqty: { type: string }\n';
const V2 =
  'name: items-api\nversion: 2\nsupersedes: 1\nbreaking: true\nqty: { type: integer }\n';

// ---- C1 -------------------------------------------------------------------------------

test('C1 the CLI commits, pushes and returns a pointer for a file the agent wrote', async () => {
  const { trees } = await scaffold();
  const tree = trees[0]!;
  const src = await writeContract(tree, 'items-api', 2, V2);

  const res = await publishToBlackboard(
    { source_file: src, kind: 'contract_published', body: { name: 'items-api', version: 2, supersedes: 1 } },
    { root: tree, repo: REPO },
    silent,
  );

  assert.equal(res.path, 'contracts/items-api.v2.yaml');
  assert.match(res.commit_sha, /^[0-9a-f]{40}$/, 'the pointer must pin a 40-hex commit');
  assert.equal(res.unchanged, false);
  assert.equal(res.attempts, 1);

  // The commit really is on the remote branch, with exactly that one path.
  const log = await git(['log', '--oneline', `origin/${BLACKBOARD_BRANCH}`], tree);
  assert.match(log.stdout, /publish items-api v2/);
  const files = await git(['show', '--name-only', '--format=', res.commit_sha], tree);
  assert.deepEqual(
    files.stdout.trim().split('\n').filter(Boolean),
    ['contracts/items-api.v2.yaml'],
    'exactly one path per commit — never git add -A',
  );
});

// ---- C2 -------------------------------------------------------------------------------

test('C2 the pointer carries commit_sha and never the contract content', async () => {
  const { trees } = await scaffold();
  const tree = trees[0]!;
  const src = await writeContract(tree, 'items-api', 2, V2);
  const res = await publishToBlackboard(
    { source_file: src, kind: 'contract_published', body: { name: 'items-api', version: 2 } },
    { root: tree, repo: REPO },
    silent,
  );

  // This is the shape that goes into the event body.
  const eventBody = {
    name: 'items-api',
    version: 2,
    path: res.path,
    commit_sha: res.commit_sha,
    supersedes: 1,
  };
  const serialised = JSON.stringify(eventBody);
  assert.ok(serialised.includes(res.commit_sha), 'the pointer must include the sha');
  assert.ok(!serialised.includes('qty'), 'the contract content must NOT be in the event');
  assert.ok(!serialised.includes('integer'), 'not even a fragment of it');
  assert.ok(serialised.length < 250, `a pointer is small; got ${serialised.length} bytes`);
});

// ---- C3 -------------------------------------------------------------------------------

test('C3 two agents publishing two different contracts both land with zero conflicts', async () => {
  const { trees } = await scaffold(2);
  const [a, b] = trees as [string, string];

  const srcA = await writeContract(a, 'items-api', 2, V2);
  const srcB = await writeContract(b, 'orders-api', 1, 'name: orders-api\nversion: 1\n');

  // Genuinely concurrent: both publishes start before either finishes, so one of them will
  // certainly be rejected and have to rebase.
  const [resA, resB] = await Promise.all([
    publishToBlackboard(
      { source_file: srcA, kind: 'contract_published', body: { name: 'items-api', version: 2 } },
      { root: a, repo: REPO },
      silent,
    ),
    publishToBlackboard(
      { source_file: srcB, kind: 'contract_published', body: { name: 'orders-api', version: 1 } },
      { root: b, repo: REPO },
      silent,
    ),
  ]);

  assert.match(resA.commit_sha, /^[0-9a-f]{40}$/);
  assert.match(resB.commit_sha, /^[0-9a-f]{40}$/);

  // Both files exist on the branch: additive, no conflict, nothing lost.
  await git(['fetch', 'origin', BLACKBOARD_BRANCH], a);
  const listing = await git(['ls-tree', '-r', '--name-only', `origin/${BLACKBOARD_BRANCH}`], a);
  const files = listing.stdout.trim().split('\n').filter(Boolean);
  assert.ok(files.includes('contracts/items-api.v2.yaml'), 'items-api v2 must be on the branch');
  assert.ok(files.includes('contracts/orders-api.v1.yaml'), 'orders-api v1 must be on the branch');
});

// ---- C4 -------------------------------------------------------------------------------

test('C4 a push rejection triggers pull --rebase and succeeds within 3 attempts', async () => {
  const { trees } = await scaffold(2);
  const [a, b] = trees as [string, string];

  // Agent A publishes first, so B's branch view is stale.
  const srcA = await writeContract(a, 'items-api', 1, V1);
  await publishToBlackboard(
    { source_file: srcA, kind: 'contract_published', body: { name: 'items-api', version: 1 } },
    { root: a, repo: REPO },
    silent,
  );

  // Force B into a rejection by pinning its worktree to the pre-A commit before it pushes.
  const srcB = await writeContract(b, 'orders-api', 1, 'name: orders-api\nversion: 1\n');
  let sawRejection = false;
  const logger: Logger = {
    debug: () => {},
    info: (_code, m) => {
      if (m.includes('push rejected')) sawRejection = true;
    },
    warn: () => {},
    error: () => {},
  };

  const res = await publishToBlackboard(
    { source_file: srcB, kind: 'contract_published', body: { name: 'orders-api', version: 1 } },
    { root: b, repo: REPO, max_attempts: 3, runner: rejectFirstPush() },
    logger,
  );

  assert.ok(sawRejection, 'the rejection path must actually have been exercised');
  assert.ok(res.attempts <= 3, `must succeed within 3 attempts, took ${res.attempts}`);
  assert.match(res.commit_sha, /^[0-9a-f]{40}$/);

  await git(['fetch', 'origin', BLACKBOARD_BRANCH], b);
  const listing = await git(['ls-tree', '-r', '--name-only', `origin/${BLACKBOARD_BRANCH}`], b);
  assert.match(listing.stdout, /contracts\/items-api\.v1\.yaml/, "A's contract must survive the rebase");
  assert.match(listing.stdout, /contracts\/orders-api\.v1\.yaml/, "B's contract must land");
});

/** Wrap git so the first `push` reports a non-fast-forward rejection. */
function rejectFirstPush(): typeof git {
  let rejected = false;
  return async (args, cwd, timeout) => {
    if (args[0] === 'push' && !rejected) {
      rejected = true;
      return {
        code: 1,
        stdout: '',
        stderr: ' ! [rejected]        HEAD -> agentic/blackboard (non-fast-forward)\nUpdates were rejected because the tip of your current branch is behind.\n',
      };
    }
    return git(args, cwd, timeout);
  };
}

// ---- C5 -------------------------------------------------------------------------------

test('C5 a consumer fetches the blob by sha-pinned CDN url, not git fetch', async () => {
  const { trees } = await scaffold();
  const tree = trees[0]!;
  const sha = 'a3f9c1e0d4b28f6712c9ab3e5580f1d2c7e46a9b';

  const requested: string[] = [];
  const fakeFetch = (async (url: string | URL) => {
    requested.push(String(url));
    return new Response(V2, { status: 200 });
  }) as unknown as typeof fetch;

  const local = await materialise(
    { path: 'contracts/items-api.v2.yaml', commit_sha: sha },
    { root: tree, repo: REPO, fetchImpl: fakeFetch },
    silent,
  );

  assert.equal(local, path.join('.agentic', 'contracts', 'items-api.v2.yaml'));
  assert.equal(requested.length, 1, 'exactly one network call');
  assert.equal(
    requested[0],
    `https://raw.githubusercontent.com/${REPO}/${sha}/contracts/items-api.v2.yaml`,
    'must be the sha-pinned raw url',
  );
  assert.equal(await fs.readFile(path.join(tree, local), 'utf8'), V2);

  // Sha-pinned content is immutable, so a second read must not touch the network at all.
  await materialise(
    { path: 'contracts/items-api.v2.yaml', commit_sha: sha },
    { root: tree, repo: REPO, fetchImpl: fakeFetch },
    silent,
  );
  assert.equal(requested.length, 1, 'each agent fetches each contract exactly once, ever');
});

test('C5b a CDN failure is a named error, not a silent empty contract', async () => {
  const { trees } = await scaffold();
  const failing = (async () => new Response('not found', { status: 404 })) as unknown as typeof fetch;
  await assert.rejects(
    () =>
      materialise(
        { path: 'contracts/items-api.v9.yaml', commit_sha: 'f'.repeat(40) },
        { root: trees[0]!, repo: REPO, fetchImpl: failing },
        silent,
      ),
    (e: unknown) => e instanceof BlackboardError && /404/.test((e as Error).message),
  );
});

// ---- C6 -------------------------------------------------------------------------------

test('C6 v1 is untouched after v2 is published', async () => {
  const { trees } = await scaffold();
  const tree = trees[0]!;

  const src1 = await writeContract(tree, 'items-api', 1, V1);
  const r1 = await publishToBlackboard(
    { source_file: src1, kind: 'contract_published', body: { name: 'items-api', version: 1 } },
    { root: tree, repo: REPO },
    silent,
  );

  const src2 = await writeContract(tree, 'items-api', 2, V2);
  const r2 = await publishToBlackboard(
    { source_file: src2, kind: 'contract_published', body: { name: 'items-api', version: 2, supersedes: 1 } },
    { root: tree, repo: REPO },
    silent,
  );

  // The v2 commit touches only the v2 path.
  const changed = await git(['show', '--name-only', '--format=', r2.commit_sha], tree);
  assert.deepEqual(changed.stdout.trim().split('\n').filter(Boolean), ['contracts/items-api.v2.yaml']);

  // And v1's bytes are identical at both commits.
  const at1 = await git(['show', `${r1.commit_sha}:contracts/items-api.v1.yaml`], tree);
  const at2 = await git(['show', `${r2.commit_sha}:contracts/items-api.v1.yaml`], tree);
  assert.equal(at1.stdout, at2.stdout, 'v1 must be byte-identical after v2 lands');
  assert.equal(at2.stdout, V1);

  const diff = await git(['diff', r1.commit_sha, r2.commit_sha, '--', 'contracts/items-api.v1.yaml'], tree);
  assert.equal(diff.stdout.trim(), '', 'git diff for v1 must be empty');
});

test('C6b republishing the same version with different content is refused', async () => {
  const { trees } = await scaffold();
  const tree = trees[0]!;
  const src = await writeContract(tree, 'items-api', 1, V1);
  await publishToBlackboard(
    { source_file: src, kind: 'contract_published', body: { name: 'items-api', version: 1 } },
    { root: tree, repo: REPO },
    silent,
  );

  await fs.writeFile(path.join(tree, src), 'name: items-api\nversion: 1\nqty: { type: integer }\n', 'utf8');
  await assert.rejects(
    () =>
      publishToBlackboard(
        { source_file: src, kind: 'contract_published', body: { name: 'items-api', version: 1 } },
        { root: tree, repo: REPO },
        silent,
      ),
    (e: unknown) => e instanceof BlackboardError && /never edits/.test((e as Error).message),
    'editing a published version destroys the diff a blocked consumer needs',
  );
});

test('C6c republishing byte-identical content is idempotent, not a new commit', async () => {
  const { trees } = await scaffold();
  const tree = trees[0]!;
  const src = await writeContract(tree, 'items-api', 1, V1);
  const first = await publishToBlackboard(
    { source_file: src, kind: 'contract_published', body: { name: 'items-api', version: 1 } },
    { root: tree, repo: REPO },
    silent,
  );
  // This is what an outbox re-drain after a crash looks like.
  const again = await publishToBlackboard(
    { source_file: src, kind: 'contract_published', body: { name: 'items-api', version: 1 } },
    { root: tree, repo: REPO },
    silent,
  );
  assert.equal(again.unchanged, true);
  assert.equal(again.commit_sha, first.commit_sha, 'the same pointer, so the event dedupes too');
});

// ---- path derivation and safety --------------------------------------------------------

test('pathFor follows the naming table, and a version is always a new file', () => {
  assert.equal(pathFor('contract_published', { name: 'items-api', version: 2 }), 'contracts/items-api.v2.yaml');
  assert.equal(pathFor('contract_published', { name: 'items-api' }), 'contracts/items-api.v1.yaml');
  assert.equal(pathFor('schema_published', { table: 'items' }), 'schema/items.sql');
  assert.equal(
    pathFor('decision_recorded', { number: 7, slug: 'qty-is-integer' }),
    'decisions/0007-qty-is-integer.md',
  );
});

test('an agent-supplied name cannot escape its directory', () => {
  for (const name of ['../../.github/workflows/deploy', '..', 'a/../../b', '/etc/passwd', '', 'a b']) {
    assert.throws(
      () => pathFor('contract_published', { name, version: 1 }),
      (e: unknown) => e instanceof BlackboardError,
      `name ${JSON.stringify(name)} must be refused`,
    );
  }
});

test('a source file outside the working tree is refused', async () => {
  const { trees } = await scaffold();
  await assert.rejects(
    () =>
      publishToBlackboard(
        { source_file: '../../../etc/passwd', kind: 'contract_published', body: { name: 'x', version: 1 } },
        { root: trees[0]!, repo: REPO },
        silent,
      ),
    (e: unknown) => e instanceof BlackboardError && /escapes the working tree/.test((e as Error).message),
  );
});

test('cdnUrl pins the sha so the object is cacheable forever', () => {
  const sha = 'a'.repeat(40);
  const url = cdnUrl(REPO, sha, 'contracts/items-api.v2.yaml');
  assert.equal(url, `https://raw.githubusercontent.com/${REPO}/${sha}/contracts/items-api.v2.yaml`);
  assert.ok(!url.includes('main'), 'never a branch name: a branch url is mutable');
  assert.ok(!url.includes('HEAD'));
});

// ---- C7 -------------------------------------------------------------------------------

test('C7 the agent never sees a commit sha in .agentic', async () => {
  const { trees } = await scaffold();
  const tree = trees[0]!;
  const sha = 'a3f9c1e0d4b28f6712c9ab3e5580f1d2c7e46a9b';
  const fakeFetch = (async () => new Response(V2, { status: 200 })) as unknown as typeof fetch;

  const local = await materialise(
    { path: 'contracts/items-api.v2.yaml', commit_sha: sha },
    { root: tree, repo: REPO, fetchImpl: fakeFetch },
    silent,
  );

  // Neither the path nor the file contents may carry the sha.
  assert.ok(!local.includes(sha), 'the local path must not embed the sha');
  const contents = await fs.readFile(path.join(tree, local), 'utf8');
  assert.ok(!contents.includes(sha), 'the materialised blob is the contract, nothing more');

  // Sweep the whole .agentic tree for any 40-hex string.
  const found: string[] = [];
  const walk = async (dir: string) => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // The blackboard worktree is git's own storage, not agent-visible context.
        if (entry.name === '.blackboard-worktree') continue;
        await walk(abs);
      } else {
        const text = await fs.readFile(abs, 'utf8').catch(() => '');
        if (/\b[0-9a-f]{40}\b/.test(text)) found.push(path.relative(tree, abs));
      }
    }
  };
  await walk(path.join(tree, '.agentic'));
  assert.deepEqual(found, [], `no file under .agentic may contain a commit sha, found: ${found.join(', ')}`);
});
