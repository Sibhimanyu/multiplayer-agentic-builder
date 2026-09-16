// How the projects index is ordered. Pure, so it can be asserted without a backend.
//
// Split out of directory.ts deliberately: that file imports the Firestore SDK, so a test that
// wanted to check the ordering rule would have to drag the whole SDK in, or mock it, or skip the
// check. A comparator is the one part of listProjects with a real decision in it, and it should
// be the easiest part to test.

/** The fields ordering depends on. Structural, so both the real summary and a fixture satisfy it. */
export interface Orderable {
  project_id: string;
  created_at?: string;
  rollup?: { last_activity?: string };
}

/**
 * Most recently ACTIVE first, not most recently created.
 *
 * A project made last month that three agents are working in right now belongs above one created
 * this morning and untouched since. Creation order answers "what is new"; the index is asked
 * "where do I look".
 *
 * `created_at` is the fallback so a brand-new project with no events yet sorts among the live
 * ones rather than sinking beneath the abandoned. `project_id` is the final tiebreak: two equal
 * keys must not reshuffle between renders, which is locked pattern 7.
 *
 * ISO-8601 strings compare correctly with localeCompare because the format is
 * lexicographically ordered — no Date parsing, and no NaN when a field is missing.
 */
export function byActivity(a: Orderable, b: Orderable): number {
  const ka = a.rollup?.last_activity || a.created_at || '';
  const kb = b.rollup?.last_activity || b.created_at || '';
  return kb.localeCompare(ka) || a.project_id.localeCompare(b.project_id);
}
