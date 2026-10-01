import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { api } from '../lib/api.js';
import { countdown, inr, istClock, istDayHM, istHM, money, pct, price, qty, sidePill, tone } from '../lib/format.js';
import PriceChart from '../components/PriceChart.jsx';
import EChart, { C } from '../components/EChart.jsx';

const STATUS_LABEL = {
  warming_up: 'loading',
  watching: 'watching',
  in_trade: 'in trade',
  cooldown: 'cooldown',
  paused: 'paused',
  skipped: 'skipped',
  error: 'error',
};

export default function Live({ state, logs, connected }) {
  const [selected, setSelected] = useState(null);
  const s = state;
  const instId = selected || s?.positions?.[0]?.instId || s?.instruments?.[0]?.id;
  const position = s?.positions?.find((p) => p.instId === instId);
  const inst = s?.instruments?.find((x) => x.id === instId);

  // P&L curve for the day, sampled from the live stream
  const curve = useRef([]);
  const [curveTick, setCurveTick] = useState(0);
  useEffect(() => {
    if (!s) return;
    const arr = curve.current;
    const last = arr[arr.length - 1];
    if (!last || new Date(s.now) - new Date(last[0]) >= 30_000) {
      arr.push([s.now, s.day.total]);
      if (arr.length > 3000) arr.shift();
      setCurveTick((x) => x + 1);
    }
  }, [s]);

  const { data: trades = [] } = useQuery({
    queryKey: ['trades', s?.date, s?.mode],
    queryFn: () => api.get(`/trades?date=${s.date}&mode=${s.mode}`),
    enabled: Boolean(s?.date),
    refetchInterval: 5000,
  });

  if (!s) return <div className="empty">{connected ? 'Loading…' : 'Connecting to the trading engine…'}</div>;

  const d = s.day;
  const winRate = d.closed ? Math.round((d.wins / d.closed) * 100) : null;
  const lossUsed = d.total < 0 ? Math.min(100, (-d.total / d.lossLimit) * 100) : 0;
  const st = s.strategy;

  return (
    <div className="desk">
      {/* ── left column ── */}
      <section className="col">
        <div className="panel">
          <div className="label">Today (IST) · net P&amp;L after fees</div>
          <div className={`bignum ${tone(d.total)}`}>{money(d.total, { sign: true, unit: false })}<span className="muted small"> USDT</span></div>
          <div className="inr">{inr(d.total, s.usdtInr)}</div>
          <div className="row small">
            <span>realized <b className={tone(d.realized)}>{money(d.realized, { sign: true, unit: false })}</b></span>
            <span>open <b className={tone(d.unrealized)}>{money(d.unrealized, { sign: true, unit: false })}</b></span>
          </div>
          <PnlSpark data={curve.current} tick={curveTick} />
        </div>

        <div className="panel kv">
          <KV k="Capital" v={`${money(s.capital, { dp: 0 })}`} />
          <KV k="Trades today" v={`${d.trades}`} />
          <KV k="Win / loss" v={`${d.wins} / ${d.losses}${winRate != null ? `  (${winRate}%)` : ''}`} />
          <KV k="Fees paid" v={money(d.fees)} />
          {d.tds > 0 && <KV k="TDS withheld (spot)" v={money(d.tds)} />}
          <div className="meter-wrap">
            <div className="label">Daily loss limit {money(d.lossLimit)}</div>
            <div className="meter"><div className="fill bad" style={{ width: `${lossUsed}%` }} /></div>
          </div>
          {s.mode === 'paper' && s.paperDays && (
            <div className="meter-wrap">
              <div className="label">Paper days before live: {Math.min(s.paperDays.done, s.paperDays.required)}/{s.paperDays.required} · today {d.activeHours}h/20h</div>
              <div className="meter"><div className="fill" style={{ width: `${Math.min(100, (s.paperDays.done / Math.max(1, s.paperDays.required)) * 100)}%` }} /></div>
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panel-head"><span className="label">Open positions</span><span className="muted small">{s.positions.length}</span></div>
          {!s.positions.length && <div className="muted small pad">No open positions.</div>}
          {s.positions.map((p) => (
            <Position key={p.id} p={p} onSelect={() => setSelected(p.instId)} />
          ))}
        </div>

        <div className="panel">
          <div className="label">Strategy</div>
          <div className="timeline">
            <span>{st.timeframe}m candles</span>
            <span>{st.channelBars}-bar channel</span>
            <span>EMA{st.emaPeriod} trend filter</span>
            <span>{st.market !== 'spot' ? `futures ${st.leverage}×` : 'spot only'}</span>
            <span>next check in</span>
            <span>{countdown(st.nextScanAt, s.now)}</span>
          </div>
        </div>
      </section>

      {/* ── centre ── */}
      <section className="col wide">
        <div className="panel">
          <div className="panel-head">
            <div>
              <span className="title">{inst?.label || position?.label} <span className="muted">· {inst?.kind || position?.kind} · {st.timeframe}m</span></span>
              {position && <span className={`pill ${sidePill(position)[1]}`}>{sidePill(position)[0]} {qty(position.qty)}{position.leverage > 1 ? ` · ${position.leverage}×` : ''}</span>}
            </div>
            <div className="bigprice">{price(position?.ltp ?? inst?.ltp)}</div>
          </div>
          {s.instruments.length > 1 && (
            <div className="seg sm">
              {s.instruments.map((c) => (
                <button key={c.id} className={c.id === instId ? 'on' : ''} onClick={() => setSelected(c.id)}>{c.label}</button>
              ))}
            </div>
          )}
          <PriceChart instId={instId} position={position} />
        </div>

        <div className="panel">
          <div className="panel-head"><span className="label">Breakout scanner · close beyond the {st.channelBars}-candle channel, with the EMA{st.emaPeriod} trend</span></div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Market</th><th className="r">Price</th><th className="r">24h</th><th className="r">Channel high</th><th className="r">Channel low</th><th className="r">ATR</th><th>Trend</th><th>Status</th><th>Note</th></tr>
              </thead>
              <tbody>
                {s.instruments.map((x) => (
                  <tr key={x.id} className={x.id === instId ? 'sel' : ''} onClick={() => setSelected(x.id)}>
                    <td className="sym">{x.label} <span className={`kind ${x.kind}`}>{x.kind === 'futures' ? 'PERP' : 'SPOT'}</span></td>
                    <td className="r mono">{price(x.ltp)}</td>
                    <td className={`r mono ${tone(x.change24h)}`}>{pct(x.change24h)}</td>
                    <td className="r mono">{price(x.channelHigh)}</td>
                    <td className="r mono">{price(x.channelLow)}</td>
                    <td className="r mono">{x.atrPct != null ? `${x.atrPct}%` : '—'}</td>
                    <td className={`mono small trend-${x.trend}`}>{x.trend ? (x.trend === 'up' ? '▲ up' : '▼ down') : '—'}</td>
                    <td><span className={`status st-${x.status}`}>{STATUS_LABEL[x.status] || x.status}</span></td>
                    <td className="muted small note">{x.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ── right column ── */}
      <section className="col">
        <div className="panel log-panel">
          <div className="panel-head"><span className="label">Decision log</span><span className={`pill ${connected ? 'good' : 'bad'}`}>{connected ? 'LIVE' : 'OFFLINE'}</span></div>
          <div className="log">
            {logs.map((e, i) => (
              <div key={`${e.ts}-${i}`} className={`log-row lv-${e.level}`}>
                <span className="log-ts">{istClock(e.ts)}</span>
                <span className="log-lv">{e.level}</span>
                <span className="log-msg">{e.message}</span>
              </div>
            ))}
            {!logs.length && <div className="muted small pad">Nothing logged yet.</div>}
          </div>
        </div>

        <div className="panel">
          <div className="label">Data &amp; API</div>
          <div className="kv">
            <KV k="Price source" v={s.feed.source === 'sim' ? `Simulator (${s.feed.speed}× speed)` : 'CoinDCX live prices'} />
            {s.feed.lastOkAt && <KV k="Last price update" v={istClock(s.feed.lastOkAt)} />}
            {s.feed.lastError && <div className="err small">{s.feed.lastError}</div>}
            {s.instruments.some((i) => i.rules === 'default') && s.feed.source !== 'sim' && (
              <div className="muted small">Some exchange rules (tick/step size) could not be loaded — using estimates.</div>
            )}
          </div>
          {s.rateLimits?.map((r) => (
            <div key={r.name} className="meter-wrap">
              <div className="label">{r.name} · {r.lastMinute}/{r.perMinute} per min</div>
              <div className="meter"><div className="fill" style={{ width: `${Math.min(100, (r.lastMinute / r.perMinute) * 100)}%` }} /></div>
            </div>
          ))}
          {!s.rateLimits?.length && <div className="muted small">No CoinDCX API calls in simulator mode.</div>}
        </div>
      </section>

      {/* ── bottom strip ── */}
      <section className="strip">
        <div className="label">Today&apos;s trades</div>
        <div className="cards">
          {!trades.length && <div className="muted small pad">No trades yet today.</div>}
          {trades.map((t) => (
            <div key={t._id} className="tcard" onClick={() => setSelected(t.instId)}>
              <div className="row">
                <span className={`pill ${sidePill(t)[1]}`}>{sidePill(t)[0]}</span>
                <b>{t.label}</b>
                <span className="muted small">× {qty(t.qty)}</span>
              </div>
              <div className="small muted">{istHM(t.entryAt)} @ {price(t.entryPrice)} {t.exitPrice ? `→ ${istDayHM(t.exitAt)} @ ${price(t.exitPrice)}` : ''}</div>
              <div className="row">
                <span className="small muted">{t.status === 'CLOSED' ? t.exitReason : t.status.toLowerCase()}</span>
                {t.status === 'CLOSED' && <b className={tone(t.netPnl)}>{money(t.netPnl, { sign: true })}</b>}
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function KV({ k, v }) {
  return (
    <div className="kv-row">
      <span className="muted">{k}</span>
      <span className="mono">{v}</span>
    </div>
  );
}

function Position({ p, onSelect }) {
  const close = async (e) => {
    e.stopPropagation();
    if (!window.confirm(`Close ${p.label} now at market?`)) return;
    try {
      await api.post(`/control/close/${p.id}`);
    } catch (err) {
      alert(err.message);
    }
  };
  return (
    <div className="pos" onClick={onSelect}>
      <div className="row">
        <span className={`pill ${sidePill(p)[1]}`}>{sidePill(p)[0]}</span>
        <b>{p.label}</b>
        <span className="muted small">× {qty(p.qty)}{p.leverage > 1 ? ` · ${p.leverage}×` : ''}</span>
        <span className="grow" />
        <b className={tone(p.unrealized)}>{money(p.unrealized, { sign: true, unit: false })}</b>
        {p.status === 'OPEN' && <button className="btn icon sm" title="Close at market" onClick={close}><X size={13} /></button>}
      </div>
      <div className="pos-grid small mono">
        <span>entry {price(p.entryPrice)}</span>
        <span>last {price(p.ltp)}</span>
        <span className="down">SL {price(p.stop)}{p.trailed ? ' (trailed)' : ''}</span>
        <span className="up">TGT {price(p.target)}</span>
      </div>
      {p.softStop && <div className="err small">No exchange stop — the bot is watching the stop itself</div>}
      {p.status !== 'OPEN' && <div className="muted small">{p.status.toLowerCase()}…</div>}
    </div>
  );
}

function PnlSpark({ data, tick }) {
  const option = useMemo(
    () => ({
      animation: false,
      grid: { left: 0, right: 0, top: 6, bottom: 0 },
      xAxis: { type: 'time', show: false },
      yAxis: { type: 'value', show: false, scale: true },
      series: [
        {
          type: 'line',
          data,
          showSymbol: false,
          lineStyle: { color: C.up, width: 1.5 },
          areaStyle: { color: { type: 'linear', x: 0, y: 0, x2: 0, y2: 1, colorStops: [{ offset: 0, color: 'rgba(46,229,157,0.35)' }, { offset: 1, color: 'rgba(46,229,157,0)' }] } },
        },
      ],
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tick],
  );
  if (data.length < 2) return <div className="spark-empty muted small">P&amp;L curve builds while the dashboard is open</div>;
  return <EChart option={option} height={70} />;
}
