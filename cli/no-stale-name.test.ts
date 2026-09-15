// A freshly generated project must contain ZERO occurrences of any superseded product name.
//
// THIS IS THE DELIVERABLE OF THE RENAME, not the rename itself.
//
// Order 0048 renamed `builder` to `drydock` and covered the CLI's own help text but NOT the files
// the CLI GENERATES. A real agent read a generated role pack weeks later, was told to run
// `builder claim`, looked for a binary that did not exist, and stopped. The rename had been
// reported as done.
//
// So the check is on GENERATED OUTPUT: every string the CLI writes for a human or an agent to
// read. It is written against a LIST of dead names rather than the current one, so the next
// rename inherits it by adding one entry -- and so it keeps testing the names already retired,
// which is where the rot actually lives.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  renderAgentsMd, renderCurrentTask, renderProtocolMd,
  type ProjectFile, type RolePack,
} from './agentic.ts';

/**
 * Every product name this thing has had, except the current one.
 *
 * `builder` is matched only as a WHOLE WORD, because `backend-builder` and `frontend-builder` are
 * ROLE SLUGS -- data, not the product name -- and must survive every rename. That distinction was
 * flagged during the last rename and holds here.
 */
const DEAD_NAMES: { name: string; re: RegExp }[] = [
  { name: 'drydock', re: /drydock/i },
  { name: 'catalyst-builder', re: /catalyst-builder/i },
  { name: 'builder (as the product)', re: /\bbuilder\s+(connect|claim|start|status|report|new|init|login|members|ls)\b|`builder[ `]/i },
];

const ROLE: RolePack = {
  role_slug: 'backend', title: 'Backend builder',
  responsibilities: 'Implement API handlers and the data schema.',
  may_edit: ['functions/**', 'schema/**'],
  may_not_edit: ['client/**', 'contracts/**'],
  branch_prefix: 'feat/be-', push_branches: true, open_prs: true, merge: false,
};
const PROJECT: ProjectFile = {
  project_id: 'proj_x', name: 'X', repo_url: 'o/r',
  brief: 'A brief.', protocol_version: '0.2',
};

/** Everything the CLI writes into a project for someone to read. */
const generated = (): { file: string; text: string }[] => [
  { file: 'AGENTS.md', text: renderAgentsMd(ROLE, PROJECT) },
  { file: '.agentic/protocol.md', text: renderProtocolMd() },
  { file: '.agentic/tasks/current-task.md (none)', text: renderCurrentTask(null) },
  {
    file: '.agentic/tasks/current-task.md (claimed)',
    text: renderCurrentTask({
      task_id: 't1', title: 'A task', kind: 'backend', status: 'claimed', claimed_by: 'a1',
      branch: null, pr_url: null, pr_number: null, ci: null, depends_on: [],
      blocked_by: null, blocked_reason: null, file_scope: ['functions/**'],
      updated_at: '2026-09-15T00:00:00.000Z',
    }),
  },
];

test('generated files contain no superseded product name', () => {
  for (const { file, text } of generated()) {
    for (const { name, re } of DEAD_NAMES) {
      const m = text.match(new RegExp(re.source, 'gi'));
      assert.equal(
        m, null,
        `${file} still contains the retired name "${name}": ${JSON.stringify(m?.slice(0, 3))}`,
      );
    }
  }
});

test('and they do name the CURRENT product, so the check above is not vacuous', () => {
  // A file that mentions no product at all would pass every assertion above. At least one
  // generated file must actually say `flotilla`, or the rename could have deleted the name
  // rather than replaced it.
  const all = generated().map((g) => g.text).join('\n');
  assert.match(all, /flotilla/i, 'no generated file mentions the current product name');
});

test('role slugs survive the rename, because they are data', () => {
  // backend-builder / frontend-builder contain "builder" and must NOT be rewritten. If a future
  // rename matches them, this fails and says why.
  const pack: RolePack = { ...ROLE, role_slug: 'backend-builder', title: 'Backend builder' };
  const text = renderAgentsMd(pack, PROJECT);
  assert.match(text, /Backend builder/, 'the role title is data and stays');
  // And the whole-word product check above must not fire on it.
  for (const { re } of DEAD_NAMES) {
    assert.doesNotMatch(text, new RegExp(re.source, 'i'), 'a role slug must not read as a product name');
  }
});
