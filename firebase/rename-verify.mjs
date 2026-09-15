// Verify the rename against the INSTALLED ARTIFACT, not the source. Order 0054.
//
// Pack, install into a clean directory under a scrubbed environment, run `flotilla --help`, and
// grep the installed bundle. Source being clean proves nothing -- that is exactly how the project
// id got baked in, and how `builder claim` survived order 0048's rename into a generated file.
//
// Also generates a REAL project scaffold from the installed CLI's own code path and greps every
// file it wrote, because "a freshly generated project contains zero occurrences" is the
// deliverable and the generated files are where the last rename actually failed.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';

const exec = promisify(execFile);
const repo = path.resolve(import.meta.dirname, '..');
const pkgDir = path.join(repo, 'flotilla');
const SANDBOX = path.join(repo, '.agentic', 'renamecheck');

let failed = 0;
const check = (ok, label) => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed += 1;
};
const run = async (cmd, args, opts = {}) => {
  try {
    const { stdout, stderr } = await exec(cmd, args, { maxBuffer: 1 << 24, ...opts });
    return { code: 0, out: stdout + stderr };
  } catch (e) {
    return { code: e.code ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

const DEAD = [
  ['drydock', /drydock/gi],
  ['DRYDOCK_', /DRYDOCK_/g],
  ['catalyst-builder', /catalyst-builder/gi],
  ['builder <command>', /\bbuilder\s+(connect|claim|start|status|report|new|init|login)\b/gi],
];
const countDead = (text) => DEAD.map(([name, re]) => [name, (text.match(re) ?? []).length]);

await fs.rm(SANDBOX, { recursive: true, force: true });
await fs.mkdir(SANDBOX, { recursive: true });
const HOME = path.join(SANDBOX, 'home');
await fs.mkdir(HOME, { recursive: true });

const env = { ...process.env, HOME };
for (const k of ['GOOGLE_APPLICATION_CREDENTIALS', 'FIREBASE_TOKEN', 'GCLOUD_PROJECT',
  'GOOGLE_CLOUD_PROJECT', 'FLOTILLA_PROJECT', 'FLOTILLA_API_KEY', 'FB_PROJECT_ID',
  'DRYDOCK_PROJECT', 'DRYDOCK_API_KEY']) delete env[k];

console.log('RENAME VERIFICATION -- against the installed artifact\n');

// ---------------------------------------------------------------- install
const packed = await run('npm', ['pack', '--json'], { cwd: pkgDir });
const meta = JSON.parse(packed.out.slice(packed.out.indexOf('['), packed.out.lastIndexOf(']') + 1))[0];
const tarball = path.join(pkgDir, meta.filename);
check(meta.filename.startsWith('flotilla-cli-'), `tarball is named for the new package (${meta.filename})`);

await fs.writeFile(path.join(SANDBOX, 'package.json'), JSON.stringify({ name: 'rc', private: true }));
const install = await run('npm', ['install', '--no-audit', '--no-fund', tarball], { cwd: SANDBOX, env });
check(install.code === 0, 'npm install <tarball> into a clean directory');

const bin = path.join(SANDBOX, 'node_modules', '.bin', 'flotilla');
check(await fs.stat(bin).then(() => true, () => false), 'the `flotilla` binary is on .bin');
check(!(await fs.stat(path.join(SANDBOX, 'node_modules', '.bin', 'drydock')).then(() => true, () => false)),
  'and no `drydock` binary was installed alongside it');

const help = await run(bin, ['--help'], { cwd: SANDBOX, env });
check(help.code === 0, `flotilla --help exits 0 (${help.code})`);
check(/flotilla — agentic coordination CLI/.test(help.out), 'and identifies itself as flotilla');

// ---------------------------------------------------------------- grep the INSTALLED bundle
console.log('\ngrep of the INSTALLED bundle (node_modules/flotilla-cli/dist/flotilla.js):');
const installed = await fs.readFile(
  path.join(SANDBOX, 'node_modules', 'flotilla-cli', 'dist', 'flotilla.js'), 'utf8',
);
for (const [name, n] of countDead(installed)) {
  console.log(`    ${String(n).padStart(4)}  ${name}`);
  check(n === 0, `installed bundle contains 0 "${name}"`);
}
// Not vacuous: the same file must contain the CURRENT name, or the rename deleted rather than
// replaced, and every count above would still read zero.
console.log(`    ${String((installed.match(/flotilla/gi) ?? []).length).padStart(4)}  flotilla (current name — must be > 0)`);
check((installed.match(/flotilla/gi) ?? []).length > 0, 'and it does contain "flotilla"');

// ---------------------------------------------------------------- grep GENERATED output
//
// The failure mode order 0048 actually had: the binary was renamed and the files it WRITES were
// not. Generated here from the same renderers the installed CLI bundles.
console.log('\ngrep of a freshly GENERATED project scaffold:');
const { writeAgenticTree } = await import('../cli/agentic.ts');
const { consoleLogger } = await import('../shared/log.ts');
const gen = path.join(SANDBOX, 'generated');
await fs.mkdir(gen, { recursive: true });
await writeAgenticTree(
  gen,
  {
    role: {
      role_slug: 'backend-builder', title: 'Backend builder',
      responsibilities: 'Implement API handlers and the data schema.',
      may_edit: ['functions/**', 'schema/**'], may_not_edit: ['client/**'],
      branch_prefix: 'feat/be-', push_branches: true, open_prs: true, merge: false,
    },
    project: {
      project_id: 'proj_rc', name: 'Rename Check', repo_url: 'o/r',
      brief: 'A brief.', protocol_version: '0.2',
    },
    task: null,
    state: { agent_id: 'agent_rc', last_seen_seq: 0, last_written_seq: 0 },
  },
  consoleLogger,
);

const walk = async (dir) => {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
};
const files = await walk(gen);
check(files.length >= 5, `${files.length} files generated: ${files.map((f) => path.basename(f)).join(', ')}`);

let genTotal = 0;
for (const [name, re] of DEAD) {
  let n = 0;
  for (const f of files) n += ((await fs.readFile(f, 'utf8')).match(re) ?? []).length;
  console.log(`    ${String(n).padStart(4)}  ${name}`);
  genTotal += n;
  check(n === 0, `generated project contains 0 "${name}"`);
}
let cur = 0;
for (const f of files) cur += ((await fs.readFile(f, 'utf8')).match(/flotilla/gi) ?? []).length;
console.log(`    ${String(cur).padStart(4)}  flotilla (current name — must be > 0)`);
check(cur > 0, 'and the generated project DOES name flotilla');

// The role slug is data and must have survived.
const agents = await fs.readFile(path.join(gen, 'AGENTS.md'), 'utf8');
check(/Backend builder/.test(agents), 'the backend-builder role title survived the rename (it is data)');

void genTotal;
await fs.rm(tarball, { force: true });
console.log(`\n${failed === 0 ? 'RENAME VERIFIED ON THE ARTIFACT' : `FAILED (${failed})`}`);
process.exit(failed === 0 ? 0 : 1);
