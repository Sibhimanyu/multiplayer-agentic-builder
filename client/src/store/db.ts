// One Firestore handle per app, built the way Safari needs it.
//
// SAFARI IS WHY THIS FILE EXISTS. Firestore's default transport is WebChannel, a long-lived
// streaming connection. Safari — and any corporate proxy that buffers responses — can accept the
// connection and then never deliver the first chunk. The SDK has no timeout on that path, so
// `getDocs` does not fail: it never settles. Upstream that reads as a promise that is still
// pending, which is indistinguishable from a slow network and renders as "Connecting…" forever.
//
// `experimentalAutoDetectLongPolling` makes the SDK probe the connection and fall back to
// long-polling when the stream does not come through. It is the supported fix for exactly this
// and costs nothing where WebChannel works: the probe only changes behaviour when the stream is
// already broken.
//
// initializeFirestore MUST run before the first getFirestore for an app and MUST run once, so the
// handle is memoised per app rather than per module — client/edge/cases.tsx builds more than one.

import { type FirebaseApp } from 'firebase/app';
import { type Firestore, getFirestore, initializeFirestore } from 'firebase/firestore';

const handles = new WeakMap<FirebaseApp, Firestore>();

export function boardDb(app: FirebaseApp): Firestore {
  const existing = handles.get(app);
  if (existing) return existing;

  let db: Firestore;
  try {
    db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true });
  } catch {
    // Already initialised by someone else (a second constructor on the same app). Settling for
    // the existing handle is correct — throwing here would break a board that is otherwise fine.
    db = getFirestore(app);
  }
  handles.set(app, db);
  return db;
}
