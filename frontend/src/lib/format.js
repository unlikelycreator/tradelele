const usd = (dp) => new Intl.NumberFormat('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const inr0 = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });

/** USDT amount: "+12.34 USDT" (dp adapts so tiny amounts stay readable). */
export const money = (v, { sign = false, dp = 2, unit = true } = {}) => {
  if (v == null || Number.isNaN(v)) return '—';
  const abs = Math.abs(v);
  const d = abs !== 0 && abs < 1 && dp === 2 ? 4 : dp;
  const pre = v < 0 ? '−' : sign && v > 0 ? '+' : '';
  return `${pre}${usd(d).format(abs)}${unit ? ' USDT' : ''}`;
};

/** ₹ equivalent of a USDT amount, if the USDT/INR rate is known. */
export const inr = (usdt, rate) => (usdt == null || !rate ? '' : `≈ ${usdt < 0 ? '−' : ''}₹${inr0.format(Math.abs(usdt * rate))}`);

/** Price with decimals that suit its size (BTC 61,234.5 · XRP 0.5432). */
export const price = (v) => {
  if (v == null || Number.isNaN(v)) return '—';
  const a = Math.abs(v);
  const dp = a >= 1000 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : a >= 0.01 ? 5 : 8;
  return usd(dp).format(v);
};
export const qty = (v) => (v == null ? '—' : String(+Number(v).toPrecision(8)));
export const pct = (v, sign = true) => (v == null ? '—' : `${sign && v > 0 ? '+' : ''}${Number(v).toFixed(2)}%`);
export const tone = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : 'flat');

const tf = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
const tfShort = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false });
const dfShort = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
export const istClock = (d) => (d ? tf.format(new Date(d)) : '—');
export const istHM = (d) => (d ? tfShort.format(new Date(d)) : '—');
export const istDayHM = (d) => (d ? dfShort.format(new Date(d)) : '—');

export const PHASE_LABEL = {
  warming_up: 'Loading candles',
  hunting: 'Scanning for breakouts',
  managing: 'Managing positions',
  paused: 'Paused',
  halted: 'Halted',
  loss_limit: 'Daily loss limit hit',
};

/** Pill text + tone for a trade/position. */
export function sidePill(t) {
  return t?.side === 'BUY' ? ['LONG', 'good'] : ['SHORT', 'bad'];
}

/** "in 3m 20s" until a date. */
export function countdown(to, now) {
  if (!to) return '—';
  const s = Math.max(0, Math.round((new Date(to) - new Date(now)) / 1000));
  const m = Math.floor(s / 60);
  return m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}
