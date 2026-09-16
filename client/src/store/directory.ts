/// <reference types="vite/client" />
// Browser ProjectDirectory. READ-ONLY, and only the two read operations the index needs.
//
// It deliberately does NOT implement the full port. Every write on ProjectDirectory is denied to
// clients by firestore.rules and happens in the CLI through the admin SDK, so a browser
// implementation of createProject could only ever be a method that fails. Implementing it to
// throw would be worse than not having it: it would suggest the capability exists.
//
// listProjects is a collectionGroup query over `members` constrained to the signed-in uid. That
// shape is forced: rules REJECT a list rather than filtering it, so `getDocs(collection(db,
// 'projects'))` fails outright the moment one project exists that this user is not in. Querying
// memberships and then reading each project by id is the only way round, and firestore.rules has
// a collection-group rule permitting exactly that query and no wider one.

import type { FirebaseApp } from 'firebase/app';
import {
  collection,
  collectionGroup,
  getDoc,
  getDocs,
  getFirestore,
  query,
  where,
  type Firestore,
} from 'firebase/firestore';

import type { MemberRecord, ProjectRecord, ProjectRollup, RoleSlug } from './directory-types';
import { STALE_AFTER_MS } from './types';
import { byActivity } from './project-order';

export type ProjectSummary = ProjectRecord & {
  role: RoleSlug;
  members: MemberRecord[];
  rollup: ProjectRollup;
  /** Agents heartbeating inside the staleness window. Who is working NOW, not who is on the roster. */
  agents_live: number;
};

export class BrowserDirectory {
  private readonly db: Firestore;
  constructor(app: FirebaseApp) {
    this.db = getFirestore(app);
  }

  /**
   * Projects this uid belongs to, each with its roster for the avatar row.
   *
   * `revoked` is filtered HERE rather than in the query: adding a second `where` makes it a
   * composite query, which production refuses until a composite index is deployed. The emulator
   * does not enforce indexes at all, so that difference only ever shows up in production — it
   * did, on the first run of `flotilla ls`.
   */
  async listProjects(uid: string): Promise<ProjectSummary[]> {
    const memberships = await getDocs(query(collectionGroup(this.db, 'members'), where('uid', '==', uid)));

    const out: ProjectSummary[] = [];
    for (const m of memberships.docs) {
      if (m.get('revoked') === true) continue;
      const projectRef = m.ref.parent.parent;
      if (!projectRef) continue;

      const p = await getDoc(projectRef);
      // A membership pointing at a project that is gone is an inconsistency, not a project with
      // no name. Skip it rather than rendering a card for something that does not exist.
      if (!p.exists()) continue;

      const roster = await getDocs(collection(this.db, 'projects', p.id, 'members'));

      // Presence is a separate collection from membership: the roster says who MAY work, this
      // says who IS. Counted here rather than carried in the rollup because a heartbeat arrives
      // every 30s per agent, and folding that into the project document would put a write on the
      // hot path purely to keep a number on a screen nobody may be looking at.
      const agents = await getDocs(collection(this.db, 'projects', p.id, 'agents'));
      const now = Date.now();
      const agents_live = agents.docs.filter((a) => {
        if (a.get('revoked') === true) return false;
        const hb = a.get('last_heartbeat_at');
        const t = typeof hb === 'number' ? hb : hb ? Date.parse(String(hb)) : NaN;
        // Same derivation as the board: stale is computed from the heartbeat, never stored.
        return Number.isFinite(t) && now - t <= STALE_AFTER_MS;
      }).length;

      out.push({
        project_id: p.id,
        project_name: (p.get('project_name') as string) ?? p.id,
        repo_url: (p.get('repo_url') as string) ?? '',
        created_at: (p.get('created_at') as string) ?? '',
        created_by: (p.get('created_by') as string) ?? '',
        role: (m.get('role') as RoleSlug) ?? 'client',
        rollup: (p.get('rollup') as ProjectRollup) ?? {},
        agents_live,
        members: roster.docs
          .map((d) => ({
            uid: (d.get('uid') as string) ?? d.id,
            role: (d.get('role') as RoleSlug) ?? 'client',
            label: (d.get('label') as string) ?? d.id,
            revoked: d.get('revoked') === true,
            added_at: (d.get('added_at') as string) ?? '',
          }))
          .filter((x) => !x.revoked)
          .sort((a, b) => a.uid.localeCompare(b.uid)),
      });
    }

    // Most recently ACTIVE first. The rule and its reasoning live in project-order.ts, which is
    // pure so the ordering can be asserted without standing up Firestore.
    return out.sort(byActivity);
  }
}
