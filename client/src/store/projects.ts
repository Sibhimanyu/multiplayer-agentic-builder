/// <reference types="vite/client" />
// Loading the projects index: sign in, then list.
//
// Separate from firebase.ts because that file is the CoordinationStore adapter and this is the
// ProjectDirectory tier — the same split the ports have. Lazily imported by App so the index
// route does not pull the directory code into the board's bundle path.

import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';

import { BrowserDirectory } from './directory';
import { configFromEnv } from './firebase';
import type { AgentPresence } from './types';
import type { MemberRecord } from './directory-types';

export interface ProjectRow {
  project_id: string;
  project_name: string;
  repo_url: string;
  role: string;
  members: AgentPresence[];
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

export async function loadProjects(): Promise<ProjectRow[]> {
  const env = import.meta.env as unknown as Record<string, string | undefined>;
  const app: FirebaseApp = getApps()[0] ?? initializeApp(configFromEnv(env));

  // Same anonymous identity the board uses: the uid IS the membership key, so the index and the
  // board must agree about who you are or you would see a project you cannot then open.
  const cred = await signInAnonymously(getAuth(app));

  const rows = await new BrowserDirectory(app).listProjects(cred.user.uid);
  return rows.map((p) => ({
    project_id: p.project_id,
    project_name: p.project_name,
    repo_url: p.repo_url,
    role: p.role,
    members: p.members.map(asAvatar),
  }));
}
