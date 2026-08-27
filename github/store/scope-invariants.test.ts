// Two invariants that `acquireScope` silently depends on, pinned offline.
//
// WHY THIS FILE EXISTS -- and it is the most useful thing I found today.
//
// I claimed entry 18 was closed by a generation ref used as a compare-and-swap,
// and wrote a live adversarial test that injects a competitor between the
// pre-check and the push. It passed. Then, per order 0025 ("would this have
// given the same answer in the broken state?"), I mutation-tested it:
//
//   MUTANT 1  generation ref still pushed, CAS lease REMOVED  -> test PASSED
//   MUTANT 2  generation ref removed from the push entirely   -> test FAILED
//
// So the live test genuinely detects an open window -- mutant 2 proves it is not
// vacuous. But mutant 1 proves the CAS is NOT what closes it in that
// configuration. The window is closed by TWO independent mechanisms:
//
//   1. the explicit CAS lease  -- designed, and what I described in the notes
//   2. generation commits being ORPHANS -- accidental
//
// Mechanism 2 works because `mkObject` builds commits with no parent, so pushing
// one over an existing generation ref is a non-fast-forward and the server
// rejects it. That is the descendant rule this project already measured, quietly
// doing load-bearing work nobody designed it to do.
//
// Mechanism 2 is FRAGILE in a specific and plausible way: chaining generation
// commits (parenting each to the previous) is an obvious "improvement" for
// auditability, and it would make every plain push a fast-forward and evaporate
// mechanism 2 entirely. The CAS would still hold -- but the live test would
// still pass either way, so a later regression that dropped the CAS would then
// go undetected.
//
// These two tests pin both mechanisms explicitly so neither can be removed
// silently. Offline, zero quota.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createGithubStore } from './github.ts';
import { FakeClock } from '../../shared/clock.ts';
import { CapturingLogger } from '../../shared/log.ts';
import type { GitRunner, HttpTransport, PushResult } from './transport.ts';
import { parsePorcelain } from './transport.ts';

const PROJECT = 'proj_inv';

interface Recorded { run: string[][]; push: string[][] }

function fakeGit(rec: Recorded): GitRunner {
  return {
    async run(args) {
      rec.run.push(args);
      if (args[0] === 'commit-tree') {
        // Any plausible 40-hex sha; the tests only inspect the ARGS.
        return { code: 0, stdout: 'a'.repeat(40), stderr: '' };
      }
      return { code: 0, stdout: '', stderr: '' };
    },
    async push(args): Promise<PushResult> {
      rec.push.push(args);
      // Report every requested ref as freshly created, so acquireScope proceeds.
      const specs = args.filter((a) => a.includes(':') && !a.startsWith('--'));
      const lines = specs
        .map((s) => `*\t${s}\t[new reference]`)
        .join('\n');
      return { code: 0, refs: parsePorcelain(`To fake\n${lines}\nDone\n`), stderr: '' };
    },
  };
}

/** Every ref listing comes back empty, so there is nothing to conflict with. */
const emptyHttp: HttpTransport = async () => ({
  status: 200, headers: {}, body: '[]',
});

function makeStore(rec: Recorded) {
  return createGithubStore({
    repo: 'o/r', git: fakeGit(rec), http: emptyHttp, token: 't',
    clock: new FakeClock(), log: new CapturingLogger(),
  });
}

test('generation commits are ORPHANS, which is a load-bearing accident', async () => {
  const rec: Recorded = { run: [], push: [] };
  const store = makeStore(rec);
  await store.acquireScope(PROJECT, 'agent_a', 'task_a', ['src/**']);

  const commitTrees = rec.run.filter((a) => a[0] === 'commit-tree');
  assert.ok(commitTrees.length >= 1, 'acquireScope must build at least one object');

  for (const args of commitTrees) {
    assert.ok(!args.includes('-p'),
      'a generation commit with a parent would make a plain push a FAST-FORWARD, '
      + 'and the non-fast-forward rejection that currently backstops the CAS would '
      + 'silently stop protecting anything. Mutation testing showed the live race '
      + 'test cannot see this change. If you deliberately chain these commits, the '
      + 'CAS below becomes the ONLY protection -- make sure it is still there.');
  }
});

test('acquireScope pushes a compare-and-swap lease on the generation ref', async () => {
  const rec: Recorded = { run: [], push: [] };
  const store = makeStore(rec);
  await store.acquireScope(PROJECT, 'agent_a', 'task_a', ['src/**']);

  assert.equal(rec.push.length, 1, 'acquisition must be a single push');
  const args = rec.push[0]!;

  assert.ok(args.includes('--atomic'),
    'without --atomic a losing lease leaves the lock ref behind -- measured in probe M');

  const genRef = `refs/agentic/${PROJECT}/locks-gen`;
  const lease = args.find((a) => a.startsWith(`--force-with-lease=${genRef}:`));
  assert.ok(lease,
    'the generation ref must carry a lease, or the serialisation point is not enforced. '
    + 'This is the protection the live race test CANNOT see, because orphan commits '
    + 'independently close the same window.');

  // First acquisition: the generation ref does not exist yet, so the lease is
  // the create-if-absent form (empty expected value).
  assert.equal(lease, `--force-with-lease=${genRef}:`,
    'the first acquisition must demand the generation ref be ABSENT');

  // And the lock itself rides in the same push.
  assert.ok(args.some((a) => a.endsWith(`:refs/agentic/${PROJECT}/locks/agent_a`)),
    'the lock and the generation bump must land together or not at all');
});

test('a SECOND acquisition pins the lease to the generation it actually read', async () => {
  // The create-if-absent form is only correct for the first acquisition. Once a
  // generation exists, the lease must pin its exact sha -- that is what makes it
  // a compare-and-swap rather than a create.
  const rec: Recorded = { run: [], push: [] };
  const GEN_SHA = 'b'.repeat(40);
  const genRef = `refs/agentic/${PROJECT}/locks-gen`;

  const http: HttpTransport = async (url) => {
    if (url.includes('locks-gen')) {
      return {
        status: 200, headers: {},
        body: JSON.stringify([{ ref: genRef, object: { sha: GEN_SHA } }]),
      };
    }
    return { status: 200, headers: {}, body: '[]' };
  };

  const store = createGithubStore({
    repo: 'o/r', git: fakeGit(rec), http, token: 't',
    clock: new FakeClock(), log: new CapturingLogger(),
  });
  await store.acquireScope(PROJECT, 'agent_a', 'task_a', ['src/**']);

  const args = rec.push[0]!;
  assert.ok(args.includes(`--force-with-lease=${genRef}:${GEN_SHA}`),
    'the lease must pin the generation sha that was READ, so an acquisition that '
    + 'landed in between is detected. A create-if-absent lease here would silently '
    + 'succeed against a moved generation.');
});
