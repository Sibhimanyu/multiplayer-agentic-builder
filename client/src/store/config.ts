/// <reference types="vite/client" />
// Reading the Firebase web config out of the build environment.
//
// Split out of store/firebase.ts by order 0064 for one reason: store/session.ts needs
// configFromEnv to build the app it signs into, and store/firebase.ts needs session.ts to learn
// who is signed in. Left in one file that is an import cycle, and an import cycle between two
// modules that both run at startup is the kind of thing that works until a bundler reorders it.
//
// Nothing here changed. firebase.ts re-exports both names, so every existing caller and the edge
// harness import exactly what they did before.

import type { FirebaseOptions } from 'firebase/app';

/**
 * Which origin hosts the Firebase auth handler.
 *
 * SAFARI IS WHY THIS IS NOT JUST THE CONFIGURED VALUE. Firebase's default authDomain is
 * `<project>.firebaseapp.com`, a DIFFERENT ORIGIN from the board at `<project>.web.app`. The
 * redirect sign-in flow parks state in that origin's storage and reads it back on return, and
 * Safari's Intelligent Tracking Prevention partitions exactly that — so getRedirectResult comes
 * back null and the user lands on a page that says sign-in was cancelled when it was not.
 *
 * Firebase Hosting serves the handler on EVERY site connected to the project, so when the board
 * is itself served from a Hosting domain the auth handler is available same-origin and ITP has
 * nothing to partition. Verified: https://<project>.web.app/__/auth/handler returns 200.
 *
 * A CUSTOM authDomain still wins — that is the other supported way to make these same-origin and
 * this must not override someone who has set one up. But `<project>.firebaseapp.com` is treated
 * as unset, because that is the value the Firebase console hands out: it is the default written
 * down, not a decision. Our own client/.env.local had exactly that, which would have silently
 * defeated this fix while every test still passed.
 */
export function authDomainFor(
  env: Record<string, string | undefined>,
  location: { hostname: string } | undefined =
    typeof window === 'undefined' ? undefined : window.location,
): string {
  const fallback = `${env.VITE_FIREBASE_PROJECT_ID}.firebaseapp.com`;
  const configured = env.VITE_FIREBASE_AUTH_DOMAIN;
  if (configured && configured !== fallback) return configured;

  const host = location?.hostname ?? '';
  // Only for the project's OWN Hosting domains. Any other host does not serve /__/auth/handler,
  // and pointing authDomain at one would break sign-in everywhere rather than fix it in Safari.
  if (host === `${env.VITE_FIREBASE_PROJECT_ID}.web.app` || host === fallback) return host;
  return fallback;
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
    authDomain: authDomainFor(env),
    projectId: env.VITE_FIREBASE_PROJECT_ID!,
    storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
    appId: env.VITE_FIREBASE_APP_ID ?? 'emulator-no-app-id',
  };
}
