// A bundle built without client/.env carries no Firebase config, so initializeApp
// throws at module scope and #root stays empty: a blank page that ships green.
// This has happened twice. The build now refuses to finish without the config in it.
import { readFileSync, readdirSync } from 'node:fs';

const dir = 'dist/assets';
const js = readdirSync(dir).filter((f) => f.endsWith('.js'));
if (js.length === 0) { console.error('verify-bundle: no JS emitted in ' + dir); process.exit(1); }

const bundle = js.map((f) => readFileSync(`${dir}/${f}`, 'utf8')).join('');
const required = {
  'API key': /AIza[0-9A-Za-z_-]{30,}/,
  'project id': /multiplayer-agents-eec02/,
  'auth domain': /\.firebaseapp\.com/,
};

const missing = Object.entries(required).filter(([, re]) => !re.test(bundle)).map(([n]) => n);
if (missing.length) {
  console.error(`verify-bundle: FAIL - bundle is missing ${missing.join(', ')}.`);
  console.error('verify-bundle: client/.env is absent or incomplete. Regenerate it with:');
  console.error('  firebase apps:sdkconfig WEB --project multiplayer-agents-eec02');
  process.exit(1);
}
console.log(`verify-bundle: OK - Firebase config present in ${js.length} chunk(s).`);
