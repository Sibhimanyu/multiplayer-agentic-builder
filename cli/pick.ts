// Which ticket `flotilla claim` (with no id) should take.
//
// Nothing handed tickets out: an agent read the board and took whichever it liked, so two agents
// eyed the same card and a ticket outside your fence looked as takeable as one inside it. This is
// the smallest honest version of hand-out -- the oldest open ticket you could actually finish --
// with no scheduler behind it. The claim that follows is still the atomic claimTask, so two
// agents running this at once cannot both win.

import { globContains } from '../shared/store/roles.ts';
import { globsIntersect } from '../shared/globs.ts';

interface Task { task_id: string; status: string; claimed_by: string | null; file_scope: string[] }
interface Lock { agent_id: string; globs: string[] }

export interface Pick {
  /** Takeable now, oldest first (the snapshot lists tasks in creation order). */
  fits: string[];
  /** Open, but declares no files: takeable only with `--scope`, so never picked for you. */
  unscoped: string[];
  /** Open and in your fence, but another agent holds overlapping files right now. */
  blocked: string[];
}

export function pickTasks(tasks: readonly Task[], roleScope: readonly string[], locks: readonly Lock[], me: string): Pick {
  const out: Pick = { fits: [], unscoped: [], blocked: [] };
  const others = locks.filter((l) => l.agent_id !== me).flatMap((l) => l.globs);
  for (const t of tasks) {
    if (t.status !== 'open' || t.claimed_by) continue;
    if (t.file_scope.length === 0) { out.unscoped.push(t.task_id); continue; }
    // Every glob the ticket locks must sit inside some glob the role may edit. Containment, not
    // intersection: `**` intersects `functions/**`, and a picker that used intersection would
    // hand backend a ticket the server then refuses.
    if (!t.file_scope.every((g) => roleScope.some((r) => globContains(r, g)))) continue;
    if (t.file_scope.some((g) => others.some((o) => globsIntersect(g, o)))) { out.blocked.push(t.task_id); continue; }
    out.fits.push(t.task_id);
  }
  return out;
}
