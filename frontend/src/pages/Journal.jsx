import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { istDayHM, money, price, qty, sidePill, tone } from '../lib/format.js';
import EChart, { C } from '../components/EChart.jsx';

export default function Journal({ mode: liveMode }) {
  const [mode, setMode] = useState(null);
  const m = mode || liveMode || 'paper';
  const { data: trades = [] } = useQuery({ queryKey: ['alltrades', m], queryFn: () => api.get(`/trades?mode=${m}&limit=1000`), refetchInterval: 15000 });
  const { data: daily = [] } = useQuery({ queryKey: ['daily', m], queryFn: () => api.get(`/daily?mode=${m}`), refetchInterval: 15000 });

  const closed = trades.filter((t) => t.status === 'CLOSED');
  const stats = useMemo(() => computeStats(closed), [closed]);

  const equity = useMemo(() => {
    let cum = 0;
    let peak = 0;
    let maxDd = 0;
    const pts = daily.map((d) => {
      cum += d.netPnl || 0;
      peak = Math.max(peak, cum);
      maxDd = Math.max(maxDd, peak - cum);
      return [d.date, +cum.toFixed(2)];
    });
    return { pts, maxDd };
  }, [daily]);

  const option = useMemo(
    () => ({
      animation: false,
      grid: { left: 60, right: 16, top: 16, bottom: 28 },
      tooltip: { trigger: 'axis', backgroundColor: '#0b1511', borderColor: '#1f3a2f', textStyle: { color: '#d5efe4' } },
      xAxis: { type: 'category', data: equity.pts.map((p) => p[0]), axisLabel: { color: C.axis, fontSize: 10 }, axisLine: { lineStyle: { color: C.grid } } },
      yAxis: { type: 'value', axisLabel: { color: C.axis, fontSize: 10 }, splitLine: { lineStyle: { color: C.grid } } },
      series: [
        { type: 'line', name: 'Cumulative net P&L', data: equity.pts.map((p) => p[1]), smooth: false, showSymbol: true, lineStyle: { color: C.up }, itemStyle: { color: C.up }, areaStyle: { color: 'rgba(46,229,157,0.12)' } },
        { type: 'bar', name: 'Day net', barMaxWidth: 36, data: daily.map((d) => ({ value: d.netPnl, itemStyle: { color: d.netPnl >= 0 ? C.up : C.down, opacity: 0.55 } })) },
      ],
    }),
    [equity, daily],
  );

  return (
    <div className="page">
      <div className="page-head">
        <h2>Trade journal</h2>
        <div className="seg">
          {['paper', 'live', 'sim'].map((x) => (
            <button key={x} className={x === m ? 'on' : ''} onClick={() => setMode(x)}>{x}</button>
          ))}
        </div>
      </div>

      <div className="stats">
        <Stat k="Net P&L" v={money(stats.net, { sign: true })} t={tone(stats.net)} />
        <Stat k="Trades" v={stats.n} />
        <Stat k="Win rate" v={stats.n ? `${stats.winRate}%` : '—'} />
        <Stat k="Avg win / loss" v={stats.n ? `${money(stats.avgWin, { unit: false })} / ${money(stats.avgLoss, { unit: false })}` : '—'} />
        <Stat k="Profit factor" v={stats.pf ?? '—'} />
        <Stat k="Expectancy" v={stats.expR != null ? `${stats.expR}R` : '—'} t={tone(stats.expR)} />
        <Stat k="Max drawdown" v={money(-equity.maxDd)} t={equity.maxDd ? 'down' : ''} />
        <Stat k="Fees" v={money(stats.fees)} />
        <Stat k="Long / short net" v={stats.n ? `${money(stats.longNet, { sign: true, unit: false })} / ${money(stats.shortNet, { sign: true, unit: false })}` : '—'} />
      </div>
      {stats.n > 0 && stats.n < 50 && <div className="banner warn">Only {stats.n} trades — too small a sample to judge the strategy. Aim for 50+ before drawing conclusions.</div>}

      <div className="panel">
        <div className="label">Equity curve (cumulative net P&amp;L by IST day, USDT)</div>
        {equity.pts.length ? <EChart option={option} height={260} /> : <div className="empty">No completed sessions yet.</div>}
      </div>

      <div className="panel">
        <div className="label">All trades</div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Market</th><th>Side</th><th className="r">Qty</th><th className="r">Entry</th><th className="r">Exit</th><th>Opened → closed (IST)</th><th>Exit reason</th><th className="r">R</th><th className="r">Fees</th><th className="r">Net (USDT)</th></tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t._id}>
                  <td className="sym">{t.label} <span className={`kind ${t.kind}`}>{t.kind === 'futures' ? `PERP${t.leverage > 1 ? ` ${t.leverage}×` : ''}` : 'SPOT'}</span></td>
                  <td><span className={`pill ${sidePill(t)[1]}`}>{sidePill(t)[0]}</span></td>
                  <td className="r mono">{qty(t.qty)}</td>
                  <td className="r mono">{price(t.entryPrice)}</td>
                  <td className="r mono">{price(t.exitPrice)}</td>
                  <td className="mono small">{istDayHM(t.entryAt)} → {t.exitAt ? istDayHM(t.exitAt) : '…'}</td>
                  <td className="small">{t.status === 'CLOSED' ? t.exitReason : <span className="muted">{t.status.toLowerCase()}{t.note ? ` · ${t.note}` : ''}</span>}</td>
                  <td className={`r mono ${tone(t.rMultiple)}`}>{t.rMultiple ?? '—'}</td>
                  <td className="r mono muted">{t.fees != null ? money(t.fees, { unit: false }) : '—'}</td>
                  <td className={`r mono ${tone(t.netPnl)}`}>{t.netPnl != null ? money(t.netPnl, { sign: true, unit: false }) : '—'}</td>
                </tr>
              ))}
              {!trades.length && (
                <tr><td colSpan={10} className="muted pad">No trades recorded in {m} mode yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function Stat({ k, v, t = '' }) {
  return (
    <div className="panel stat">
      <div className="label">{k}</div>
      <div className={`statv ${t}`}>{v}</div>
    </div>
  );
}

function computeStats(closed) {
  const n = closed.length;
  const wins = closed.filter((t) => t.netPnl > 0);
  const losses = closed.filter((t) => t.netPnl <= 0);
  const sum = (a, f) => a.reduce((s, t) => s + (f(t) || 0), 0);
  const grossWin = sum(wins, (t) => t.netPnl);
  const grossLoss = -sum(losses, (t) => t.netPnl);
  const rs = closed.filter((t) => t.rMultiple != null);
  return {
    n,
    net: +sum(closed, (t) => t.netPnl).toFixed(2),
    fees: sum(closed, (t) => t.fees),
    longNet: sum(closed.filter((t) => t.side === 'BUY'), (t) => t.netPnl),
    shortNet: sum(closed.filter((t) => t.side === 'SELL'), (t) => t.netPnl),
    winRate: n ? Math.round((wins.length / n) * 100) : 0,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? -grossLoss / losses.length : 0,
    pf: grossLoss > 0 ? (grossWin / grossLoss).toFixed(2) : wins.length ? '∞' : null,
    expR: rs.length ? +(sum(rs, (t) => t.rMultiple) / rs.length).toFixed(2) : null,
  };
}
