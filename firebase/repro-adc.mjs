// Reproduce order 0052: which commands leak "Could not load the default credentials"?
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const exec = promisify(execFile);
const repo = path.resolve(import.meta.dirname, '..');
const bin = path.join(repo, '.agentic', 'stranger', 'node_modules', '.bin', 'flotilla');
const HOME = path.join(repo, '.agentic', 'stranger', 'home');

const env = { ...process.env, HOME };
for (const k of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_TOKEN', 'GCLOUD_PROJECT',
  'GOOGLE_CLOUD_PROJECT', 'FLOTILLA_PROJECT', 'FLOTILLA_API_KEY', 'FB_PROJECT_ID']) delete env[k];

for (const args of [['ls'], ['members', 'proj_x'], ['new', 'X'], ['status']]) {
  let out = '';
  let code = 0;
  try {
    const r = await exec(bin, args, { env, cwd: repo, maxBuffer: 1 << 22 });
    out = r.stdout + r.stderr;
  } catch (e) {
    code = e.code ?? 1;
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  const leak = /default credentials/i.test(out);
  console.log(`${leak ? 'LEAK' : 'ok  '}  exit ${code}  flotilla ${args.join(' ')}`);
  console.log(`        ${out.trim().split('\n').filter(Boolean)[0]?.slice(0, 110) ?? '(no output)'}`);
}
