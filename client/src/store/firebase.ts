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
  connectAuthEmulator,
  getAuth,
  signInAnonymously,
  type Auth,
} from 'firebase/auth';
import {
  collection,
  connectFirestoreEmulator,
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

/**
 * What the board is actually doing, so a failure can be rendered as itself.
 *
 * Order 0039 ruling 1, condition 1: a permission failure must surface in the UI AS a permission
 * failure. Before this, six listeners hit onErr, console.warn ran six times, `mark()` was never
 * called, the readiness gate never opened and App sat on "Connecting..." forever -- identical on
 * screen to a dead subscriber. That ambiguity is exactly why firebase/rulesprobe.mjs had to
 * exist, and the product must not need a probe to tell a user what is wrong.
 *
 * These states are distinguished because each has a DIFFERENT fix, and saying "error" would
 * throw that away:
 *
 *   auth-unavailable  the project has no sign-in configured  -> a console setting
 *   denied            signed in, but not a member of this project -> admit the uid
 *   error             anything else, reported verbatim
 */
export type StoreStatus =
  | { state: 'signing-in' }
  | { state: 'live'; uid: string }
  | { state: 'denied'; uid: string; project_id: ProjectId }
  | { state: 'auth-unavailable'; code: string; detail: string }
  | { state: 'error'; detail: string };

/**
 * The browser store, plus a status channel.
 *
 * A separate interface rather than a change to CoordinationStore: store/types.ts is frozen and
 * shared with the Catalyst build, and the ten-operation seam is the point of it. Status is a
 * property of THIS transport (a signed-in browser talking to rules), not of the coordination
 * contract, so it belongs here.
 */
export interface BrowserStore extends CoordinationStore {
  onStatus(cb: (s: StoreStatus) => void): () => void;
}

export interface FirestoreStoreOptions {
  /** Firebase web config. Safe to ship: it identifies the project, it does not authorise. */
  config: FirebaseOptions;
  /** Coalescing window. One transaction settles six collections; render one frame, not six. */
  debounce_ms?: number;
  app?: FirebaseApp;
  /** Auth emulator origin, e.g. "http://127.0.0.1:9099". From VITE_AUTH_EMULATOR. */
  auth_emulator?: string;
  /**
   * Point the dashboard at a local Firestore emulator, e.g. "127.0.0.1:8080".
   *
   * This is what makes checklist section E verifiable without a deployed project: the board can
   * be run against seeded emulator data and screenshotted. Read from VITE_FIRESTORE_EMULATOR,
   * which is never set in a production build.
   */
  emulator?: string;
}

class BrowserFirestoreStore implements BrowserStore {
  /**
   * Firestore is genuinely push-based, so this is honest.
   *
   * The dashboard reads this to decide whether to render a live dot or an "updated Ns ago"
   * counter. Faking a poll counter here to make the two builds look alike would destroy the
   * one measurement the whole exercise exists to produce.
   */
  readonly freshness: Freshness = { mode: 'live', stale_ms: 0 };

  private readonly db: Firestore;
  private readonly auth: Auth;
  private readonly debounce_ms: number;

  private status: StoreStatus = { state: 'signing-in' };
  private readonly watchers = new Set<(s: StoreStatus) => void>();
  /** Resolves to the anonymous uid, or rejects once sign-in has failed. */
  private readonly signedIn: Promise<string>;

  constructor(opts: FirestoreStoreOptions) {
    const app = opts.app ?? initializeApp(opts.config);
    this.db = getFirestore(app);
    this.auth = getAuth(app);
    this.debounce_ms = opts.debounce_ms ?? 40;

    if (opts.auth_emulator) {
      connectAuthEmulator(this.auth, opts.auth_emulator, { disableWarnings: true });
    }

    // Started in the constructor, not in subscribe(), so the round trip overlaps with React
    // mounting rather than being serialised after it. subscribe() awaits the same promise.
    this.signedIn = this.beginSignIn();

    if (opts.emulator) {
      const [host, port] = opts.emulator.split(':');
      // Loud, not silent. A dashboard quietly talking to an emulator while someone believes
      // they are looking at production is a worse failure than not connecting at all.
      console.warn(
        `[store] EMULATOR MODE — connected to ${opts.emulator}, not to project ` +
          `"${opts.config.projectId}". Nothing here is real data.`,
      );
      connectFirestoreEmulator(this.db, host || '127.0.0.1', Number(port ?? 8080));
    }
  }

  // ---- status ------------------------------------------------------------------------

  onStatus(cb: (s: StoreStatus) => void): () => void {
    this.watchers.add(cb);
    cb(this.status); // current state immediately, so a late subscriber is not left blank
    return () => {
      this.watchers.delete(cb);
    };
  }

  private setStatus(s: StoreStatus): void {
    this.status = s;
    for (const w of this.watchers) {
      try {
        w(s);
      } catch (err) {
        console.warn('[store] status watcher threw', err);
      }
    }
  }

  /**
   * Anonymous sign-in. Four lines of intent, wrapped in the classification that makes a failure
   * legible.
   *
   * Anonymous rather than a login screen because the rules only ask "is this uid a member of
   * this project" -- identity, not authentication of a person. The uid is stable per browser
   * (the SDK persists it in IndexedDB), so admitting it once is enough.
   */
  private async beginSignIn(): Promise<string> {
    try {
      const cred = await signInAnonymously(this.auth);
      // Not marked live yet: being signed in says nothing about being ALLOWED to read. Only a
      // listener actually delivering does that, so `live` is set in attach().
      return cred.user.uid;
    } catch (err) {
      const code = (err as { code?: string }).code ?? 'unknown';
      const detail = (err as { message?: string }).message ?? String(err);
      // These two are configuration, not outage, and they are fixed in completely different
      // places. Collapsing them into "sign-in failed" would send someone to the wrong screen.
      const known: Record<string, string> = {
        'auth/configuration-not-found':
          'Firebase Authentication is not enabled for this project. ' +
          'Firebase console -> Authentication -> Get started, then enable the Anonymous provider.',
        'auth/operation-not-allowed':
          'Anonymous sign-in is disabled for this project. ' +
          'Firebase console -> Authentication -> Sign-in method -> Anonymous -> Enable.',
      };
      this.setStatus({ state: 'auth-unavailable', code, detail: known[code] ?? detail });
      throw err;
    }
  }

  subscribe(project_id: ProjectId, from_seq: Seq, onChange: (s: Snapshot) => void): () => void {
    let closed = false;
    let detach: (() => void) | null = null;

    // Listeners must not attach before sign-in resolves: an unauthenticated onSnapshot is
    // rejected by the rules, and the retry would just be a second denial.
    this.signedIn
      .then((uid) => {
        if (closed) return;
        detach = this.attach(project_id, uid, from_seq, onChange);
      })
      .catch(() => {
        // Status was already set by beginSignIn(); nothing to add, and rethrowing here would
        // surface as an unhandled rejection that says less than the status already does.
      });

    return () => {
      closed = true;
      detach?.();
      detach = null;
    };
  }

  private attach(
    project_id: ProjectId,
    uid: string,
    from_seq: Seq,
    onChange: (s: Snapshot) => void,
  ): () => void {
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
      if (!firstFrameSent) {
        // `live` only here: sign-in succeeding proves identity, not access. All six listeners
        // having delivered proves the rules actually let this uid read the project, which is
        // the thing the user cares about and the only honest moment to claim it.
        this.setStatus({ state: 'live', uid });
      }
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
    //
    // And it now RAISES the failure rather than only logging it. A console.warn is not a user
    // interface: the six warnings this used to emit were invisible to anyone not holding devtools
    // open, while the page showed a placeholder that means "almost there".
    const onErr = (name: string) => (err: unknown) => {
      console.warn(`[store] listener "${name}" failed`, err);
      const code = (err as { code?: string }).code;
      if (code === 'permission-denied') {
        // Not a member, or not admitted yet. The rules are working exactly as intended, so this
        // is a legitimate state to render rather than an error to swallow.
        this.setStatus({ state: 'denied', uid, project_id });
      } else {
        this.setStatus({
          state: 'error',
          detail: `listener "${name}": ${(err as { message?: string }).message ?? String(err)}`,
        });
      }
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
  // Against the emulator only the project id is meaningful: there is no credential to check,
  // and demanding a real apiKey would mean you could not run the board locally without one.
  const required = env.VITE_FIRESTORE_EMULATOR
    ? ['VITE_FIREBASE_PROJECT_ID']
    : ['VITE_FIREBASE_API_KEY', 'VITE_FIREBASE_PROJECT_ID', 'VITE_FIREBASE_APP_ID'];
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
    apiKey: env.VITE_FIREBASE_API_KEY ?? 'emulator-no-key',
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN ?? `${env.VITE_FIREBASE_PROJECT_ID}.firebaseapp.com`,
    projectId: env.VITE_FIREBASE_PROJECT_ID!,
    storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: env.VITE_FIREBASE_APP_ID ?? 'emulator-no-app-id',
  };
}

export function createFirestoreStore(opts?: Partial<FirestoreStoreOptions>): BrowserStore {
  const env = import.meta.env as unknown as Record<string, string | undefined>;
  const config = opts?.config ?? configFromEnv(env);
  return new BrowserFirestoreStore({
    ...opts,
    config,
    emulator: opts?.emulator ?? env.VITE_FIRESTORE_EMULATOR,
    auth_emulator: opts?.auth_emulator ?? env.VITE_AUTH_EMULATOR,
  });
}
