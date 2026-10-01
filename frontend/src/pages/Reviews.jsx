import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { api } from '../lib/api.js';

export default function Reviews({ state }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mode = state?.mode;
  const { data: reviews = [] } = useQuery({ queryKey: ['reviews', mode], queryFn: () => api.get(`/reviews?mode=${mode}`), enabled: Boolean(mode) });

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      await api.post('/reviews/run', { date: state.date });
      qc.invalidateQueries({ queryKey: ['reviews'] });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page narrow">
      <div className="page-head">
        <h2>AI end-of-day review</h2>
        <button className="btn primary" disabled={busy || !state?.reviewer} onClick={run}><Sparkles size={14} /> {busy ? 'Reviewing…' : `Review ${state?.date || 'today'}`}</button>
      </div>
      <div className="panel muted small">
        Gemini reads each IST day&apos;s trades and writes a journal entry: what worked, execution problems and patterns over time.
        It <b>never</b> places, sizes or blocks trades. An LLM is too slow and unpredictable for that, and you can&apos;t backtest it. A review runs automatically just after
        midnight IST for the day that ended, when <code>GEMINI_API_KEY</code> is set.
      </div>
      {!state?.reviewer && <div className="banner warn">Gemini is off. Add GEMINI_API_KEY to backend/.env to enable reviews (optional).</div>}
      {error && <div className="banner bad">{error}</div>}
      {reviews.map((r) => (
        <div key={r._id} className="panel review">
          <div className="panel-head"><span className="title">{r.date}</span><span className="muted small">{r.model}</span></div>
          <Markdown text={r.text} />
        </div>
      ))}
      {!reviews.length && <div className="empty">No reviews yet.</div>}
    </div>
  );
}

/** Tiny markdown renderer (headings, bold, lists, paragraphs) — enough for review text. */
function Markdown({ text }) {
  const inline = (s) =>
    s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) =>
      part.startsWith('**') ? <b key={i}>{part.slice(2, -2)}</b> : part.startsWith('`') ? <code key={i}>{part.slice(1, -1)}</code> : part,
    );
  const blocks = [];
  let list = null;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const li = line.match(/^\s*(?:[-*]|\d+\.)\s+(.*)/);
    if (li) {
      if (!list) blocks.push((list = { type: 'ul', items: [] }));
      list.items.push(li[1]);
      continue;
    }
    list = null;
    if (!line.trim()) continue;
    const h = line.match(/^#{1,4}\s+(.*)/);
    blocks.push(h ? { type: 'h', text: h[1] } : { type: 'p', text: line });
  }
  return (
    <div className="md">
      {blocks.map((b, i) =>
        b.type === 'ul' ? (
          <ul key={i}>{b.items.map((it, j) => <li key={j}>{inline(it)}</li>)}</ul>
        ) : b.type === 'h' ? (
          <h4 key={i}>{inline(b.text)}</h4>
        ) : (
          <p key={i}>{inline(b.text)}</p>
        ),
      )}
    </div>
  );
}
