import { EventEmitter } from 'node:events';
import { barStart } from '../lib/time.js';
import { log } from '../lib/bus.js';

/**
 * Shared market-data layer. Feeds (CoinDCX poller / simulator) call `pushTick`;
 * this class keeps last prices and the candles shown on the dashboard, and emits
 *   'tick' (instrumentId, ltp)   on every price update.
 */
export class MarketData extends EventEmitter {
  constructor(clock) {
    super();
    this.clock = clock;
    this.prices = new Map(); // id → { ltp, at, change24h }
    this.candles = new Map(); // id → candles (oldest first) at the strategy timeframe
    this.tf = 15;
    this.usdtInr = null;
  }

  ltp(id) {
    return this.prices.get(id)?.ltp ?? null;
  }

  change24h(id) {
    return this.prices.get(id)?.change24h ?? null;
  }

  pushTick(id, ltp, extra = {}) {
    if (!(ltp > 0)) return;
    const now = this.clock.now();
    this.prices.set(id, { ltp, at: now, ...extra });
    this.#updateForming(id, ltp, now.getTime());
    this.emit('tick', id, ltp);
  }

  /** Candles fetched from the exchange (closed + the forming one). */
  setCandles(id, candles, tf) {
    this.tf = tf;
    this.candles.set(id, candles.slice(-400));
  }

  getCandles(id) {
    return this.candles.get(id) || [];
  }

  /** Keep the chart's last candle moving between candle fetches. */
  #updateForming(id, ltp, nowMs) {
    const list = this.candles.get(id);
    if (!list?.length) return;
    const start = barStart(nowMs, this.tf);
    const last = list[list.length - 1];
    if (last.time === start) {
      last.high = Math.max(last.high, ltp);
      last.low = Math.min(last.low, ltp);
      last.close = ltp;
    } else if (start > last.time) {
      list.push({ time: start, open: ltp, high: ltp, low: ltp, close: ltp, volume: 0, forming: true });
      if (list.length > 400) list.shift();
    }
  }
}

/** Normalise a raw candle row → { time(ms), open, high, low, close, volume }. */
export function normCandle(c) {
  const t = Number(c.time ?? c.t ?? c.open_time);
  return {
    time: t < 1e12 ? t * 1000 : t,
    open: +c.open,
    high: +c.high,
    low: +c.low,
    close: +c.close,
    volume: +(c.volume ?? 0),
  };
}

/** Merge smaller candles (oldest first) into `tf`-minute candles. Drops a partial first bucket. */
export function aggregate(candles, tf, baseTf) {
  const out = [];
  for (const c of candles) {
    const start = barStart(c.time, tf);
    const last = out[out.length - 1];
    if (last && last.time === start) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume;
      last.n++;
    } else out.push({ ...c, time: start, n: 1 });
  }
  if (out.length && baseTf && out[0].n < tf / baseTf) out.shift();
  return out.map(({ n, ...c }) => c);
}

const SPOT_INTERVAL = { 5: '5m', 15: '15m', 30: '30m', 60: '1h' };

/**
 * Polls CoinDCX public prices: ONE spot-ticker call covers every spot market and ONE call
 * covers every futures pair, so polling every 2 s costs ~60 requests/min in total.
 * No API keys needed — paper trading runs on real prices without credentials.
 */
export class CoinDcxFeed {
  constructor({ client, marketData, pollMs = 2000 }) {
    this.client = client;
    this.md = marketData;
    this.pollMs = pollMs;
    this.instruments = [];
    this.timer = null;
    this.lastError = null;
    this.lastOkAt = null;
  }

  setInstruments(list) {
    this.instruments = list;
  }

  start() {
    if (this.timer) return;
    const loop = async () => {
      await this.poll();
      this.timer = setTimeout(loop, this.pollMs);
    };
    this.timer = setTimeout(loop, 0);
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = null;
  }

  async poll() {
    const errors = [];
    const spot = this.instruments.filter((i) => i.kind === 'spot');
    const fut = this.instruments.filter((i) => i.kind === 'futures');
    // spot ticker also carries USDTINR, used to show ₹ equivalents (so poll it every time)
    try {
      const rows = await this.client.spotTickers();
      const bySym = new Map(rows.map((r) => [r.market, r]));
      const inr = bySym.get('USDTINR');
      if (inr) this.md.usdtInr = +inr.last_price || this.md.usdtInr;
      for (const i of spot) {
        const r = bySym.get(i.symbol);
        if (r) this.md.pushTick(i.id, +r.last_price, { change24h: r.change_24_hour != null ? +r.change_24_hour : null });
        else errors.push(`${i.symbol} not in spot ticker`);
      }
    } catch (e) {
      if (spot.length) errors.push(`spot prices: ${e.message}`);
    }
    if (fut.length) {
      try {
        const res = await this.client.futuresPrices();
        const prices = res?.prices || {};
        for (const i of fut) {
          const p = prices[i.symbol];
          const last = +(p?.ls ?? p?.last_price ?? p?.mp ?? 0);
          if (last > 0) this.md.pushTick(i.id, last, { change24h: p.pc != null ? +p.pc : null, mark: p.mp != null ? +p.mp : null, funding: p.fr != null ? +p.fr : null });
          else errors.push(`${i.symbol} not in futures prices`);
        }
      } catch (e) {
        errors.push(`futures prices: ${e.message}`);
      }
    }
    const error = errors.length ? errors.join(' · ') : null;
    if (error && error !== this.lastError) log('error', `Price poll failed: ${error}`);
    if (!error) this.lastOkAt = new Date();
    this.lastError = error;
  }

  /** Recent candles at `tf` minutes, oldest first (the last one may still be forming). */
  async candles(inst, tf, limit) {
    if (inst.kind === 'spot') {
      const rows = await this.client.spotCandles(inst.candlePair, SPOT_INTERVAL[tf], Math.min(1000, limit));
      return (Array.isArray(rows) ? rows : []).map(normCandle).sort((a, b) => a.time - b.time);
    }
    // futures: 60m natively; smaller timeframes are built from 5-minute candles
    const base = tf >= 60 ? 60 : 5;
    const to = Math.floor(Date.now() / 1000);
    const from = to - Math.ceil(limit * tf * 60 * 1.05);
    const res = await this.client.futuresCandles(inst.symbol, String(base), from, to);
    const rows = (Array.isArray(res) ? res : res?.data || []).map(normCandle).sort((a, b) => a.time - b.time);
    return base === tf ? rows : aggregate(rows, tf, base);
  }

  status() {
    return { source: 'coindcx', lastError: this.lastError, lastOkAt: this.lastOkAt, instruments: this.instruments.length, pollMs: this.pollMs };
  }
}
