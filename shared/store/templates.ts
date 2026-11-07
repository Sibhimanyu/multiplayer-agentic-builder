// Project templates and personal seats. docs/designs/shared-sessions.md, piece 1.
//
// A project used to have exactly the six web roles, because RoleSlug was a closed union. That
// made Flotilla a tool for websites: a slide deck has no backend, and its second speaker is not a
// "frontend". A template is the set of roles a project is born with; a SEAT is a role a host draws
// for one person later, with `flotilla share`.
//
// Both end up as the same thing -- a document at projects/{pid}/roles/{slug} -- so every gate
// reads one shape. See roleFor() in directory.ts for how a gate turns that document into a role.

import {
  CAPABILITIES,
  DEFAULT_ROLES,
  RESERVED_ROLES,
  isRoleSlug,
  type Capability,
  type RoleDefinition,
  type RoleSlug,
} from './directory.ts';

export type ProjectTemplate = 'web' | 'deck' | 'blank';
export const PROJECT_TEMPLATES: readonly ProjectTemplate[] = ['web', 'deck', 'blank'];

export const isProjectTemplate = (v: unknown): v is ProjectTemplate =>
  typeof v === 'string' && (PROJECT_TEMPLATES as readonly string[]).includes(v);

/**
 * The narrowest seat that can still finish work: take a ticket, lock its files, open its PR, and
 * raise a suggestion. Not triage (it cannot put work on anybody's board), not invite (it cannot
 * add people), not deploy. `flotilla share --can` widens it, one named capability at a time.
 */
export const CONTRIBUTOR_CAPABILITIES: readonly Capability[] = ['claim', 'acquire_scope', 'open_pr', 'suggest'];

/**
 * The roles each template writes into a new project. `owner` is always present (the creator) and
 * so is `user` (people who use what you ship).
 *
 * `web` IS today's behaviour, unchanged: the six DEFAULT_ROLES. A test pins that, so choosing no
 * template can never change what an existing workflow gets.
 */
export function templateRoles(t: ProjectTemplate): RoleDefinition[] {
  switch (t) {
    case 'web':
      return Object.values(DEFAULT_ROLES);
    case 'deck':
      // A contributor with no files: every speaker's slides are drawn per person by `share`. A
      // default scope here would be a guess about which slides are whose.
      return [
        DEFAULT_ROLES.owner,
        { slug: 'contributor', label: 'Contributor', file_scope: [], deploy_scope: [], capabilities: [...CONTRIBUTOR_CAPABILITIES] },
        DEFAULT_ROLES.user,
      ];
    case 'blank':
      return [DEFAULT_ROLES.owner, DEFAULT_ROLES.user];
  }
}

/**
 * A slug for a person's seat, from the label the host typed. "Priya, second speaker" -> "priya".
 *
 * The FIRST word, because that is what people type after an @: `flotilla say @priya`. Reserved
 * and taken slugs get a numeric suffix rather than an error -- two Priyas is a normal team, not a
 * mistake the host should have to work around.
 */
export function seatSlug(label: string, taken: readonly string[]): RoleSlug {
  const word = label.trim().toLowerCase().split(/[^a-z0-9]+/).find((w) => w.length > 0) ?? '';
  let base = word.replace(/^[^a-z]+/, '').slice(0, 28);
  if (base.length < 2) base = 'seat';
  const used = new Set([...taken, ...RESERVED_ROLES]);
  if (!used.has(base) && isRoleSlug(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const s = `${base}-${n}`;
    if (!used.has(s)) return s;
  }
  throw new Error(`no free seat slug for "${label}"`);
}

/**
 * The capabilities of a seat: the contributor set plus whatever `--can` named.
 *
 * Unknown names are REFUSED, not dropped -- unlike roleFor, which reads stored documents and must
 * fail closed silently. Here a person is typing, and "--can deplyo" quietly doing nothing is how
 * they find out on the day of the deploy.
 */
export function seatCapabilities(can: readonly string[]): { ok: true; capabilities: Capability[] } | { ok: false; error: string } {
  const out = [...CONTRIBUTOR_CAPABILITIES];
  // People type the verbs the CLI uses; the model calls them something else in two places.
  const alias: Record<string, Capability> = { ship: 'open_pr', pr: 'open_pr', edit: 'acquire_scope', contracts: 'publish_contract' };
  for (const raw of can) {
    const name = raw.trim().toLowerCase().replace(/-/g, '_');
    if (!name) continue;
    const cap = alias[name] ?? name;
    if (!(CAPABILITIES as readonly string[]).includes(cap)) {
      return { ok: false, error: `unknown capability "${raw}". One of: ship, deploy, triage, invite, contracts` };
    }
    if (!out.includes(cap as Capability)) out.push(cap as Capability);
  }
  return { ok: true, capabilities: out };
}
