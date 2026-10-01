import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { api } from '../lib/api.js';

// [key, label, type, step | options]; keys like "futures.x" are nested
const GROUPS = [
  {
    title: 'Futures (USDT-margined perpetuals)',
    when: (m) => m !== 'spot',
    fields: [
      ['futures.leverage', 'Leverage (×) — keep it low', 'number', 1],
      ['futures.allowShorts', 'Allow short trades', 'bool'],
    ],
  },
  {
    title: 'Signal: channel breakout',
    fields: [
      ['timeframe', 'Candle size (minutes)', 'select', [5, 15, 30, 60]],
      ['channelBars', 'Breakout of the last N candles', 'number', 1],
      ['breakoutBufferPct', 'Close must clear the channel by (%)', 'number', 0.01],
      ['useTrendFilter', 'Trade only with the EMA trend', 'bool'],
      ['emaPeriod', 'Trend EMA period', 'number', 1],
      ['atrPeriod', 'ATR period', 'number', 1],
      ['minAtrPct', 'Skip if ATR below (% of price)', 'number', 0.05],
      ['maxAtrPct', 'Skip if ATR above (% of price)', 'number', 0.1],
      ['cooldownBars', 'Candles to wait after a trade on that coin', 'number', 1],
    ],
  },
  {
    title: 'Exits',
    fields: [
      ['stopAtr', 'Stop distance (× ATR)', 'number', 0.1],
      ['maxStopPct', 'Max stop distance from entry (%)', 'number', 0.1],
      ['rewardRisk', 'Target = reward : risk', 'number', 0.1],
      ['trailToBreakevenAtR', 'Move stop to breakeven after (R, 0 = off)', 'number', 0.1],
      ['trailAtr', 'Then trail the stop by (× ATR, 0 = off)', 'number', 0.1],
      ['maxHoldHours', 'Close trades older than (hours, 0 = off)', 'number', 1],
    ],
  },
  {
    title: 'Risk (USDT)',
    fields: [
      ['capital', 'Capital (USDT, blank = CAPITAL from .env)', 'number', 10],
      ['riskPerTradePct', 'Max loss per trade (% of capital)', 'number', 0.1],
      ['maxPositionPct', 'Max margin per trade (% of capital)', 'number', 1],
      ['maxOpenPositions', 'Max open positions', 'number', 1],
      ['maxTradesPerDay', 'Max trades per IST day', 'number', 1],
      ['maxDailyLossPct', 'Stop for the day after losing (% of capital)', 'number', 0.1],
      ['paperSlippageBps', 'Paper-trading slippage (bps)', 'number', 1],
    ],
  },
  {
    title: 'CoinDCX fees (match your fee tier)',
    fields: [
      ['fees.spotPct', 'Spot fee per side (%)', 'number', 0.01],
      ['fees.futuresTakerPct', 'Futures taker fee per side (%)', 'number', 0.005],
      ['fees.gstPct', 'GST on fees (%)', 'number', 1],
      ['fees.tdsPct', 'TDS on spot sells (%) — shown, not deducted', 'number', 0.1],
    ],
  },
];

const list = (text) => text.split(/[\s,]+/).map((x) => x.trim().toUpperCase()).filter(Boolean);

export default function Settings() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['settings'], queryFn: () => api.get('/settings') });
  const [form, setForm] = useState(null);
  const [spot, setSpot] = useState('');
  const [fut, setFut] = useState('');
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    if (data) {
      setForm(data);
      setSpot(data.spotSymbols.join(', '));
      setFut(data.futuresPairs.join(', '));
    }
  }, [data]);

  if (!form) return <div className="empty">Loading…</div>;

  const get = (k) => (k.includes('.') ? form[k.split('.')[0]]?.[k.split('.')[1]] : form[k]);
  const set = (k, v) =>
    setForm((f) => {
      if (!k.includes('.')) return { ...f, [k]: v };
      const [a, b] = k.split('.');
      return { ...f, [a]: { ...f[a], [b]: v } };
    });
  const save = async () => {
    setMsg(null);
    try {
      const next = await api.put('/settings', { ...form, spotSymbols: list(spot), futuresPairs: list(fut) });
      qc.setQueryData(['settings'], next);
      setMsg({ ok: true, text: 'Saved. Changes apply on the next candle check (a few seconds).' });
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    }
  };

  return (
    <div className="page narrow">
      <div className="page-head">
        <h2>Strategy &amp; risk</h2>
        <button className="btn primary" onClick={save}><Save size={14} /> Save</button>
      </div>
      {msg && <div className={`banner ${msg.ok ? 'good' : 'bad'}`}>{msg.text}</div>}
      <div className="panel muted small">
        Paper and live mode are set only in <code>backend/.env</code>, never from this page. Live trading also needs <code>LIVE_TRADING_CONFIRM</code>, your CoinDCX API keys and the
        required number of completed paper days. Open positions keep being managed when you change these settings.
      </div>

      <div className="panel">
        <div className="label">What to trade</div>
        <div className="seg">
          {[['futures', 'Futures'], ['spot', 'Spot'], ['both', 'Both']].map(([v, l]) => (
            <button key={v} className={form.market === v ? 'on' : ''} onClick={() => set('market', v)}>{l}</button>
          ))}
        </div>
        <div className="muted small">
          Futures can go long or short and use leverage: the stop-loss is placed on the exchange, and the bot refuses trades whose stop sits too close to the liquidation
          price. Spot is long only, with no leverage. In India, 1% TDS is withheld on every spot sell.
        </div>
      </div>

      {form.market !== 'futures' && (
        <div className="panel">
          <div className="label">Spot markets (CoinDCX, USDT quoted)</div>
          <textarea className="input" rows={2} value={spot} onChange={(e) => setSpot(e.target.value.toUpperCase())} />
          <div className="muted small">For example <code>BTCUSDT, ETHUSDT, SOLUSDT</code>. Stick to liquid coins: thin markets mean slippage and fake breakouts.</div>
        </div>
      )}
      {form.market !== 'spot' && (
        <div className="panel">
          <div className="label">Futures pairs (CoinDCX USDT-M perpetuals)</div>
          <textarea className="input" rows={2} value={fut} onChange={(e) => setFut(e.target.value.toUpperCase())} />
          <div className="muted small">CoinDCX futures pair format, for example <code>B-BTC_USDT, B-ETH_USDT</code>.</div>
        </div>
      )}

      {GROUPS.filter((g) => !g.when || g.when(form.market)).map((g) => (
        <div key={g.title} className="panel">
          <div className="label">{g.title}</div>
          <div className="form-grid">
            {g.fields.map(([k, label, type, step]) => (
              <label key={k} className="field">
                <span>{label}</span>
                {type === 'bool' ? (
                  <input type="checkbox" checked={!!get(k)} onChange={(e) => set(k, e.target.checked)} />
                ) : type === 'select' ? (
                  <select className="input" value={get(k)} onChange={(e) => set(k, Number(e.target.value))}>
                    {step.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : (
                  <input
                    className="input"
                    type="number"
                    step={step}
                    value={get(k) ?? ''}
                    onChange={(e) => set(k, e.target.value === '' ? (k === 'capital' ? null : '') : Number(e.target.value))}
                  />
                )}
              </label>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
