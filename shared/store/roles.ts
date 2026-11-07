// The two role gates. Order 0047.
//
// A prompt is guidance; these are gates. The role pack tells an agent its scope in AGENTS.md and
// an agent that ignores it is not stopped by anything in that file. These two functions are what
// actually refuses.
//
// CONTAINMENT IS NOT INTERSECTION, and using the wrong one here would be a silent hole.
// globsIntersect answers "could these two ever match the same path", which is the right question
// for LOCK CONFLICTS -- two agents must not both hold a path. It is the WRONG question for scope
// enforcement: `**` intersects `functions/**`, so an agent asking for `**` would pass an
// intersection test against a backend role and take a lock on the entire repository.
//
// The question here is containment: is every path the REQUEST could match also a path the ROLE
// allows. That is a subset test, and it is strictly stronger.

import { normalizeGlob } from '../globs.ts';
import { RoleDeniedError, roleFor, type Capability, type RolePolicy } from './directory.ts';

/**
 * Is every path matched by `requested` also matched by `allowed`?
 *
 * Segment-wise, with `**` spanning zero or more segments on the ALLOWED side only. A `**` on the
 * requested side can only be contained by a `**` on the allowed side, which is what stops `**`
 * slipping inside `functions/**`.
 *
 * Bias, and it is the opposite of globsIntersect's: over-approximating a CONFLICT costs an agent
 * one alternative task, but over-approximating CONTAINMENT grants permission that was not given.
 * So when in doubt here, refuse.
 */
export function globContains(allowed: string, requested: string): boolean {
  const a = normalizeGlob(allowed).split('/');
  const r = normalizeGlob(requested).split('/');
  const memo = new Map<string, boolean>();

  const segContains = (allowSeg: string, reqSeg: string): boolean => {
    if (allowSeg === '**' || allowSeg === '*') return true;
    if (reqSeg === '**' || reqSeg === '*') return false; // a wildcard request needs a wildcard grant
    if (allowSeg === reqSeg) return true;
    if (!allowSeg.includes('?') && !allowSeg.includes('*')) return false;
    // A wildcard INSIDE the requested segment (`05-*.html`) is only contained by the identical
    // pattern or a whole-segment wildcard, both handled above. Deciding whether one partial
    // pattern contains another is a language-inclusion question, and the bias here is refuse.
    if (reqSeg.includes('*') || reqSeg.includes('?')) return false;
    // A literal requested segment against a partial pattern on the allowed side: `*` is any run
    // within the segment, `?` one character. Shared sessions need this -- a deck seat is
    // `slides/05-*.html`, and before it every such fence contained nothing, not even its own files.
    const re = new RegExp(`^${allowSeg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`);
    return re.test(reqSeg);
  };

  const go = (i: number, j: number): boolean => {
    const key = `${i}:${j}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;

    let out: boolean;
    if (i >= a.length) out = j >= r.length;
    else if (a[i] === '**') {
      // '**' on the allowed side absorbs zero or more requested segments.
      out = go(i + 1, j) || (j < r.length && go(i, j + 1));
    } else if (j >= r.length) out = false;
    // `?? ''` rather than a non-null assertion: both indices are bounds-checked above, so this
    // is unreachable, and an empty segment fails segContains closed rather than throwing. The
    // functions/ build runs with noUncheckedIndexedAccess, which is how this surfaced.
    else out = segContains(a[i] ?? '', r[j] ?? '') && go(i + 1, j + 1);

    memo.set(key, out);
    return out;
  };

  return go(0, 0);
}

/**
 * Every requested glob must be contained by at least one glob the role allows.
 *
 * `override` is the PROJECT'S policy when it has one. File scope depends on repo layout --
 * `functions/**` is Firebase's -- so the per-project value wins over the default template.
 */
export function globsWithinRole(role_slug: string, requested: string[], override?: string[]): string[] {
  const allowed = override ?? roleFor(role_slug).file_scope;
  return requested.filter((g) => !allowed.some((a) => globContains(a, g)));
}

/**
 * GATE 1 — file scope. Throws RoleDeniedError naming exactly which globs were refused.
 *
 * Bounds acquireScope by ROLE rather than by whatever the agent asks for. The primitive itself is
 * unchanged and still verified contended; this only narrows what may be asked of it.
 */
export function assertScopeAllowed(
  role_slug: string,
  requested: string[],
  override?: string[],
  opts: {
    /** The project's role document, so a seat drawn by `flotilla share` has its own capabilities. */
    policy?: RolePolicy | null;
    /** Globs the host granted for THIS ticket (shared/store/sessions.ts activeGrantGlobs). */
    granted?: string[];
  } = {},
): void {
  const role = roleFor(role_slug, opts.policy);
  const seat = override ?? role.file_scope;
  const granted = opts.granted ?? [];
  const allowed = [...seat, ...granted.filter((g) => !seat.includes(g))];
  if (!role.capabilities.includes('acquire_scope') || allowed.length === 0) {
    throw new RoleDeniedError(role_slug, 'hold a file scope at all', requested, allowed);
  }
  const refused = globsWithinRole(role_slug, requested, allowed);
  if (refused.length > 0) {
    // The message names the way out. Before shared sessions a refusal was the end of the story;
    // now the agent can ask, and an agent that is not told so will not.
    throw new RoleDeniedError(role_slug, 'edit outside its file scope (ask the host: flotilla request)', refused, allowed);
  }
}

/**
 * GATE 2 — deploy scope. Nothing calls this yet, and that is fine.
 *
 * A gate with no caller is a gate; a caller with no gate is a hole. Deploy is the one capability
 * in the model with no implementation behind it, so the enforcement point lands first and the
 * deployer is written against it rather than the other way round.
 */
export function assertDeployAllowed(role_slug: string, targets: string[]): void {
  const role = roleFor(role_slug);
  if (!role.capabilities.includes('deploy')) {
    throw new RoleDeniedError(role.slug, 'deploy anything', targets, []);
  }
  const refused = targets.filter(
    (t) => !role.deploy_scope.some((allowed) => allowed === '*' || allowed === t),
  );
  if (refused.length > 0) {
    throw new RoleDeniedError(role.slug, 'deploy those targets', refused, role.deploy_scope);
  }
}

/** Capability check for everything that is not a scope or a target. */
export function assertCapability(role_slug: string, cap: Capability, policy?: RolePolicy | null): void {
  const role = roleFor(role_slug, policy);
  if (!role.capabilities.includes(cap)) {
    throw new RoleDeniedError(role_slug, cap.replace(/_/g, ' '), [cap], role.capabilities);
  }
}
