// Generate docs/board.html — the one-page overview of what Flotilla is.
//
// THE BOARD IS DERIVED, NOT WRITTEN. It started as a hand-made page and would have been a lie
// inside a week: a role gains a capability, a ticket type is added, one of the unbuilt steps
// ships, and the picture everyone reasons from still shows last month. So everything on it that
// CAN be read from the source is read from the source, and `cli/board.test.ts` fails when the
// committed HTML differs from a fresh render. A stale board is a red build, not a quiet lie.
//
//   npm run board          regenerate docs/board.html
//   npm run board:check    fail if it is out of date (what the test calls)
//
// WHAT IS DERIVED, and from where:
//   roles, file scopes, capabilities   shared/store/directory.ts   DEFAULT_ROLES
//   ticket types                       shared/store/tasks.ts       TASK_KINDS
//   which ticket types no role owns    the two above, compared
//   whether the PR/merge steps work    functions/src/index.ts      is githubWebhook exported
//   the CLI's command list             cli/index.ts                the USAGE block
//
// WHAT IS DECLARED, because no file states it: the prose of the three rules, the wording of the
// seven steps, and the gaps that are facts about the world rather than about the code ("two
// agents at once has never been run"). Those live in DECLARED below, in one place, so it is
// obvious what is asserted versus measured.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_ROLES, ROLE_SLUGS, type Capability, type RoleSlug } from '../shared/store/directory.ts';
import { TASK_KINDS } from '../shared/store/tasks.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'docs', 'board.html');

const read = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf8');

// ---- declared -------------------------------------------------------------------------------

/** Capabilities that change production. These invert to a filled chip; everything else outlines. */
const PRIVILEGED = new Set<Capability>(['invite', 'deploy', 'open_pr']);

/**
 * One line per role, because "what is this person for" is not in the type.
 *
 * THE ONE THING A NEW ROLE STILL NEEDS BY HAND. Adding a seventh role used to crash this script
 * with `Cannot read properties of undefined (reading 'replace')` from inside the HTML escaper --
 * a stack trace that names the escaper and not the missing note. `assertNotes()` turns that into
 * a sentence naming the role and this constant.
 */
const ROLE_NOTE: Record<string, string> = {
  owner: 'you',
  architect: 'decides shape',
  backend: 'server',
  frontend: 'the app UI',
  qa: 'tests',
  user: 'the people who use what you ship',
};

const DECLARED = {
  surfaces: [
    {
      kind: 'web', name: 'The board', sub: 'in any browser',
      does: ['Sign in with Google', 'Raise a suggestion', 'See every ticket', 'Who holds which files'],
      who: 'everyone, users included',
    },
    {
      kind: 'terminal', name: 'The CLI', sub: 'flotilla',
      does: ['Join a project', 'Claim a ticket', 'Push your branch', 'Keeps you online'],
      who: 'anyone with an agent',
    },
    {
      kind: 'browser, local', name: 'The chat', sub: 'flotilla chat',
      does: ['Talk to your agent', 'It knows your ticket', 'Sees the live fleet', 'Edits only your files'],
      who: 'designers, non-terminal folk',
    },
  ],
  /** `built` on the last two is OVERWRITTEN below by what the source actually says. */
  steps: [
    { t: 'Raised or suggested', w: 'user or dev', built: true },
    { t: 'Anyone picks it up', w: 'triage = claim', built: true },
    { t: 'Their files lock', w: 'automatic', built: true },
    { t: 'Agent works', w: 'their machine', built: true },
    { t: 'Branch pushed', w: 'flotilla ship', built: true },
    { t: 'PR opened', w: 'by hand', built: false },
    { t: 'Merged, lock freed', w: 'not built', built: false },
  ],
  rules: [
    {
      n: 'I', b: 'Your agent, your machine',
      body: 'Everyone runs their own Claude or Codex on their own subscription. Flotilla holds no keys and runs no models.',
    },
    {
      n: 'II', b: 'One ticket, one set of files',
      body: 'Claiming locks the files. Nobody else can take overlapping files until you are done, so two agents cannot edit the same thing.',
    },
    {
      n: 'III', b: 'Your role is a fence',
      body: 'Frontend cannot touch the server. It is refused, not merely discouraged.',
    },
  ],
  /** Gaps that are facts about the world. Code-derived gaps are appended to these. */
  gaps: [
    '<b>A user cannot raise anything yet from the web.</b> The seat, the four report types and the API exist; the sign-in form and the suggestions lane on the board do not.',
    '<b>Hand-out is first come, not planned.</b> <code>flotilla claim</code> gives you the oldest open ticket inside your fence; nothing decides who <em>should</em> do what, or in which order.',
    '<b>Several agents at once has run on one machine only.</b> Three checkouts shared a repo and the locks held, but every checkout was signed in as the same person.',
    '<b>Nobody reviews anybody&rsquo;s work</b> inside the product.',
  ],
};

// ---- derived --------------------------------------------------------------------------------

/**
 * Are the PR and merge steps real?
 *
 * `githubWebhook` is the only thing authorised to emit `branch_pushed`, `pr_opened` and `merged`
 * (functions/src/authority.ts reserves them to actor `github`). It is defined in
 * functions/src/index.ts and, as of writing, never exported — so it has never deployed and the
 * board never learns a branch exists. Read rather than remembered: the day someone exports it,
 * this page stops claiming the steps are missing.
 */
function webhookLive(): boolean {
  const src = read('functions/src/index.ts');
  return /^export\s+const\s+githubWebhook\b/m.test(src);
}

/** Ticket types that no role's slug accounts for. `docs` is one today. */
function unownedKinds(): string[] {
  const slugs = new Set<string>(ROLE_SLUGS);
  return TASK_KINDS.filter((k) => !slugs.has(k));
}

/** The CLI's own command list, from its USAGE block, so the surface card cannot go stale. */
function cliCommands(): string[] {
  const src = read('cli/index.ts');
  const names = new Set<string>();
  for (const m of src.matchAll(/^ {2}flotilla ([a-z-]+)/gm)) names.add(m[1]!);
  return [...names];
}

/**
 * Every role has a note, or say which does not and stop.
 *
 * Exported so `cli/board.test.ts` fails in the fast suite the moment a role is added, rather
 * than at the next time somebody happens to regenerate.
 */
export function missingNotes(): string[] {
  return ROLE_SLUGS.filter((s) => typeof ROLE_NOTE[s] !== 'string');
}

function assertNotes(): void {
  const missing = missingNotes();
  if (missing.length === 0) return;
  console.error(
    `board: ${missing.length} role(s) have no one-line note: ${missing.join(', ')}\n` +
    `  Add each to ROLE_NOTE in scripts/board.ts. It is the one thing about a role that\n` +
    '  cannot be read from shared/store/directory.ts, so it has to be written once.',
  );
  process.exit(1);
}

// ---- render ---------------------------------------------------------------------------------

const esc = (s: string): string =>
  s.replace(/&(?!#?\w+;)/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const capLabel: Partial<Record<Capability, string>> = {
  acquire_scope: 'lock files',
  publish_contract: 'contracts',
  open_pr: 'open pr',
};

function roleRow(slug: RoleSlug): string {
  const r = DEFAULT_ROLES[slug];
  const scope = r.file_scope.length === 0
    ? '<span class="g none">nothing</span>'
    // `**` means everything, and saying so beats printing the glob on a page for non-engineers.
    : r.file_scope.map((g) => `<span class="g">${esc(g === '**' ? 'everything' : g)}</span>`).join('');

  // Privileged first, so the eye lands on what can change production. `suggest` is every role's
  // floor, so it is only worth showing on the role that has nothing else.
  const caps = [...r.capabilities]
    .filter((c) => c !== 'suggest' || r.capabilities.length === 1)
    .sort((a, b) => Number(PRIVILEGED.has(b)) - Number(PRIVILEGED.has(a)))
    .map((c) => {
      const label = c === 'suggest' ? 'suggest only' : (capLabel[c] ?? c.replace(/_/g, ' '));
      return `<span class="cap${PRIVILEGED.has(c) ? ' hot' : ''}">${esc(label)}</span>`;
    })
    .join('');

  // The user row inverts entirely: its emptiness IS the role, and inversion says that without
  // needing a colour or a caption.
  const invert = r.file_scope.length === 0 && r.capabilities.length === 1 ? ' invert' : '';
  return `    <div class="rrow${invert}">
      <div class="rname">${esc(slug[0]!.toUpperCase() + slug.slice(1))}<small>${esc(ROLE_NOTE[slug])}</small></div>
      <div>${scope}</div>
      <div>${caps}</div>
    </div>`;
}

function render(): string {
  const live = webhookLive();
  const steps = DECLARED.steps.map((s, i) =>
    // The last two steps are true exactly when the webhook ships. Nothing else on this page
    // needs editing on that day.
    i >= 5 ? { ...s, built: live, w: live ? 'automatic' : s.w } : s);
  const builtCount = steps.filter((s) => s.built).length;

  const gaps: string[] = [];
  if (!live) {
    gaps.push('<b>Steps 6 and 7 are manual.</b> The board never learns a branch exists, '
      + 'so tickets sit on &ldquo;claimed&rdquo; forever.');
  }
  gaps.push(...DECLARED.gaps);
  for (const k of unownedKinds()) {
    gaps.push(`A <code>${esc(k)}</code> ticket type exists, but <b>no role owns ${esc(k)}.</b>`);
  }

  const cli = cliCommands();
  const date = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Flotilla — the whole thing on one board</title>
<!-- GENERATED BY scripts/board.ts. Do not edit: run \`npm run board\`.
     ${ROLE_SLUGS.length} roles and ${TASK_KINDS.length} ticket types read from
     shared/store/, the PR/merge state read from functions/src/index.ts,
     ${cli.length} CLI commands read from cli/index.ts. -->
<style>
  :root{
    /* Monochrome only. No accent hue anywhere: hierarchy comes from WEIGHT, SIZE and GROUND
       inversion, which is what makes a black-and-white board read as designed rather than as
       drained of colour. */
    --paper:#FFFFFF;
    --panel:#F4F4F2;      /* a hair warm, so white-on-white edges still read */
    --ink:#0A0A0A;
    --ink2:#3D3D3D;
    --mid:#6B6B6B;        /* 5.3:1 on paper, 4.9:1 on panel — legal as body text */
    --hair:#E2E2DF;
    --rule:#0A0A0A;

    /* Helvetica Neue carries Regular through Black on every Mac. Chosen for the look, not
       inherited as a default stack: a grotesk at 800 with tight tracking IS this design. */
    --sans:'Helvetica Neue',Helvetica,Arial,sans-serif;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;

    --t-0:11px; --t-1:12px; --t-2:14px; --t-3:17px; --t-4:21px; --t-5:28px; --t-6:40px; --t-7:64px;
    --sp-2:4px; --sp-3:6px; --sp-4:8px; --sp-5:12px; --sp-6:16px; --sp-7:24px; --sp-8:32px;
    --sp-9:48px; --sp-10:72px;
    color-scheme:light;
  }
  *{box-sizing:border-box;margin:0;padding:0;min-width:0}
  body{background:var(--paper);color:var(--ink);
       font:400 var(--t-2)/1.5 var(--sans);-webkit-font-smoothing:antialiased;
       padding:var(--sp-10) var(--sp-7)}
  .wrap{max-width:1080px;margin:0 auto}
  ::selection{background:var(--ink);color:var(--paper)}

  header{border-bottom:3px solid var(--rule);padding-bottom:var(--sp-6);margin-bottom:var(--sp-9)}
  .kicker{font-family:var(--mono);font-size:var(--t-0);letter-spacing:.18em;text-transform:uppercase;
          color:var(--mid);display:flex;justify-content:space-between;margin-bottom:var(--sp-6);
          gap:var(--sp-5);flex-wrap:wrap}
  h1{font-size:var(--t-7);font-weight:800;letter-spacing:-.04em;line-height:.95;
     text-wrap:balance;display:flex;align-items:center;gap:var(--sp-6)}
  .mk{width:44px;height:36px;flex:none}

  .sec{margin-top:var(--sp-10)}
  .sec > h2{font-size:var(--t-4);font-weight:800;letter-spacing:-.02em;
            padding-bottom:var(--sp-4);border-bottom:1px solid var(--rule);
            margin-bottom:var(--sp-6);display:flex;align-items:baseline;gap:var(--sp-5)}
  .sec > h2 .num{font-family:var(--mono);font-size:var(--t-1);font-weight:400;color:var(--mid);
                 letter-spacing:.1em}

  .roles{border-top:1px solid var(--hair)}
  .rrow{display:grid;grid-template-columns:200px 1fr 300px;gap:var(--sp-6);
        padding:var(--sp-6) 0;border-bottom:1px solid var(--hair);align-items:center}
  .rrow.head{padding:var(--sp-4) 0;border-bottom:1px solid var(--rule);
             font-family:var(--mono);font-size:var(--t-0);color:var(--mid);
             letter-spacing:.14em;text-transform:uppercase}
  .rname{font-size:var(--t-4);font-weight:800;letter-spacing:-.025em;line-height:1}
  .rname small{display:block;font:400 var(--t-1)/1.3 var(--mono);color:var(--mid);
               letter-spacing:.02em;margin-top:var(--sp-3);text-transform:none}
  .g{font-family:var(--mono);font-size:var(--t-1);padding:3px var(--sp-4);
     background:var(--panel);border:1px solid var(--hair);color:var(--ink2);
     display:inline-block;margin:2px 3px 2px 0;overflow-wrap:anywhere}
  .g.none{color:var(--mid);background:none;border-style:dashed}
  /* Filled means "this one can change production". That is the whole colour system. */
  .cap{font-family:var(--mono);font-size:var(--t-0);padding:4px var(--sp-4);
       display:inline-block;margin:3px 3px 0 0;letter-spacing:.04em;
       border:1.5px solid var(--ink);color:var(--ink);font-weight:500;text-transform:uppercase;
       white-space:nowrap}
  .cap.hot{background:var(--ink);color:var(--paper)}
  .rrow.invert{background:var(--ink);color:var(--paper);padding:var(--sp-6);margin-top:-1px}
  .rrow.invert .rname small{color:#9A9A9A}
  .rrow.invert .g.none{color:#9A9A9A;border-color:#4A4A4A}
  .rrow.invert .cap{border-color:var(--paper);color:var(--paper)}

  .three{display:grid;grid-template-columns:repeat(3,1fr);border:1px solid var(--rule)}
  .surf{padding:var(--sp-7);display:grid;gap:var(--sp-5);align-content:start;
        border-right:1px solid var(--hair)}
  .surf:last-child{border-right:none}
  .surf .ic{font-family:var(--mono);font-size:var(--t-0);letter-spacing:.16em;
            text-transform:uppercase;color:var(--mid)}
  .surf .nm{font-size:var(--t-5);font-weight:800;letter-spacing:-.035em;line-height:.98}
  .surf .nm code{display:block;font:400 var(--t-1)/1 var(--mono);color:var(--mid);
                 letter-spacing:0;margin-top:var(--sp-4)}
  .surf ul{list-style:none;display:grid;gap:var(--sp-4);margin-top:var(--sp-3)}
  .surf li{font-size:var(--t-2);color:var(--ink2);padding-left:18px;position:relative;
           font-weight:500}
  .surf li::before{content:'';position:absolute;left:0;top:8px;width:7px;height:2px;
                   background:var(--ink)}
  .who-for{font-family:var(--mono);font-size:var(--t-0);color:var(--mid);letter-spacing:.06em;
           border-top:1px solid var(--hair);padding-top:var(--sp-5);margin-top:var(--sp-3)}

  .flow{display:grid;grid-template-columns:repeat(${steps.length},1fr);border:1px solid var(--rule)}
  .step{padding:var(--sp-6) var(--sp-5);display:grid;gap:var(--sp-4);align-content:start;
        border-right:1px solid var(--hair)}
  .step:last-child{border-right:none}
  .step .n{font-family:var(--mono);font-size:var(--t-5);font-weight:400;line-height:.8;
           color:var(--hair);letter-spacing:-.04em}
  .step .t{font-size:var(--t-2);font-weight:700;line-height:1.2;letter-spacing:-.015em}
  .step .w{font-family:var(--mono);font-size:var(--t-0);color:var(--mid);letter-spacing:.04em}
  /* Not built is said with a hatch and a word, never with a colour. */
  .step.dead{background:repeating-linear-gradient(135deg,
      var(--panel) 0 6px, transparent 6px 12px)}
  .step.dead .t{color:var(--mid)}
  .step.dead .w{background:var(--ink);color:var(--paper);padding:2px var(--sp-3);
                justify-self:start;font-weight:500}

  .rules{display:grid;grid-template-columns:repeat(3,1fr);gap:var(--sp-7)}
  .rule .rn{font-family:var(--mono);font-size:var(--t-0);color:var(--mid);letter-spacing:.14em;
            display:block;margin-bottom:var(--sp-5)}
  .rule b{display:block;font-size:var(--t-4);font-weight:800;letter-spacing:-.03em;
          line-height:1.05;margin-bottom:var(--sp-5);text-wrap:balance}
  .rule span.body{font-size:var(--t-2);color:var(--ink2);line-height:1.55;display:block;
                  font-weight:400}

  .gap{background:var(--ink);color:var(--paper);padding:var(--sp-8)}
  .gap h3{font-size:var(--t-5);font-weight:800;letter-spacing:-.035em;margin-bottom:var(--sp-7);
          line-height:1}
  .gap ul{list-style:none}
  .gap li{font-size:var(--t-2);color:#D6D6D6;padding:var(--sp-5) 0 var(--sp-5) 42px;
          position:relative;border-top:1px solid #2A2A2A;font-weight:500}
  .gap li:first-child{border-top:none}
  .gap li b{color:var(--paper);font-weight:700}
  .gap li .no{position:absolute;left:0;top:var(--sp-5);font-family:var(--mono);font-size:var(--t-0);
              color:#8A8A8A;letter-spacing:.08em}
  .gap code{font-family:var(--mono);font-size:var(--t-1);border:1px solid #4A4A4A;
            padding:1px var(--sp-3);color:var(--paper)}
  .gap .clear{font-size:var(--t-2);color:#D6D6D6;font-weight:500}

  footer{margin-top:var(--sp-9);padding-top:var(--sp-6);border-top:3px solid var(--rule);
         font-family:var(--mono);font-size:var(--t-0);color:var(--mid);letter-spacing:.08em;
         text-transform:uppercase;display:flex;justify-content:space-between;flex-wrap:wrap;
         gap:var(--sp-5)}

  @media (max-width:900px){
    body{padding:var(--sp-8) var(--sp-5)}
    h1{font-size:var(--t-6)}
    .three,.rules{grid-template-columns:1fr}
    .surf{border-right:none;border-bottom:1px solid var(--hair)}
    .flow{grid-template-columns:repeat(2,1fr)}
    .step{border-bottom:1px solid var(--hair)}
    .rrow{grid-template-columns:1fr;gap:var(--sp-5)}
    .rrow.head{display:none}
  }
  @media print{ body{padding:0} .gap{background:none;color:var(--ink)} }
</style>
</head><body><div class="wrap">

<header>
  <div class="kicker"><span>Flotilla</span><span>Generated ${esc(date)}</span></div>
  <h1>
    <svg class="mk" viewBox="0 0 520 420" aria-hidden="true"><path fill="#0A0A0A" d="M60 40l180 90-180 40zM60 210l300 60-300 50zM300 110l160 100-160 60z"/></svg>
    The whole thing<br>on one board
  </h1>
</header>

<section class="sec">
  <h2><span class="num">01</span> The ${ROLE_SLUGS.length} roles you can hand out</h2>
  <div class="roles">
    <div class="rrow head"><div>role</div><div>owns these files</div><div>may</div></div>
${ROLE_SLUGS.map(roleRow).join('\n')}
  </div>
</section>

<section class="sec">
  <h2><span class="num">02</span> ${DECLARED.surfaces.length} ways in</h2>
  <div class="three">
${DECLARED.surfaces.map((s) => `    <div class="surf">
      <span class="ic">${esc(s.kind)}</span>
      <span class="nm">${esc(s.name)}<code>${esc(s.sub)}</code></span>
      <ul>${s.does.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>
      <span class="who-for">${esc(s.who)}</span>
    </div>`).join('\n')}
  </div>
</section>

<section class="sec">
  <h2><span class="num">03</span> A ticket, start to finish</h2>
  <div class="flow">
${steps.map((s, i) => `    <div class="step${s.built ? '' : ' dead'}"><span class="n">${i + 1}</span><span class="t">${esc(s.t)}</span><span class="w">${esc(s.w)}</span></div>`).join('\n')}
  </div>
</section>

<section class="sec">
  <h2><span class="num">04</span> The ${DECLARED.rules.length} rules that make it work</h2>
  <div class="rules">
${DECLARED.rules.map((r) => `    <div class="rule">
      <span class="rn">${esc(r.n)}</span>
      <b>${esc(r.b)}</b>
      <span class="body">${esc(r.body)}</span>
    </div>`).join('\n')}
  </div>
</section>

<section class="sec">
  <h2><span class="num">05</span> Honest gaps</h2>
  <div class="gap">
    <h3>Not yet true</h3>
${gaps.length === 0
    ? '    <p class="clear">Nothing outstanding. Every step on this board is built.</p>'
    : `    <ul>
${gaps.map((g, i) => `      <li><span class="no">${String(i + 1).padStart(2, '0')}</span>${g}</li>`).join('\n')}
    </ul>`}
  </div>
</section>

<footer>
  <span>${ROLE_SLUGS.length} roles &middot; ${DECLARED.surfaces.length} surfaces &middot; ${steps.length} steps &middot; ${cli.length} cli commands</span>
  <span>${builtCount} of ${steps.length} steps built</span>
</footer>

</div></body></html>
`;
}

// ---- main -----------------------------------------------------------------------------------

/**
 * ONLY WHEN RUN DIRECTLY, and this guard is load-bearing rather than tidy.
 *
 * Without it, this module WROTE docs/board.html as an import side effect -- and
 * `cli/board.test.ts` imports it for `missingNotes()`. So the test regenerated the very file it
 * was checking, one statement before checking it, and "the committed board matches a fresh
 * render" could not fail no matter how stale the committed board was. Proven: with
 * `<!-- stale -->` appended, `node scripts/board.ts --check` exited 1 while the test suite
 * reported 8 of 8 passing.
 *
 * It was also silently mutating a tracked file on every `npm test`, which is how the board came
 * to be already-regenerated after a rename nobody had regenerated for.
 *
 * `cli/index.ts` uses this same idiom for the same reason. A module that does work on import
 * cannot be imported by its own test.
 */
if (import.meta.url === `file://${process.argv[1]}`) main();

function main(): void {
assertNotes();

const html = render();

if (process.argv.includes('--check')) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  // THE DATE LINE IS EXCLUDED from the comparison. It changes every day and would make the check
  // fail for a reason that has nothing to do with the app, which is how a guard gets muted.
  const strip = (s: string) => s.replace(/<span>Generated [^<]*<\/span>/, '');
  if (strip(current) !== strip(html)) {
    console.error('board: docs/board.html is out of date. Run `npm run board`.');
    process.exit(1);
  }
  console.log('board: up to date');
} else {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, html);
  console.log(`board: wrote docs/board.html (${ROLE_SLUGS.length} roles, ${TASK_KINDS.length} ticket types)`);
}
}
