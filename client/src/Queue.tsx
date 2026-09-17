// My queue — the signed-in home. Order 0071.
//
// The screen answers one question: what should I work on next, and can I start it right now.
//
// CLAIMING FROM A BROWSER RESERVES; IT DOES NOT START ANYTHING. The agent runs on the claimer's
// own machine, so this does exactly what `flotilla claim` does -- an atomic claim plus the scope
// acquisition -- and the local agent picks the work up on its next poll. Every string on this
// screen has to be honest about that, because a button that implies it started an agent is a
// promise the architecture cannot keep.

import { useState } from 'react';
import type { TaskView, AgentPresence } from './store/types';
import { claimTask, createTask } from './store/write';

/** What a row needs to decide whether it can be claimed, and to say why not. */
export interface QueueRow {
  task: TaskView;
  /** Set when something stops this being claimable now. */
  blocker?: { kind: 'depends' | 'scope'; detail: string; holder?: string };
  /** The agent that would run it, if known. */
  agent?: AgentPresence;
}

function Chips({ row }: { row: QueueRow }) {
  const scopes = row.task.file_scope;
  return (
    <div className="meta">
      <span className="chip kind" data-k={row.task.kind}>{row.task.kind}</span>
      {scopes.map((s) => (
        <span className="chip scope" key={s}><span className="k">locks</span> {s}</span>
      ))}
      {row.agent && <span className="chip agent">{row.agent.harness ?? 'agent'}</span>}
    </div>
  );
}

/**
 * One claimable row.
 *
 * A DISABLED ACTION STATES ITS REASON rather than disappearing. A row you cannot claim and a row
 * that does not exist look identical when the button is simply absent, and the first one is
 * information the person needs.
 */
function ReadyRow({
  row, project_id, canClaim, onClaimed,
}: {
  row: QueueRow;
  project_id: string;
  canClaim: boolean;
  onClaimed: (task_id: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const blocked = Boolean(row.blocker);

  const claim = async () => {
    setBusy(true);
    setFailed(null);
    try {
      const out = await claimTask(project_id, row.task.task_id);
      // ok:false is a LOST RACE, not an error. Two people claiming the same task at the same
      // moment is the system working; it gets a plain sentence, not a red one.
      if (out.ok) onClaimed(row.task.task_id);
      else setFailed(out.error ?? 'Someone else claimed this first.');
    } catch {
      setFailed('Could not reach the server. Your claim was not recorded.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="qrow" data-blocked={blocked} data-task={row.task.task_id}>
      <div className="id">{row.task.task_id}</div>
      <div>
        <div className="t">{row.task.title}</div>
        <Chips row={row} />
        {row.blocker && (
          <div className="why">
            <b>{row.blocker.kind === 'depends' ? 'Waiting' : 'Scope held'}</b> — {row.blocker.detail}
          </div>
        )}
        {failed && <div className="why">{failed}</div>}
      </div>
      <div className="act">
        <button
          className="cta"
          onClick={claim}
          disabled={busy || blocked || !canClaim}
        >
          {busy ? 'Claiming…' : 'Claim'}
        </button>
        <span className="sub">
          {!canClaim
            ? 'Your role cannot claim work'
            : blocked
              ? 'Blocked for now'
              : 'Reserves it for your agent'}
        </span>
      </div>
    </div>
  );
}

function MineRow({ row, agentConnected }: { row: QueueRow; agentConnected: boolean }) {
  return (
    <div className="qrow" data-task={row.task.task_id}>
      <div className="id">{row.task.task_id}</div>
      <div>
        <div className="t">{row.task.title}</div>
        <Chips row={row} />
        {!agentConnected && (
          <div className="why">
            <b>Claimed, waiting for your agent</b> — nothing is running this yet. Start it with{' '}
            <code>flotilla start</code> on the machine you want it to run on.
          </div>
        )}
      </div>
      <div className="act">
        <span className="sub">{agentConnected ? 'Your agent is on it' : 'No agent connected'}</span>
      </div>
    </div>
  );
}

/**
 * Nothing to do, and the two reasons are different screens.
 *
 * An empty project is the state this product is actually in most of the time, and it was the one
 * state the approved comp did not draw. Telling someone to run a CLI command they have already
 * run is the bug order 0064 was about; now that the board can write, the first action is here.
 */
function NothingReady({
  projectEmpty, canCreate, onNewTask,
}: {
  projectEmpty: boolean;
  canCreate: boolean;
  onNewTask: () => void;
}) {
  if (projectEmpty) {
    return (
      <div className="empty">
        <h3>No tasks in this project yet</h3>
        <p>
          A task is the unit an agent claims. Creating one locks a file scope to whoever claims it,
          which is what stops two agents editing the same files.
        </p>
        {canCreate
          ? <p><button className="cta" onClick={onNewTask}>Create the first task</button></p>
          : <p>Your role cannot create tasks. Ask an owner or architect to add one.</p>}
      </div>
    );
  }
  return (
    <div className="empty">
      <h3>Nothing ready for you</h3>
      <p>
        Every open task is either claimed by someone else or waiting on work that has not landed.
        The fleet board shows what the rest of the team is doing.
      </p>
    </div>
  );
}

export function Queue({
  project_id, projectName, ready, mine, canClaim, canCreate,
  agentConnected, onClaimed, onNewTask, projectEmpty,
}: {
  project_id: string;
  projectName: string;
  ready: QueueRow[];
  mine: QueueRow[];
  canClaim: boolean;
  canCreate: boolean;
  agentConnected: boolean;
  onClaimed: (task_id: string) => void;
  onNewTask: () => void;
  projectEmpty: boolean;
}) {
  const heldScopes = mine.flatMap((m) => m.task.file_scope);

  return (
    <main className="queue">
      <h1>My queue</h1>
      <p className="lede">
        Work you can pick up on <strong>{projectName}</strong>. Claiming a task locks its file
        scope to you and hands it to the agent running on your own machine.
      </p>

      <section className="grp">
        <div className="grp-head">
          <h2>Ready for you</h2>
          <span className="count">{ready.length}</span>
          <span className="note">
            {canClaim ? 'Nothing here is locked by anyone else unless marked' : 'Read only'}
          </span>
        </div>
        {ready.length === 0
          ? <NothingReady projectEmpty={projectEmpty} canCreate={canCreate} onNewTask={onNewTask} />
          : (
            <div className="qlist">
              {ready.map((r) => (
                <ReadyRow
                  key={r.task.task_id} row={r} project_id={project_id}
                  canClaim={canClaim} onClaimed={onClaimed}
                />
              ))}
            </div>
          )}
      </section>

      {mine.length > 0 && (
        <section className="grp">
          <div className="grp-head">
            <h2>Yours in progress</h2>
            <span className="count">{mine.length}</span>
            {heldScopes.length > 0 && (
              <span className="note">You hold {heldScopes.join(' and ')}</span>
            )}
          </div>
          <div className="qlist">
            {mine.map((r) => (
              <MineRow key={r.task.task_id} row={r} agentConnected={agentConnected} />
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

/**
 * Creating a task, inline.
 *
 * NOT A MODAL. The craft floor refuses a modal for a task that needs neither interruption nor
 * protected focus, and this needs neither: it is three fields on a page with room for them.
 *
 * `kind` has no default. write-api.ts refuses a misspelled kind rather than guessing, on the
 * grounds that "a task quietly filed as 'backend' because the kind was misspelled is a card in
 * the wrong swimlane that nobody can explain a week later" -- so the form must not reintroduce a
 * default the server deliberately refused to have.
 */
export function NewTaskForm({
  project_id, kinds, onCreated, onCancel,
}: {
  project_id: string;
  kinds: readonly string[];
  onCreated: (task_id: string) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState('');
  const [scope, setScope] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const out = await createTask(project_id, {
        title: title.trim(),
        kind,
        // Comma or whitespace separated, because a person typing two globs will use either and
        // rejecting one of them teaches nothing.
        file_scope: scope.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean),
      });
      if (out.ok && out.task_id) onCreated(out.task_id);
      else setErr(out.error ?? 'A task with that id already exists.');
    } catch {
      setErr('Could not reach the server. The task was not created.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="newtask" onSubmit={submit}>
      <label>
        Title
        <input
          value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus
          placeholder="PATCH /items/:sku returns 404 for existing rows"
        />
      </label>
      <label>
        Kind
        <select value={kind} onChange={(e) => setKind(e.target.value)} required>
          <option value="" disabled>Choose one</option>
          {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
        </select>
      </label>
      <label>
        File scope
        <input
          value={scope} onChange={(e) => setScope(e.target.value)}
          placeholder="server/** docs/**"
        />
      </label>
      {err && <div className="err">{err}</div>}
      <div className="row">
        <button className="cta" type="submit" disabled={busy || !title.trim() || !kind}>
          {busy ? 'Creating…' : 'Create task'}
        </button>
        <button className="ghost" type="button" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}
