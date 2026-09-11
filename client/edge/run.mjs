// Build client/edge/cases.tsx with esbuild, run it, and separately assert the CSS rules that
// server-rendering cannot see.
//
// esbuild rather than vite because there is no page here -- just a bundle node can execute.
// react/react-dom are bundled in; nothing touches the network or a backend.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const client = path.resolve(here, '..');
const out = path.join(here, '.out.mjs');

// The JS API, not bin/esbuild: that path is the native Go binary in this install, and handing
// it to node produced a Mach-O header dumped as a SyntaxError.
const esbuild = await import(
  path.join(client, 'node_modules', 'esbuild', 'lib', 'main.js')
);
await esbuild.build({
  entryPoints: [path.join(here, 'cases.tsx')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  jsx: 'automatic',
  logLevel: 'warning',
  outfile: out,
  absWorkingDir: client,
  // react-dom/server is CJS and calls require('util'); bundling it into ESM turns that into a
  // "Dynamic require is not supported" throw. Leaving every bare import external lets node
  // resolve them from client/node_modules, which is also the copy vite bundles. Relative
  // imports -- the real components under test -- are still bundled.
  packages: 'external',
});

let code = 0;
try {
  execFileSync(process.execPath, [out], { stdio: 'inherit' });
} catch {
  code = 1;
}

// ---- the CSS half. Rendered markup cannot tell you whether a border is dashed. ----
const css = fs.readFileSync(path.join(client, 'src', 'tokens.css'), 'utf8');
const rule = (sel) => {
  const i = css.indexOf(sel);
  if (i < 0) return '';
  return css.slice(i, css.indexOf('}', i) + 1).replace(/\s+/g, '');
};
const cssChecks = [
  ['.empty{', 'borderdashed or dashed border', (r) => /1?\.?5?pxdashed/.test(r) || r.includes('dashed')],
  ['.panel{', 'position:absolute;right:0;z-index:20', (r) => r.includes('position:absolute') && r.includes('right:0') && r.includes('z-index:20')],
  ['.board{', 'padding-right 400px so the last column clears the panel', (r) => /padding:[^;]*400px/.test(r)],
  ['.card .title{', 'wraps rather than truncating', (r) => r.includes('overflow-wrap:break-word') && !r.includes('nowrap') && !r.includes('text-overflow')],
];
let cssFailed = 0;
console.log('\ntokens.css -- rules server-rendering cannot check:');
for (const [sel, label, ok] of cssChecks) {
  const r = rule(sel);
  const pass = !!r && ok(r);
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${sel.replace('{', '')} ${label}`);
  if (!pass) cssFailed += 1;
}
if (cssFailed > 0) code = 1;

fs.rmSync(out, { force: true });
process.exit(code);
