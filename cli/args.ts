// Positional words, with flags AND their values removed.
//
// `new` stripped `--repo` but kept its value, so `flotilla new "Fit Test" --repo o/r` named the
// project "Fit Test o/r" -- and the project id derived from it. `task` had this right inline;
// both use this now, so the next command with a value flag cannot get it wrong a third way.

export function positional(args: readonly string[], valueFlags: readonly string[]): string {
  const skip = new Set<number>();
  for (const f of valueFlags) {
    const i = args.indexOf(f);
    if (i > -1) { skip.add(i); skip.add(i + 1); }
  }
  return args.filter((a, i) => !skip.has(i) && !a.startsWith('--')).join(' ').trim();
}
