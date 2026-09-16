/// <reference types="vite/client" />
// Loading the projects index: sign in, then list.
//
// Separate from firebase.ts because that file is the CoordinationStore adapter and this is the
// ProjectDirectory tier — the same split the ports have. Lazily imported by App so the index
// route does not pull the directory code into the board's bundle path.

import { BrowserDirectory } from './directory';
import { boardApp } from './session';
import type { AgentPresence } from './types';
import type { MemberRecord, ProjectRollup } from './directory-types';

export interface ProjectRow {
  project_id: string;
  project_name: string;
  repo_url: string;
  role: string;
  members: AgentPresence[];
  rollup?: ProjectRollup;
  agents_live?: number;
}

/**
 * What loadProjects needs from a directory, and nothing more.
 *
 * Narrow on purpose so the projects route can be driven by a fake in client/edge/cases.tsx. The
 * bug order 0064 is about was NOT inside listProjects -- it was that the uid handed to it came
 * from an unconditional signInAnonymously, so every existing test seeded its fixture against
 * whatever uid the harness happened to use and the two were always the same identity. A port this
 * shape is what makes "a member sees it, a stranger does not" expressible at all.
 */
export interface ProjectLister {
  listProjects(uid: string): Promise<{
    project_id: string; project_name: string; repo_url: string;
    role: string; members: MemberRecord[];
    rollup?: ProjectRollup; agents_live?: number;
  }[]>;
}

/**
 * A project member rendered as an avatar.
 *
 * Members are not agents, but Avatar draws a person and both are people. `stale` is false and
 * `status` is 'connected' because a member has no liveness of their own — presence belongs to
 * agents, and pretending otherwise would put a grey "offline" ring on every human in the list.
 */
function asAvatar(m: MemberRecord): AgentPresence {
  return {
    agent_id: m.uid,
    role_slug: m.role,
    member_label: m.label,
    initials: (m.label || m.uid).slice(0, 2).toUpperCase(),
    harness: 'manual',
    status: 'connected',
    current_task: null,
    branch: null,
    last_heartbeat_at: null,
    stale: false,
  };
}

/**
 * The projects this uid is a member of.
 *
 * TAKES THE UID. It used to call `signInAnonymously` itself and use whatever uid came back, with
 * a comment saying that was "the same anonymous identity the board uses" -- which was true, and
 * was the bug. The uid IS the membership key, so a throwaway identity is a member of nothing and
 * the index answered "No projects yet" to someone looking at a project they had just created.
 *
 * Signing in is now the one decision App makes and this function makes none: whoever is signed
 * in is who we ask about. `directory` is injectable for the same reason -- see ProjectLister.
 */
export async function loadProjects(uid: string, directory?: ProjectLister): Promise<ProjectRow[]> {
  const lister = directory ?? new BrowserDirectory(boardApp());
  const rows = await lister.listProjects(uid);
  return rows.map((p) => ({
    project_id: p.project_id,
    project_name: p.project_name,
    repo_url: p.repo_url,
    role: p.role,
    members: p.members.map(asAvatar),
    ...(p.rollup === undefined ? {} : { rollup: p.rollup }),
    ...(p.agents_live === undefined ? {} : { agents_live: p.agents_live }),
  }));
}
