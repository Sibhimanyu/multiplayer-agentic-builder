// The chat page `flotilla chat` serves. One file, no build step, no framework.
//
// WHY A STRING AND NOT THE REACT APP. The board is a deployed SPA that talks to Firebase with a
// browser credential. This page is served by the CLI on loopback and talks to the CLI, which
// already holds the agent token -- a different trust boundary and a different lifetime. Bundling
// the React app here would mean shipping a build step inside the CLI tarball to render one screen.
//
// The design language is DESIGN.md's instrument panel, deliberately: a designer opening this
// should recognise it as the same product as the board.

/** Fonts are not fetched. A tool that opens on loopback must work with no network. */
export function chatPage(nonce: string): string {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Flotilla — chat</title>
<style>
  :root{
    --paper:#0D1117; --card:#161B22; --raise:#1B222B;
    --ink:#E6EDF3; --ink2:#ADBAC7; --muted:#7C8894;
    --line:#21262D; --line2:#30363D;
    --teal:#2DD4BF; --teal-soft:rgba(45,212,191,.13);
    --red:#FF7B72; --amber:#E3B341;
    --sans:ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
    color-scheme:dark;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%}
  body{background:var(--paper);color:var(--ink);font:400 15px/1.6 var(--sans);
       -webkit-font-smoothing:antialiased;display:grid;
       grid-template-columns:minmax(0,1fr) 320px}
  ::selection{background:rgba(45,212,191,.28)}

  /* ---- conversation ---- */
  main{display:grid;grid-template-rows:auto minmax(0,1fr) auto;min-height:0}
  header{padding:18px 26px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:12px}
  header .mk{width:22px;height:18px;flex:none}
  header h1{font-size:15px;font-weight:600;letter-spacing:-.01em}
  header .t{font-family:var(--mono);font-size:11.5px;color:var(--muted);margin-left:auto;
            font-variant-numeric:tabular-nums}

  #log{overflow-y:auto;padding:26px;display:grid;gap:22px;align-content:start}
  .turn{display:grid;gap:7px;max-width:74ch}
  .turn .who{font-family:var(--mono);font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;
             color:var(--muted)}
  .turn .body{white-space:pre-wrap;overflow-wrap:anywhere;color:var(--ink)}
  .turn[data-w="you"]{justify-items:end;margin-left:auto;text-align:right}
  .turn[data-w="you"] .body{background:var(--raise);border:1px solid var(--line2);
       border-radius:10px;padding:10px 13px;text-align:left}
  .turn[data-w="err"] .who{color:var(--red)}
  .turn[data-w="err"] .body{color:var(--red)}
  .turn .meta{font-family:var(--mono);font-size:10.5px;color:var(--muted);
              font-variant-numeric:tabular-nums}
  .empty{color:var(--muted);max-width:60ch}
  .empty b{color:var(--ink);display:block;margin-bottom:6px;font-weight:600}

  /* ---- composer ---- */
  form{border-top:1px solid var(--line);padding:16px 26px 22px;display:grid;gap:10px}
  .box{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:end}
  textarea{font:400 15px/1.55 var(--sans);color:var(--ink);background:var(--card);
     border:1px solid var(--line2);border-radius:10px;padding:12px 13px;resize:none;
     min-height:52px;max-height:200px}
  textarea:focus-visible{outline:2px solid var(--teal);outline-offset:2px;border-color:var(--teal)}
  textarea::placeholder{color:var(--muted)}
  button{background:var(--teal);color:var(--paper);border:none;border-radius:10px;
     padding:13px 20px;font:500 14px var(--sans);cursor:pointer;
     transition:background 160ms ease}
  button:hover:not(:disabled){background:#5EE3D2}
  button:disabled{background:var(--line2);color:var(--muted);cursor:not-allowed}
  button:focus-visible{outline:2px solid var(--teal);outline-offset:2px}
  .hint{font-family:var(--mono);font-size:10.5px;color:var(--muted)}

  /* ---- rail ---- */
  aside{border-left:1px solid var(--line);background:var(--card);overflow-y:auto;padding:18px}
  aside h2{font-family:var(--mono);font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;
           color:var(--muted);margin-bottom:10px}
  aside h2:not(:first-child){margin-top:24px}
  .who-row{padding:11px 0;border-bottom:1px solid var(--line)}
  .who-row:last-child{border-bottom:none}
  .who-row .n{font-size:13.5px;font-weight:600}
  .who-row .r{font-size:11.5px;color:var(--muted);margin-top:2px}
  .who-row .s{display:flex;flex-wrap:wrap;gap:4px;margin-top:7px}
  .g{font-family:var(--mono);font-size:10.5px;padding:2px 6px;border-radius:4px;
     background:var(--raise);border:1px solid var(--line);color:var(--ink2)}
  .you{font-size:9.5px;background:var(--teal-soft);color:var(--teal);border-radius:4px;
       padding:1px 5px;margin-left:6px;font-family:var(--mono);letter-spacing:.05em}
  .off{color:var(--muted);font-size:11px;margin-top:3px}
  .warn{border:1px solid rgba(255,123,114,.35);background:rgba(255,123,114,.08);
        border-radius:9px;padding:11px 12px;font-size:12.5px;color:var(--ink2);margin-top:10px}
  .warn b{color:var(--red);display:block;margin-bottom:4px;font-size:11px;
          font-family:var(--mono);letter-spacing:.06em;text-transform:uppercase}
  .task{font-size:13px;color:var(--ink);line-height:1.5}
  .task .id{font-family:var(--mono);font-size:10.5px;color:var(--muted);display:block;margin-bottom:3px}
  .none{color:var(--muted);font-size:12.5px}
  @media (max-width:860px){ body{grid-template-columns:minmax(0,1fr)} aside{display:none} }
</style>
</head><body>

<main>
  <header>
    <svg class="mk" viewBox="0 0 520 420" aria-hidden="true"><path fill="#2DD4BF" d="M60 40l180 90-180 40zM60 210l300 60-300 50zM300 110l160 100-160 60z"/></svg>
    <h1>Flotilla chat</h1>
    <span class="t" id="ctx">connecting…</span>
  </header>

  <div id="log">
    <div class="empty" id="welcome">
      <b>Your agent is on this machine, and it knows where it stands.</b>
      Ask it anything about the work. Before it edits a file it can check what your role may write
      and which files a teammate is holding, so it will not touch code someone else has locked.
    </div>
  </div>

  <form id="f">
    <div class="box">
      <textarea id="m" rows="1" placeholder="Ask your agent to do something…" autofocus></textarea>
      <button id="s" type="submit">Send</button>
    </div>
    <div class="hint" id="h">enter to send · shift-enter for a newline</div>
  </form>
</main>

<aside>
  <h2>Your assignment</h2>
  <div id="task"><span class="none">loading…</span></div>
  <h2>Who is working</h2>
  <div id="fleet"><span class="none">loading…</span></div>
  <div id="contested"></div>
</aside>

<script>
const NONCE = ${JSON.stringify(nonce)};
const api = (p, init) => fetch(p, { ...init, headers: { 'content-type':'application/json', 'x-flotilla-nonce': NONCE } });
const log = document.getElementById('log');
const esc = s => s.replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));

function turn(who, body, meta) {
  document.getElementById('welcome')?.remove();
  const d = document.createElement('div');
  d.className = 'turn'; d.dataset.w = who;
  d.innerHTML = '<div class="who">' + (who === 'you' ? 'you' : who === 'err' ? 'failed' : 'agent')
    + '</div><div class="body">' + esc(body) + '</div>'
    + (meta ? '<div class="meta">' + esc(meta) + '</div>' : '');
  log.appendChild(d);
  log.scrollTop = log.scrollHeight;
  return d;
}

async function paintContext() {
  try {
    const c = await (await api('/api/context')).json();
    if (c.error) { document.getElementById('ctx').textContent = 'offline'; return; }
    document.getElementById('ctx').textContent = c.project + ' · ' + c.role;

    document.getElementById('task').innerHTML = c.task
      ? '<div class="task"><span class="id">' + esc(c.task.task_id) + ' · ' + esc(c.task.status)
        + '</span>' + esc(c.task.title) + '</div>'
        + '<div class="s" style="margin-top:8px">' + (c.task.file_scope.length
          ? c.task.file_scope.map(g => '<span class="g">' + esc(g) + '</span>').join('')
          : '<span class="none">locks no files</span>') + '</div>'
      : '<span class="none">No task claimed. Ask your agent to claim one.</span>';

    document.getElementById('fleet').innerHTML = c.agents.length
      ? c.agents.map(a =>
          '<div class="who-row"><div class="n">' + esc(a.label)
          + (a.you ? '<span class="you">you</span>' : '') + '</div>'
          + '<div class="r">' + esc(a.role) + ' · ' + esc(a.harness) + '</div>'
          + (a.stale ? '<div class="off">offline</div>' : '')
          + (a.holds.length ? '<div class="s">' + a.holds.map(g => '<span class="g">' + esc(g) + '</span>').join('') + '</div>' : '')
          + '</div>').join('')
      : '<span class="none">No agents connected. Run flotilla start.</span>';

    document.getElementById('contested').innerHTML = c.contested.length
      ? '<div class="warn"><b>held by others</b>Your agent must not edit these: '
        + c.contested.map(esc).join(', ') + '</div>'
      : '';
  } catch { document.getElementById('ctx').textContent = 'offline'; }
}

const form = document.getElementById('f');
const input = document.getElementById('m');
const send = document.getElementById('s');
const hint = document.getElementById('h');

input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 200) + 'px';
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
  } catch (err) {
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
