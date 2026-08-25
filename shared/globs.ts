// Glob intersection for server-enforced file-scope locks.
//
// The question is not "does this path match this glob" -- it is "could these two
// globs ever match the same path". Scope locks are enforced at claim time, before
// any file exists, so there is no filesystem to consult.
//
// Bias: over-approximate. A false conflict costs an agent one alternative task.
// A missed conflict costs a rebase, which is the failure this whole mechanism
// exists to prevent. When in doubt, conflict.

/** Normalise a pattern: strip './', collapse '//', expand a trailing '/' to '/**'. */
export function normalizeGlob(pattern: string): string {
  let p = pattern.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  if (p.startsWith('/')) p = p.slice(1);
  if (p.endsWith('/')) p = `${p}**`;
  return p;
}

/** Could two single-segment patterns ('*', '?' and literals) match one string? */
function segmentsIntersect(a: string, b: string): boolean {
  const memo = new Set<string>();

  const allStars = (s: string): boolean => /^\**$/.test(s);

  const go = (i: number, j: number): boolean => {
    const key = `${i}:${j}`;
    if (memo.has(key)) return false; // already explored this pair, no path found
    memo.add(key);

    const ra = a.slice(i);
    const rb = b.slice(j);
    if (ra === '' && rb === '') return true;
    if (ra === '') return allStars(rb);
    if (rb === '') return allStars(ra);

    const ca = ra[0];
    const cb = rb[0];
    // '*' matches zero or more chars: either it ends here, or it eats one char
    // that the other side must also be able to produce.
    if (ca === '*') return go(i + 1, j) || go(i, j + 1);
    if (cb === '*') return go(i, j + 1) || go(i + 1, j);
    if (ca === '?' || cb === '?' || ca === cb) return go(i + 1, j + 1);
    return false;
  };

  return go(0, 0);
}

/** Could two globs ever match the same path? '**' spans zero or more segments. */
export function globsIntersect(globA: string, globB: string): boolean {
  const a = normalizeGlob(globA).split('/');
  const b = normalizeGlob(globB).split('/');
  const memo = new Map<string, boolean>();

  const allDoubleStars = (segs: string[]): boolean => segs.every((s) => s === '**');

  const go = (i: number, j: number): boolean => {
    const key = `${i}:${j}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;

    let result: boolean;
    if (i === a.length && j === b.length) result = true;
    else if (i === a.length) result = allDoubleStars(b.slice(j));
    else if (j === b.length) result = allDoubleStars(a.slice(i));
    else if (a[i] === '**') result = go(i + 1, j) || go(i, j + 1);
    else if (b[j] === '**') result = go(i, j + 1) || go(i + 1, j);
    else result = segmentsIntersect(a[i], b[j]) && go(i + 1, j + 1);

    memo.set(key, result);
    return result;
  };

  return go(0, 0);
}

/** Every (mine, theirs) pair that collides. Empty means the scopes are disjoint. */
export function findGlobConflicts(mine: string[], theirs: string[]): { mine: string; theirs: string }[] {
  const out: { mine: string; theirs: string }[] = [];
  for (const m of mine) {
    for (const t of theirs) {
      if (globsIntersect(m, t)) out.push({ mine: m, theirs: t });
    }
  }
  return out;
}
