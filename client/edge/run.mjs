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

// ---- ONE SOURCE RULE, BECAUSE RENDERING CANNOT SEE IT. Order 0064. ----
//
// The bug was not a wrong pixel or a wrong string: it was that two modules called
// signInAnonymously on their own initiative, so the board became a throwaway identity before any
// component existed to be rendered. No server-rendered assertion can observe that, and the next
// module that wants a uid in a hurry will reach for the same four lines.
//
// So: signing in lives in store/session.ts, and ONLY there. Everywhere else asks who is signed
// in. Stated as a rule with a named exception rather than a grep for a bug, so it fails when the
// rule is broken rather than when this particular bug returns.
const SIGNIN_OWNER = 'src/store/session.ts';
const srcFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.tsx?$/.test(e.name)) srcFiles.push(p);
  }
})(path.join(client, 'src'));

// Comments stripped first. The rule is about CALLS, and firebase.ts's own comment explains what
// it used to do -- a scan that cannot tell code from prose would forbid writing that down, which
// is the wrong incentive entirely. Crude (a `//` inside a string literal would be cut) and that
// is acceptable for a rule whose only job is to find a function call.
const code_only = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
const callsAnon = (f) => /\bsignInAnonymously\s*\(/.test(code_only(fs.readFileSync(f, 'utf8')));

const offenders = srcFiles.filter((f) => {
  const rel = path.relative(client, f).split(path.sep).join('/');
  if (rel === SIGNIN_OWNER) return false;
  return callsAnon(f);
});
console.log('\nsign-in ownership -- a rule rendering cannot check:');
console.log(
  `  ${offenders.length === 0 ? 'PASS' : 'FAIL'}  only ${SIGNIN_OWNER} may call signInAnonymously` +
    `${offenders.length ? ` -- also called by ${offenders.map((f) => path.relative(client, f)).join(', ')}` : ''}`,
);
// The control: the rule is only meaningful if the scan can see the call it is looking for.
const ownerHasIt = callsAnon(path.join(client, SIGNIN_OWNER));
console.log(
  `  ${ownerHasIt ? 'PASS' : 'FAIL'}  (control) the scan does find that call in ${SIGNIN_OWNER}`,
);
if (offenders.length > 0 || !ownerHasIt) code = 1;

// ---- THE BRAND MARK IS A COMPONENT, NOT A LITERAL. Order 0065. ----
//
// A browser measures whether the mark renders; client/edge/layout-shot.mjs does that. This rule
// is here because of HOW the regression happened: not an edit, but a branch consolidation that
// restored an older components.tsx wholesale, and three files quietly went back to
// `<div className="mark">FL</div>`. A grep catches that without needing Chromium, which means it
// catches it on a machine that has not installed one.
//
// The literal is still allowed inside BrandLockup, because that is where the fallback lives.
const MARK_OWNER = 'src/components.tsx';
const bareMark = /<div\s+className="mark"/;
const markOffenders = srcFiles.filter((f) => bareMark.test(code_only(fs.readFileSync(f, 'utf8'))));
console.log('\nbrand mark ownership -- the shape the regression had:');
console.log(
  `  ${markOffenders.length === 0 ? 'PASS' : 'FAIL'}  no file renders a bare <div className="mark">` +
    `${markOffenders.length ? ` -- ${markOffenders.map((f) => path.relative(client, f)).join(', ')}` : ''}`,
);
// The control: a rule that cannot see its own subject proves nothing. BrandLockup must exist and
// must be the thing referencing the asset.
const ownerSrc = fs.readFileSync(path.join(client, MARK_OWNER), 'utf8');
const ownsAsset = /export function BrandLockup/.test(ownerSrc)
  && /\/brand\/flotilla-mark\.svg/.test(ownerSrc);
console.log(
  `  ${ownsAsset ? 'PASS' : 'FAIL'}  (control) BrandLockup exists in ${MARK_OWNER} and references the asset`,
);
// And nothing else may reference the asset path directly -- a second <img> is a second place to
// forget, which is exactly how this happened.
const assetRefs = srcFiles.filter((f) => {
  const rel = path.relative(client, f).split(path.sep).join('/');
  return rel !== MARK_OWNER && /\/brand\/flotilla-mark\.svg/.test(code_only(fs.readFileSync(f, 'utf8')));
});
console.log(
  `  ${assetRefs.length === 0 ? 'PASS' : 'FAIL'}  only BrandLockup references /brand/flotilla-mark.svg` +
    `${assetRefs.length ? ` -- also ${assetRefs.map((f) => path.relative(client, f)).join(', ')}` : ''}`,
);
if (markOffenders.length > 0 || !ownsAsset || assetRefs.length > 0) code = 1;

fs.rmSync(out, { force: true });
process.exit(code);
