// One-shot: add VITE_FIREBASE_DATABASE_URL to client/.env.local if it is not already there.
// .env.local is gitignored, so it cannot be updated by a commit.
import fs from 'node:fs';

const path = new URL('../client/.env.local', import.meta.url);
const URL_LINE = 'VITE_FIREBASE_DATABASE_URL=https://multiplayer-agents-eec02-default-rtdb.firebaseio.com';
let s = fs.readFileSync(path, 'utf8');

if (s.includes('VITE_FIREBASE_DATABASE_URL=')) {
  console.log('already set');
} else {
  s = `${s.replace(/\n*$/, '\n')}\n# RTDB owns presence. us-central1 (decision 0003).\n${URL_LINE}\n`;
  fs.writeFileSync(path, s, 'utf8');
  console.log('added VITE_FIREBASE_DATABASE_URL');
}
console.log(s.split('\n').filter((l) => l.includes('=')).map((l) => l.split('=')[0]).join(', '));
