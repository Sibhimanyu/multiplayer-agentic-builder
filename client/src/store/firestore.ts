/// <reference types="vite/client" />
// Browser CoordinationStore for Cloud Firestore. Read-only, by design.
//
// The triple-slash reference above pulls in import.meta.env typing locally rather than adding
// "vite/client" to client/tsconfig.json — that file is shared with the Catalyst build, and a
// change there would show up in their diff for no reason.
//
// The dashboard calls exactly one method — subscribe — so this file implements exactly one
// method. Everything else in the interface is a write, and clients never write the ledger:
// writes go through the API, which resolves token -> agent_id server-side. The security rules
// deny every client write, so adding an appendEvent here would not work even if it existed.
//
// Two Firestore-specific costs shape this file:
//
//   Listeners are billed per DOCUMENT DELIVERED on change, not per unit time. So this never
//   attaches a listener to the `events` collection — an append-only log re-delivers on every
//   append, forever, and the board renders the fold rather than the ledger. It listens to the
//   bounded folded collections plus a single counter document for `seq`.
//
//   A resumed query after roughly 30 minutes offline is rebilled as new. There is no way to
//   avoid that, so the only thing worth doing is not ALSO leaking the old listener — hence the
//   unconditional teardown of every unsubscribe below.

import { initializeApp, type FirebaseApp, type FirebaseOptions } from 'firebase/app';
import {
  collection,
  doc,
  getFirestore,
  limit,
  onSnapshot,
  query,
  type Firestore,
} from 'firebase/firestore';

import type {
  AgentPresence,
  ContractPointer,
  CoordinationStore,
  Freshness,
  ProjectId,
  ScopeLock,
  Seq,
  Snapshot,
  TaskView,
} from './types';

/** Derived at read time, never stored. Must match shared/store/types.ts. */
const STALE_TIMEOUT_MS = 90_000;
const PRESENCE_CAP = 100;
const LOCKS_CAP = 200;
/** meta, counter, tasks, agents, locks, contracts. */
const LISTENER_COUNT = 6;

interface StoredAgent {
  agent_id: string;
  role_slug?: string;
  member_label?: string;
  initials?: string;
  harness?: AgentPresence['harness'];
  status?: AgentPresence['status'];
  current_task?: string | null;
  branch?: string | null;
  last_heartbeat_ms?: number | null;
  revoked?: boolean;
}

export interface FirestoreStoreOptions {
  /** Firebase web config. Safe to ship: it identifies the project, it does not authorise. */
  config: FirebaseOptions;
  /** Coalescing window. One transaction settles six collections; render one frame, not six. */
  debounce_ms?: number;
  app?: FirebaseApp;
}

class BrowserFirestoreStore implements CoordinationStore {
  /**
   * Firestore is genuinely push-based, so this is honest.
   *
   * The dashboard reads this to decide whether to render a live dot or an "updated Ns ago"
   * counter. Faking a poll counter here to make the two builds look alike would destroy the
   * one measurement the whole exercise exists to produce.
   */
  readonly freshness: Freshness = { mode: 'live', stale_ms: 0 };

  private readonly db: Firestore;
  private readonly debounce_ms: number;

  constructor(opts: FirestoreStoreOptions) {
    const app = opts.app ?? initializeApp(opts.config);
    this.db = getFirestore(app);
    this.debounce_ms = opts.debounce_ms ?? 40;
  }

  subscribe(project_id: ProjectId, from_seq: Seq, onChange: (s: Snapshot) => void): () => void {
    const projectRef = doc(this.db, 'projects', project_id);
    const tasks = new Map<string, TaskView>();
    const agents = new Map<string, StoredAgent>();
    const locks = new Map<string, ScopeLock>();
    const contracts = new Map<string, ContractPointer>();
    const ready = new Set<string>();
    let seq = 0;
    let project_name = project_id;
    let repo_url = '';

    let closed = false;
    let firstFrameSent = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const emit = () => {
      if (closed) return;
      // Hold the first frame until all six listeners have delivered their initial load, so a
      // subscriber gets one complete snapshot instead of six partial ones. An empty collection
      // still delivers an initial empty snapshot, so this cannot deadlock on a fresh project.
      if (!firstFrameSent && ready.size < LISTENER_COUNT) return;
      firstFrameSent = true;

      const now = Date.now();
      const presence: AgentPresence[] = [...agents.values()]
        .slice(0, PRESENCE_CAP)
        .map((a) => {
          const hb = a.last_heartbeat_ms ?? null;
          return {
            agent_id: a.agent_id,
            role_slug: a.role_slug ?? 'unknown',
            member_label: a.member_label ?? a.agent_id,
            initials: a.initials ?? a.agent_id.slice(-2).toUpperCase(),
            harness: a.harness ?? 'manual',
            // A revoked agent is not merely offline, and the board must say so distinctly.
            status: a.revoked ? 'revoked' : (a.status ?? 'offline'),
            current_task: a.current_task ?? null,
            branch: a.branch ?? null,
            last_heartbeat_at: hb === null ? null : new Date(hb).toISOString(),
            // Derived here, at read time. There is no `stale` field in Firestore: storing it
            // would need a write per agent per timeout just to keep it true.
            stale: hb === null || now - hb > STALE_TIMEOUT_MS,
          };
        });
      if (agents.size > PRESENCE_CAP) {
        console.warn('[store] presence capped', {
          op: 'subscribe.presence',
          requested: agents.size,
          returned: PRESENCE_CAP,
          dropped: agents.size - PRESENCE_CAP,
          project_id,
        });
      }
      if (locks.size > LOCKS_CAP) {
        console.warn('[store] locks capped', {
          op: 'subscribe.locks',
          requested: locks.size,
          returned: LOCKS_CAP,
          dropped: locks.size - LOCKS_CAP,
          project_id,
        });
      }

      onChange({
        project_id,
        seq,
        generated_at: new Date().toISOString(),
        project_name,
        repo_url,
        // Stable sort order. Cards must not reshuffle between frames (E9, no layout shift).
        tasks: [...tasks.values()].sort((a, b) => a.task_id.localeCompare(b.task_id)),
        agents: presence.sort((a, b) => a.agent_id.localeCompare(b.agent_id)),
        locks: [...locks.values()].slice(0, LOCKS_CAP).sort((a, b) => a.agent_id.localeCompare(b.agent_id)),
        contracts: [...contracts.values()].sort(
          (a, b) => a.name.localeCompare(b.name) || a.version - b.version,
        ),
      });
    };

    const schedule = () => {
      if (closed) return;
      if (this.debounce_ms <= 0) {
        emit();
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        emit();
      }, this.debounce_ms);
    };

    const mark = (name: string) => {
      ready.add(name);
      schedule();
    };

    // Every listener names itself in its error handler. A listener that fails silently would
    // freeze one column of the board while the rest kept updating, which is worse than an
    // obvious outage because nobody notices.
    const onErr = (name: string) => (err: unknown) => {
      console.warn(`[store] listener "${name}" failed`, err);
    };

    const unsubs: (() => void)[] = [
      onSnapshot(
        projectRef,
        (d) => {
          project_name = (d.get('project_name') as string) ?? project_id;
          repo_url = (d.get('repo_url') as string) ?? '';
          mark('meta');
        },
        onErr('meta'),
      ),
      onSnapshot(
        doc(this.db, 'projects', project_id, 'meta', 'ledger'),
        (d) => {
          seq = (d.get('seq') as number) ?? 0;
          mark('counter');
        },
        onErr('counter'),
      ),
      onSnapshot(
        collection(this.db, 'projects', project_id, 'tasks'),
        (s) => {
          for (const ch of s.docChanges()) {
            if (ch.type === 'removed') tasks.delete(ch.doc.id);
            else tasks.set(ch.doc.id, ch.doc.data() as TaskView);
          }
          mark('tasks');
        },
        onErr('tasks'),
      ),
      onSnapshot(
        query(collection(this.db, 'projects', project_id, 'agents'), limit(PRESENCE_CAP)),
        (s) => {
          for (const ch of s.docChanges()) {
            if (ch.type === 'removed') agents.delete(ch.doc.id);
            else agents.set(ch.doc.id, ch.doc.data() as StoredAgent);
          }
          mark('agents');
        },
        onErr('agents'),
      ),
      onSnapshot(
        query(collection(this.db, 'projects', project_id, 'locks'), limit(LOCKS_CAP)),
        (s) => {
          for (const ch of s.docChanges()) {
            if (ch.type === 'removed') locks.delete(ch.doc.id);
            else locks.set(ch.doc.id, ch.doc.data() as ScopeLock);
          }
          mark('locks');
        },
        onErr('locks'),
      ),
      onSnapshot(
        collection(this.db, 'projects', project_id, 'contracts'),
        (s) => {
          for (const ch of s.docChanges()) {
            if (ch.type === 'removed') contracts.delete(ch.doc.id);
            else contracts.set(ch.doc.id, ch.doc.data() as ContractPointer);
          }
          mark('contracts');
        },
        onErr('contracts'),
      ),
    ];

    // `from_seq` is unused on purpose: the fold is absolute state, not a delta stream, so
    // there is no cursor position a subscriber could miss by starting from zero.
    void from_seq;

    /**
     * Presence staleness is time-based, so the board must re-render on a timer even when
     * nothing changes — otherwise a dead agent stays green until the next unrelated write.
     * A local re-render, not a query: it costs nothing.
     */
    const staleTick = setInterval(() => {
      if (firstFrameSent) emit();
    }, 15_000);

    return () => {
      if (closed) return;
      closed = true;
      if (timer) clearTimeout(timer);
      clearInterval(staleTick);
      // Unconditionally, every one. A leaked onSnapshot keeps billing after the component that
      // created it is gone, and it is invisible until the invoice.
      for (const u of unsubs) {
        try {
          u();
        } catch (err) {
          console.warn('[store] listener teardown threw', err);
        }
      }
    };
  }
}

/**
 * Read the Firebase web config from the build environment.
 *
 * These values are public by design — the web config identifies a project, it does not
 * authorise anything. Authorisation is the security rules plus the API. Shipping them in the
 * bundle is correct and not a leak.
 */
export function configFromEnv(env: Record<string, string | undefined>): FirebaseOptions {
  const required = ['VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_PROJECT_ID', 'VITE_FIREBASE_APP_ID'];
  const missing = required.filter((k) => !env[k]);
  if (missing.length > 0) {
    // Fail loudly at startup rather than rendering an empty board that looks like "no tasks
    // yet". An empty board and a misconfigured board must not look the same.
    throw new Error(
      `Firebase config is incomplete: missing ${missing.join(', ')}. ` +
        'Copy client/.env.example to client/.env.local and fill it in.',
    );
  }
  return {
    apiKey: env.VITE_FIREBASE_API_KEY!,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN ?? `${env.VITE_FIREBASE_PROJECT_ID}.firebaseapp.com`,
    projectId: env.VITE_FIREBASE_PROJECT_ID!,
    storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: env.VITE_FIREBASE_APP_ID!,
  };
}

export function createFirestoreStore(opts?: Partial<FirestoreStoreOptions>): CoordinationStore {
  const config = opts?.config ?? configFromEnv(import.meta.env as unknown as Record<string, string>);
  return new BrowserFirestoreStore({ ...opts, config });
}
