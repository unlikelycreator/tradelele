import { useState } from 'react';
import { Pause, Play, Power } from 'lucide-react';
import { api } from '../lib/api.js';
import { inr, istClock, money, pct, PHASE_LABEL, price, tone } from '../lib/format.js';

export default function TopBar({ state, connected }) {
  const [busy, setBusy] = useState(false);
  const act = async (path, confirmText) => {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    try {
      await api.post(path);
    } catch (e) {
      alert(e.message);
    } finally {
      setBusy(false);
    }
  };
  const s = state;
  return (
    <header>
      <div className="topbar">
        <div className="brand"><span className={`dot ${connected ? 'on' : ''}`} /> ZOOP/TRADE <span className="sub">— crypto breakout desk · CoinDCX</span></div>
        {s && <span className={`mode mode-${s.mode}`}>{s.mode.toUpperCase()}{s.mode !== 'live' ? ' · no real orders' : ' · REAL MONEY'}</span>}
        {s?.paused && <span className="pill warn">PAUSED</span>}
        {s?.halted && <span className="pill bad" title={s.haltReason}>HALTED</span>}
        <span className="grow" />
        {s?.usdtInr && (
          <span className="tick-item"><b>USDT/INR</b> {s.usdtInr.toFixed(2)}</span>
        )}
        {s && (
          <span className="tick-item">
            <b>DAY P&amp;L</b> <span className={tone(s.day.total)}>{money(s.day.total, { sign: true })}</span> <span className="inr">{inr(s.day.total, s.usdtInr)}</span>
          </span>
        )}
        <span className="tick-item"><b>{s ? PHASE_LABEL[s.enginePhase] || s.enginePhase : 'Connecting…'}</b></span>
        <span className="clock">{s ? `${istClock(s.now)} IST` : '—'}</span>
        {s && (s.paused || s.halted ? (
          <button className="btn sm" disabled={busy} onClick={() => act('/control/resume')}><Play size={13} /> Resume</button>
        ) : (
          <button className="btn sm" disabled={busy} onClick={() => act('/control/pause')}><Pause size={13} /> Pause</button>
        ))}
        {s && (
          <button className="btn sm danger" disabled={busy} onClick={() => act('/control/kill', 'KILL SWITCH: close ALL open positions at market and pause the bot?')}>
            <Power size={13} /> Kill switch
          </button>
        )}
      </div>
      {s && (
        <div className="ticker">
          {s.instruments.map((x) => (
            <span key={x.id} className="tick-item">
              <b>{x.label}</b> {price(x.ltp)} <span className={tone(x.change24h)}>{pct(x.change24h)}</span>
            </span>
          ))}
        </div>
      )}
      {s?.modeBlockedReason && <div className="banner warn">{s.modeBlockedReason}</div>}
      {s?.halted && <div className="banner bad">{s.haltReason}</div>}
    </header>
  );
}
