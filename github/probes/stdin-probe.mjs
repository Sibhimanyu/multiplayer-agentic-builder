// Does an unclosed stdin pipe wedge `git push`?
//
// Four hypotheses eliminated so far, each by measurement: the push shape (all
// five variants healthy), the network (1.9 s throughout), the GIT_ASKPASS env
// (all four variants healthy), and the FakeClock (real, fixed, but only ever
// affected tests).
//
// What is left is the one difference I had not varied: every probe so far
// spawned git from PYTHON, where `subprocess.run` gives the child an inherited
// stdin. The adapter spawns from NODE, where `spawn`'s default is a PIPE that
// is never written to and never closed.
//
// And the wedged process I captured was:
//     git send-pack --stateless-rpc ... --atomic ... --stdin
//
// If anything in that chain reads the top-level stdin, an open-but-silent pipe
// blocks forever, while an inherited or ignored one does not.
//
//   node github/probes/stdin-probe.mjs

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = 'https://github.com/Sibhimanyu/inventory-tracker-github.git';
const NS = 'refs/agentic/stdinprobe';
const TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const DEADLINE = 25_000;

const dir = mkdtempSync(join(tmpdir(), 'stdinprobe-'));
const g = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
g(['init', '--quiet']);
g(['config', 'user.email', 'p@e.invalid']);
g(['config', 'user.name', 'p']);
g(['remote', 'add', 'origin', REPO]);

const created = [];

function push(label, stdinMode) {
  return new Promise((resolve) => {
    const obj = g(['commit-tree', TREE, '-m', label]);
    const ref = `${NS}/${Date.now()}${Math.floor(Math.random() * 1000)}`;
    const args = [
      'push', '--porcelain', '--atomic',
      `--force-with-lease=${ref}:`, 'origin', `${obj}:${ref}`,
    ];
    const t0 = Date.now();
    const child = spawn('git', args, {
      cwd: dir,
      stdio: [stdinMode, 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', () => {});
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      console.log(`  ${label.padEnd(44)}  WEDGED (killed at ${DEADLINE / 1000}s)`);
      resolve();
    }, DEADLINE);
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const ms = Date.now() - t0;
      console.log(`  ${label.padEnd(44)} ${String(ms).padStart(6)} ms  rc=${code}`);
      if (code === 0) created.push(ref);
      void out;
      resolve();
    });
  });
}

console.log('spawned from NODE, varying ONLY the stdin mode:\n');
for (let i = 0; i < 3; i += 1) {
  console.log('round', i);
  // What the adapter does today: an open pipe nobody writes to or closes.
  await push("stdio[0]='pipe'  (what the adapter does)", 'pipe');
  // What Python's subprocess.run effectively gives the child.
  await push("stdio[0]='inherit'", 'inherit');
  // The safest: the child gets /dev/null and any read returns EOF at once.
  await push("stdio[0]='ignore'", 'ignore');
  console.log();
}

if (created.length) {
  for (let i = 0; i < created.length; i += 40) {
    execFileSync('git', ['push', '--quiet', 'origin', ...created.slice(i, i + 40).map((r) => `:${r}`)],
      { cwd: dir });
  }
}
console.log('cleanup: deleted', created.length, 'refs');
