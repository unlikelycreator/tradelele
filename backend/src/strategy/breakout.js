/**
 * Trend-filtered channel breakout — pure functions, no I/O, fully unit-tested.
 *
 * Crypto trades 24×7, so there is no "opening range". Instead, on every CLOSED candle:
 *  1. Channel = highest high / lowest low of the previous N candles (Donchian, default 20).
 *  2. LONG  when the candle CLOSES above channel high × (1 + buffer)
 *     SHORT when the candle CLOSES below channel low  × (1 − buffer)   (futures only)
 *     Using the close (not a tick) filters most wick fake-outs.
 *  3. Trend filter: longs only above the EMA (default 50), shorts only below.
 *  4. Volatility filter: skip if ATR is too small (dead market) or too large (stop too wide).
 *  5. Stop = entry ∓ stopAtr × ATR, capped at maxStopPct. Target = entry ± rewardRisk × risk.
 *     Stop moves to breakeven (+ fees) after +1R; optional ATR trail after that.
 */

const round8 = (x) => +x.toPrecision(10);

export function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

/** Wilder's ATR over `period` candles. */
export function atr(candles, period) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const pc = candles[i - 1].close;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc)));
  }
  let a = trs.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = period; i < trs.length; i++) a = (a * (period - 1) + trs[i]) / period;
  return a;
}

export function minCandles(s) {
  return Math.max(s.channelBars + 1, s.emaPeriod + 1, s.atrPeriod + 2);
}

/**
 * Indicators on CLOSED candles (oldest first). The last candle is the one just closed.
 * Returns null if there is not enough history.
 */
export function indicators(candles, s) {
  if (candles.length < minCandles(s)) return null;
  const last = candles[candles.length - 1];
  const prior = candles.slice(-1 - s.channelBars, -1);
  const high = Math.max(...prior.map((c) => c.high));
  const low = Math.min(...prior.map((c) => c.low));
  const e = ema(candles.map((c) => c.close), s.emaPeriod);
  const a = atr(candles.slice(-(s.atrPeriod * 4 + 1)), s.atrPeriod);
  return { close: last.close, time: last.time, channelHigh: high, channelLow: low, ema: e, atr: a, atrPct: (a / last.close) * 100, trend: last.close >= e ? 'up' : 'down' };
}

/**
 * Signal for the candle that just closed.
 * Returns null (nothing), { blocked: true, side, reason } or { side: 'BUY'|'SELL', reason, ind }.
 */
export function breakoutSignal(ind, s, { allowShort }) {
  if (!ind) return null;
  const buf = s.breakoutBufferPct / 100;
  let side = null;
  if (ind.close > ind.channelHigh * (1 + buf)) side = 'BUY';
  else if (ind.close < ind.channelLow * (1 - buf)) side = 'SELL';
  if (!side) return null;

  const what = side === 'BUY' ? `close ${fmt(ind.close)} > ${s.channelBars}-bar high ${fmt(ind.channelHigh)}` : `close ${fmt(ind.close)} < ${s.channelBars}-bar low ${fmt(ind.channelLow)}`;
  if (side === 'SELL' && !allowShort) return { blocked: true, side, reason: 'downside breakout but shorts not allowed here' };
  if (s.useTrendFilter && side === 'BUY' && ind.close < ind.ema) return { blocked: true, side, reason: `upside breakout but below EMA${s.emaPeriod}` };
  if (s.useTrendFilter && side === 'SELL' && ind.close > ind.ema) return { blocked: true, side, reason: `downside breakout but above EMA${s.emaPeriod}` };
  if (ind.atrPct < s.minAtrPct) return { blocked: true, side, reason: `ATR ${ind.atrPct.toFixed(2)}% < min ${s.minAtrPct}% (too quiet)` };
  if (ind.atrPct > s.maxAtrPct) return { blocked: true, side, reason: `ATR ${ind.atrPct.toFixed(2)}% > max ${s.maxAtrPct}% (too wild)` };
  return { side, reason: what, ind };
}

/** Stop and target for an entry. `roundPx(price, dir)` rounds to the instrument tick. */
export function stopAndTarget({ side, entry, atr: a, settings: s, roundPx = (x) => round8(x) }) {
  const dist = Math.min(s.stopAtr * a, (entry * s.maxStopPct) / 100);
  const long = side === 'BUY';
  const stop = roundPx(long ? entry - dist : entry + dist, long ? 'down' : 'up');
  const risk = Math.abs(entry - stop);
  const target = roundPx(long ? entry + s.rewardRisk * risk : entry - s.rewardRisk * risk, 'nearest');
  return { stop, target, risk: round8(risk) };
}

/**
 * Trailing: after +trailToBreakevenAtR × risk the stop moves to entry ± round-trip costs
 * (so a "breakeven" exit really is breakeven), then optionally trails `trailAtr` ATRs behind
 * the close. Returns a better stop or null. Only ever tightens.
 */
export function trailStop({ side, entry, stop, initialRisk, price, atr: a, settings: s, costPct, roundPx = (x) => round8(x) }) {
  if (!(initialRisk > 0)) return null;
  const long = side === 'BUY';
  const move = long ? price - entry : entry - price;
  let candidate = null;
  if (s.trailToBreakevenAtR > 0 && move >= s.trailToBreakevenAtR * initialRisk) {
    const c = costPct / 100;
    candidate = long ? entry * (1 + c) : entry * (1 - c);
  }
  if (s.trailAtr > 0 && a > 0 && candidate != null) {
    const t = long ? price - s.trailAtr * a : price + s.trailAtr * a;
    candidate = long ? Math.max(candidate, t) : Math.min(candidate, t);
  }
  if (candidate == null) return null;
  // never place a stop on the wrong side of the current price
  if (long ? candidate >= price : candidate <= price) return null;
  const next = roundPx(candidate, long ? 'down' : 'up');
  return (long ? next > stop : next < stop) ? next : null;
}

export function pnl(side, entry, exit, qty) {
  return round8((side === 'BUY' ? exit - entry : entry - exit) * qty);
}

function fmt(x) {
  return x >= 100 ? x.toFixed(2) : x >= 1 ? x.toFixed(4) : x.toPrecision(4);
}
