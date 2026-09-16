/// <reference types="vite/client" />
// WHO THE BROWSER IS. One module, shared by the board and by the /login page.
//
// Order 0064. Before this, three places signed a browser in independently:
//
//   client/src/store/firebase.ts   signInAnonymously, unconditionally, in the constructor
//   client/src/store/projects.ts   signInAnonymously, unconditionally, in loadProjects
//   client/src/Login.tsx           Google redirect / popup / anonymous, the real provider handling
//
// The first two meant the board was ALWAYS a throwaway uid. The user created a real project owned
// by their Google account, the browser asked "which projects is anon_7f3… a member of", and the
// honest answer was none — so the board said "No projects yet" and was, on its own terms, correct.
// The two identities could never meet because nothing on the board could sign in as a person.
//
// The fix is not a fourth sign-in. The provider handling lives HERE and Login.tsx calls it, for
// the reason STALE_AFTER_MS was consolidated: two copies of one rule drift, and the drift is
// invisible until someone is looking at two screens that disagree.
//
// ---------------------------------------------------------------------------------------------
// PERSISTENCE: TWO PAGES IN THIS CODEBASE, TWO OPPOSITE CORRECT ANSWERS. DO NOT "FIX" EITHER.
//
//   cli/loginpage.ts (served by `flotilla login` on 127.0.0.1) uses inMemoryPersistence, and must.
//   That page exists to hand ONE credential to a terminal and then be closed. It runs on an
//   ephemeral loopback origin that the user did not choose to trust, so leaving a Google session
//   in that origin's IndexedDB is a credential left on the floor of a room nobody owns.
//
//   THE BOARD IS THE OPPOSITE and uses browserLocalPersistence, below. It is a place you return
//   to. A board that made you sign in on every reload would be wrong in the ordinary way — and
//   the uid IS the membership key, so losing it means losing your projects until you sign in
//   again.
//
// The hosted /login route shares the board's origin and therefore its persistence, which is fine:
// it is the same person and the same account, and a session left behind there is one they wanted.
// The argument above is about the LOOPBACK page, and that page is untouched.
// ---------------------------------------------------------------------------------------------

import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import {
  GoogleAuthProvider,
  browserLocalPersistence,
  connectAuthEmulator,
  getAuth,
  getRedirectResult,
  onAuthStateChanged,
  setPersistence,
  signInAnonymously,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type Auth,
  type User,
} from 'firebase/auth';

import { configFromEnv } from './config';

/**
 * Who this browser is, reduced to the three things the product asks.
 *
 * `anonymous` is carried explicitly rather than inferred from a missing email, because the board
 * has to be able to SAY "you are signed in anonymously, which is why you see no projects" — that
 * sentence is the whole of order 0064's complaint, and it cannot be said by a UI that only knows
 * it has a uid.
 */
export interface Session {
  uid: string;
  email: string | null;
  anonymous: boolean;
}

/** How a user is signed in. The board offers both; nothing chooses for them. */
export type SignInMethod = 'google' | 'anonymous';

export const sessionOf = (u: User | null): Session | null =>
  u ? { uid: u.uid, email: u.email, anonymous: u.isAnonymous } : null;

/**
 * The app + auth the BOARD uses.
 *
 * `getApps()[0]` rather than a fresh app: the board, the projects index and the /login route all
 * run in one document, and two FirebaseApps would mean two Auth instances and two answers to
 * "who am I" — which is a smaller version of the bug this order is about.
 */
export function boardApp(env?: Record<string, string | undefined>): FirebaseApp {
  const e = env ?? (import.meta.env as unknown as Record<string, string | undefined>);
  return getApps()[0] ?? initializeApp(configFromEnv(e));
}

export function boardAuth(app?: FirebaseApp, env?: Record<string, string | undefined>): Auth {
  const e = env ?? (import.meta.env as unknown as Record<string, string | undefined>);
  const auth = getAuth(app ?? boardApp(e));
  if (e.VITE_AUTH_EMULATOR) connectAuthEmulator(auth, e.VITE_AUTH_EMULATOR, { disableWarnings: true });
  return auth;
}

/**
 * Keep the session across reloads. See the persistence note at the top of this file.
 *
 * Deliberately awaited before any sign-in call rather than fired and forgotten: setPersistence
 * applies to sign-ins that happen AFTER it resolves, so racing it against signInWithRedirect is
 * how a "stay signed in" checkbox silently stops working.
 */
export const persistSession = (auth: Auth): Promise<void> => setPersistence(auth, browserLocalPersistence);

/**
 * THE provider handling. Login.tsx calls this; the board calls this.
 *
 * REDIRECT IS THE DEFAULT, and the reasoning is Login.tsx's, unchanged: signInWithPopup is blocked
 * by Safari's default settings, so popup-first would make "your browser blocked the sign-in popup"
 * the first-run experience on macOS. `popup` is an explicit opt-in, not a fallback — a
 * popup-then-fallback still flashes the failure on every Safari first run.
 *
 * Returns null on the redirect path because there is nothing to return to: the document is
 * leaving. The flow resumes via consumeRedirect() on the next load.
 */
export async function signInWithGoogle(auth: Auth, opts: { popup?: boolean } = {}): Promise<User | null> {
  if (opts.popup) return (await signInWithPopup(auth, new GoogleAuthProvider())).user;
  await signInWithRedirect(auth, new GoogleAuthProvider());
  return null;
}

export async function signInAnonymous(auth: Auth): Promise<User> {
  return (await signInAnonymously(auth)).user;
}

/**
 * Consume whatever Google left behind. MUST be called on every load, not only when the URL looks
 * like a return leg: it is what finishes a redirect, and Firebase resolves it to null when there
 * is nothing to finish.
 */
export async function consumeRedirect(auth: Auth): Promise<User | null> {
  const cred = await getRedirectResult(auth);
  return cred?.user ?? null;
}

export const signOutOf = (auth: Auth): Promise<void> => signOut(auth);

/**
 * Watch who is signed in. Fires immediately with the restored session, then on every change.
 *
 * onAuthStateChanged rather than a one-shot read because the restored session arrives
 * ASYNCHRONOUSLY — `auth.currentUser` is null for the first few milliseconds after a reload even
 * when a perfectly good session is in IndexedDB. Reading it once would render the sign-in screen
 * to someone who is already signed in, on every single reload.
 */
export function watchSession(auth: Auth, cb: (s: Session | null) => void): () => void {
  return onAuthStateChanged(auth, (u) => cb(sessionOf(u)));
}

/**
 * Classify a sign-in failure into something a person can act on.
 *
 * These are configuration, not outage, and they are fixed in different places; collapsing them
 * into "sign-in failed" sends someone to the wrong screen. Kept in the same vocabulary the board's
 * StoreStatus already uses so the two do not describe one failure two ways.
 */
export function explainAuthError(err: unknown): { code: string; detail: string } {
  const code = (err as { code?: string }).code ?? 'unknown';
  const detail = (err as { message?: string }).message ?? String(err);
  const known: Record<string, string> = {
    'auth/configuration-not-found':
      'Firebase Authentication is not enabled for this project. ' +
      'Firebase console -> Authentication -> Get started, then enable the provider you want.',
    'auth/operation-not-allowed':
      'That sign-in method is disabled for this project. ' +
      'Firebase console -> Authentication -> Sign-in method.',
    'auth/unauthorized-domain':
      'This domain is not in the Firebase authorised domains list. ' +
      'Firebase console -> Authentication -> Settings -> Authorized domains.',
    'auth/popup-blocked':
      'The browser blocked the sign-in popup. Reload and use the normal button, which redirects ' +
      'instead of opening a window.',
  };
  return { code, detail: known[code] ?? detail };
}
