// The chat page `flotilla chat` serves. One file, no build step, no framework.
//
// WHY A STRING AND NOT THE REACT APP. The board is a deployed SPA that talks to Firebase with a
// browser credential. This page is served by the CLI on loopback and talks to the CLI, which
// already holds the agent token -- a different trust boundary and a different lifetime. Bundling
// the React app here would mean shipping a build step inside the CLI tarball to render one screen.
//
// The design language is DESIGN.md's Graphite, deliberately: a designer opening this
// should recognise it as the same product as the board. Order 0083 made that literally true --
// the type scale below is DESIGN.md's `--t-*`, and the fonts are the same two files the board
// serves, now shipped in the CLI tarball and served from disk by `serveChat`.

/**
 * Fonts are served by the CLI from `dist/brand/fonts/`, same-origin, never fetched from the
 * internet: a tool that opens on loopback must draw its own text on a plane. `local()` is not
 * used -- Plex is not installed on a normal machine, and a silent fallback to system-ui is the
 * "I gave up on typography" signal DESIGN.md forbids by name.
 */
export function chatPage(nonce: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Flotilla chat</title>
<link rel="preload" href="/brand/fonts/PlexSans-400.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/brand/fonts/PlexSans-600.woff2" as="font" type="font/woff2" crossorigin>
<style>
  @font-face{font-family:'Plex Sans';src:url('/brand/fonts/PlexSans-400.woff2') format('woff2');
    font-weight:400;font-style:normal;font-display:swap}
  @font-face{font-family:'Plex Sans';src:url('/brand/fonts/PlexSans-500.woff2') format('woff2');
    font-weight:500;font-style:normal;font-display:swap}
  @font-face{font-family:'Plex Sans';src:url('/brand/fonts/PlexSans-600.woff2') format('woff2');
    font-weight:600;font-style:normal;font-display:swap}
  @font-face{font-family:'Plex Mono';src:url('/brand/fonts/PlexMono-400.woff2') format('woff2');
    font-weight:400;font-style:normal;font-display:swap}
  @font-face{font-family:'Plex Mono';src:url('/brand/fonts/PlexMono-500.woff2') format('woff2');
    font-weight:500;font-style:normal;font-display:swap}

  :root{
    /* DESIGN.md "Graphite" -- the same values as client/src/tokens.css, by hand, because this
       page has no build step. Neutral greys, no hue; colour for state only. */
    --paper:#121212; --card:#1A1A1A; --raise:#232323;
    --ink:#EDEDED; --ink2:#B8B8B8; --muted:#8C8C8C;
    --line:#262626; --line2:#363636; --line3:#4A4A4A;
    --inverse:#EDEDED; --on-inverse:#121212; --inverse-hover:#FFFFFF;
    --red:#E5877E; --red-soft:rgba(229,135,126,.12); --green:#86B98F;
    --sans:'Plex Sans',ui-sans-serif,system-ui,sans-serif;
    --mono:'Plex Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
    /* DESIGN.md "Type". Integers only, 11px floor. Not one value off this list. */
    --t-0:11px; --t-1:12px; --t-2:14px; --t-3:16px; --t-4:18px; --t-5:21px; --t-6:24px; --t-7:28px;
    --lh-tight:1.2; --lh:1.5; --lh-read:1.6;
    /* DESIGN.md "Spacing". */
    --sp-1:2px; --sp-2:4px; --sp-3:6px; --sp-4:8px; --sp-5:12px;
    --sp-6:16px; --sp-7:24px; --sp-8:32px; --sp-9:48px;
    /* THREE radii, not one. A single 10px on the textarea, the button, the message bubble and
       the panel is the uniform-bubbly-radius tell: nothing is nested, nothing is a control,
       everything is a lozenge. Containers 12, controls 8, tags 5. */
    --r-card:12px; --r-ctl:8px; --r-tag:5px;
    --shadow:inset 0 1px 0 rgba(255,255,255,.04);
    --motion-fast:160ms; --ease:cubic-bezier(.2,0,.2,1);
    color-scheme:dark;
  }
  *{box-sizing:border-box;margin:0;padding:0;min-width:0}
  html,body{height:100%}
  body{background:var(--paper);color:var(--ink);
       font:400 var(--t-2)/var(--lh) var(--sans);
       -webkit-font-smoothing:antialiased;
       display:grid;grid-template-columns:minmax(0,1fr) 336px}
  ::selection{background:rgba(237,237,237,.22);color:var(--ink)}
  /* One ring, one place. The old page set outline AND recoloured the border, so an autofocused
     textarea opened wearing a 4px double neon halo -- AI look #2 (near-black, one neon accent,
     glowing edges) arriving on page load, before the user did anything. */
  :where(a,button,textarea,[tabindex]):focus-visible{
    outline:2px solid var(--ink);outline-offset:2px}
  @media (prefers-reduced-motion:reduce){*{transition:none!important;animation:none!important}}

  /* ---- conversation ---- */
  main{display:grid;grid-template-rows:auto minmax(0,1fr) auto;min-height:0}
  header{padding:var(--sp-5) var(--sp-7);border-bottom:1px solid var(--line);
         display:flex;align-items:center;gap:var(--sp-4)}
  /* The real mark, inline, in ink -- not the three-triangle stand-in this header used to draw,
     which was a second, different logo on the second surface. Its viewBox carries 9.1% dead
     space on the left and 18.0% on the right (DESIGN.md "Logo spacing"), cancelled here so the
     header gap is ink to glyph, the same way the board's lockup does it. */
  header .mk{--mark-w:26px;width:var(--mark-w);height:21px;flex:none;color:var(--ink);
       margin-left:calc(var(--mark-w) * -.091);margin-right:calc(var(--mark-w) * -.18)}
  header .name{font-size:var(--t-3);font-weight:600;letter-spacing:-.01em}
  /* Wayfinding: which of the two surfaces is this. The old header said "Flotilla chat" as one
     15px string and offered no way back to the board -- a dead end, and the trunk test's
     "where am I in the scheme of things" had no answer at all. An outlined neutral tag now:
     it was teal on teal-soft, the brightest object on the page, for a word that is a label. */
  header .where{font-family:var(--mono);font-size:var(--t-0);letter-spacing:.06em;
        text-transform:uppercase;color:var(--ink2);border:1px solid var(--line2);
        border-radius:var(--r-tag);padding:var(--sp-1) var(--sp-3)}
  header .ctx{font-family:var(--mono);font-size:var(--t-1);color:var(--muted);
              margin-left:auto;font-variant-numeric:tabular-nums}
  header .board{font-size:var(--t-1);font-weight:500;color:var(--ink);text-decoration:none;
        border:1px solid var(--line3);border-radius:var(--r-ctl);padding:var(--sp-2) var(--sp-5);
        transition:border-color var(--motion-fast) var(--ease),background var(--motion-fast) var(--ease)}
  header .board:hover{border-color:var(--ink2);background:var(--raise)}
  header .board[hidden]{display:none}

  #log{overflow-y:auto;padding:var(--sp-8) var(--sp-7);display:grid;gap:var(--sp-7);
       align-content:start}
  .turn{display:grid;gap:var(--sp-3);max-width:72ch}
  .turn .who{font-family:var(--mono);font-size:var(--t-0);letter-spacing:.08em;
             text-transform:uppercase;color:var(--muted)}
  .turn .body{white-space:pre-wrap;overflow-wrap:anywhere;color:var(--ink);
              font-size:var(--t-3);line-height:var(--lh-read)}
  .turn[data-w="you"]{justify-items:end;margin-left:auto;text-align:right}
  .turn[data-w="you"] .body{background:var(--raise);border:1px solid var(--line2);
       box-shadow:var(--shadow);border-radius:var(--r-card);
       padding:var(--sp-4) var(--sp-5);text-align:left;font-size:var(--t-2)}
  .turn[data-w="err"] .who,.turn[data-w="err"] .body{color:var(--red)}
  .turn .meta{font-family:var(--mono);font-size:var(--t-0);color:var(--muted);
              font-variant-numeric:tabular-nums}

  /* ---- the opening screen ----
     WHAT WAS HERE WAS HAPPY TALK. Three lines telling the user their agent "knows where it
     stands" and what it could do before editing a file -- a welcome paragraph nobody reads,
     above 600px of dead void, with no action in it. The empty state is now the four things
     worth asking, written from the live task and the live scope, as buttons that send. It
     answers "what do I type" by being the answer. */
  .start{display:grid;gap:var(--sp-6);max-width:68ch;align-content:start}
  .start h2{font-size:var(--t-7);font-weight:600;line-height:var(--lh-tight);
            letter-spacing:-.025em;text-wrap:balance}
  .start .sub{color:var(--ink2);font-size:var(--t-3);line-height:var(--lh-read);
              overflow-wrap:anywhere}
  /* ONE LIST WITH FOUR ROWS, NOT FOUR CARDS. Four separately bordered, separately shadowed,
     identically shaped boxes is the card-grid tell -- content of equal weight given equal boxes
     until the page reads as a template. These are four rows of one list, so they are drawn as
     one list, hairline-ruled on the ground like the board's queue. The mono verb and the arrow
     are the static affordance; nothing here depends on hover to be discoverable. */
  .prompts{display:grid;border-top:1px solid var(--line2);border-bottom:1px solid var(--line2)}
  .prompts button{display:grid;grid-template-columns:6rem minmax(0,1fr) auto;gap:var(--sp-5);
     align-items:baseline;text-align:left;background:none;color:var(--ink);
     border:none;border-top:1px solid var(--line);
     padding:var(--sp-5) var(--sp-5);font:500 var(--t-2)/var(--lh) var(--sans);cursor:pointer;
     transition:background var(--motion-fast) var(--ease)}
  .prompts button:first-child{border-top:none}
  .prompts button::after{content:'\\2192';color:var(--muted);
     transition:color var(--motion-fast) var(--ease)}
  .prompts button:hover{background:var(--card)}
  .prompts button:hover::after{color:var(--ink)}
  .prompts button:focus-visible{outline-offset:-2px}
  .prompts button .k{font-family:var(--mono);font-size:var(--t-0);font-weight:400;
     color:var(--muted);letter-spacing:.06em;text-transform:uppercase}
  .prompts button .q{overflow-wrap:anywhere}
  /* Upfront about the limit rather than letting the user discover it by being refused. */
  .cando{font-size:var(--t-1);color:var(--muted);line-height:var(--lh-read)}
  .cando b{color:var(--ink2);font-weight:600}

  /* ---- composer ---- */
  form{border-top:1px solid var(--line);padding:var(--sp-6) var(--sp-7) var(--sp-6);
       display:grid;gap:var(--sp-4)}
  .box{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:var(--sp-4);align-items:end}
  textarea{font:400 var(--t-3)/var(--lh) var(--sans);color:var(--ink);background:var(--card);
     border:1px solid var(--line2);border-radius:var(--r-ctl);caret-color:var(--ink);
     padding:var(--sp-5);resize:none;min-height:54px;max-height:208px;box-shadow:var(--shadow);
     transition:border-color var(--motion-fast) var(--ease)}
  textarea:hover{border-color:var(--line3)}
  textarea::placeholder{color:var(--muted)}
  /* THE COMPOSER IS AUTOFOCUSED, SO THE GENERIC RING IS WRONG HERE. A text field always matches
     :focus-visible while focused, so the shared 2px offset ring fired on page load and the first
     thing anyone saw was a glowing teal halo around an empty box -- near-black with one neon
     accent and glowing edges, arriving before the user had done anything. A focused text cursor
     in a box whose border has stepped up to ink2 is unambiguous without shouting; the shared
     ring stays for every control where focus really is the only signal. */
  textarea:focus-visible{outline:none;border-color:var(--ink2)}
  /* The primary is the inversion, as on the board: near-white, ground-coloured label, 16.00:1. */
  button.send{background:var(--inverse);color:var(--on-inverse);border:none;
     border-radius:var(--r-ctl);padding:var(--sp-5) var(--sp-6);font:600 var(--t-2) var(--sans);
     cursor:pointer;transition:background var(--motion-fast) var(--ease)}
  button.send:hover:not(:disabled){background:var(--inverse-hover)}
  button.send:disabled{background:var(--raise);color:var(--muted);cursor:not-allowed}
  .hint{font-family:var(--mono);font-size:var(--t-0);color:var(--muted)}

  /* ---- rail ---- */
  /* THE RAIL IS FIRST IN THE DOM AND SECOND ON SCREEN. It comes first in the markup so that a
     narrow window stacks it ABOVE the conversation without a second grid definition, and so a
     screen reader reaches "what am I working on" before the message log. On desktop it is placed
     explicitly in column 2 -- without this it took the 1fr column and the conversation got the
     336px one, which is what happened the first time. */
  aside{grid-column:2;grid-row:1;
        border-left:1px solid var(--line);background:var(--card);overflow-y:auto;
        padding:var(--sp-7) var(--sp-6);display:grid;gap:var(--sp-8);align-content:start}
  main{grid-column:1;grid-row:1}
  .sec{display:grid;gap:var(--sp-4)}
  .lbl{font-family:var(--mono);font-size:var(--t-0);font-weight:500;letter-spacing:.08em;
       text-transform:uppercase;color:var(--muted)}
  /* THE RAIL USED TO SCROLL SIDEWAYS. A task id is one unbroken 47-character mono token, and
     nothing told it to break, so the rail measured 347px inside a 319px box: the id was clipped
     at the window edge and the one identifier this panel exists to show could not be read.
     'anywhere' rather than 'break-word', because a mono id has no break opportunities at all. */
  .id,.g{overflow-wrap:anywhere}
  .task-title{font-size:var(--t-3);font-weight:600;line-height:var(--lh-tight);letter-spacing:-.01em}
  .id{font-family:var(--mono);font-size:var(--t-0);color:var(--muted)}
  /* The task's state is a label, not a warning: it was amber, and amber means an anonymous
     session. An outlined tag in ink, sitting above the title it describes. */
  .state{justify-self:start;font-family:var(--mono);font-size:var(--t-0);letter-spacing:.06em;
         text-transform:uppercase;color:var(--ink);border:1px solid var(--line3);
         border-radius:var(--r-tag);padding:var(--sp-1) var(--sp-3)}
  .globs{display:flex;flex-wrap:wrap;gap:var(--sp-2)}
  .g{font-family:var(--mono);font-size:var(--t-0);padding:var(--sp-1) var(--sp-3);
     border-radius:var(--r-tag);background:transparent;border:1px solid var(--line2);
     color:var(--ink)}
  .who-row{display:grid;gap:var(--sp-2);padding:var(--sp-5) 0;border-bottom:1px solid var(--line)}
  .who-row:first-child{padding-top:0}
  .who-row:last-child{border-bottom:none}
  .who-row .n{font-size:var(--t-2);font-weight:600;display:flex;align-items:baseline;gap:var(--sp-3)}
  .who-row .r{font-family:var(--mono);font-size:var(--t-0);color:var(--muted)}
  .who-row .globs{margin-top:var(--sp-2)}
  .you{font-size:var(--t-0);background:var(--raise);color:var(--ink);
       border-radius:var(--r-tag);padding:0 var(--sp-3);font-family:var(--mono);
       letter-spacing:.05em;font-weight:500}
  /* Offline is the quietest state, so it is the dimmest text, not a warning colour. */
  .off{font-family:var(--mono);font-size:var(--t-0);font-weight:400;color:var(--muted)}
  /* Held by others IS a state -- your agent will be refused there -- so it keeps red, quietly:
     red text on red-soft over card, 5.57:1, and a hairline not a glow. */
  .warn{border:1px solid var(--line2);background:var(--red-soft);
        border-radius:var(--r-ctl);padding:var(--sp-5);font-size:var(--t-1);color:var(--ink2);
        display:grid;gap:var(--sp-3);line-height:var(--lh)}
  .warn b{color:var(--red);font-size:var(--t-0);font-family:var(--mono);
          letter-spacing:.06em;text-transform:uppercase;font-weight:500}
  .none{color:var(--muted);font-size:var(--t-1)}

  /* THE RAIL IS THE REASON THIS PAGE EXISTS, so narrow does not mean deleted. It used to be
     display:none under 860px, which silently removed the live fleet context from a laptop with
     a split screen. It moves above the conversation and scrolls with the page instead. */
  @media (max-width:900px){
    body{grid-template-columns:minmax(0,1fr);grid-template-rows:auto minmax(0,1fr)}
    aside{border-left:none;border-bottom:1px solid var(--line);
          grid-column:1;grid-row:1;padding:var(--sp-5) var(--sp-6);
          grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:var(--sp-6)}
    main{grid-column:1;grid-row:2}
    header{padding:var(--sp-5)}
    header .ctx{display:none}
    .start h2{font-size:var(--t-5)}
    #log{padding-top:var(--sp-7)}
    #log,form{padding-left:var(--sp-5);padding-right:var(--sp-5)}
  }
</style>
</head><body>

<aside>
  <div class="sec">
    <h2 class="lbl">Your assignment</h2>
    <div id="task"><span class="none">loading…</span></div>
  </div>
  <div class="sec">
    <h2 class="lbl">Who is working</h2>
    <div id="fleet"><span class="none">loading…</span></div>
  </div>
  <div id="contested"></div>
</aside>

<main>
  <header>
    <svg class="mk" viewBox="0 0 520 420" aria-hidden="true"><g fill="currentColor" transform="rotate(-7 260 210)"><path transform="translate(0 -12)" d="M184 39C245 46 346 75 429 112C442 118 444 128 430 135C376 164 311 185 249 199C235 202 231 193 239 181C259 151 266 121 256 94C246 68 220 50 184 39Z"/><path transform="translate(-4 6)" d="M86 143C132 151 198 173 239 193C250 198 250 207 239 213C192 238 139 261 54 281C41 284 37 275 46 264C75 235 98 211 101 188C103 170 98 155 86 143Z"/><path transform="translate(0 12)" d="M190 245C233 253 290 274 326 293C337 299 337 307 326 313C287 336 243 353 176 369C163 372 159 363 168 352C192 326 210 304 212 284C213 268 207 254 190 245Z"/></g></svg>
    <span class="name">Flotilla</span>
    <span class="where">chat</span>
    <span class="ctx" id="ctx">connecting…</span>
    <a class="board" id="boardlink" href="#" hidden>Board</a>
  </header>

  <div id="log">
    <div class="start" id="start">
      <h2>Your agent runs here, on your machine, and it already knows the fleet.</h2>
      <p class="sub" id="startsub">Reading your assignment…</p>
      <div class="prompts" id="prompts"></div>
      <p class="cando" id="cando"></p>
    </div>
  </div>

  <form id="f">
    <div class="box">
      <textarea id="m" rows="1" placeholder="Ask your agent to do something…" autofocus></textarea>
      <button class="send" id="s" type="submit">Send</button>
    </div>
    <div class="hint" id="h">enter to send · shift-enter for a newline</div>
  </form>
</main>

<script>
const NONCE = ${JSON.stringify(nonce)};
const api = (p, init) => fetch(p, { ...init, headers: { 'content-type':'application/json', 'x-flotilla-nonce': NONCE } });
const log = document.getElementById('log');
const el = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

function turn(who, body, meta) {
  el('start')?.remove();
  const d = document.createElement('div');
  d.className = 'turn'; d.dataset.w = who;
  d.innerHTML = '<div class="who">' + (who === 'you' ? 'you' : who === 'err' ? 'failed' : 'agent')
    + '</div><div class="body">' + esc(body) + '</div>'
    + (meta ? '<div class="meta">' + esc(meta) + '</div>' : '');
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
  return d;
}

/* The starter prompts are WRITTEN FROM LIVE STATE, not a hardcoded list: they name the task you
   actually hold and the globs you actually own, so the first click is already about your work.
   Nothing here offers an edit, because the agent cannot do one from this page and a starter
   prompt that gets refused is worse than no starter prompt. */
function starters(c) {
  const scope = (c.scope && c.scope.length) ? c.scope.join(', ') : null;
  const canWrite = c.writable && c.writable.length;
  const out = [];
  if (c.task) {
    out.push(['assignment', 'What am I working on, and exactly which files may I write?']);
    out.push(['read', 'Read the files under ' + (c.task.file_scope[0] || scope || 'my scope')
      + ' and tell me what could cause: ' + c.task.title]);
    // The verb follows the permission. Offering "fix it" while the agent would be refused, or
    // offering only "plan it" once it genuinely can edit, both teach the wrong thing about what
    // this tool does -- and the second is how a working feature stays undiscovered.
    out.push(canWrite
      ? ['fix', 'Fix "' + c.task.title + '" in ' + c.writable.join(', ')
          + ', then report what you changed.']
      : ['plan', 'Plan a fix for "' + c.task.title
          + '". List the files you would change and why, but do not change them.']);
  } else {
    out.push(['queue', 'What tasks are ready for my role, and which one should I claim first?']);
    out.push(['orient', 'What is this project, what is my role, and what may I write?']);
  }
  out.push(['fleet', c.contested && c.contested.length
    ? 'Which globs is someone else holding right now, and what must I avoid touching?'
    : 'Who else is connected right now, and what are they working on?']);
  return out;
}

function paintStart(c) {
  const start = el('start');
  if (!start) return;
  // THE TITLE, NOT THE ID. A 47-character mono task id dropped into a prose sentence has no
  // break opportunity, so at 375px it ran straight off the right edge of the screen -- and the
  // id is already in the rail, in mono, where an identifier belongs. A sentence gets the
  // sentence-shaped half of the same fact.
  el('startsub').textContent = c.task
    ? 'You hold "' + c.task.title + '". Pick a starting point or type your own.'
    : 'You have not claimed a task yet. Pick a starting point or type your own.';
  // WHAT IT MAY WRITE IS A FACT ABOUT RIGHT NOW, so it is rendered from state rather than
  // written into the HTML. It was a fixed sentence saying "it cannot edit files from this page",
  // which stopped being true the moment editing was scoped to the held locks -- a hardcoded
  // capability line is a lie waiting for the next release.
  el('cando').innerHTML = (c.writable && c.writable.length)
    ? 'It can read anything here, and <b>edit files in '
      + c.writable.map(g => '<span class="g">' + esc(g) + '</span>').join(' ')
      + '</b> — the globs you hold. Everything else in the repository is refused, '
      + 'and it cannot run shell commands.'
    : 'It can read anything here, check what your role may write, see which globs a teammate is '
      + 'holding, post progress and claim a task. <b>It cannot edit any file yet</b>, because '
      + 'editing is scoped to the globs you hold and you are holding none. Claim a task first.';

  el('prompts').innerHTML = starters(c).map(([k, q]) =>
    '<button type="button" data-q="' + esc(q) + '"><span class="k">' + esc(k)
    + '</span><span class="q">' + esc(q) + '</span></button>').join('');
  el('prompts').querySelectorAll('button').forEach(b => {
    b.addEventListener('click', () => { input.value = b.dataset.q; form.requestSubmit(); });
  });
}

/* A FAILED POLL USED TO SAY "offline" IN THE HEADER AND LEAVE THE RAIL READING "loading…"
   FOREVER. Two different lies on one screen. One function sets every region. */
function paintOffline(why) {
  el('ctx').textContent = why;
  const msg = '<span class="none">Lost the CLI. Is <span class="id">flotilla chat</span> still running?</span>';
  el('task').innerHTML = msg;
  el('fleet').innerHTML = msg;
  el('contested').innerHTML = '';
}

async function paintContext() {
  let c;
  try { c = await (await api('/api/context')).json(); }
  catch { return paintOffline('cli unreachable'); }
  if (c.error) return paintOffline('offline');

  el('ctx').textContent = c.project + ' · ' + c.role;
  if (c.board_url) { const a = el('boardlink'); a.href = c.board_url; a.hidden = false; }

  el('task').innerHTML = c.task
    ? '<div class="sec" style="gap:var(--sp-3)">'
      + '<span class="state">' + esc(c.task.status) + '</span>'
      + '<span class="task-title">' + esc(c.task.title) + '</span>'
      + '<span class="id">' + esc(c.task.task_id) + '</span>'
      + '<div class="globs">' + (c.task.file_scope.length
        ? c.task.file_scope.map(g => '<span class="g">' + esc(g) + '</span>').join('')
        : '<span class="none">locks no files</span>') + '</div></div>'
    : '<span class="none">No task claimed. Ask your agent which one to take.</span>';

  el('fleet').innerHTML = c.agents.length
    ? c.agents.map(a =>
        '<div class="who-row"><div class="n">' + esc(a.label)
        + (a.you ? '<span class="you">you</span>' : '')
        + (a.stale ? '<span class="off">offline</span>' : '') + '</div>'
        + '<div class="r">' + esc(a.role) + ' · ' + esc(a.harness) + '</div>'
        + (a.holds.length ? '<div class="globs">' + a.holds.map(g => '<span class="g">' + esc(g) + '</span>').join('') + '</div>' : '')
        + '</div>').join('')
    : '<span class="none">No agents connected. Run <span class="id">flotilla start</span>.</span>';

  el('contested').innerHTML = c.contested.length
    ? '<div class="warn"><b>held by others</b><span>Your agent must not edit these.</span>'
      + '<div class="globs">' + c.contested.map(g => '<span class="g">' + esc(g) + '</span>').join('')
      + '</div></div>'
    : '';

  paintStart(c);
}

const form = el('f');
const input = el('m');
const send = el('s');
const hint = el('h');

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 208) + 'px';
});
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
});

form.addEventListener('submit', async e => {
  e.preventDefault();
  const message = input.value.trim();
  if (!message) return;
  turn('you', message);
  input.value = ''; input.style.height = 'auto';
  send.disabled = true; send.textContent = 'Working…';
  hint.textContent = 'the agent is running on this machine; this can take a while';
  const pending = turn('agent', '…');
  try {
    const r = await (await api('/api/send', { method:'POST', body: JSON.stringify({ message }) })).json();
    pending.remove();
    const meta = [
      r.cost != null ? '$' + r.cost.toFixed(4) : null,
      r.denials ? r.denials + ' permission denial(s)' : null,
    ].filter(Boolean).join(' · ');
    turn(r.error ? 'err' : 'agent', r.reply || r.error || '(no reply)', meta);
  } catch {
    pending.remove();
    turn('err', 'Could not reach the Flotilla CLI. Is it still running in your terminal?');
  }
  send.disabled = false; send.textContent = 'Send';
  hint.textContent = 'enter to send · shift-enter for a newline';
  input.focus();
  paintContext();
});

paintContext();
// The fleet changes while you talk. This is the whole reason the rail exists.
setInterval(paintContext, 8000);
</script>
</body></html>`;
}
