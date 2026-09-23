// Renders the suggestions group with fixture data, for both seats, so it can be SEEN without a
// signed-in member. Same approach as shell-shot.tsx.
//   node client/edge/run-shot.mjs suggestions-shot.tsx /tmp/suggestions.html
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync, writeFileSync } from 'node:fs';
import { Queue } from '../src/Queue';
import { RaiseForm, SuggestionsGroup } from '../src/Suggestions';
import { TASK_KINDS, type SuggestionView } from '../src/store/types';

const s = (o: Partial<SuggestionView> & { suggestion_id: string; title: string }): SuggestionView => ({
  body: '', report: 'improvement', status: 'open', raised_by: 'u9', raised_by_label: 'Priya Raghavan',
  raised_at: '2026-09-23T09:00:00.000Z', ...o,
});
const open = [
  s({ suggestion_id: 'sug_1', report: 'broken', title: 'Searching for a SKU with a trailing space finds nothing', body: 'Typed "B-01 " in search, got no rows.' }),
  s({ suggestion_id: 'sug_2', report: 'confusing', title: 'I could not tell which warehouse a row belongs to', raised_by_label: 'Marcus Bell' }),
  s({ suggestion_id: 'sug_3', report: 'idea', title: 'Export the list as CSV' }),
];
const page = (label: string, canTriage: boolean, canSuggest: boolean) => (
  <div className="main" data-label={label}>
    <Queue project_id="p1" projectName="inventory-tracker" ready={[]} mine={[]}
      canClaim={canTriage} canCreate={canTriage} agentConnected projectEmpty={false}
      onClaimed={() => {}} onNewTask={() => {}}>
      <SuggestionsGroup project_id="p1" suggestions={open} canSuggest={canSuggest} canTriage={canTriage} kinds={TASK_KINDS} />
    </Queue>
  </div>
);
const body = renderToStaticMarkup(
  <>
    <h4 style={{ padding: '12px 28px', color: '#888', fontFamily: 'monospace' }}>SEAT: owner (triage)</h4>
    {page('owner', true, true)}
    <h4 style={{ padding: '12px 28px', color: '#888', fontFamily: 'monospace' }}>SEAT: user (suggest only) — raise form open</h4>
    <div className="main"><main className="queue"><RaiseForm project_id="p1" onDone={() => {}} /></main></div>
    {page('user', false, true)}
  </>,
);
const css = readFileSync(new URL('../src/tokens.css', import.meta.url), 'utf8');
writeFileSync(process.argv[2] ?? '/tmp/suggestions.html',
  `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head>`
  + `<body><div id="root">${body}</div></body></html>`);
console.log('SUGGESTIONS_SHOT_OK');
