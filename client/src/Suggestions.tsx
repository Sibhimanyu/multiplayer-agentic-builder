// Suggestions on the board: raising one, and deciding what becomes of it.
//
// THE `user` SEAT'S ONLY VERB. Someone who uses the delivered app signs in, says what is wrong,
// and that is the whole seat. Everything else on this group is for people with `triage`: make it
// a ticket, or turn it down with a reason the raiser can read.
//
// Suggestions live in their own collection, never the ledger, so nothing typed here reaches an
// agent's inbox. Only an ACCEPTED suggestion becomes work an agent sees, as an ordinary ticket.

import { useState } from 'react';
import { REPORT_TYPES, type ReportType, type SuggestionView } from './store/types';
import { acceptSuggestion, declineSuggestion, raiseSuggestion } from './store/write';

/** Plain words for the one question a reporter can answer: how wrong is it. */
export const REPORT_LABEL: Record<ReportType, string> = {
  broken: 'It is broken',
  confusing: 'It is confusing',
  improvement: 'Could be better',
  idea: 'New idea',
};

export function RaiseForm({ project_id, onDone }: { project_id: string; onDone: () => void }) {
  const [title, setTitle] = useState('');
  const [report, setReport] = useState<ReportType | ''>('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!report) return;
    setBusy(true);
    setErr(null);
    try {
      const out = await raiseSuggestion(project_id, { title: title.trim(), report, body: body.trim() });
      if (out.ok) onDone();
      else setErr(out.error ?? 'The suggestion was not saved.');
    } catch {
      setErr('Could not reach the server. Nothing was raised.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="newtask" onSubmit={submit} data-raise="true">
      <label>
        What is it
        <input
          value={title} onChange={(e) => setTitle(e.target.value)} required autoFocus
          placeholder="Searching for a SKU with a space finds nothing"
        />
      </label>
      <fieldset className="reports">
        <legend>How would you describe it</legend>
        {REPORT_TYPES.map((r) => (
          <label key={r} className="report-opt" data-r={r}>
            <input type="radio" name="report" value={r} checked={report === r} onChange={() => setReport(r)} required />
            {REPORT_LABEL[r]}
          </label>
        ))}
      </fieldset>
      <label>
        <span>Details <span className="opt">optional</span></span>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3}
          placeholder="What you did, what you expected, what happened instead" />
      </label>
      {err && <div className="err">{err}</div>}
      <div className="row">
        <button className="cta" type="submit" disabled={busy || !title.trim() || !report}>
          {busy ? 'Raising…' : 'Raise it'}
        </button>
        <button className="ghost" type="button" onClick={onDone}>Cancel</button>
      </div>
    </form>
  );
}

/** What a triager chose to do with one suggestion, while they are choosing it. */
type Deciding = { mode: 'accept'; kind: string; scope: string } | { mode: 'decline'; reason: string } | null;

function SuggestionRow({
  s, project_id, canTriage, kinds,
}: { s: SuggestionView; project_id: string; canTriage: boolean; kinds: readonly string[] }) {
  const [deciding, setDeciding] = useState<Deciding>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const act = async () => {
    if (!deciding) return;
    setBusy(true);
    setNote(null);
    try {
      const out = deciding.mode === 'accept'
        ? await acceptSuggestion(project_id, {
          suggestion_id: s.suggestion_id, title: s.title, kind: deciding.kind,
          file_scope: deciding.scope.split(/[,\s]+/).map((g) => g.trim()).filter(Boolean),
        })
        : await declineSuggestion(project_id, s.suggestion_id, deciding.reason.trim());
      // A lost race is not an error: somebody else decided first, and the row is about to leave.
      if (!out.ok) setNote(out.error ?? `Already decided by ${String(out.result?.resolved_by ?? 'someone else')}.`);
      else setDeciding(null);
    } catch {
      setNote('Could not reach the server. Nothing changed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="qrow" data-suggestion={s.suggestion_id}>
      <div className="id"><span className="report" data-r={s.report}>{s.report}</span></div>
      <div>
        <div className="t">{s.title}</div>
        {s.body && <div className="why">{s.body}</div>}
        <div className="meta"><span className="sub">Raised by {s.raised_by_label}</span></div>

        {deciding?.mode === 'accept' && (
          <div className="decide">
            <select value={deciding.kind} onChange={(e) => setDeciding({ ...deciding, kind: e.target.value })} aria-label="Kind">
              <option value="" disabled>Kind</option>
              {kinds.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
            <input value={deciding.scope} onChange={(e) => setDeciding({ ...deciding, scope: e.target.value })}
              placeholder="File scope, e.g. web/**" aria-label="File scope" />
            <button className="cta" onClick={act} disabled={busy || !deciding.kind}>{busy ? 'Making…' : 'Make the ticket'}</button>
            <button className="ghost" onClick={() => setDeciding(null)}>Cancel</button>
          </div>
        )}
        {deciding?.mode === 'decline' && (
          <div className="decide">
            <input value={deciding.reason} onChange={(e) => setDeciding({ ...deciding, reason: e.target.value })}
              placeholder="Why not — the person who raised it reads this" aria-label="Reason" autoFocus />
            <button className="cta" onClick={act} disabled={busy || !deciding.reason.trim()}>{busy ? 'Declining…' : 'Decline'}</button>
            <button className="ghost" onClick={() => setDeciding(null)}>Cancel</button>
          </div>
        )}
        {note && <div className="why">{note}</div>}
      </div>
      <div className="act">
        {canTriage && !deciding && (
          <>
            <button className="cta" onClick={() => setDeciding({ mode: 'accept', kind: '', scope: '' })}>Make a ticket</button>
            <button className="ghost" onClick={() => setDeciding({ mode: 'decline', reason: '' })}>Decline</button>
          </>
        )}
        {!canTriage && <span className="sub">Waiting for someone to pick it up</span>}
      </div>
    </div>
  );
}

export function SuggestionsGroup({
  project_id, suggestions, canSuggest, canTriage, kinds,
}: {
  project_id: string;
  suggestions: SuggestionView[];
  canSuggest: boolean;
  canTriage: boolean;
  kinds: readonly string[];
}) {
  const [raising, setRaising] = useState(false);
  return (
    <section className="grp" data-suggestions="true">
      <div className="grp-head">
        <h2>Suggestions</h2>
        <span className="count">{suggestions.length}</span>
        <span className="note">
          {canSuggest && !raising
            ? <button className="ghost" onClick={() => setRaising(true)}>Raise something</button>
            : canTriage ? 'Make one a ticket, or say why not' : ''}
        </span>
      </div>
      {raising && <RaiseForm project_id={project_id} onDone={() => setRaising(false)} />}
      {suggestions.length === 0
        ? !raising && (
          <div className="empty">
            <b>Nothing raised</b>
            {canSuggest ? 'Something broken or confusing? Raise it and a person decides what happens.' : 'When someone raises something, it waits here for a decision.'}
          </div>
        )
        : (
          <div className="qlist">
            {suggestions.map((s) => (
              <SuggestionRow key={s.suggestion_id} s={s} project_id={project_id} canTriage={canTriage} kinds={kinds} />
            ))}
          </div>
        )}
    </section>
  );
}
