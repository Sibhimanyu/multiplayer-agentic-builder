// Re-export the admin SDK from a file that sits next to the node_modules containing it.
//
// Node resolves a BARE specifier from the importing file's own directory upward. firebase-admin
// is installed under firebase/, so `import 'firebase-admin/app'` works from firebase/*.ts and
// fails from flotilla/*.mjs -- which is where the stranger harness wanted to verify things.
//
// A RELATIVE import of this file works from anywhere in the repo, and the bare specifier is
// resolved here, where it resolves. One indirection instead of a hardcoded ../firebase/node_modules
// path that would break the moment the install layout changed.

export { deleteApp, initializeApp } from 'firebase-admin/app';
export { getAuth } from 'firebase-admin/auth';
export { getFirestore } from 'firebase-admin/firestore';
