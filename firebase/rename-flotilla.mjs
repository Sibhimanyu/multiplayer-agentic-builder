// One-shot rename: Flotilla -> Flotilla, decision 0004.
//
// Case-preserving, across source only. Excludes node_modules, .git, build output (dist/, lib/)
// and .agentic/ scratch -- build output is regenerated and is where the VERIFICATION looks, so
// rewriting it here would be editing the evidence.
//
// Every occurrence of "flotilla" in this repo is the product name: the role slugs are
// backend-builder / frontend-builder and the Firebase project is multiplayer-agents-eec02, so
// unlike the `builder` rename there is no data collision to police. Checked before running this,
// not assumed -- that collision is exactly what made the last rename need care.
import fs from 'node:fs';
import path from 'node:path';

const repo = path.resolve(import.meta.dirname, '..');
const SKIP = new Set(['node_modules', '.git', 'dist', 'lib', '.agentic', '.firebase']);
const EXT = new Set(['.ts', '.tsx', '.mjs', '.js', '.json', '.md', '.html', '.css', '.sh', '.yml', '.yaml']);

const replacements = [
  [/FLOTILLA_/g, 'FLOTILLA_'],
  [/Flotilla/g, 'Flotilla'],
  [/flotilla/g, 'flotilla'],
  [/Flotilla/g, 'Flotilla'],
];

let files = 0;
let hits = 0;
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { walk(p); continue; }
    if (!EXT.has(path.extname(e.name))) continue;
    const before = fs.readFileSync(p, 'utf8');
    if (!/flotilla/i.test(before)) continue;
    let after = before;
    for (const [re, to] of replacements) after = after.replace(re, to);
    if (after !== before) {
      hits += (before.match(/flotilla/gi) ?? []).length;
      fs.writeFileSync(p, after, 'utf8');
      files += 1;
      console.log(`  ${path.relative(repo, p)}`);
    }
  }
};

walk(repo);
console.log(`\n${hits} occurrences rewritten across ${files} files`);
