// Pure display formatting for the board. No imports, so shared/format.test.ts can load it under
// plain node without the client's toolchain.

/**
 * How long something has been blocked, in the largest unit that reads naturally.
 *
 * The card used to print raw minutes, and a ticket blocked for 13 days rendered as
 * "Blocked 18690m" -- a number nobody can read at a glance, on the one badge whose whole job is
 * to say "this has been stuck a long time".
 */
export function formatAge(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

/**
 * A task kind as a person writes it. CSS `text-transform: capitalize` turned `qa` into "Qa"
 * and `devops` into "Devops"; acronyms need a table, not a transform.
 */
const KIND_LABEL: Record<string, string> = { qa: 'QA', devops: 'DevOps' };

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
}
