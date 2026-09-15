// The files the CLI GENERATES are a product surface, and nothing tested them.
//
// A real agent read them, found a stale command name, a self-contradiction and a false claim, and
// stopped. Three defects that ~400 assertions could not see, because every assertion covered code
// and none covered the prose the code writes.
//
// These are deliberately blunt string checks. Prose cannot be type-checked, so the only thing
// that keeps it honest is asserting the specific ways it has already gone wrong.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderAgentsMd, renderCurrentTask, renderProtocolMd, type ProjectFile, type RolePack } from './agentic.ts';

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

/** Everything the CLI writes for an agent to read. */
const generated = (): { name: string; text: string }[] => [
  { name: 'AGENTS.md', text: renderAgentsMd(ROLE, PROJECT) },
  { name: 'protocol.md', text: renderProtocolMd() },
  { name: 'current-task.md (no task)', text: renderCurrentTask(null) },
];

test('generated prose names no stale command', () => {
  // `builder` was the CLI's name until order 0048. That rename covered cli/index.ts's own help
  // text and MISSED the files the CLI writes, so an agent was told to run a binary that does not
  // exist. Any future rename has to come through here.
  for (const { name, text } of generated()) {
    assert.doesNotMatch(text, /\bbuilder\s+(connect|claim|start|status|report|new|init|login)\b/,
      `${name} tells the agent to run a command from a previous product name`);
    assert.doesNotMatch(text, /`builder[ `]/, `${name} still refers to \`builder\``);
  }
});

test('generated prose makes no claim that is false for an empty project', () => {
  // AGENTS.md said "Contracts you need are already on disk in .agentic/contracts/." On a new
  // project that directory is empty, and an agent checked, found nothing, and reported the file
  // as wrong. A statement about the world must hold in the state the agent is most likely to
  // meet it in: the first one.
  for (const { name, text } of generated()) {
    assert.doesNotMatch(
      text,
      /contracts you need are already on disk/i,
      `${name} asserts contracts are on disk, which is false for a project with none`,
    );
  }
  const agents = renderAgentsMd(ROLE, PROJECT);
  // And it must say the thing it was reaching for: the ORDERING guarantee.
  assert.match(agents, /BEFORE they are announced/,
    'AGENTS.md should explain that contracts land on disk before being announced');
  assert.match(agents, /empty, which is normal/, 'and that an empty directory is not a fault');
});

test('generated prose does not contradict itself about git', () => {
  // "push branches: yes" against the role pack's "never run git yourself". Both were true of the
  // SYSTEM and only one of the AGENT; the agent hit the contradiction and stopped.
  const agents = renderAgentsMd(ROLE, PROJECT);
  assert.match(agents, /never run git/i, 'AGENTS.md must tell the agent not to run git');
  assert.doesNotMatch(agents, /^push branches:/m, 'and must not also read as an instruction to push');
  assert.match(agents, /branches pushed for you/i, 'phrasing it as something done FOR the agent');
});

test('the outbox envelope is specified, because an agent had to guess it', () => {
  const p = renderProtocolMd();
  assert.match(p, /"kind"/, 'protocol.md names the kind field');
  assert.match(p, /"body"/, 'and the body field');
  assert.match(p, /assigned by the server/i, 'and says the rest is assigned by the server');
  assert.match(p, /IGNORED/, 'and that extra fields are ignored rather than rejected');
});

test('claiming a task is documented, with both outcomes', () => {
  const p = renderProtocolMd();
  assert.match(p, /claim_requested/, 'protocol.md documents claim_requested');
  assert.match(p, /task_claimed/, 'and the winning reply');
  assert.match(p, /claim_denied/, 'and the losing reply');
  assert.match(p, /normal reply, not an error/i, 'and says a denial is normal');
});

test('the role pack does not claim to be the enforcement boundary', () => {
  // The scope file is guidance. Saying otherwise would teach an agent that editing the file
  // changes what it may do.
  const agents = renderAgentsMd(ROLE, PROJECT);
  assert.match(agents, /functions\/\*\*/, 'the scope is stated');
  assert.doesNotMatch(agents, /enforced by this file/i, 'but not claimed to be enforced here');
});
